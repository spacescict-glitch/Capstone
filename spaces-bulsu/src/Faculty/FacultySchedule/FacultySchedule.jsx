// ============================================================
// FILE: FacultySchedule.jsx
// - Realtime via onSnapshot
// - Compact 12-hour time format
// - Respects room-schedule activation windows
// - Online classes tied to the active term
// - Mid-class release preserves elapsed time (effectiveEndTime)
// - ✅ NEW: Reassignments & Reservations can also be released
// ============================================================
import { useEffect, useMemo, useState, useRef } from "react";
import "./faculty-schedule.css";
import ReleaseRoomModal from "../../Components/ReleaseRoomModal/ReleaseRoomModal";
import ScheduleDetailsModal from "../../Components/ScheduleDetailsModal/ScheduleDetailsModal";
import ImportScheduleModal from "./ImportScheduleModal";
import Toast from "../../Popup/Toast/Toast";
import { auth, db } from "../../firebase";
import {
  collection,
  getDocs,
  doc,
  getDoc,
  addDoc,
  query,
  where,
  serverTimestamp,
  onSnapshot,
} from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { logActivity } from "../../utils/logActivity";
import { isActiveOnDate } from "../../utils/scheduleActivePeriod";

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const START_HOUR = 7;
const END_HOUR = 21;
const HOUR_HEIGHT = 60;

const CARD_COLORS = [
  { bg: "#EEF2FF", border: "#4F6EF7", text: "#3651D4", timeBg: "#C7D0FA" },
  { bg: "#ECFDF5", border: "#34C77B", text: "#1A9E5C", timeBg: "#A7F0CC" },
  { bg: "#FFF7ED", border: "#F97316", text: "#C2621A", timeBg: "#FDD9B5" },
  { bg: "#F5F3FF", border: "#8B5CF6", text: "#6D28D9", timeBg: "#DDD6FE" },
  { bg: "#F3E8FF", border: "#c38af8", text: "#7E22CE", timeBg: "#E9D5FF" },
];

const LEGEND = [
  { label: "Academic", color: "#4F6EF7" },
  { label: "Room Activity", color: "#34C77B" },
  { label: "Reservation", color: "#F97316" },
  { label: "Reassigned", color: "#8B5CF6" },
  { label: "Online", color: "#c38af8" },
];

// ✅ Kinds na pwedeng i-release (hindi lang schedule)
const RELEASABLE_KINDS = new Set(["schedule", "reassignment", "reservation"]);

// ─── Helpers ──────────────────────────────────────────────────────
const normalizeName = (name = "") =>
  name
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim();

const isApprovedReassignment = (status) =>
  ["approved", "accepted"].includes(String(status || "").toLowerCase());

const semesterRank = (sem = "") => {
  const s = sem.toLowerCase();
  if (s.includes("2nd")) return 2;
  if (s.includes("1st")) return 1;
  return 0;
};

const schoolYearStart = (sy = "") => {
  const match = sy.match(/\d{4}/);
  return match ? parseInt(match[0], 10) : 0;
};

const mondayIndexFromDate = (dateStr) => {
  const d = new Date(`${dateStr}T00:00:00`);
  const jsDay = d.getDay();
  return jsDay === 0 ? 7 : jsDay;
};

const isWithinWeek = (dateStr, start, end) => {
  if (!dateStr) return false;
  const d = new Date(`${dateStr}T00:00:00`);
  return d >= start && d <= end;
};

const parseTimeParts = (time) => {
  const [h, m] = (time || "0:0").split(":").map(Number);
  return [Number.isNaN(h) ? 0 : h, Number.isNaN(m) ? 0 : m];
};

const toDateStr = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const todayStr = () => toDateStr(new Date());

function fmtHour(h) {
  if (h < 12) return `${String(h).padStart(2, "0")} AM`;
  if (h === 12) return `12 PM`;
  return `${String(h - 12).padStart(2, "0")} PM`;
}

const fmtTimeRange = (startH, startM, endH, endM) => {
  const startSuffix = startH >= 12 ? "PM" : "AM";
  const endSuffix = endH >= 12 ? "PM" : "AM";
  const startHh = startH % 12 || 12;
  const endHh = endH % 12 || 12;
  const startStr = `${startHh}:${String(startM).padStart(2, "0")}`;
  const endStr = `${endHh}:${String(endM).padStart(2, "0")}`;
  if (startSuffix === endSuffix) {
    return `${startStr} – ${endStr} ${startSuffix}`;
  }
  return `${startStr} ${startSuffix} – ${endStr} ${endSuffix}`;
};

