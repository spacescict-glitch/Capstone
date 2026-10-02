import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import "./clerk-view-academic-schedule.css";
import LRRoomCard from "../../Components/LRRoomCard/LRRoomCard";
import { isActiveOnDate } from "../../utils/scheduleActivePeriod";
import { collection, onSnapshot } from "firebase/firestore";

import { db } from "../../firebase";

// ─── Time helpers ─────────────────────────────────────────────────────
const timeToMinutes = (time) => {
  if (!time) return 0;
  if (!time.includes(" ")) {
    const [hour, minute] = time.split(":").map(Number);
    return hour * 60 + minute;
  }
  const [clock, period] = time.trim().split(" ");
  let [hour, minute] = clock.split(":").map(Number);
  if (period === "PM" && hour !== 12) hour += 12;
  if (period === "AM" && hour === 12) hour = 0;
  return hour * 60 + minute;
};

const getCurrentMinutes = () => {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
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

const isUnderMaintenance = (roomData) => {
  const roomStatus = String(roomData?.roomStatus || "").trim().toLowerCase();
  return roomStatus === "maintenance";
};

// ─── Latest schedule helpers ─────────────────────────────────────────
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

const getLatestSchedule = (schedules) => {
  if (!schedules || schedules.length === 0) return null;
  return schedules.reduce((best, cur) => {
    const by = schoolYearStart(best.schoolYear);
    const bs = semesterRank(best.semester);
    const cy = schoolYearStart(cur.schoolYear);
    const cs = semesterRank(cur.semester);
    if (cy > by || (cy === by && cs > bs)) return cur;
    return best;
  }, schedules[0]);
};

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
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
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
    month: "long",
    day: "numeric",
    year: "numeric",
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

// ─── Main component ──────────────────────────────────────────────────
function ClerkViewAcademicSchedule() {
  const navigate = useNavigate();

  const [selectedBuilding, setSelectedBuilding] = useState("All Buildings");
  const [selectedFloor, setSelectedFloor] = useState("All Floors");

  const [selectedDate, setSelectedDate] = useState(getToday());
  const [startTime, setStartTime] = useState(getCurrentTime());
  const [endTime, setEndTime] = useState(getCurrentTime());
  const [selectedStatus, setSelectedStatus] = useState("All Status");
  const [showFilterPanel, setShowFilterPanel] = useState(false);

  const [showBuildingPicker, setShowBuildingPicker] = useState(false);
  const [buildingSearch, setBuildingSearch] = useState("");

  const [showDatePicker, setShowDatePicker] = useState(false);
  const [calendarCursor, setCalendarCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const [rooms, setRooms] = useState([]);
  const [roomSchedules, setRoomSchedules] = useState({});
  const [events, setEvents] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [releases, setReleases] = useState([]);
  const [reassignments, setReassignments] = useState([]);
  const [loading, setLoading] = useState(true);

  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);

  const PAGE_SIZE = 8;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => {
    const unsubRooms = onSnapshot(collection(db, "rooms"), (snap) => {
      const data = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      setRooms(data);
      setLoading(false);
    });

    const unsubEvents = onSnapshot(collection(db, "events"), (snap) => {
      setEvents(snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
    });

    const unsubReservations = onSnapshot(
      collection(db, "reservationRequests"),
      (snap) => {
        const data = snap.docs
          .map((doc) => ({ id: doc.id, ...doc.data() }))
          .filter((r) => String(r.status || "").toLowerCase() === "approved");
        setReservations(data);
      }
    );

    const unsubReleases = onSnapshot(collection(db, "roomReleases"), (snap) => {
      setReleases(snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
    });

    const unsubReassignments = onSnapshot(
      collection(db, "roomReassignments"),
      (snap) => {
        const data = snap.docs
          .map((doc) => ({ id: doc.id, ...doc.data() }))
          // ✅ Now matches both "approved" AND "accepted"
          .filter((r) => isApprovedReassignment(r.status));
        setReassignments(data);
      }
    );

    return () => {
      unsubRooms();
      unsubEvents();
      unsubReservations();
      unsubReleases();
      unsubReassignments();
    };
  }, []);

  useEffect(() => {
    if (rooms.length === 0) return;

    const unsubs = rooms.map((room) =>
      onSnapshot(
        collection(db, "rooms", room.id, "schedules"),
        (snap) => {
          const list = snap.docs
            .map((d) => ({ id: d.id, ...d.data() }))
            .filter((s) => !s.initialized);
          setRoomSchedules((prev) => ({
            ...prev,
            [room.id]: list,
          }));
        }
      )
    );

    return () => unsubs.forEach((u) => u());
  }, [rooms.map((r) => r.id).join(",")]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [
    selectedBuilding,
    selectedFloor,
    selectedStatus,
    selectedDate,
    startTime,
    endTime,
  ]);

  const buildingOptions = useMemo(() => {
    const set = new Set();
    rooms.forEach((r) => r.building && set.add(r.building));
    return ["All Buildings", ...Array.from(set).sort()];
  }, [rooms]);

  const filteredBuildings = useMemo(() => {
    const q = buildingSearch.trim().toLowerCase();
    if (!q) return buildingOptions;
    return buildingOptions.filter((b) => String(b).toLowerCase().includes(q));
  }, [buildingOptions, buildingSearch]);

  const floorOptions = useMemo(() => {
    const set = new Set();
    rooms
      .filter(
        (r) =>
          selectedBuilding === "All Buildings" ||
          r.building === selectedBuilding
      )
      .forEach((r) => r.floor && set.add(r.floor));
    return ["All Floors", ...Array.from(set).sort()];
  }, [rooms, selectedBuilding]);

  useEffect(() => {
    if (!floorOptions.includes(selectedFloor)) {
      setSelectedFloor("All Floors");
    }
  }, [floorOptions, selectedFloor]);

  const computedRooms = useMemo(() => {
    const todayDay = new Date(selectedDate + "T00:00:00")
      .toLocaleDateString("en-US", { weekday: "short" })
      .toUpperCase();

    const selectedDateStr = selectedDate;

    const nowMinutes = getCurrentMinutes();
    let windowStart = startTime
      ? timeToMinutes(startTime)
      : endTime
      ? timeToMinutes(endTime)
      : nowMinutes;
    let windowEnd = endTime
      ? timeToMinutes(endTime)
      : startTime
      ? timeToMinutes(startTime)
      : nowMinutes;
    if (windowStart > windowEnd) {
      [windowStart, windowEnd] = [windowEnd, windowStart];
    }

    const overlaps = (startMin, endMin) =>
      startMin <= windowEnd && endMin >= windowStart;

    const releaseKeysForDate = new Set(
      releases
        .filter((r) => r.date === selectedDate)
        .map((r) => `${r.scheduleId}_${r.date}`)
    );

    const reassignAwayKeysForDate = new Set(
      reassignments
        .filter((r) => r.date === selectedDate && r.oldRoomId)
        .map((r) => `${r.scheduleId}_${r.date}`)
    );

    const reassignIntoByRoom = reassignments
      .filter((r) => r.date === selectedDate && r.newRoomId)
      .reduce((acc, r) => {
        if (!acc[r.newRoomId]) acc[r.newRoomId] = [];
        acc[r.newRoomId].push(r);
        return acc;
      }, {});

    return rooms
      .map((room) => {
        const maintenance = isUnderMaintenance(room);
        const schedules = roomSchedules[room.id] || [];

        const activeSchedules = schedules.filter((s) =>
          isActiveOnDate(s, selectedDateStr)
        );
        const latestSchedule =
          getLatestSchedule(activeSchedules) || getLatestSchedule(schedules);

        let occupied = false;
        let occupiedUntil = "";
        let currentSchedule = null;

        const daySchedules = schedules.filter(
          (s) =>
            !s.initialized &&
            s.day?.toUpperCase() === todayDay &&
            isActiveOnDate(s, selectedDateStr) &&
            !releaseKeysForDate.has(`${s.id}_${selectedDate}`) &&
            !reassignAwayKeysForDate.has(`${s.id}_${selectedDate}`)
        );

        for (const sched of daySchedules) {
          const start = timeToMinutes(sched.startTime);
          const end = timeToMinutes(sched.endTime);
          if (overlaps(start, end)) {
            occupied = true;
            occupiedUntil = sched.endTime;
            currentSchedule = sched;
            break;
          }
        }

        if (!occupied) {
          const roomEvents = events.filter(
            (e) => e.roomId === room.id && e.date === selectedDate
          );
          for (const e of roomEvents) {
            const start = timeToMinutes(e.startTime);
            const end = timeToMinutes(e.endTime);
            if (overlaps(start, end)) {
              occupied = true;
              occupiedUntil = e.endTime;
              currentSchedule = e;
              break;
            }
          }
        }

        if (!occupied) {
          const roomReservations = reservations.filter(
            (r) => r.roomId === room.id && r.date === selectedDate
          );
          for (const r of roomReservations) {
            const start = timeToMinutes(r.startTime);
            const end = timeToMinutes(r.endTime);
            if (overlaps(start, end)) {
              occupied = true;
              occupiedUntil = r.endTime;
              currentSchedule = r;
              break;
            }
          }
        }

        if (!occupied) {
          const reassignInto = reassignIntoByRoom[room.id] || [];
          for (const item of reassignInto) {
            const start = timeToMinutes(item.startTime);
            const end = timeToMinutes(item.endTime);
            if (overlaps(start, end)) {
              occupied = true;
              occupiedUntil = item.endTime;
              currentSchedule = item;
              break;
            }
          }
        }

        const status = maintenance
          ? "Under Maintenance"
          : occupied
          ? "Occupied"
          : "Available";

        return {
          id: room.id,
          ...room,
          status,
          latestSchedule,
          currentSchedule,
        };
      })
      .filter((room) => {
        if (
          selectedBuilding !== "All Buildings" &&
          room.building !== selectedBuilding
        )
          return false;
        if (selectedFloor !== "All Floors" && room.floor !== selectedFloor)
          return false;
        if (selectedStatus !== "All Status" && room.status !== selectedStatus)
          return false;
        return true;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rooms,
    roomSchedules,
    events,
    reservations,
    releases,
    reassignments,
    selectedBuilding,
    selectedFloor,
    selectedStatus,
    selectedDate,
    startTime,
    endTime,
    nowTick,
  ]);

  const visibleRooms = computedRooms.slice(0, visibleCount);
  const hasMore = visibleCount < computedRooms.length;

  const loadMore = () => {
    setVisibleCount((prev) => prev + PAGE_SIZE);
  };

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

  return (
    <div className="clerk-academic-schedule">
      <div className="lr-page-header">
        <h1>Academic Schedule</h1>
        <p>
          View classroom schedules by building, floor, date, and time. Status
          updates automatically in real time.
        </p>
      </div>

      <div className="white-box-rooms">
        <div className="building-floor-filter">
          <div className="filter-group building-group">
            <label className="filter-label">Building</label>

            <div className="cvas-buildingpicker">
              <button
                type="button"
                className={`cvas-building-trigger ${
                  showBuildingPicker ? "open" : ""
                }`}
                onClick={() => {
                  setBuildingSearch("");
                  setShowBuildingPicker((v) => !v);
                }}
              >
                <i className="fa-solid fa-building"></i>
                <span className="cvas-building-trigger-text">
                  {selectedBuilding || "All Buildings"}
                </span>
                <i
                  className={`fa-solid fa-chevron-down cvas-building-caret ${
                    showBuildingPicker ? "open" : ""
                  }`}
                ></i>
              </button>

              {showBuildingPicker && (
                <>
                  <div
                    className="cvas-picker-clickaway"
                    onClick={() => setShowBuildingPicker(false)}
                  ></div>
                  <div className="cvas-building-popover">
                    <span className="cvas-popover-arrow"></span>

                    <div className="cvas-search-wrap">
                      <i className="fa-solid fa-magnifying-glass"></i>
                      <input
                        type="text"
                        className="cvas-search"
                        placeholder="Search building..."
                        value={buildingSearch}
                        onChange={(e) => setBuildingSearch(e.target.value)}
                        autoFocus
                      />
                      {buildingSearch && (
                        <button
                          type="button"
                          className="cvas-search-clear"
                          onClick={() => setBuildingSearch("")}
                        >
                          <i className="fa-solid fa-xmark"></i>
                        </button>
                      )}
                    </div>

                    <div className="cvas-building-list">
                      {filteredBuildings.length === 0 ? (
                        <div className="cvas-picker-empty">
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
                              className={`cvas-building-option ${
                                isActive ? "is-active" : ""
                              }`}
                              onClick={() => {
                                setSelectedBuilding(b);
                                setSelectedFloor("All Floors");
                                setShowBuildingPicker(false);
                                setBuildingSearch("");
                              }}
                            >
                              <div className="cvas-building-option-icon">
                                <i className="fa-solid fa-building"></i>
                              </div>
                              <span className="cvas-building-option-name">
                                {b}
                              </span>
                              {isActive && (
                                <i className="fa-solid fa-circle-check cvas-building-option-check"></i>
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

        <div className="active-filter-chips">
          <span className="filter-chip">
            <i className="fa-regular fa-calendar"></i>
            {selectedDate}
          </span>
          <span className="filter-chip">
            <i className="fa-regular fa-clock"></i>
            {startTime || "--:--"} – {endTime || "--:--"}
          </span>
          <span className="filter-chip">
            <i className="fa-solid fa-circle-info"></i>
            {selectedStatus}
          </span>
        </div>

        <div className="lr-room-cards">
          {loading ? (
            <div className="room-empty">
              <i className="fa-solid fa-spinner fa-spin"></i>
              <h2>Loading Rooms</h2>
              <p>Please wait while we retrieve available rooms.</p>
            </div>
          ) : computedRooms.length === 0 ? (
            <div className="room-empty">
              <i className="fa-regular fa-building"></i>
              <h2>No Rooms Found</h2>
              <p>No rooms match the selected filters.</p>
            </div>
          ) : (
            visibleRooms.map((room) => (
              <LRRoomCard
                key={room.id}
                roomName={room.roomName}
                photoUrl={room.photoUrl}
                floor={room.floor}
                capacity={room.capacity}
                roomType={room.roomType}
                equipment={room.equipment}
                status={room.status}
                latestSchedule={room.latestSchedule}
                currentSchedule={room.currentSchedule}
                onClick={() =>
                  navigate("/clerk/schedule-room-card", {
                    state: { roomId: room.id, room },
                  })
                }
              />
            ))
          )}
        </div>

        {!loading && hasMore && (
          <div className="load-more-schedule">
            <button className="load-more-btn-sched" onClick={loadMore}>
              Load More ({computedRooms.length - visibleCount} remaining)
            </button>
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
                <div className="cvas-datepicker">
                  <button
                    type="button"
                    className={`cvas-date-trigger ${
                      showDatePicker ? "open" : ""
                    }`}
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
                    <span>
                      {selectedDate
                        ? formatDateLong(selectedDate)
                        : "Select a date"}
                    </span>
                    <i
                      className={`fa-solid fa-chevron-down cvas-date-caret ${
                        showDatePicker ? "open" : ""
                      }`}
                    ></i>
                  </button>

                  {showDatePicker && (
                    <>
                      <div
                        className="cvas-picker-clickaway"
                        onClick={() => setShowDatePicker(false)}
                      ></div>
                      <div className="cvas-date-popover">
                        <span className="cvas-popover-arrow"></span>

                        <div className="cvas-cal-header">
                          <button
                            type="button"
                            className="cvas-cal-nav"
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
                          <span className="cvas-cal-title">
                            {MONTH_NAMES[calendarCursor.month]}{" "}
                            {calendarCursor.year}
                          </span>
                          <button
                            type="button"
                            className="cvas-cal-nav"
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

                        <div className="cvas-cal-weekdays">
                          {WEEKDAY_LABELS.map((w) => (
                            <span key={w}>{w}</span>
                          ))}
                        </div>

                        <div className="cvas-cal-grid">
                          {buildCalendarGrid(
                            calendarCursor.year,
                            calendarCursor.month
                          ).map((cell, i) => {
                            const cellStr = toDateInputValue(cell.date);
                            const isSelected = cellStr === selectedDate;
                            return (
                              <button
                                type="button"
                                key={i}
                                className={[
                                  "cvas-cal-day",
                                  !cell.inMonth && "is-outside",
                                  isSelected && "is-selected",
                                ]
                                  .filter(Boolean)
                                  .join(" ")}
                                onClick={() => {
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
  );
}

export default ClerkViewAcademicSchedule;