import { useState, useEffect, useMemo } from "react";
import "./faculty-room.css";
import RoomCard from "../../Components/RoomCard/RoomCard";
import { useNavigate } from "react-router-dom";
import {
  collection,
  collectionGroup,
  onSnapshot,
  addDoc,
  deleteDoc,
  doc,
  query,
  where,
  serverTimestamp,
} from "firebase/firestore";
import { auth, db } from "../../firebase";
import { isRoomUnderMaintenance } from "../../utils/Roommaintenance";
import { isActiveOnDate } from "../../utils/scheduleActivePeriod";
import Toast from "../../Popup/Toast/Toast";

// ─── Helpers ────────────────────────────────────────────────────
const convertToMinutes = (time) => {
  if (!time) return 0;
  if (!time.includes(" ")) {
    const [h, m] = time.split(":").map(Number);
    return h * 60 + m;
  }
  const [clock, period] = time.trim().split(" ");
  let [h, m] = clock.split(":").map(Number);
  if (period === "PM" && h !== 12) h += 12;
  if (period === "AM" && h === 12) h = 0;
  return h * 60 + m;
};

const getToday = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const getCurrentTime = () => {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
};

const getDayFromDate = (dateStr) => {
  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  return days[new Date(dateStr + "T00:00:00").getDay()];
};

// ✅ Sort rooms alphabetically by roomName (numeric-aware, case-insensitive)
const sortRoomsByName = (list) =>
  [...list].sort((a, b) =>
    (a.roomName || "").localeCompare(b.roomName || "", undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );

// ✅ Accepts BOTH "approved" and "accepted" reassignment statuses.
const isApprovedReassignment = (status) =>
  ["approved", "accepted"].includes(String(status || "").toLowerCase());

const STATUS_OPTIONS = [
  "All Status",
  "Available",
  "Occupied",
  "Under Maintenance",
];

// ─── Date picker helpers ────────────────────────────────────────────
const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const toDateInputValue = (date) => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const formatDateLong = (dateStr) => {
  if (!dateStr) return "-";
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });
};

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