const fmtTime12Compact = (time) => {
  const [h, m] = parseTimeParts(time);
  const suffix = h >= 12 ? "PM" : "AM";
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, "0")} ${suffix}`;
};

const computeStatus = (dateStr, startTime, endTime) => {
  const today = todayStr();
  if (dateStr < today) return { status: "COMPLETED", remainingMinutes: 0 };
  if (dateStr > today) return { status: "UPCOMING", remainingMinutes: 0 };

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const [sh, sm] = parseTimeParts(startTime);
  const [eh, em] = parseTimeParts(endTime);

  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;

  if (nowMin >= startMin && nowMin < endMin) {
    return { status: "ONGOING", remainingMinutes: endMin - nowMin };
  }
  if (nowMin < startMin) return { status: "UPCOMING", remainingMinutes: 0 };
  return { status: "COMPLETED", remainingMinutes: 0 };
};

const eventsOverlap = (event1, event2) => {
  const getMin = (h, m) => h * 60 + m;
  const start1 = getMin(event1.startH, event1.startM);
  const end1 = getMin(event1.endH, event1.endM);
  const start2 = getMin(event2.startH, event2.startM);
  const end2 = getMin(event2.endH, event2.endM);
  return start1 < end2 && end1 > start2;
};

const notifyReleaseRoom = async ({
  facultyId,
  facultyName,
  roomName,
  subject,
  date,
  startTime,
  endTime,
}) => {
  try {
    const usersSnap = await getDocs(collection(db, "users"));
    const notifications = [];

    usersSnap.forEach((userDoc) => {
      const user = userDoc.data();
      const role = String(user.role || "").toLowerCase();

      let ownerType = "";
      if (role === "clerk") {
        ownerType = "clerk";
      } else if (role === "admin") {
        ownerType = "admin";
      } else {
        return;
      }

      notifications.push(
        addDoc(collection(db, "notifications"), {
          userId: userDoc.id,
          ownerType,
          title: "Room Released",
          message: `${facultyName} released ${roomName} for ${subject} on ${date} (${startTime} - ${endTime}).`,
          type: "room-release",
          roomName,
          subject,
          date,
          startTime,
          endTime,
          unread: true,
          archived: false,
          badge: "NEW",
          createdAt: serverTimestamp(),
        })
      );
    });

    notifications.push(
      addDoc(collection(db, "notifications"), {
        userId: facultyId,
        ownerType: "faculty",
        title: "Room Released",
        message: `You successfully released ${roomName} (${subject}) on ${date} (${startTime} - ${endTime}).`,
        type: "room-release",
        roomName,
        subject,
        date,
        startTime,
        endTime,
        unread: true,
        archived: false,
        badge: "SUCCESS",
        createdAt: serverTimestamp(),
      })
    );

    await Promise.all(notifications);
  } catch (err) {
    console.error("Notification Error:", err);
    throw err;
  }
};

// ═════════════════════════════════════════════════════════════════
// Compute a stable release-key for a given kind + item + date
// ═════════════════════════════════════════════════════════════════
const makeReleaseKey = (kind, id, date) => {
  if (kind === "reassignment") return `reassign_${id}_${date}`;
  if (kind === "reservation") return `resv_${id}_${date}`;
  return `${id}_${date}`; // schedule
};

// ─── MAIN COMPONENT ─────────────────────────────────────────────
export default function WeeklyCalendar() {
  const [weekOffset, setWeekOffset] = useState(0);

  const [loading, setLoading] = useState(true);
  const [noSchedule, setNoSchedule] = useState(false);
  const [activeTerm, setActiveTerm] = useState(null);

  const [scheduleEvents, setScheduleEvents] = useState([]);
  const [facultyOnlineEvents, setFacultyOnlineEvents] = useState([]);
  const [overrideEvents, setOverrideEvents] = useState([]);
  const [reservationEvents, setReservationEvents] = useState([]);
  const [reassignedEvents, setReassignedEvents] = useState([]);
  const [releasedMap, setReleasedMap] = useState(new Map());

  const [releaseTarget, setReleaseTarget] = useState(null);
  const [detailsTarget, setDetailsTarget] = useState(null);
  const [submittingRelease, setSubmittingRelease] = useState(false);

  const [showImportModal, setShowImportModal] = useState(false);

  const [toast, setToast] = useState({
    show: false,
    type: "success",
    title: "",
    message: "",
  });
  const toastTimeoutRef = useRef(null);

  const unsubsRef = useRef([]);
  const myRoomIdsRef = useRef([]);
  const myNameRef = useRef("");

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

  // ════════════════════════════════════════════════════════════════
  // MAIN SETUP
  // ════════════════════════════════════════════════════════════════
  useEffect(() => {
    let isCancelled = false;

    const cleanup = () => {
      unsubsRef.current.forEach((u) => {
        try {
          u();
        } catch (e) {
          /* ignore */
        }
      });
      unsubsRef.current = [];
    };

    const setup = async (user) => {
      if (isCancelled || !user) return;
      cleanup();
      setLoading(true);

      try {
        const userSnap = await getDoc(doc(db, "users", user.uid));
        if (!userSnap.exists()) {
          setLoading(false);
          return;
        }

        const me = userSnap.data();
        const myName = normalizeName(
          `${me.lastName}, ${me.firstName}${
            me.middleInitial ? ` ${me.middleInitial}` : ""
          }`
        );
        myNameRef.current = myName;

        const roomsSnap = await getDocs(collection(db, "rooms"));
        const matchedSchedules = [];

        for (const roomDoc of roomsSnap.docs) {
          const room = { id: roomDoc.id, ...roomDoc.data() };
          const scheduleSnap = await getDocs(
            collection(db, "rooms", roomDoc.id, "schedules")
          );

          scheduleSnap.docs.forEach((d) => {
            const s = d.data();
            if (s.initialized) return;
            if (!s.faculty) return;
            if (normalizeName(s.faculty) === myName) {
              matchedSchedules.push({
                id: d.id,
                ...s,
                roomId: room.id,
                roomName: room.roomName,
                floor: room.floor,
                image: room.image || null,
              });
            }
          });
        }

        if (isCancelled) return;

        let roomIds = [];

        if (matchedSchedules.length > 0) {
          const activeGroup = matchedSchedules.filter(
            (s) => s.isActive === true
          );

          let displaySchedules;
          let displaySem;
          let displaySY;

          if (activeGroup.length > 0) {
            displaySchedules = activeGroup;
            displaySem = activeGroup[0].semester;
            displaySY = activeGroup[0].schoolYear;
          } else {
            const rank = (s) => [
              schoolYearStart(s.schoolYear),
              semesterRank(s.semester),
            ];
            const latest = matchedSchedules.reduce((best, cur) => {
              const [by, bs] = rank(best);
              const [cy, cs] = rank(cur);
              if (cy > by || (cy === by && cs > bs)) return cur;
              return best;
            }, matchedSchedules[0]);

            displaySchedules = matchedSchedules.filter(
              (s) =>
                (s.schoolYear || "") === (latest.schoolYear || "") &&
                (s.semester || "") === (latest.semester || "")
            );
            displaySem = latest.semester;
            displaySY = latest.schoolYear;
          }

          setScheduleEvents(displaySchedules);
          setActiveTerm({ semester: displaySem, schoolYear: displaySY });
          setNoSchedule(false);
          roomIds = [...new Set(displaySchedules.map((s) => s.roomId))];
          myRoomIdsRef.current = roomIds;
        } else {
          setScheduleEvents([]);
          setActiveTerm(null);
          setNoSchedule(true);
          myRoomIdsRef.current = [];
        }

        setLoading(false);

        const unsubOnline = onSnapshot(
          query(
            collection(db, "facultySchedules"),
            where("userId", "==", user.uid)
          ),
          (snap) => {
            setFacultyOnlineEvents(
              snap.docs.map((d) => ({
                id: d.id,
                ...d.data(),
                isOnline: true,
              }))
            );
          },
          (err) => {
            console.warn("Online schedules listener:", err);
            setFacultyOnlineEvents([]);
          }
        );
        unsubsRef.current.push(unsubOnline);

        const unsubEvents = onSnapshot(
          collection(db, "events"),
          (snap) => {
            const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            const mine = all.filter((e) => {
              if (!roomIds.includes(e.roomId)) return false;
              if (e.status === "Cancelled") return false;
              if (String(e.source || "").toLowerCase() === "reservation") {
                return false;
              }
              return true;
            });
            setOverrideEvents(mine);
          },
          (err) => {
            console.warn("Events listener:", err);
            setOverrideEvents([]);
          }
        );
        unsubsRef.current.push(unsubEvents);

        const unsubReservations = onSnapshot(
          collection(db, "reservationRequests"),
          (snap) => {
            const mine = snap.docs
              .map((d) => ({ id: d.id, ...d.data() }))
              .filter((r) => {
                const isOwnerById =
                  r.userId === user.uid || r.createdBy === user.uid;
                const isOwnerByName =
                  normalizeName(r.requesterName || r.facultyName || "") ===
                  myName;
                const isApproved =
                  String(r.status || "").toLowerCase() === "approved";
                return (isOwnerById || isOwnerByName) && isApproved;
              });
            setReservationEvents(mine);
          },
          (err) => {
            console.warn("Reservations listener:", err);
            setReservationEvents([]);
          }
        );
        unsubsRef.current.push(unsubReservations);

        // ✅ Now keys releases by kind so schedules, reassignments,
        //    and reservations each get their own release slot.
        const unsubReleases = onSnapshot(
          query(
            collection(db, "roomReleases"),
            where("releasedBy", "==", user.uid)
          ),
          (snap) => {
            const map = new Map();
            snap.docs.forEach((d) => {
              const r = d.data();

              // Distinguish by releaseType when present
              let key;
              if (r.releaseType === "reassignment" && r.reassignmentId) {
                key = `reassign_${r.reassignmentId}_${r.date}`;
              } else if (r.releaseType === "reservation" && r.reservationId) {
                key = `resv_${r.reservationId}_${r.date}`;
              } else if (r.scheduleId) {
                key = `${r.scheduleId}_${r.date}`;
              } else {
                return; // unknown release kind — skip
              }
              map.set(key, r);
            });
            setReleasedMap(map);
          },
          (err) => {
            console.warn("Releases listener:", err);
            setReleasedMap(new Map());
          }
        );
        unsubsRef.current.push(unsubReleases);

        const unsubReassign = onSnapshot(
          query(
            collection(db, "roomReassignments"),
            where("facultyId", "==", user.uid)
          ),
          (snap) => {
            const myReassignments = snap.docs
              .map((d) => ({ id: d.id, ...d.data() }))
              .filter((r) => isApprovedReassignment(r.status));
            setReassignedEvents(myReassignments);
          },
          (err) => {
            console.warn("Reassignments listener:", err);
            setReassignedEvents([]);
          }
        );
        unsubsRef.current.push(unsubReassign);
      } catch (err) {
        console.error("setup error:", err);
        setLoading(false);
      }
    };

    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (user) setup(user);
    });

    return () => {
      isCancelled = true;
      unsubAuth();
      cleanup();
    };
  }, []);

  // ─── Week computation ──────────────────────────────────────────
  const getStartOfWeek = (date) => {
    const d = new Date(date);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  const baseMonday = getStartOfWeek(new Date());
  const weekStart = new Date(baseMonday);
  weekStart.setDate(baseMonday.getDate() + weekOffset * 7);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);

  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const weekLabel = `${months[weekStart.getMonth()]} ${weekStart.getDate()} - ${weekEnd.getDate()}, ${weekStart.getFullYear()}`;

  const dayDates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d.getDate();
  });

  const todayIdx = (() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    if (now < weekStart || now > weekEnd) return -1;
    return mondayIndexFromDate(toDateStr(now)) - 1;
  })();

  const totalH = (END_HOUR - START_HOUR) * HOUR_HEIGHT;

  // ─── CALENDAR EVENTS ────────────────────────────────────────────
  const calendarEvents = useMemo(() => {
    const items = [];
    const reassignedKeys = new Set(
      reassignedEvents.map((r) => `${r.scheduleId}_${r.date}`)
    );

    // ─── 1) Schedules ───
    const scheduleItems = [];
    scheduleEvents.forEach((s) => {
      const dayIdx = DAYS.indexOf(s.day) + 1;
      if (dayIdx < 1) return;

      const occurrenceDate = new Date(weekStart);
      occurrenceDate.setDate(weekStart.getDate() + (dayIdx - 1));
      const occurrenceDateStr = toDateStr(occurrenceDate);

      if (!isActiveOnDate(s, occurrenceDateStr)) return;
      if (reassignedKeys.has(`${s.id}_${occurrenceDateStr}`)) return;

      const releaseInfo = releasedMap.get(
        makeReleaseKey("schedule", s.id, occurrenceDateStr)
      );
      if (releaseInfo && !releaseInfo.effectiveEndTime) return;

      const [startH, startM] = parseTimeParts(s.startTime);
      let [endH, endM] = parseTimeParts(s.endTime);

      if (releaseInfo?.effectiveEndTime) {
        const [rH, rM] = parseTimeParts(releaseInfo.effectiveEndTime);
        if (rH * 60 + rM <= startH * 60 + startM) return;
        endH = rH;
        endM = rM;
      }

      const colorIdx = s.isOnline ? 4 : 0;

      scheduleItems.push({
        id: `sched-${s.id}-${occurrenceDateStr}`,
        rawId: s.id,
        kind: "schedule",
        scheduleId: s.id,
        roomId: s.roomId,
        roomName: s.roomName,
        image: s.image,
        subject: s.subject,
        section: s.section,
        day: s.day,
        date: occurrenceDateStr,
        rawStartTime: s.startTime,
        rawEndTime: s.endTime,
        title: s.subject || "Class",
        location: `${s.roomName || "-"}${s.floor ? ` | ${s.floor}` : ""}`,
        faculty: s.faculty || "Faculty",
        dayIdx,
        daySpan: 1,
        startH,
        startM,
        endH,
        endM,
        colorIdx,
        isOnline: s.isOnline || false,
        isReleased: !!releaseInfo,
        releasedAtTime: releaseInfo?.effectiveEndTime || null,
      });
    });

    // ─── 2) Room activities (overrides) ───
    const activityItems = [];
    overrideEvents.forEach((e) => {
      if (!isWithinWeek(e.date, weekStart, weekEnd)) return;
      const dayIdx = mondayIndexFromDate(e.date);
      const [startH, startM] = parseTimeParts(e.startTime);
      const [endH, endM] = parseTimeParts(e.endTime);

      let conflictsWithSchedule = false;
      let conflictingSchedule = null;

      for (const s of scheduleItems) {
        if (
          s.dayIdx === dayIdx &&
          eventsOverlap(s, { startH, startM, endH, endM, dayIdx })
        ) {
          conflictsWithSchedule = true;
          conflictingSchedule = s;
          break;
        }
      }

      // ✅ Ipakita lang ang room activity kung may tumamang schedule
      if (!conflictsWithSchedule) return;

      activityItems.push({
        id: `event-${e.id}`,
        kind: "event",
        title: `⚠️ ${e.title || e.purpose || "Room Activity"} — Conflicts with your class`,
        location: `${e.roomName || "-"} | Room Activity`,
        roomName: e.roomName || "-",
        dayIdx,
        daySpan: 1,
        startH,
        startM,
        endH,
        endM,
        colorIdx: 1,
        faculty: e.faculty || "Admin",
        date: e.date,
        rawStartTime: e.startTime,
        rawEndTime: e.endTime,
        conflictsWithSchedule,
        conflictingSchedule,
      });
    });

    const overriddenScheduleIds = new Set();
    for (const activity of activityItems) {
      if (activity.conflictsWithSchedule && activity.conflictingSchedule) {
        overriddenScheduleIds.add(activity.conflictingSchedule.id);
      }
    }

    for (const s of scheduleItems) {
      if (!overriddenScheduleIds.has(s.id)) items.push(s);
    }

    for (const activity of activityItems) items.push(activity);

    // ─── 3) Faculty online classes ───
    facultyOnlineEvents.forEach((s) => {
      if (activeTerm) {
        const sameTerm =
          (s.semester || "") === (activeTerm.semester || "") &&
          (s.schoolYear || "") === (activeTerm.schoolYear || "");
        if (!sameTerm) return;
      }

      const dayIdx = DAYS.indexOf(s.day) + 1;
      if (dayIdx < 1) return;

      const occurrenceDate = new Date(weekStart);
      occurrenceDate.setDate(weekStart.getDate() + (dayIdx - 1));
      const occurrenceDateStr = toDateStr(occurrenceDate);

      const [startH, startM] = parseTimeParts(s.startTime);
      const [endH, endM] = parseTimeParts(s.endTime);

      items.push({
        id: `faculty-online-${s.id}-${occurrenceDateStr}`,
        kind: "faculty-online",
        scheduleId: s.id,
        roomId: null,
        roomName: "Online",
        subject: s.subject,
        section: s.section,
        day: s.day,
        date: occurrenceDateStr,
        rawStartTime: s.startTime,
        rawEndTime: s.endTime,
        title: s.subject || "Online Class",
        location: "Online Class",
        faculty: s.facultyName || "Faculty",
        dayIdx,
        daySpan: 1,
        startH,
        startM,
        endH,
        endM,
        colorIdx: 4,
        isOnline: true,
        isFacultyOnline: true,
      });
    });

    // ─── 4) Reservations (✅ release-aware now) ───
    reservationEvents.forEach((r) => {
      if (!isWithinWeek(r.date, weekStart, weekEnd)) return;
      const dayIdx = mondayIndexFromDate(r.date);
      const [startH, startM] = parseTimeParts(r.startTime);
      let [endH, endM] = parseTimeParts(r.endTime);

      const releaseInfo = releasedMap.get(
        makeReleaseKey("reservation", r.id, r.date)
      );
      // Fully released → hide entirely
      if (releaseInfo && !releaseInfo.effectiveEndTime) return;

      let isReleased = false;
      let releasedAtTime = null;

      if (releaseInfo?.effectiveEndTime) {
        const [rH, rM] = parseTimeParts(releaseInfo.effectiveEndTime);
        if (rH * 60 + rM <= startH * 60 + startM) return;
        endH = rH;
        endM = rM;
        isReleased = true;
        releasedAtTime = releaseInfo.effectiveEndTime;
      } else if (releaseInfo) {
        isReleased = true;
      }

      items.push({
        id: `resv-${r.id}`,
        rawId: r.id,
        kind: "reservation",
        title: r.customPurpose || r.courseTitle || r.purpose || "Reservation",
        subject: r.customPurpose || r.courseTitle || r.purpose || "Reservation",
        section: r.section || r.yearSectionGroup || "",
        location: `${r.roomName || "-"} | Reservation`,
        roomName: r.roomName || "-",
        roomId: r.roomId,
        dayIdx,
        daySpan: 1,
        startH,
        startM,
        endH,
        endM,
        colorIdx: 2,
        faculty: r.facultyName || r.requesterName || "Faculty",
        date: r.date,
        rawStartTime: r.startTime,
        rawEndTime: r.endTime,
        isReleased,
        releasedAtTime,
      });
    });

    // ─── 5) Reassignments (✅ release-aware now) ───
    reassignedEvents.forEach((r) => {
      if (!isWithinWeek(r.date, weekStart, weekEnd)) return;
      const dayIdx = mondayIndexFromDate(r.date);
      const [startH, startM] = parseTimeParts(r.startTime);
      let [endH, endM] = parseTimeParts(r.endTime);

      const releaseInfo = releasedMap.get(
        makeReleaseKey("reassignment", r.id, r.date)
      );
      // Fully released → hide entirely
      if (releaseInfo && !releaseInfo.effectiveEndTime) return;

      let isReleased = false;
      let releasedAtTime = null;

      if (releaseInfo?.effectiveEndTime) {
        const [rH, rM] = parseTimeParts(releaseInfo.effectiveEndTime);
        if (rH * 60 + rM <= startH * 60 + startM) return;
        endH = rH;
        endM = rM;
        isReleased = true;
        releasedAtTime = releaseInfo.effectiveEndTime;
      } else if (releaseInfo) {
        isReleased = true;
      }

      items.push({
        id: `reassign-${r.id}`,
        rawId: r.id,
        kind: "reassignment",
        title: r.courseTitle || "Class",
        subject: r.courseTitle || "Class",
        section: r.section || "",
        location: `${r.newRoomName || "-"} | Reassigned Room`,
        roomName: r.newRoomName || "-",
        roomId: r.newRoomId,
        dayIdx,
        daySpan: 1,
        startH,
        startM,
        endH,
        endM,
        colorIdx: 3,
        faculty: r.facultyName || "Faculty",
        date: r.date,
        rawStartTime: r.startTime,
        rawEndTime: r.endTime,
        originalRoom: r.oldRoomName,
        isReleased,
        releasedAtTime,
      });
    });

    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    scheduleEvents,
    facultyOnlineEvents,
    overrideEvents,
    reservationEvents,
    releasedMap,
    reassignedEvents,
    activeTerm,
    weekStart.getTime(),
    weekEnd.getTime(),
  ]);

  // ─── Click handler ──────────────────────────────────────────────
  const handleEventClick = (ev) => {
    let status = "SCHEDULED";
    if (ev.date && ev.rawStartTime && ev.rawEndTime) {
      const result = computeStatus(ev.date, ev.rawStartTime, ev.rawEndTime);
      status = result.status;
    }

    // ✅ Reassignments & reservations can now be released too
    if (RELEASABLE_KINDS.has(ev.kind)) {
      if (ev.isReleased) {
        setDetailsTarget({ ...ev, status });
        return;
      }
      if (status !== "COMPLETED") {
        openReleaseModal(ev);
        return;
      }
    }
    setDetailsTarget({ ...ev, status });
  };

  const openReleaseModal = (ev) => {
    const { status, remainingMinutes } = computeStatus(
      ev.date,
      ev.rawStartTime,
      ev.rawEndTime
    );

    setReleaseTarget({
      kind: ev.kind,
      rawId: ev.rawId || null,
      scheduleId: ev.scheduleId,
      reassignmentId: ev.kind === "reassignment" ? ev.rawId : null,
      reservationId: ev.kind === "reservation" ? ev.rawId : null,
      roomId: ev.roomId,
      roomName: ev.roomName,
      image: ev.image,
      subject: ev.subject || ev.title || "",
      section: ev.section,
      day: ev.day,
      date: ev.date,
      startTime: ev.rawStartTime,
      endTime: ev.rawEndTime,
      startTimeLabel: fmtTime12Compact(ev.rawStartTime),
      endTimeLabel: fmtTime12Compact(ev.rawEndTime),
      status,
      remainingMinutes,
      faculty: ev.faculty,
      rawStartTime: ev.rawStartTime,
      rawEndTime: ev.rawEndTime,
      title: ev.title || ev.subject,
      originalRoom: ev.originalRoom,
    });
  };

  const handleConfirmRelease = async ({ reason, details }) => {
    if (!releaseTarget) return;

    setSubmittingRelease(true);
    showToast("loading", "Releasing", "Processing room release...");

    try {
      const firebaseUser = auth.currentUser;
      if (!firebaseUser) {
        showToast("error", "Error", "You must be logged in.");
        return;
      }

      const userSnap = await getDoc(doc(db, "users", firebaseUser.uid));
      const me = userSnap.exists() ? userSnap.data() : {};
      const fullName = `${me.firstName || ""} ${me.lastName || ""}`.trim();

      // Mid-class release: keep elapsed time, release remaining
      let effectiveEndTime = null;
      const nowD = new Date();
      const nowMin = nowD.getHours() * 60 + nowD.getMinutes();
      const [rsh, rsm] = parseTimeParts(releaseTarget.rawStartTime);
      const [reh, rem] = parseTimeParts(releaseTarget.rawEndTime);
      const rStartMin = rsh * 60 + rsm;
      const rEndMin = reh * 60 + rem;

      if (nowMin > rStartMin && nowMin < rEndMin) {
        effectiveEndTime = `${String(nowD.getHours()).padStart(
          2,
          "0"
        )}:${String(nowD.getMinutes()).padStart(2, "0")}`;
      }

      // Base payload for roomReleases doc
      const releaseDoc = {
        date: releaseTarget.date,
        day: releaseTarget.day,
        subject: releaseTarget.subject || "",
        section: releaseTarget.section || "",
        startTime: releaseTarget.startTime,
        endTime: releaseTarget.endTime,
        effectiveEndTime,
        faculty: fullName,
        releasedBy: firebaseUser.uid,
        releasedByName: fullName,
        reason,
        details: details || "",
        status: "released",
        releasedAt: serverTimestamp(),
        roomId: releaseTarget.roomId || null,
        roomName: releaseTarget.roomName || null,
        releaseType: releaseTarget.kind || "schedule",
      };

      // Attach the correct ID per kind
      if (releaseTarget.kind === "reassignment") {
        releaseDoc.reassignmentId = releaseTarget.reassignmentId;
      } else if (releaseTarget.kind === "reservation") {
        releaseDoc.reservationId = releaseTarget.reservationId;
      } else {
        releaseDoc.scheduleId = releaseTarget.scheduleId;
      }

      await addDoc(collection(db, "roomReleases"), releaseDoc);

      await notifyReleaseRoom({
        facultyId: firebaseUser.uid,
        facultyName: fullName,
        roomName: releaseTarget.roomName,
        subject: releaseTarget.subject,
        date: releaseTarget.date,
        startTime: releaseTarget.startTime,
        endTime: releaseTarget.endTime,
      });

      try {
        await logActivity({
          user: fullName || "Faculty",
          userId: firebaseUser.uid,
          role: "Faculty",
          action: "Released Room",
          actionType: "UPDATE",
          target: `${releaseTarget.roomName} | ${releaseTarget.subject || ""}`,
          status: "SUCCESS",
          details: {
            kind: releaseTarget.kind,
            reason,
            details,
            effectiveEndTime,
            partiallyReleased: !!effectiveEndTime,
          },
        });
      } catch (logErr) {
        console.error("logActivity failed:", logErr);
      }

      setReleaseTarget(null);
      showToast(
        "success",
        "Success",
        effectiveEndTime
          ? `Room released. Elapsed time up to ${effectiveEndTime} kept.`
          : "Room released successfully! Notifications sent."
      );
    } catch (err) {
      console.error("Release error:", err);
      showToast(
        "error",
        "Error",
        err.message || "Failed to release room. Please try again."
      );
    } finally {
      setSubmittingRelease(false);
    }
  };

  const handleImportSuccess = () => {
    showToast("success", "Schedule Updated", "Your schedule has been updated.");
    window.location.reload();
  };

  // ─── RENDER ──────────────────────────────────────────────────────
  return (
    <>
      <div className="wc-page">
        <div className="wc-page-header">
          <div className="wc-page-header-text">
            <h1>My Schedule</h1>
            <p className="wc-page-subtitle">
              View your weekly class schedule, keep track of your room
              assignments, and release a room for classes you won't be holding.
            </p>
          </div>

          <div className="wc-page-actions">
            <button
              className="wc-import-btn"
              onClick={() => setShowImportModal(true)}
            >
              <i className="fa-solid fa-upload" aria-hidden="true" />
              Import Schedule
            </button>
          </div>
        </div>

        <div className="wc-legend-row">
          <div className="wc-legend">
            {LEGEND.map((l) => (
              <div className="wc-legend-item" key={l.label}>
                <span
                  className="wc-legend-dot"
                  style={{ background: l.color }}
                />
                <span className="wc-legend-label">{l.label}</span>
              </div>
            ))}
          </div>
          {activeTerm && (
            <div className="wc-legend-term">
              {activeTerm.semester} • {activeTerm.schoolYear}
            </div>
          )}
        </div>

        <div className="wc-card">
          <div className="wc-week-nav">
            <i
              className="fa-solid fa-chevron-left"
              onClick={() => setWeekOffset((w) => w - 1)}
            />
            <span className="wc-week-label">{weekLabel}</span>
            <i
              className="fa-solid fa-chevron-right"
              onClick={() => setWeekOffset((w) => w + 1)}
            />
          </div>

          {loading ? (
            <div className="wc-empty-state">
              <i className="fa-solid fa-spinner fa-spin"></i>
              <p>Loading your schedule...</p>
            </div>
          ) : calendarEvents.length === 0 ? (
            <div className="wc-empty-state">
              <i className="fa-regular fa-calendar-xmark"></i>
              <p>No events found for this week.</p>
              <p style={{ fontSize: "14px", marginTop: "8px" }}>
                Click <strong>Import Schedule</strong> to upload your class
                schedule.
              </p>
            </div>
          ) : (
            <div className="wc-scroll-x">
              <div className="wc-scroll-inner">
                <div className="wc-days-header">
                  <div className="wc-time-offset" />
                  {DAYS.map((d, i) => (
                    <div className="wc-day-cell" key={d}>
                      <span className="wc-day-name">{d}</span>
                      <span
                        className={`wc-day-date ${
                          i === todayIdx ? "today" : ""
                        }`}
                      >
                        {dayDates[i]}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="wc-divider" />

                <div className="wc-scroll-area">
                  <div className="wc-grid" style={{ height: totalH }}>
                    <div className="wc-time-col">
                      {Array.from(
                        { length: END_HOUR - START_HOUR },
                        (_, i) => (
                          <div className="wc-time-slot" key={i}>
                            <span>{fmtHour(START_HOUR + i)}</span>
                          </div>
                        )
                      )}
                    </div>

                    <div className="wc-events-layer">
                      {DAYS.map((_, i) => (
                        <div className="wc-day-col" key={i}>
                          {Array.from(
                            { length: END_HOUR - START_HOUR },
                            (_, j) => (
                              <div
                                className="wc-hour-line"
                                key={j}
                                style={{ top: j * HOUR_HEIGHT }}
                              />
                            )
                          )}
                        </div>
                      ))}

                      {calendarEvents.map((ev) => {
                        const color = CARD_COLORS[ev.colorIdx];
                        const topPx =
                          (ev.startH - START_HOUR + ev.startM / 60) *
                          HOUR_HEIGHT;
                        const heightPx =
                          (ev.endH -
                            ev.startH +
                            (ev.endM - ev.startM) / 60) *
                            HOUR_HEIGHT -
                          4;
                        const leftPct = ((ev.dayIdx - 1) / 7) * 100;
                        const widthPct = (ev.daySpan / 7) * 100;

                        // ✅ Reassignments & reservations clickable too
                        const isClickable =
                          RELEASABLE_KINDS.has(ev.kind) &&
                          !ev.isReleased &&
                          computeStatus(
                            ev.date,
                            ev.rawStartTime,
                            ev.rawEndTime
                          ).status !== "COMPLETED";
                        const isOnline = ev.isOnline || false;

                        return (
                          <div
                            key={ev.id}
                            className={`wc-event ${
                              isClickable
                                ? "wc-event--clickable"
                                : "wc-event--viewable"
                            } ${isOnline ? "wc-event--online" : ""} ${
                              ev.isReleased ? "wc-event--released" : ""
                            }`}
                            onClick={() => handleEventClick(ev)}
                            style={{
                              top: topPx,
                              height: Math.max(heightPx, 24),
                              left: `${leftPct}%`,
                              width: `calc(${widthPct}% - 4px)`,
                              backgroundColor: color.bg,
                              borderLeft: `4px solid ${color.border}`,
                              cursor: isClickable ? "pointer" : "default",
                            }}
                          >
                            <div className="wc-event-top">
                              <span
                                className="wc-event-title"
                                style={{ color: color.text }}
                              >
                                {ev.title}
                                {ev.section && (
                                  <span className="wc-event-section">
                                    {" "}
                                    ({ev.section})
                                  </span>
                                )}
                                {isOnline && (
                                  <span className="wc-online-badge">
                                    Online
                                  </span>
                                )}
                                {ev.isReleased && (
                                  <span
                                    className="wc-released-badge"
                                    title={
                                      ev.releasedAtTime
                                        ? `Released at ${ev.releasedAtTime}`
                                        : "Released"
                                    }
                                  >
                                    {ev.releasedAtTime
                                      ? `Released ${ev.releasedAtTime}`
                                      : "Released"}
                                  </span>
                                )}
                              </span>

                              <span
                                className="wc-event-time"
                                style={{
                                  background: color.timeBg,
                                  color: color.text,
                                }}
                              >
                                {fmtTimeRange(
                                  ev.startH,
                                  ev.startM,
                                  ev.endH,
                                  ev.endM
                                )}
                              </span>
                            </div>
                            <span
                              className="wc-event-loc"
                              style={{ color: color.text }}
                            >
                              {ev.location}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <ReleaseRoomModal
        target={releaseTarget}
        onClose={() => setReleaseTarget(null)}
        onConfirm={handleConfirmRelease}
        submitting={submittingRelease}
      />

      <ScheduleDetailsModal
        target={detailsTarget}
        onClose={() => setDetailsTarget(null)}
      />

      <ImportScheduleModal
        show={showImportModal}
        onClose={() => setShowImportModal(false)}
        onSuccess={handleImportSuccess}
      />

      <Toast
        show={toast.show}
        type={toast.type}
        title={toast.title}
        message={toast.message}
        onClose={() => setToast((prev) => ({ ...prev, show: false }))}
      />
    </>
  );
}