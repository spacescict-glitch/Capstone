import { useEffect, useMemo, useState, useRef } from "react";
import "./walk-in-reservation.css";
import {
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  updateDoc,
  doc,
  serverTimestamp,
  getDocs,
  getDoc,
} from "firebase/firestore";
import { auth, db } from "../../firebase";
import { isRoomUnderMaintenance } from "../../utils/Roommaintenance";
import { logActivity } from "../../utils/logActivity";
import Toast from "../../Popup/Toast/Toast";
import { useNavigate } from "react-router-dom";

// ─── Constants ───────────────────────────────────────────────────────
const MIN_HOUR = 7;
const MAX_HOUR = 20;
const MIN_MINUTES = MIN_HOUR * 60; // 420
const MAX_MINUTES = MAX_HOUR * 60; // 1200
const ITEMS_PER_PAGE = 6;
const LIVE_ITEMS_PER_PAGE = 4;

// ─── Helpers ────────────────────────────────────────────────────────
const convertToMinutes = (time) => {
  if (!time) return 0;
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

const convertToTime = (mins) => {
  const clamped = Math.max(0, Math.min(mins, 24 * 60 - 1));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

const formatTime12 = (time) => {
  if (!time) return "";
  const [hour, minute] = time.split(":").map(Number);
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return `${h}:${String(minute).padStart(2, "0")} ${suffix}`;
};

const formatDurationLabel = (mins) => {
  const n = Number(mins);
  if (!n) return "--";
  if (n < 60) return `${n} mins`;
  const hrs = Math.floor(n / 60);
  const rem = n % 60;
  return rem ? `${hrs} hr ${rem} mins` : `${hrs} Hour${hrs > 1 ? "s" : ""}`;
};

const formatDateLong = (dateStr) => {
  if (!dateStr) return "—";
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const roundUpTo30 = (mins) => Math.ceil(mins / 30) * 30;

const overlap = (aStart, aEnd, bStart, bEnd) => {
  return (
    convertToMinutes(aStart) < convertToMinutes(bEnd) &&
    convertToMinutes(aEnd) > convertToMinutes(bStart)
  );
};

const getTodayLocal = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const toDateStrLocal = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const addDaysLocal = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toDateStrLocal(d);
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const buildCalendarGrid = (year, month) => {
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const cells = [];
  for (let i = 0; i < startOffset; i++) {
    cells.push({
      day: daysInPrevMonth - startOffset + 1 + i,
      inMonth: false,
      date: new Date(year, month - 1, daysInPrevMonth - startOffset + 1 + i),
    });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, inMonth: true, date: new Date(year, month, d) });
  }
  while (cells.length % 7 !== 0 || cells.length < 42) {
    const nextIndex = cells.length - startOffset - daysInMonth + 1;
    cells.push({
      day: nextIndex,
      inMonth: false,
      date: new Date(year, month + 1, nextIndex),
    });
    if (cells.length >= 42) break;
  }
  return cells;
};

const normalize = (value) => value?.toString().trim().toLowerCase();

// Sort rooms alphabetically by roomName (numeric-aware: "Room 2" < "Room 10")
const sortRoomsByName = (list) =>
  [...list].sort((a, b) =>
    (a.roomName || "").localeCompare(b.roomName || "", undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );

// ─── Main Component ──────────────────────────────────────────────────
export default function WalkInReservation() {
  const navigate = useNavigate();
  const toastTimeoutRef = useRef(null);

  const [pageLoading, setPageLoading] = useState(true);
  const [savingReservation, setSavingReservation] = useState(false);
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [loadingSchedule, setLoadingSchedule] = useState(true);

  const [toast, setToast] = useState({
    show: false, type: "success", title: "", message: "",
  });

  const showToast = (type, title, message) => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = null;
    }
    setToast({ show: true, type, title, message });
    if (type !== "loading") {
      toastTimeoutRef.current = setTimeout(() => {
        setToast((prev) => ({ ...prev, show: false }));
        toastTimeoutRef.current = null;
      }, 4000);
    }
  };

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  const [rooms, setRooms] = useState([]);
  const [events, setEvents] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [releases, setReleases] = useState([]);
  const [reassignments, setReassignments] = useState([]);
  const [roomSchedules, setRoomSchedules] = useState({});

  const [selectedRoom, setSelectedRoom] = useState(null);
  const [showModal, setShowModal] = useState(false);

  // ─── Filters + pagination ──────────────────────────────────────────
  const [selectedBuilding, setSelectedBuilding] = useState("All Buildings");
  const [selectedFloor, setSelectedFloor] = useState("All Floors");
  const [currentPage, setCurrentPage] = useState(1);
  const [liveCurrentPage, setLiveCurrentPage] = useState(1);

  const [selectedDate, setSelectedDate] = useState(getTodayLocal());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [calendarCursor, setCalendarCursor] = useState(() => {
    const d = new Date(`${getTodayLocal()}T00:00:00`);
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const [form, setForm] = useState({
    requesterType: "",
    requesterId: "",
    requesterName: "",
    organizationName: "",
    purpose: "",
    customPurpose: "",
    course: "",
    yearSectionGroup: "",
    studentRange: "",
    date: getTodayLocal(),
    duration: "",
    endTime: "",
    startTime: "",
  });

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  // ─── Listeners ────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = onSnapshot(collection(db, "rooms"), (snap) => {
      const data = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      setRooms(data);
      setLoadingRooms(false);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (rooms.length === 0) return;
    const unsubs = rooms.map((room) =>
      onSnapshot(collection(db, "rooms", room.id, "schedules"), (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((s) => !s.initialized);
        setRoomSchedules((prev) => ({ ...prev, [room.id]: list }));
      }),
    );
    return () => unsubs.forEach((u) => u());
  }, [rooms.map((r) => r.id).join(",")]);

  useEffect(() => {
    if (!selectedDate) return;
    setLoadingSchedule(true);

    const qEvents = query(collection(db, "events"), where("date", "==", selectedDate));
    const unsubEvents = onSnapshot(qEvents, (snap) => {
      setEvents(snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
      setLoadingSchedule(false);
    });

    const qRes = query(
      collection(db, "reservationRequests"),
      where("date", "==", selectedDate)
    );
    const unsubRes = onSnapshot(qRes, (snap) => {
      const data = snap.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((r) => normalize(r.status) === "approved");
      setReservations(data);
    });

    const unsubReleases = onSnapshot(collection(db, "roomReleases"), (snap) => {
      setReleases(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });

    const unsubReassign = onSnapshot(collection(db, "roomReassignments"), (snap) => {
      const data = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((r) => normalize(r.status) === "approved");
      setReassignments(data);
    });

    return () => {
      unsubEvents();
      unsubRes();
      unsubReleases();
      unsubReassign();
    };
  }, [selectedDate]);

  const getDayAbbrev = (dateStr) => {
    const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    return days[new Date(dateStr).getDay()];
  };

  // ═══════════════════════════════════════════════════════════════════
  //  BUSY ITEMS — clipped to 7:00 AM – 8:00 PM
  // ═══════════════════════════════════════════════════════════════════
  const getBusyItemsForRoom = (roomId, date, dayAbbrev) => {
    const raw = [];

    const schedules = roomSchedules[roomId] || [];
    const releaseKeys = new Set(
      releases
        .filter((r) => r.roomId === roomId && r.date === date)
        .map((r) => `${r.scheduleId}_${r.date}`),
    );
    const reassignAwayKeys = new Set(
      reassignments
        .filter((r) => r.oldRoomId === roomId && r.date === date)
        .map((r) => `${r.scheduleId}_${r.date}`),
    );

    schedules
      .filter((s) => s.day === dayAbbrev)
      .filter((s) => {
        const key = `${s.id}_${date}`;
        return !releaseKeys.has(key) && !reassignAwayKeys.has(key);
      })
      .forEach((s) => {
        raw.push({
          startTime: s.startTime,
          endTime: s.endTime,
          label: s.subject || "Class",
          source: "schedule",
        });
      });

    events
      .filter((e) => e.roomId === roomId && e.date === date)
      .forEach((e) => {
        raw.push({
          startTime: e.startTime,
          endTime: e.endTime,
          label: e.title || e.purpose || "Room Activity",
          source: "event",
        });
      });

    reservations
      .filter((r) => r.roomId === roomId && r.date === date)
      .forEach((r) => {
        raw.push({
          startTime: r.startTime,
          endTime: r.endTime,
          label: r.customPurpose || r.courseTitle || r.purpose || "Reservation",
          source: "reservation",
        });
      });

    reassignments
      .filter((r) => r.newRoomId === roomId && r.date === date)
      .forEach((r) => {
        raw.push({
          startTime: r.startTime,
          endTime: r.endTime,
          label: `${r.courseTitle || "Class"} (Moved)`,
          source: "reassignment",
        });
      });

    return raw
      .map((item) => {
        const s = convertToMinutes(item.startTime);
        const e = convertToMinutes(item.endTime);
        const cs = Math.max(s, MIN_MINUTES);
        const ce = Math.min(e, MAX_MINUTES);
        return { ...item, _s: cs, _e: ce };
      })
      .filter((item) => item._s < item._e)
      .sort((a, b) => a._s - b._s);
  };

  const getFreeWindowsForRoom = (roomId, date, dayAbbrev) => {
    const busy = getBusyItemsForRoom(roomId, date, dayAbbrev);
    const windows = [];
    let cursor = MIN_MINUTES;

    for (const item of busy) {
      if (item._s > cursor) {
        const gap = item._s - cursor;
        if (gap >= 30) {
          windows.push({
            startMin: cursor,
            endMin: item._s,
            startTime: convertToTime(cursor),
            endTime: convertToTime(item._s),
          });
        }
      }
      cursor = Math.max(cursor, item._e);
    }

    if (MAX_MINUTES - cursor >= 30) {
      windows.push({
        startMin: cursor,
        endMin: MAX_MINUTES,
        startTime: convertToTime(cursor),
        endTime: convertToTime(MAX_MINUTES),
      });
    }

    return windows;
  };

  // ═══════════════════════════════════════════════════════════════════
  //  AVAILABLE ROOMS (sorted alphabetically)
  // ═══════════════════════════════════════════════════════════════════
  const availableRooms = useMemo(() => {
    const dayAbbrev = getDayAbbrev(selectedDate);
    const isToday = selectedDate === getTodayLocal();
    const pastClosing = isToday && currentMinutes >= MAX_MINUTES;

    if (pastClosing) return [];

    const nowMin = isToday ? currentMinutes : 0;

    const list = rooms
      .map((room) => {
        if (isRoomUnderMaintenance(room, selectedDate, "07:00", "20:00")) return null;

        let windows = getFreeWindowsForRoom(room.id, selectedDate, dayAbbrev);

        if (isToday) {
          windows = windows
            .map((w) => {
              if (w.endMin <= nowMin) return null;
              const startMin = Math.max(w.startMin, roundUpTo30(nowMin));
              if (w.endMin - startMin < 30) return null;
              return { ...w, startMin, startTime: convertToTime(startMin) };
            })
            .filter(Boolean);
        }

        if (windows.length === 0) return null;

        const totalBookable = windows.reduce(
          (sum, w) => sum + (w.endMin - w.startMin),
          0,
        );

        return {
          ...room,
          freeWindows: windows,
          totalBookableMinutes: totalBookable,
        };
      })
      .filter(Boolean);

    return sortRoomsByName(list);
  }, [
    rooms,
    roomSchedules,
    events,
    reservations,
    releases,
    reassignments,
    selectedDate,
    currentMinutes,
  ]);

  // ═══════════════════════════════════════════════════════════════════
  //  BUILDING + FLOOR OPTIONS
  // ═══════════════════════════════════════════════════════════════════
  const buildingOptions = useMemo(() => {
    const set = new Set();
    rooms.forEach((r) => {
      if (r.building) set.add(r.building);
    });
    return ["All Buildings", ...Array.from(set).sort()];
  }, [rooms]);

  const floorOptions = useMemo(() => {
    const set = new Set();
    rooms
      .filter(
        (r) => selectedBuilding === "All Buildings" || r.building === selectedBuilding,
      )
      .forEach((r) => {
        if (r.floor) set.add(r.floor);
      });
    return ["All Floors", ...Array.from(set).sort()];
  }, [rooms, selectedBuilding]);

  useEffect(() => {
    if (!floorOptions.includes(selectedFloor)) {
      setSelectedFloor("All Floors");
    }
  }, [floorOptions, selectedFloor]);

  // ═══════════════════════════════════════════════════════════════════
  //  FILTERED + PAGINATED ROOMS (kept alphabetical after filtering)
  // ═══════════════════════════════════════════════════════════════════
  const filteredAvailableRooms = useMemo(() => {
    let list = availableRooms;

    if (selectedBuilding !== "All Buildings") {
      list = list.filter((r) => r.building === selectedBuilding);
    }
    if (selectedFloor !== "All Floors") {
      list = list.filter((r) => r.floor === selectedFloor);
    }

    return sortRoomsByName(list);
  }, [availableRooms, selectedBuilding, selectedFloor]);

  const totalPages = Math.max(
    1,
    Math.ceil(filteredAvailableRooms.length / ITEMS_PER_PAGE),
  );
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * ITEMS_PER_PAGE;
  const endIndex = Math.min(
    startIndex + ITEMS_PER_PAGE,
    filteredAvailableRooms.length,
  );
  const paginatedRooms = filteredAvailableRooms.slice(startIndex, endIndex);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedBuilding, selectedFloor, selectedDate]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  // ═══════════════════════════════════════════════════════════════════
  //  LIVE AVAILABILITY (sorted alphabetically)
  // ═══════════════════════════════════════════════════════════════════
  const liveAvailability = useMemo(() => {
    const dayAbbrev = getDayAbbrev(selectedDate);
    const isToday = selectedDate === getTodayLocal();
    const nowMin = isToday ? currentMinutes : 0;
    const pastClosing = isToday && currentMinutes >= MAX_MINUTES;

    const list = rooms.map((room) => {
      if (isRoomUnderMaintenance(room, selectedDate, "07:00", "20:00")) {
        return { ...room, maintenance: true, available: false, freeWindows: [] };
      }

      const allWindows = getFreeWindowsForRoom(room.id, selectedDate, dayAbbrev);

      let windows = allWindows;
      if (isToday) {
        windows = allWindows
          .map((w) => {
            if (w.endMin <= nowMin) return null;
            const startMin = Math.max(w.startMin, roundUpTo30(nowMin));
            if (w.endMin - startMin < 30) return null;
            return { ...w, startMin, startTime: convertToTime(startMin) };
          })
          .filter(Boolean);
      }

      const available = !pastClosing && windows.length > 0;

      return {
        ...room,
        maintenance: false,
        available,
        closed: pastClosing,
        freeWindows: windows,
        allWindows,
      };
    });

    return sortRoomsByName(list);
  }, [
    rooms,
    roomSchedules,
    events,
    reservations,
    releases,
    reassignments,
    selectedDate,
    currentMinutes,
  ]);

  const totalLivePages = Math.max(
    1,
    Math.ceil(liveAvailability.length / LIVE_ITEMS_PER_PAGE),
  );
  const safeLivePage = Math.min(liveCurrentPage, totalLivePages);
  const liveStartIndex = (safeLivePage - 1) * LIVE_ITEMS_PER_PAGE;
  const liveEndIndex = Math.min(
    liveStartIndex + LIVE_ITEMS_PER_PAGE,
    liveAvailability.length,
  );
  const paginatedLiveAvailability = liveAvailability.slice(
    liveStartIndex,
    liveEndIndex,
  );

  useEffect(() => {
    setLiveCurrentPage(1);
  }, [selectedDate]);

  useEffect(() => {
    if (liveCurrentPage > totalLivePages) {
      setLiveCurrentPage(totalLivePages);
    }
  }, [liveCurrentPage, totalLivePages]);

  // ═══════════════════════════════════════════════════════════════════
  //  AVAILABLE DURATIONS (based on selected room)
  // ═══════════════════════════════════════════════════════════════════
  const availableDurations = useMemo(() => {
    if (!selectedRoom) return [];

    const isToday = selectedDate === getTodayLocal();
    const nowMin = isToday ? currentMinutes : 0;
    const dayAbbrev = getDayAbbrev(selectedDate);
    const windows = getFreeWindowsForRoom(selectedRoom.id, selectedDate, dayAbbrev);

    const durations = new Set();
    for (const w of windows) {
      let start = w.startMin;
      if (isToday && start < nowMin) {
        start = Math.max(w.startMin, roundUpTo30(nowMin));
      }
      const maxDur = w.endMin - start;
      for (let m = 30; m <= maxDur; m += 30) {
        durations.add(m);
      }
    }

    return [...durations].sort((a, b) => a - b).map((mins) => ({
      value: mins,
      label: formatDurationLabel(mins),
    }));
  }, [
    selectedRoom,
    selectedDate,
    roomSchedules,
    events,
    reservations,
    releases,
    reassignments,
    currentMinutes,
  ]);

  // ═══════════════════════════════════════════════════════════════════
  //  AVAILABLE START TIMES (based on selected duration)
  // ═══════════════════════════════════════════════════════════════════
  const availableStartTimes = useMemo(() => {
    if (!selectedRoom || !form.duration) return [];

    const dur = parseInt(form.duration, 10);
    if (!dur) return [];

    const isToday = selectedDate === getTodayLocal();
    const nowMin = isToday ? currentMinutes : 0;
    const dayAbbrev = getDayAbbrev(selectedDate);
    const windows = getFreeWindowsForRoom(selectedRoom.id, selectedDate, dayAbbrev);

    const times = [];
    for (const w of windows) {
      let start = w.startMin;
      if (isToday && start < nowMin) {
        start = Math.max(w.startMin, roundUpTo30(nowMin));
      }
      for (let t = start; t + dur <= w.endMin; t += 30) {
        times.push({
          value: t,
          time: convertToTime(t),
          label: formatTime12(convertToTime(t)),
        });
      }
    }

    const seen = new Set();
    return times.filter((t) => {
      if (seen.has(t.value)) return false;
      seen.add(t.value);
      return true;
    });
  }, [
    selectedRoom,
    form.duration,
    selectedDate,
    roomSchedules,
    events,
    reservations,
    releases,
    reassignments,
    currentMinutes,
  ]);

  // ─── Select Room ──────────────────────────────────────────────────
  const selectRoom = (room) => {
    setSelectedRoom(room);

    const isToday = selectedDate === getTodayLocal();
    const nowMin = isToday ? currentMinutes : 0;
    const dayAbbrev = getDayAbbrev(selectedDate);
    const windows = getFreeWindowsForRoom(room.id, selectedDate, dayAbbrev);

    if (windows.length === 0) {
      setForm((prev) => ({ ...prev, startTime: "", endTime: "", duration: "" }));
      return;
    }

    let chosenWindow = windows[0];
    let startMin = chosenWindow.startMin;

    if (isToday) {
      startMin = Math.max(chosenWindow.startMin, roundUpTo30(nowMin));

      if (startMin >= chosenWindow.endMin) {
        const next = windows.find(
          (w) => w.endMin - Math.max(w.startMin, roundUpTo30(nowMin)) >= 30,
        );
        if (!next) return;
        chosenWindow = next;
        startMin = Math.max(next.startMin, roundUpTo30(nowMin));
      }
    }

    const maxDur = chosenWindow.endMin - startMin;
    const duration = Math.min(60, maxDur);

    setForm((prev) => ({
      ...prev,
      duration,
      startTime: convertToTime(startMin),
      endTime: convertToTime(startMin + duration),
    }));
  };

  const handleChange = (field) => (e) => {
    const value = e.target.value;
    setForm((prev) => {
      const updated = { ...prev, [field]: value };

      if (field === "duration" && selectedRoom) {
        const dur = parseInt(value, 10);
        if (!isNaN(dur) && dur > 0) {
          const isToday = selectedDate === getTodayLocal();
          const nowMin = isToday ? currentMinutes : 0;
          const dayAbbrev = getDayAbbrev(selectedDate);
          const windows = getFreeWindowsForRoom(selectedRoom.id, selectedDate, dayAbbrev);

          const validStarts = [];
          for (const w of windows) {
            let s = w.startMin;
            if (isToday && s < nowMin) s = Math.max(w.startMin, roundUpTo30(nowMin));
            for (let t = s; t + dur <= w.endMin; t += 30) {
              validStarts.push(t);
            }
          }

          const curStart = convertToMinutes(updated.startTime);
          let chosen;
          if (validStarts.includes(curStart)) {
            chosen = curStart;
          } else if (validStarts.length > 0) {
            chosen = validStarts[0];
          }

          if (chosen !== undefined) {
            updated.startTime = convertToTime(chosen);
            updated.endTime = convertToTime(chosen + dur);
          } else {
            updated.startTime = "";
            updated.endTime = "";
          }
        }
      }

      if (field === "startTime" && selectedRoom) {
        const start = convertToMinutes(value);
        const dur = parseInt(updated.duration, 10);
        if (!isNaN(dur) && dur > 0) {
          updated.endTime = convertToTime(start + dur);
        }
      }

      return updated;
    });
  };

  // ─── Validate ─────────────────────────────────────────────────────
  const validate = () => {
    if (!selectedRoom) return "Please select a room.";
    if (
      isRoomUnderMaintenance(selectedRoom, selectedDate, form.startTime, form.endTime)
    ) {
      return "This room is under maintenance and cannot be reserved.";
    }
    if (!form.requesterId.trim()) return "Requester ID is required.";
    if (!form.requesterName.trim()) return "Requester Name is required.";
    if (!form.duration) return "Select a duration.";
    if (!form.startTime) return "Select a start time.";
    if (!form.purpose.trim()) return "Purpose is required.";
    if (
      (form.requesterType === "organization" || form.purpose === "Meeting") &&
      !form.studentRange
    ) {
      return "Please select the estimated number of attendees.";
    }

    const start = convertToMinutes(form.startTime);
    const end = convertToMinutes(form.endTime);

    if (start < MIN_MINUTES) return "Reservations can only start from 7:00 AM.";
    if (end > MAX_MINUTES) return "Reservations must end by 8:00 PM.";
    if (start >= end) return "End time must be after start time.";

    const isToday = selectedDate === getTodayLocal();
    if (isToday && currentMinutes >= MAX_MINUTES) {
      return "Operating hours for today have ended (8:00 PM). Please select a future date.";
    }
    if (isToday && start < currentMinutes) {
      return "You cannot reserve a past time today.";
    }

    const dayAbbrev = getDayAbbrev(selectedDate);
    const windows = getFreeWindowsForRoom(selectedRoom.id, selectedDate, dayAbbrev);
    const inside = windows.some((w) => start >= w.startMin && end <= w.endMin);
    if (!inside) {
      return "Selected time is not within an available time for this room.";
    }

    return null;
  };

  const openReview = () => {
    const error = validate();
    if (error) {
      showToast("error", "Validation Error", error);
      return;
    }
    setShowModal(true);
  };

  // ─── Notifications ────────────────────────────────────────────────
  const notifyClerkAndAdmin = async (title, message, reservationId) => {
    const usersSnap = await getDocs(collection(db, "users"));
    const notifications = [];
    usersSnap.forEach((userDoc) => {
      const user = userDoc.data();
      const role = normalize(user.role);
      if (role === "clerk" || role === "admin") {
        notifications.push(
          addDoc(collection(db, "notifications"), {
            userId: userDoc.id,
            ownerType: role === "clerk" ? "clerk" : "admin",
            reservationId,
            title,
            message,
            type: "walk-in-reservation",
            unread: true,
            archived: false,
            badge: "NEW",
            createdAt: serverTimestamp(),
          }),
        );
      }
    });
    if (notifications.length > 0) await Promise.all(notifications);
  };

  // ─── Confirm ──────────────────────────────────────────────────────
  const handleConfirm = async () => {
    const error = validate();
    if (error) {
      showToast("error", "Validation Error", error);
      setShowModal(false);
      return;
    }

    setSavingReservation(true);
    showToast("loading", "Processing", "Creating walk-in reservation...");

    let clerkName = "Clerk";

    try {
      const firebaseUser = auth.currentUser;
      if (firebaseUser) {
        const userSnap = await getDoc(doc(db, "users", firebaseUser.uid));
        if (userSnap.exists()) {
          const data = userSnap.data();
          clerkName =
            `${data.firstName || ""} ${data.lastName || ""}`.trim() || "Clerk";
        }
      }

      const reservationRef = await addDoc(
        collection(db, "reservationRequests"),
        {
          reservationType: "walk-in",
          requesterId: form.requesterId,
          requesterName: form.requesterName,
          organizationName: form.organizationName,
          course: form.course,
          yearSectionGroup: form.yearSectionGroup,
          estimatedAttendees: form.studentRange,
          roomId: selectedRoom.id,
          roomName: selectedRoom.roomName,
          floor: selectedRoom.floor,
          date: selectedDate,
          startTime: form.startTime,
          endTime: form.endTime,
          duration: Number(form.duration),
          purpose: form.customPurpose || form.purpose,
          status: "approved",
          approvedBy: firebaseUser?.uid || "",
          createdBy: firebaseUser?.uid || "",
          createdAt: serverTimestamp(),
        },
      );

      await notifyClerkAndAdmin(
        "Walk-In Reservation Created",
        `${form.requesterName} created a walk-in reservation for ${selectedRoom.roomName} on ${selectedDate} from ${form.startTime} to ${form.endTime}.`,
        reservationRef.id,
      );

      if (firebaseUser?.uid) {
        await addDoc(collection(db, "notifications"), {
          userId: firebaseUser.uid,
          ownerType: "clerk",
          reservationId: reservationRef.id,
          title: "Walk-In Reservation Created",
          message: `You successfully created a walk-in reservation for ${selectedRoom.roomName} (${form.startTime} - ${form.endTime}) on ${selectedDate}.`,
          type: "walk-in-created",
          unread: true,
          archived: false,
          badge: "SUCCESS",
          createdAt: serverTimestamp(),
        });
      }

      if (selectedDate === getTodayLocal()) {
        const start = convertToMinutes(form.startTime);
        const end = convertToMinutes(form.endTime);
        if (currentMinutes >= start && currentMinutes < end) {
          await updateDoc(doc(db, "rooms", selectedRoom.id), {
            status: "Occupied",
          });
        }
      }

      await logActivity({
        userId: firebaseUser?.uid || "",
        user: clerkName,
        role: "Clerk",
        action: "Created Walk-In Reservation",
        actionType: "CREATE",
        target: `${selectedRoom.roomName} | ${form.requesterName}`,
        status: "SUCCESS",
        details: {
          reservationId: reservationRef.id,
          requester: form.requesterName,
          date: selectedDate,
          startTime: form.startTime,
          endTime: form.endTime,
          purpose: form.customPurpose || form.purpose,
        },
      });

      showToast("success", "Success", "Walk-in reservation created successfully!");
      setShowModal(false);
      setSelectedRoom(null);
      setForm({
        requesterId: "",
        requesterName: "",
        organizationName: "",
        course: "",
        yearSectionGroup: "",
        studentRange: "",
        customPurpose: "",
        requesterType: "",
        purpose: "",
        date: selectedDate,
        duration: "",
        endTime: "",
        startTime: "",
      });
    } catch (err) {
      console.error(err);
      showToast("error", "Error", err.message || "Failed to save reservation.");
      await logActivity({
        userId: auth.currentUser?.uid || "",
        user: clerkName || "Clerk",
        role: "Clerk",
        action: "Created Walk-In Reservation",
        actionType: "CREATE",
        target: selectedRoom?.roomName || "Unknown Room",
        status: "FAILED",
        details: { error: err.message },
      });
    } finally {
      setSavingReservation(false);
    }
  };

  useEffect(() => {
    if (!loadingRooms && !loadingSchedule) {
      setPageLoading(false);
    }
  }, [loadingRooms, loadingSchedule]);

  if (pageLoading) {
    return (
      <div className="wir-loading-page">
        <div className="spinner"></div>
        <p>Loading walk-in reservation...</p>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  //  RENDER
  // ═══════════════════════════════════════════════════════════════════
  return (
    <div className="wir-container">
      <div className="wir-page">
        <h1 className="wir-title">Walk-In Reservation</h1>
        <p className="wir-subtitle">Instant Booking</p>

        <div className="wir-hours-banner">
          <i className="fa-regular fa-clock" />
          <span>
            Operating hours: <strong>7:00 AM – 8:00 PM</strong> only.
            Choose any free rooms inside this range.
          </span>
        </div>

        <div className="wir-layout">
          <div className="wir-card">
            <div className="wir-section-title">
              <span className="wir-section-bar" />
              Requester Information
            </div>

            <div className="wir-field">
              <label>Requester Type</label>
              <select
                className="wir-input"
                value={form.requesterType}
                onChange={handleChange("requesterType")}
              >
                <option value="">Select Requester</option>
                <option value="faculty">Faculty</option>
                <option value="organization">Organization</option>
              </select>
            </div>

            <div className="wir-row">
              <div className="wir-field">
                <label>
                  {form.requesterType === "faculty"
                    ? "Faculty ID"
                    : "Organization / Student ID"}
                </label>
                <input
                  className="wir-input"
                  value={form.requesterId}
                  onChange={handleChange("requesterId")}
                />
              </div>
              <div className="wir-field">
                <label>
                  {form.requesterType === "faculty"
                    ? "Faculty Name"
                    : "Requester Name"}
                </label>
                <input
                  className="wir-input"
                  value={form.requesterName}
                  onChange={handleChange("requesterName")}
                />
              </div>
            </div>

            {form.requesterType === "organization" && (
              <div className="wir-field">
                <label>Organization Name</label>
                <input
                  className="wir-input"
                  placeholder="Computer Society"
                  value={form.organizationName}
                  onChange={handleChange("organizationName")}
                />
              </div>
            )}

            <div className="wir-field">
              <label>Purpose</label>
              <select
                className="wir-input"
                value={form.purpose}
                onChange={handleChange("purpose")}
              >
                <option value="">Select Purpose</option>
                {form.requesterType === "faculty" ? (
                  <>
                    <option value="Class">Class</option>
                    <option value="Meeting">Meeting</option>
                  </>
                ) : (
                  <>
                    <option value="Training">Training</option>
                    <option value="Meeting">Meeting</option>
                    <option value="Seminar">Seminar</option>
                    <option value="Other Activity">Other Activity</option>
                  </>
                )}
              </select>
            </div>

            {form.requesterType === "faculty" && form.purpose === "Class" && (
              <div className="wir-row">
                <div className="wir-field">
                  <label>Course</label>
                  <input
                    className="wir-input"
                    placeholder="BSIT"
                    value={form.course}
                    onChange={handleChange("course")}
                  />
                </div>
                <div className="wir-field">
                  <label>Year / Section / Group</label>
                  <input
                    className="wir-input"
                    placeholder="4F-G2"
                    value={form.yearSectionGroup}
                    onChange={handleChange("yearSectionGroup")}
                  />
                </div>
              </div>
            )}

            {((form.requesterType === "faculty" && form.purpose === "Meeting") ||
              form.requesterType === "organization") && (
              <div className="wir-field">
                <label>Estimated Number of Attendees</label>
                <select
                  className="wir-input"
                  value={form.studentRange}
                  onChange={handleChange("studentRange")}
                >
                  <option value="">Select Range</option>
                  <option value="1-30">1 - 30 Persons</option>
                  <option value="31-50">31 - 50 Persons</option>
                  <option value="51-80">51 - 80 Persons</option>
                  <option value="81-100">81 - 100 Persons</option>
                  <option value="101+">101+ Persons</option>
                </select>
              </div>
            )}

            {form.purpose === "Other Activity" && (
              <div className="wir-field">
                <label>Specify Activity</label>
                <input
                  className="wir-input"
                  placeholder="Specify..."
                  value={form.customPurpose}
                  onChange={handleChange("customPurpose")}
                />
              </div>
            )}

            <div className="wir-section-title" style={{ marginTop: 24 }}>
              <span className="wir-section-bar" />
              Room And Schedule
            </div>

            <div className="wir-field">
              <label>Select Date</label>
              <div className="wir-datepicker">
                <button
                  type="button"
                  className={`wir-date-trigger ${showDatePicker ? "open" : ""}`}
                  onClick={() => {
                    const d = new Date(`${selectedDate}T00:00:00`);
                    setCalendarCursor({ year: d.getFullYear(), month: d.getMonth() });
                    setShowDatePicker((v) => !v);
                  }}
                >
                  <i className="fa-regular fa-calendar"></i>
                  <span>
                    {new Date(`${selectedDate}T00:00:00`).toLocaleDateString("en-US", {
                      weekday: "short",
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                  <i className="fa-solid fa-chevron-down wir-date-caret"></i>
                </button>

                {showDatePicker && (
                  <>
                    <div
                      className="wir-date-clickaway"
                      onClick={() => setShowDatePicker(false)}
                    ></div>
                    <div className="wir-date-popover">
                      <span className="wir-date-popover-arrow"></span>

                      <div className="wir-date-quick-row">
                        <button
                          type="button"
                          className={selectedDate === getTodayLocal() ? "active" : ""}
                          onClick={() => {
                            setSelectedDate(getTodayLocal());
                            setShowDatePicker(false);
                          }}
                        >
                          Today
                        </button>
                        <button
                          type="button"
                          className={
                            selectedDate === addDaysLocal(getTodayLocal(), 1) ? "active" : ""
                          }
                          onClick={() => {
                            setSelectedDate(addDaysLocal(getTodayLocal(), 1));
                            setShowDatePicker(false);
                          }}
                        >
                          Tomorrow
                        </button>
                      </div>

                      <div className="wir-cal-header">
                        <button
                          type="button"
                          className="wir-cal-nav"
                          onClick={() =>
                            setCalendarCursor((c) => {
                              const m = c.month - 1;
                              return m < 0
                                ? { year: c.year - 1, month: 11 }
                                : { year: c.year, month: m };
                            })
                          }
                        >
                          <i className="fa-solid fa-chevron-left"></i>
                        </button>
                        <span className="wir-cal-title">
                          {MONTH_NAMES[calendarCursor.month]} {calendarCursor.year}
                        </span>
                        <button
                          type="button"
                          className="wir-cal-nav"
                          onClick={() =>
                            setCalendarCursor((c) => {
                              const m = c.month + 1;
                              return m > 11
                                ? { year: c.year + 1, month: 0 }
                                : { year: c.year, month: m };
                            })
                          }
                        >
                          <i className="fa-solid fa-chevron-right"></i>
                        </button>
                      </div>

                      <div className="wir-cal-weekdays">
                        {WEEKDAY_LABELS.map((w) => (
                          <span key={w}>{w}</span>
                        ))}
                      </div>

                      <div className="wir-cal-grid">
                        {buildCalendarGrid(calendarCursor.year, calendarCursor.month).map(
                          (cell, i) => {
                            const cellStr = toDateStrLocal(cell.date);
                            const isPast = cellStr < getTodayLocal();
                            const isSelected = cellStr === selectedDate;
                            return (
                              <button
                                type="button"
                                key={i}
                                className={[
                                  "wir-cal-day",
                                  !cell.inMonth && "is-outside",
                                  isSelected && "is-selected",
                                  isPast && "is-disabled",
                                ]
                                  .filter(Boolean)
                                  .join(" ")}
                                disabled={isPast}
                                onClick={() => {
                                  setSelectedDate(cellStr);
                                  setShowDatePicker(false);
                                }}
                              >
                                {cell.day}
                              </button>
                            );
                          },
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* SLOTS HEADER — label + building + floor filters */}
            <div className="wir-slots-header">
              <span className="wir-slots-label">Available Room Slots</span>

              <div className="wir-filter-controls">
                <div className="wir-filter-group">
                  <i className="fa-solid fa-building wir-filter-icon"></i>
                  <select
                    className="wir-filter-select"
                    value={selectedBuilding}
                    onChange={(e) => setSelectedBuilding(e.target.value)}
                  >
                    {buildingOptions.map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                  <i className="fa-solid fa-angle-down wir-filter-chev"></i>
                </div>

                <div className="wir-filter-group">
                  <i className="fa-solid fa-layer-group wir-filter-icon"></i>
                  <select
                    className="wir-filter-select"
                    value={selectedFloor}
                    onChange={(e) => setSelectedFloor(e.target.value)}
                  >
                    {floorOptions.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                  <i className="fa-solid fa-angle-down wir-filter-chev"></i>
                </div>

                {(selectedBuilding !== "All Buildings" ||
                  selectedFloor !== "All Floors") && (
                  <button
                    type="button"
                    className="wir-filter-clear"
                    onClick={() => {
                      setSelectedBuilding("All Buildings");
                      setSelectedFloor("All Floors");
                    }}
                    title="Clear filters"
                  >
                    <i className="fa-solid fa-xmark"></i>
                  </button>
                )}
              </div>
            </div>

            {/* Room grid */}
            <div className="wir-slots">
              {loadingRooms ? (
                <div className="wir-inline-loading">
                  <span className="small-spinner wir-inline-spinner"></span>
                  Loading rooms...
                </div>
              ) : availableRooms.length === 0 ? (
                <div className="wir-empty-state">
                  <div className="wir-empty-icon">
                    <i className="fa-regular fa-calendar-xmark"></i>
                  </div>
                  <h4 className="wir-empty-title">No Rooms Available</h4>
                  <p className="wir-empty-text">
                    There are no available rooms on{" "}
                    <strong>{formatDateLong(selectedDate)}</strong> within operating
                    hours (7:00 AM – 8:00 PM).
                  </p>
                  <div className="wir-empty-hint">
                    <i className="fa-solid fa-lightbulb"></i>
                    <span>Try selecting a different date.</span>
                  </div>
                </div>
              ) : filteredAvailableRooms.length === 0 ? (
                <div className="wir-empty-state">
                  <div className="wir-empty-icon">
                    <i className="fa-solid fa-filter-circle-xmark"></i>
                  </div>
                  <h4 className="wir-empty-title">No Matches Found</h4>
                  <p className="wir-empty-text">
                    No rooms match the selected{" "}
                    <strong>
                      {selectedBuilding !== "All Buildings"
                        ? selectedBuilding
                        : selectedFloor !== "All Floors"
                        ? selectedFloor
                        : "filter"}
                    </strong>{" "}
                    filter for {formatDateLong(selectedDate)}.
                  </p>
                  <button
                    type="button"
                    className="wir-empty-btn"
                    onClick={() => {
                      setSelectedBuilding("All Buildings");
                      setSelectedFloor("All Floors");
                    }}
                  >
                    <i className="fa-solid fa-rotate-left"></i> Clear Filters
                  </button>
                </div>
              ) : (
                paginatedRooms.map((room) => (
                  <button
                    key={room.id}
                    className={`wir-room-card ${
                      selectedRoom?.id === room.id ? "selected" : ""
                    }`}
                    onClick={() => selectRoom(room)}
                  >
                    <div className="wir-room-card-top">
                      <div>
                        <h4>{room.roomName}</h4>
                        <p>{room.roomType}</p>
                      </div>
                      <span className="wir-room-status">AVAILABLE</span>
                    </div>

                    <div className="wir-room-loc">
                      <span className="wir-room-loc-chip">
                        <i className="fa-solid fa-building"></i>
                        {room.building || "—"}
                      </span>
                      <span className="wir-room-loc-chip">
                        <i className="fa-solid fa-layer-group"></i>
                        {room.floor || "—"}
                      </span>
                    </div>

                    <div className="wir-room-duration">
                      Available Time
                      <strong>
                        {room.freeWindows.length > 0
                          ? `${formatTime12(
                              room.freeWindows[0].startTime
                            )} - ${formatTime12(
                              room.freeWindows[room.freeWindows.length - 1].endTime
                            )}`
                          : "--"}
                      </strong>
                    </div>
                  </button>
                ))
              )}
            </div>

            {/* PAGINATION */}
            {!loadingRooms && filteredAvailableRooms.length > 0 && totalPages > 1 && (
              <div className="wir-pagination">
                <span className="wir-page-info">
                  Showing {startIndex + 1}–{endIndex} of {filteredAvailableRooms.length} rooms
                </span>

                <div className="wir-page-controls">
                  <button
                    type="button"
                    className="wir-page-btn"
                    disabled={safePage === 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  >
                    <i className="fa-solid fa-chevron-left"></i>
                  </button>

                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={`wir-page-btn ${safePage === p ? "active" : ""}`}
                      onClick={() => setCurrentPage(p)}
                    >
                      {p}
                    </button>
                  ))}

                  <button
                    type="button"
                    className="wir-page-btn"
                    disabled={safePage === totalPages}
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  >
                    <i className="fa-solid fa-chevron-right"></i>
                  </button>
                </div>
              </div>
            )}

            {/* Duration + From + To — one line */}
            {selectedRoom && availableDurations.length > 0 && (
              <div className="wir-row wir-row-3" style={{ marginTop: 20 }}>
                <div className="wir-field">
                  <label>Duration</label>
                  <select
                    className="wir-input"
                    value={form.duration}
                    onChange={handleChange("duration")}
                  >
                    {availableDurations.map((slot) => (
                      <option key={slot.value} value={slot.value}>
                        {slot.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="wir-field">
                  <label>From</label>
                  <select
                    className="wir-input"
                    value={form.startTime}
                    onChange={handleChange("startTime")}
                  >
                    {availableStartTimes.map((t) => (
                      <option key={t.value} value={t.time}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="wir-field">
                  <label>To</label>
                  <input
                    className="wir-input wir-input-readonly"
                    value={form.endTime ? formatTime12(form.endTime) : "--"}
                    readOnly
                    disabled
                  />
                </div>
              </div>
            )}

            <div className="wir-footer">
              <button
                className="wir-confirm-btn"
                onClick={openReview}
                disabled={savingReservation}
              >
                Confirm Booking
              </button>
            </div>
          </div>

          <div className="wir-right-col">
            <div className="wir-quick-note">
              <i className="fa-solid fa-circle-info" />
              <div>
                <div className="wir-note-title">Operating Window</div>
                <div className="wir-note-text">
                  Rooms are only usable <strong>7:00 AM – 8:00 PM</strong>. Each
                  room may have <strong>multiple available time slots</strong> — pick any
                  of them when booking.
                </div>
              </div>
            </div>

            <div className="wir-availability-card">
              <div className="wir-avail-header">
                <span className="wir-avail-title">
                  Availability · 7:00 AM – 8:00 PM
                </span>
                <span className="wir-live-dot" />
              </div>

              {selectedRoom && (
                <div className="wir-room-timeline">
                  <h4>
                    Schedule for{" "}
                    {new Date(`${selectedDate}T00:00:00`).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </h4>
                  {getBusyItemsForRoom(
                    selectedRoom.id,
                    selectedDate,
                    getDayAbbrev(selectedDate),
                  ).length === 0 ? (
                    <div className="timeline-empty">
                      No bookings within operating hours.
                    </div>
                  ) : (
                    getBusyItemsForRoom(
                      selectedRoom.id,
                      selectedDate,
                      getDayAbbrev(selectedDate),
                    ).map((item) => (
                      <div key={item.source + item.startTime} className="timeline-item">
                        <div className="timeline-time">
                          {formatTime12(item.startTime)} - {formatTime12(item.endTime)}
                        </div>
                        <div className="timeline-label">{item.label}</div>
                      </div>
                    ))
                  )}
                </div>
              )}

              <div className="wir-avail-date">
                {new Date(`${selectedDate}T00:00:00`).toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
              </div>

              <div className="wir-avail-list">
                {paginatedLiveAvailability.map((room) => (
                  <div
                    key={room.id}
                    className={`wir-live-room ${
                      room.available ? "available" : "occupied"
                    }`}
                  >
                    <div className="wir-live-top">
                      <div>
                        <div className="wir-live-room-name">{room.roomName}</div>
                        <div className="wir-live-room-type">{room.roomType}</div>
                      </div>
                      <span
                        className={`wir-live-badge ${
                          room.maintenance
                            ? "gray"
                            : room.available
                              ? "green"
                              : "red"
                        }`}
                      >
                        {room.maintenance
                          ? "MAINTENANCE"
                          : room.available
                            ? "AVAILABLE"
                            : "FULLY BOOKED"}
                      </span>
                    </div>

                    <div className="wir-live-bottom">
                      {room.maintenance ? (
                        <strong>Room is under maintenance</strong>
                      ) : room.closed ? (
                        <strong>Operating hours ended (8:00 PM)</strong>
                      ) : room.freeWindows.length === 0 ? (
                        <strong>No available time remaining today</strong>
                      ) : (
                        <div className="wir-live-windows">
                          <span className="wir-live-windows-label">
                            {room.freeWindows.length} available time slot
                            {room.freeWindows.length > 1 ? "s" : ""}
                          </span>
                          <div className="wir-live-window-chips">
                            {room.freeWindows.map((w, i) => (
                              <span key={i} className="wir-live-window-chip">
                                <i className="fa-regular fa-clock"></i>
                                {formatTime12(w.startTime)} –{" "}
                                {formatTime12(w.endTime)}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* PAGINATION — live availability sidebar */}
              {totalLivePages > 1 && (
                <div className="wir-live-pagination">
                  <button
                    type="button"
                    className="wir-live-page-btn"
                    disabled={safeLivePage === 1}
                    onClick={() => setLiveCurrentPage((p) => Math.max(1, p - 1))}
                    aria-label="Previous"
                  >
                    <i className="fa-solid fa-chevron-left"></i>
                  </button>

                  {Array.from({ length: totalLivePages }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={`wir-live-page-btn ${safeLivePage === p ? "active" : ""}`}
                      onClick={() => setLiveCurrentPage(p)}
                    >
                      {p}
                    </button>
                  ))}

                  <button
                    type="button"
                    className="wir-live-page-btn"
                    disabled={safeLivePage === totalLivePages}
                    onClick={() => setLiveCurrentPage((p) => Math.min(totalLivePages, p + 1))}
                    aria-label="Next"
                  >
                    <i className="fa-solid fa-chevron-right"></i>
                  </button>

                  <span className="wir-live-page-info">
                    {liveStartIndex + 1}–{liveEndIndex} of {liveAvailability.length}
                  </span>
                </div>
              )}

              <button
                className="wir-view-btn"
                onClick={() => navigate("/clerk/schedule-view-academic-schedule")}
              >
                View Full Schedule
              </button>
            </div>
          </div>
        </div>

        {showModal && (
          <div className="wir-modal-overlay">
            <div className="wir-modal wir-review-modal">
              <div className="wir-modal-icon">
                <i className="fa-solid fa-clipboard-check" />
              </div>
              <h3 className="wir-modal-title">Review Booking</h3>
              <p className="wir-modal-text">
                Please check the details below before confirming.
              </p>

              <div className="wir-review-group">
                <span className="wir-review-group-title">Requester</span>
                <div className="wir-review-list">
                  <div className="wir-review-row">
                    <span>Type</span>
                    <strong>
                      {form.requesterType === "faculty" ? "Faculty" : "Organization"}
                    </strong>
                  </div>
                  <div className="wir-review-row">
                    <span>
                      {form.requesterType === "faculty"
                        ? "Faculty Name"
                        : "Requester Name"}
                    </span>
                    <strong>{form.requesterName || "—"}</strong>
                  </div>
                  <div className="wir-review-row">
                    <span>
                      {form.requesterType === "faculty"
                        ? "Faculty ID"
                        : "Org. / Student ID"}
                    </span>
                    <strong>{form.requesterId || "—"}</strong>
                  </div>
                  {form.requesterType === "organization" && form.organizationName && (
                    <div className="wir-review-row">
                      <span>Organization</span>
                      <strong>{form.organizationName}</strong>
                    </div>
                  )}
                  <div className="wir-review-row">
                    <span>Purpose</span>
                    <strong>
                      {form.purpose === "Other Activity"
                        ? form.customPurpose || "—"
                        : form.purpose || "—"}
                    </strong>
                  </div>
                  {form.requesterType === "faculty" && form.purpose === "Class" && (
                    <>
                      <div className="wir-review-row">
                        <span>Course</span>
                        <strong>{form.course || "—"}</strong>
                      </div>
                      <div className="wir-review-row">
                        <span>Year / Section / Group</span>
                        <strong>{form.yearSectionGroup || "—"}</strong>
                      </div>
                    </>
                  )}
                  {form.studentRange && (
                    <div className="wir-review-row">
                      <span>Est. Attendees</span>
                      <strong>{form.studentRange} Persons</strong>
                    </div>
                  )}
                </div>
              </div>

              <div className="wir-review-group">
                <span className="wir-review-group-title">Room & Schedule</span>
                <div className="wir-review-list">
                  <div className="wir-review-row">
                    <span>Room</span>
                    <strong>{selectedRoom?.roomName || "—"}</strong>
                  </div>
                  <div className="wir-review-row">
                    <span>Date</span>
                    <strong>{formatDateLong(selectedDate)}</strong>
                  </div>
                  <div className="wir-review-row">
                    <span>Time</span>
                    <strong>
                      {form.startTime ? formatTime12(form.startTime) : "--"} –{" "}
                      {form.endTime ? formatTime12(form.endTime) : "--"}
                    </strong>
                  </div>
                  <div className="wir-review-row">
                    <span>Duration</span>
                    <strong>{formatDurationLabel(form.duration)}</strong>
                  </div>
                </div>
              </div>

              <div className="wir-modal-actions">
                <button
                  className="wir-modal-cancel"
                  onClick={() => setShowModal(false)}
                  disabled={savingReservation}
                >
                  <i className="fa-solid fa-pen"></i> Edit Details
                </button>
                <button
                  className="wir-modal-confirm"
                  disabled={savingReservation}
                  onClick={handleConfirm}
                >
                  {savingReservation ? (
                    <>
                      <span className="small-spinner"></span>
                      Saving...
                    </>
                  ) : (
                    <>
                      <i className="fa-solid fa-check"></i> Confirm Booking
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <Toast
        show={toast.show}
        type={toast.type}
        title={toast.title}
        message={toast.message}
        onClose={() => setToast((prev) => ({ ...prev, show: false }))}
      />
    </div>
  );
}