export default function FacultyRoom() {
  const navigate = useNavigate();

  const [selectedBuilding, setSelectedBuilding] = useState("All Buildings");
  const [selectedFloor, setSelectedFloor] = useState("All Floors");

  const [selectedDate, setSelectedDate] = useState(getToday());
  const [startTime, setStartTime] = useState(getCurrentTime());
  const [endTime, setEndTime] = useState(getCurrentTime());
  const [selectedStatus, setSelectedStatus] = useState("All Status");
  const [showFilterPanel, setShowFilterPanel] = useState(false);

  // ── Building picker popover ────────────────────────────────
  const [showBuildingPicker, setShowBuildingPicker] = useState(false);
  const [buildingSearch, setBuildingSearch] = useState("");

  // ── Date picker popover state ──
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [calendarCursor, setCalendarCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const [roomsData, setRoomsData] = useState([]);
  const [schedulesData, setSchedulesData] = useState([]);
  const [eventsData, setEventsData] = useState([]);
  const [reservationsData, setReservationsData] = useState([]);
  const [releasesData, setReleasesData] = useState([]);
  const [reassignmentsData, setReassignmentsData] = useState([]);
  const [loading, setLoading] = useState(true);

  const [myWatches, setMyWatches] = useState([]);
  const [watchBusyRoomId, setWatchBusyRoomId] = useState(null);

  const [toast, setToast] = useState({
    show: false,
    type: "success",
    title: "",
    message: "",
  });
  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    setTimeout(() => setToast((p) => ({ ...p, show: false })), 3500);
  };

  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const unsubs = [];

    unsubs.push(
      onSnapshot(
        collection(db, "rooms"),
        (snap) => {
          setRoomsData(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
          setLoading(false);
        },
        (err) => {
          console.error("rooms listener:", err);
          setLoading(false);
        }
      )
    );

    unsubs.push(
      onSnapshot(
        collectionGroup(db, "schedules"),
        (snap) => {
          setSchedulesData(
            snap.docs.map((d) => ({
              id: d.id,
              roomId: d.ref.parent.parent?.id,
              ...d.data(),
            }))
          );
        },
        (err) => console.error("schedules listener:", err)
      )
    );

    unsubs.push(
      onSnapshot(
        collection(db, "events"),
        (snap) =>
          setEventsData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        (err) => console.error("events listener:", err)
      )
    );

    unsubs.push(
      onSnapshot(
        collection(db, "reservationRequests"),
        (snap) => {
          setReservationsData(
            snap.docs
              .map((d) => ({ id: d.id, ...d.data() }))
              .filter(
                (r) => String(r.status || "").toLowerCase() === "approved"
              )
          );
        },
        (err) => console.error("reservations listener:", err)
      )
    );

    unsubs.push(
      onSnapshot(
        collection(db, "roomReleases"),
        (snap) =>
          setReleasesData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        (err) => console.error("releases listener:", err)
      )
    );

    unsubs.push(
      onSnapshot(
        collection(db, "roomReassignments"),
        (snap) => {
          setReassignmentsData(
            snap.docs
              .map((d) => ({ id: d.id, ...d.data() }))
              // ✅ Now matches both "approved" AND "accepted"
              .filter((r) => isApprovedReassignment(r.status))
          );
        },
        (err) => console.error("reassignments listener:", err)
      )
    );

    return () => unsubs.forEach((u) => u());
  }, []);

  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    const q = query(
      collection(db, "roomAvailabilityWatches"),
      where("userId", "==", uid)
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        setMyWatches(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      },
      (err) => console.error("watches listener:", err)
    );

    return () => unsub();
  }, []);

  const schedulesByRoom = useMemo(() => {
    const map = new Map();
    schedulesData.forEach((s) => {
      if (!s.roomId) return;
      if (!map.has(s.roomId)) map.set(s.roomId, []);
      map.get(s.roomId).push(s);
    });
    return map;
  }, [schedulesData]);

  const buildingOptions = useMemo(() => {
    const set = new Set();
    roomsData.forEach((r) => r.building && set.add(r.building));
    return ["All Buildings", ...Array.from(set).sort()];
  }, [roomsData]);

  // Filtered list of buildings (for the search input inside picker)
  const filteredBuildings = useMemo(() => {
    const q = buildingSearch.trim().toLowerCase();
    if (!q) return buildingOptions;
    return buildingOptions.filter((b) =>
      String(b).toLowerCase().includes(q)
    );
  }, [buildingOptions, buildingSearch]);

  const floorOptions = useMemo(() => {
    const set = new Set();
    roomsData
      .filter(
        (r) =>
          selectedBuilding === "All Buildings" ||
          r.building === selectedBuilding
      )
      .forEach((r) => r.floor && set.add(r.floor));
    return ["All Floors", ...Array.from(set).sort()];
  }, [roomsData, selectedBuilding]);

  useEffect(() => {
    if (!floorOptions.includes(selectedFloor)) {
      setSelectedFloor("All Floors");
    }
  }, [floorOptions, selectedFloor]);

  const isRoomAvailableAt = (roomId, date, sTime, eTime) => {
    const roomData = roomsData.find((r) => r.id === roomId);
    if (!roomData) return false;

    const day = getDayFromDate(date);
    let wStart = convertToMinutes(sTime);
    let wEnd = convertToMinutes(eTime);
    if (wStart > wEnd) [wStart, wEnd] = [wEnd, wStart];

    if (isRoomUnderMaintenance(roomData, date, sTime, eTime)) return false;
    if (
      String(roomData?.roomStatus || "").trim().toLowerCase() === "maintenance"
    ) {
      return false;
    }

    const overlaps = (s, e) => s <= wEnd && e >= wStart;

    const releaseSet = new Set(
      releasesData
        .filter((r) => r.date === date)
        .map((r) => `${r.scheduleId}_${r.date}`)
    );
    const awaySet = new Set(
      reassignmentsData
        .filter((r) => r.date === date && r.oldRoomId === roomId)
        .map((r) => `${r.scheduleId}_${r.date}`)
    );

    const schedules = schedulesByRoom.get(roomId) || [];
    for (const s of schedules) {
      if (s.initialized) continue;
      if (s.day?.toUpperCase() !== day) continue;
      if (!isActiveOnDate(s, date)) continue;
      const key = `${s.id}_${date}`;
      if (releaseSet.has(key)) continue;
      if (awaySet.has(key)) continue;
      if (
        overlaps(convertToMinutes(s.startTime), convertToMinutes(s.endTime))
      ) {
        return false;
      }
    }

    for (const e of eventsData) {
      if (e.roomId !== roomId || e.date !== date) continue;
      if (e.status === "Cancelled") continue;
      if (
        overlaps(convertToMinutes(e.startTime), convertToMinutes(e.endTime))
      ) {
        return false;
      }
    }

    for (const r of reservationsData) {
      if (r.roomId !== roomId || r.date !== date) continue;
      if (
        overlaps(convertToMinutes(r.startTime), convertToMinutes(r.endTime))
      ) {
        return false;
      }
    }

    for (const r of reassignmentsData) {
      if (r.date !== date || r.newRoomId !== roomId) continue;
      if (
        overlaps(convertToMinutes(r.startTime), convertToMinutes(r.endTime))
      ) {
        return false;
      }
    }

    return true;
  };

  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    const activeWatches = myWatches.filter((w) => !w.notified);
    if (activeWatches.length === 0) return;

    activeWatches.forEach(async (watch) => {
      try {
        const available = isRoomAvailableAt(
          watch.roomId,
          watch.date,
          watch.startTime,
          watch.endTime
        );

        if (!available) return;

        await addDoc(collection(db, "notifications"), {
          userId: uid,
          ownerType: "faculty",
          title: "Room Now Available",
          message: `${watch.roomName} is now available for your watched slot on ${watch.date} (${watch.startTime} – ${watch.endTime}). Book it before it's taken!`,
          type: "room-available",
          roomId: watch.roomId,
          roomName: watch.roomName,
          date: watch.date,
          startTime: watch.startTime,
          endTime: watch.endTime,
          unread: true,
          archived: false,
          badge: "NEW",
          createdAt: serverTimestamp(),
        });

        await deleteDoc(doc(db, "roomAvailabilityWatches", watch.id));

        showToast(
          "success",
          "Room Available!",
          `${watch.roomName} is now available. Check your notifications.`
        );
      } catch (err) {
        console.error("Auto-notify error:", err);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    myWatches,
    roomsData,
    schedulesByRoom,
    eventsData,
    reservationsData,
    releasesData,
    reassignmentsData,
    nowTick,
  ]);

  const processedRooms = useMemo(() => {
    if (roomsData.length === 0) return [];

    const selectedDay = getDayFromDate(selectedDate);
    const nowMinutes = convertToMinutes(getCurrentTime());

    let windowStart = startTime
      ? convertToMinutes(startTime)
      : endTime
      ? convertToMinutes(endTime)
      : nowMinutes;
    let windowEnd = endTime
      ? convertToMinutes(endTime)
      : startTime
      ? convertToMinutes(startTime)
      : nowMinutes;
    if (windowStart > windowEnd)
      [windowStart, windowEnd] = [windowEnd, windowStart];

    const overlaps = (startMin, endMin) =>
      startMin <= windowEnd && endMin >= windowStart;

    const releaseMap = new Map();
    releasesData.forEach((data) => {
      if (data.date !== selectedDate) return;
      const key = `${data.scheduleId}_${data.date}`;
      if (!releaseMap.has(data.roomId)) releaseMap.set(data.roomId, new Set());
      releaseMap.get(data.roomId).add(key);
    });

    const reassignAwayMap = new Map();
    const reassignIntoMap = new Map();
    reassignmentsData.forEach((data) => {
      if (data.date !== selectedDate) return;
      const key = `${data.scheduleId}_${data.date}`;
      if (data.oldRoomId) {
        if (!reassignAwayMap.has(data.oldRoomId)) {
          reassignAwayMap.set(data.oldRoomId, new Set());
        }
        reassignAwayMap.get(data.oldRoomId).add(key);
      }
      if (data.newRoomId) {
        if (!reassignIntoMap.has(data.newRoomId)) {
          reassignIntoMap.set(data.newRoomId, []);
        }
        reassignIntoMap.get(data.newRoomId).push(data);
      }
    });

    const result = [];

    roomsData.forEach((roomData) => {
      const roomId = roomData.id;

      const maintenance =
        isRoomUnderMaintenance(roomData, selectedDate, startTime, endTime) ||
        String(roomData?.roomStatus || "").trim().toLowerCase() ===
          "maintenance";

      if (maintenance) {
        result.push({
          ...roomData,
          id: roomId,
          status: "Under Maintenance",
          occupiedUntil: "",
        });
        return;
      }

      let occupied = false;
      let occupiedUntil = "";

      const schedules = schedulesByRoom.get(roomId) || [];
      const releasesForRoom = releaseMap.get(roomId) || new Set();
      const reassignAwayForRoom = reassignAwayMap.get(roomId) || new Set();

      schedules.forEach((sched) => {
        if (sched.initialized) return;
        if (sched.day?.toUpperCase() !== selectedDay) return;
        if (!isActiveOnDate(sched, selectedDate)) return;
        const key = `${sched.id}_${selectedDate}`;
        if (releasesForRoom.has(key)) return;
        if (reassignAwayForRoom.has(key)) return;

        const start = convertToMinutes(sched.startTime);
        const end = convertToMinutes(sched.endTime);
        if (overlaps(start, end)) {
          occupied = true;
          occupiedUntil = sched.endTime;
        }
      });

      if (!occupied) {
        eventsData
          .filter((e) => e.roomId === roomId && e.date === selectedDate)
          .forEach((event) => {
            const start = convertToMinutes(event.startTime);
            const end = convertToMinutes(event.endTime);
            if (overlaps(start, end)) {
              occupied = true;
              occupiedUntil = event.endTime;
            }
          });
      }

      if (!occupied) {
        reservationsData
          .filter((r) => r.roomId === roomId && r.date === selectedDate)
          .forEach((reservation) => {
            const start = convertToMinutes(reservation.startTime);
            const end = convertToMinutes(reservation.endTime);
            if (overlaps(start, end)) {
              occupied = true;
              occupiedUntil = reservation.endTime;
            }
          });
      }

      if (!occupied) {
        const reassignIntoForRoom = reassignIntoMap.get(roomId) || [];
        reassignIntoForRoom.forEach((item) => {
          const start = convertToMinutes(item.startTime);
          const end = convertToMinutes(item.endTime);
          if (overlaps(start, end)) {
            occupied = true;
            occupiedUntil = item.endTime;
          }
        });
      }

      result.push({
        ...roomData,
        id: roomId,
        status: occupied ? "Occupied" : "Available",
        occupiedUntil,
      });
    });

    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    roomsData,
    schedulesByRoom,
    eventsData,
    reservationsData,
    releasesData,
    reassignmentsData,
    selectedDate,
    startTime,
    endTime,
    nowTick,
  ]);

  const filteredRooms = useMemo(() => {
    let list = processedRooms;

    if (selectedBuilding !== "All Buildings") {
      list = list.filter((r) => r.building === selectedBuilding);
    }
    if (selectedFloor !== "All Floors") {
      list = list.filter((r) => r.floor === selectedFloor);
    }
    if (selectedStatus !== "All Status") {
      list = list.filter((r) => r.status === selectedStatus);
    }
    // ✅ Alphabetical order (numeric-aware)
    return sortRoomsByName(list);
  }, [processedRooms, selectedBuilding, selectedFloor, selectedStatus]);

  const clearFilters = () => {
    setSelectedBuilding("All Buildings");
    setSelectedFloor("All Floors");
    setSelectedDate(getToday());
    setStartTime(getCurrentTime());
    setEndTime(getCurrentTime());
    setSelectedStatus("All Status");
  };

  const hasActiveFilters =
    selectedBuilding !== "All Buildings" ||
    selectedFloor !== "All Floors" ||
    selectedStatus !== "All Status";

  const handleToggleWatch = async (room) => {
    const uid = auth.currentUser?.uid;
    if (!uid) {
      showToast("error", "Not Signed In", "Please log in again.");
      return;
    }
    if (watchBusyRoomId) return;

    if (room.status === "Available") {
      showToast("error", "Room Already Available", "This room is already free.");
      return;
    }
    if (room.status === "Under Maintenance") {
      showToast(
        "error",
        "Under Maintenance",
        "You can't watch a room under maintenance."
      );
      return;
    }

    const existing = myWatches.find(
      (w) => w.roomId === room.id && w.date === selectedDate
    );

    setWatchBusyRoomId(room.id);
    try {
      if (existing) {
        await deleteDoc(doc(db, "roomAvailabilityWatches", existing.id));
        showToast(
          "success",
          "Watch Removed",
          `You won't be notified about ${room.roomName}.`
        );
      } else {
        await addDoc(collection(db, "roomAvailabilityWatches"), {
          userId: uid,
          roomId: room.id,
          roomName: room.roomName,
          building: room.building || "",
          floor: room.floor || "",
          date: selectedDate,
          startTime,
          endTime,
          roomStatusAtWatch: room.status,
          notified: false,
          createdAt: serverTimestamp(),
        });
        showToast(
          "success",
          "Watch Added",
          `You'll be notified when ${room.roomName} becomes available on ${selectedDate}.`
        );
      }
    } catch (err) {
      console.error(err);
      showToast("error", "Failed", err.message);
    } finally {
      setWatchBusyRoomId(null);
    }
  };

  return (
    <>
      <div className="faculty-room-container">
        <div className="faculty-room-header">
          <h1>Rooms</h1>
          <p>
            Browse all classrooms and check their availability by
            building, floor, date, and time.
          </p>
        </div>

        <div className="white-box-rooms">
          <div className="building-floor-filter">
            <div className="filter-group building-group">
              <label className="filter-label">Building</label>

              {/* ── BUILDING PICKER ── */}
              <div className="fr-buildingpicker">
                <button
                  type="button"
                  className={`fr-building-trigger ${
                    showBuildingPicker ? "open" : ""
                  }`}
                  onClick={() => {
                    setBuildingSearch("");
                    setShowBuildingPicker((v) => !v);
                  }}
                >
                  <i className="fa-solid fa-building"></i>
                  <span className="fr-building-trigger-text">
                    {selectedBuilding || "All Buildings"}
                  </span>
                  <i
                    className={`fa-solid fa-chevron-down fr-building-caret ${
                      showBuildingPicker ? "open" : ""
                    }`}
                  ></i>
                </button>

                {showBuildingPicker && (
                  <>
                    <div
                      className="fr-picker-clickaway"
                      onClick={() => setShowBuildingPicker(false)}
                    ></div>
                    <div className="fr-building-popover">
                      <span className="fr-popover-arrow"></span>

                      <div className="fr-search-wrap">
                        <i className="fa-solid fa-magnifying-glass"></i>
                        <input
                          type="text"
                          className="fr-search"
                          placeholder="Search building..."
                          value={buildingSearch}
                          onChange={(e) => setBuildingSearch(e.target.value)}
                          autoFocus
                        />
                        {buildingSearch && (
                          <button
                            type="button"
                            className="fr-search-clear"
                            onClick={() => setBuildingSearch("")}
                          >
                            <i className="fa-solid fa-xmark"></i>
                          </button>
                        )}
                      </div>

                      <div className="fr-building-list">
                        {filteredBuildings.length === 0 ? (
                          <div className="fr-picker-empty">
                            <i className="fa-regular fa-face-frown"></i>
                            <span>No buildings match.</span>
                          </div>
                        ) : (
                          filteredBuildings.map((b) => {
                            const isActive = b === selectedBuilding;
                            return (
                              <button
                                type="button"
                                key={b}
                                className={`fr-building-option ${
                                  isActive ? "is-active" : ""
                                }`}
                                onClick={() => {
                                  setSelectedBuilding(b);
                                  setSelectedFloor("All Floors");
                                  setShowBuildingPicker(false);
                                  setBuildingSearch("");
                                }}
                              >
                                <div className="fr-building-option-icon">
                                  <i className="fa-solid fa-building"></i>
                                </div>
                                <span className="fr-building-option-name">
                                  {b}
                                </span>
                                {isActive && (
                                  <i className="fa-solid fa-circle-check fr-building-option-check"></i>
                                )}
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="floor-buttons-lr">
              {floorOptions.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`floor-btn-lr ${
                    selectedFloor === f ? "active" : ""
                  }`}
                  onClick={() => setSelectedFloor(f)}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="room-empty">
              <i className="fa-solid fa-spinner fa-spin"></i>
              <h2>Loading Rooms</h2>
              <p>Please wait while we retrieve available rooms.</p>
            </div>
          ) : filteredRooms.length === 0 ? (
            <div className="room-empty">
              <i className="fa-regular fa-building"></i>
              <h2>No Rooms Found</h2>
              <p>There are no rooms available under the selected filter.</p>
            </div>
          ) : (
            <div className="faculty-room-grid">
              {filteredRooms.map((room) => {
                const isWatched = myWatches.some(
                  (w) => w.roomId === room.id && w.date === selectedDate
                );
                return (
                  <RoomCard
                    key={room.id}
                    room={room}
                    isWatched={isWatched}
                    watchBusy={watchBusyRoomId === room.id}
                    onToggleWatch={() => handleToggleWatch(room)}
                    onViewSchedule={() =>
                      navigate("/faculty/view-room", { state: { room } })
                    }
                    onReserve={() => {
                      if (room.status === "Under Maintenance") return;
                      navigate("/faculty/submit-reservation", {
                        state: { room },
                      });
                    }}
                  />
                );
              })}
            </div>
          )}
        </div>

        <button
          type="button"
          className={`fab-filter-btn ${hasActiveFilters ? "has-active" : ""}`}
          onClick={() => setShowFilterPanel((v) => !v)}
          aria-label="Open filters"
        >
          <i className="fa-solid fa-sliders"></i>
          {hasActiveFilters && <span className="fab-dot" />}
        </button>

        {showFilterPanel && (
          <>
            <div
              className="filter-panel-overlay"
              onClick={() => setShowFilterPanel(false)}
            />
            <div className="filter-panel">
              <div className="filter-panel-header">
                <h3>
                  <i className="fa-solid fa-sliders"></i> Filters
                </h3>
                <button
                  type="button"
                  className="filter-panel-close"
                  onClick={() => setShowFilterPanel(false)}
                >
                  <i className="fa-solid fa-xmark"></i>
                </button>
              </div>

              <div className="filter-panel-body">
                {/* ── DATE PICKER ── */}
                <div className="filter-group">
                  <label className="filter-label">Date</label>
                  <div className="fr-datepicker">
                    <button
                      type="button"
                      className={`fr-date-trigger ${showDatePicker ? "open" : ""}`}
                      onClick={() => {
                        const base = selectedDate
                          ? new Date(`${selectedDate}T00:00:00`)
                          : new Date();
                        setCalendarCursor({
                          year: base.getFullYear(),
                          month: base.getMonth(),
                        });
                        setShowDatePicker((v) => !v);
                      }}
                    >
                      <i className="fa-regular fa-calendar"></i>
                      <span>{selectedDate ? formatDateLong(selectedDate) : "Select a date"}</span>
                      <i
                        className={`fa-solid fa-chevron-down fr-date-caret ${
                          showDatePicker ? "open" : ""
                        }`}
                      ></i>
                    </button>

                    {showDatePicker && (
                      <>
                        <div
                          className="fr-picker-clickaway"
                          onClick={() => setShowDatePicker(false)}
                        ></div>
                        <div className="fr-date-popover">
                          <span className="fr-popover-arrow"></span>

                          <div className="fr-cal-header">
                            <button
                              type="button"
                              className="fr-cal-nav"
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
                            <span className="fr-cal-title">
                              {MONTH_NAMES[calendarCursor.month]} {calendarCursor.year}
                            </span>
                            <button
                              type="button"
                              className="fr-cal-nav"
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

                          <div className="fr-cal-weekdays">
                            {WEEKDAY_LABELS.map((w) => (
                              <span key={w}>{w}</span>
                            ))}
                          </div>

                          <div className="fr-cal-grid">
                            {buildCalendarGrid(
                              calendarCursor.year,
                              calendarCursor.month
                            ).map((cell, i) => {
                              const cellStr = toDateInputValue(cell.date);
                              const isSelected = cellStr === selectedDate;
                              const isPast = cellStr < getToday();

                              return (
                                <button
                                  type="button"
                                  key={i}
                                  disabled={isPast}
                                  className={[
                                    "fr-cal-day",
                                    !cell.inMonth && "is-outside",
                                    isSelected && "is-selected",
                                    isPast && "is-disabled",
                                  ]
                                    .filter(Boolean)
                                    .join(" ")}
                                  onClick={() => {
                                    if (isPast) return;
                                    setSelectedDate(cellStr);
                                    setShowDatePicker(false);
                                  }}
                                >
                                  {cell.day}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="filter-row">
                  <div className="filter-group">
                    <label className="filter-label">Start Time</label>
                    <div className="dropdown-container">
                      <input
                        type="time"
                        className="dropdown time-input"
                        value={startTime}
                        onChange={(e) => setStartTime(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="filter-group">
                    <label className="filter-label">End Time</label>
                    <div className="dropdown-container">
                      <input
                        type="time"
                        className="dropdown time-input"
                        value={endTime}
                        onChange={(e) => setEndTime(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div className="filter-group">
                  <label className="filter-label">Status</label>
                  <div className="status-pills">
                    {STATUS_OPTIONS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={`status-pill ${
                          selectedStatus === s ? "active" : ""
                        }`}
                        onClick={() => setSelectedStatus(s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="filter-panel-footer">
                <button
                  type="button"
                  className="panel-clear-btn"
                  onClick={clearFilters}
                >
                  <i className="fa-solid fa-rotate-left"></i> Clear
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <Toast
        show={toast.show}
        type={toast.type}
        title={toast.title}
        message={toast.message}
        onClose={() => setToast((p) => ({ ...p, show: false }))}
      />
    </>
  );
}