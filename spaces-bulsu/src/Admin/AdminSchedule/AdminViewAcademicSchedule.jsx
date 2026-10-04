import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import "./admin-view-academic-schedule.css";
import LRRoomCard from "../../Components/LRRoomCard/LRRoomCard";
import { isActiveOnDate } from "../../utils/scheduleActivePeriod";
import { collection, collectionGroup, onSnapshot } from "firebase/firestore";
import { db } from "../../firebase";

// ─── Helpers ────────────────────────────────────────────────────
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

// ✅ Sort rooms alphabetically by roomName (numeric-aware: "Room 2" < "Room 10")
const sortRoomsByName = (list) =>
  [...list].sort((a, b) =>
    (a.roomName || "").localeCompare(b.roomName || "", undefined, {
      numeric: true,
      sensitivity: "base",
    }),
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

function AdminViewAcademicSchedule() {
  const navigate = useNavigate();

  const [selectedBuilding, setSelectedBuilding] = useState("All Buildings");
  const [selectedFloor, setSelectedFloor] = useState("All Floors");

  const [selectedDate, setSelectedDate] = useState(getToday());
  const [startTime, setStartTime] = useState(getCurrentTime());
  const [endTime, setEndTime] = useState(getCurrentTime());
  const [selectedStatus, setSelectedStatus] = useState("All Status");
  const [showFilterPanel, setShowFilterPanel] = useState(false);

  // ── Building picker ──
  const [showBuildingPicker, setShowBuildingPicker] = useState(false);
  const [buildingSearch, setBuildingSearch] = useState("");

  // ── Date picker ──
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

  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const unsubs = [];
    unsubs.push(
      onSnapshot(collection(db, "rooms"), (snap) => {
        setRoomsData(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      }, (err) => { console.error("rooms listener:", err); setLoading(false); })
    );
    unsubs.push(
      onSnapshot(collectionGroup(db, "schedules"), (snap) => {
        setSchedulesData(snap.docs.map((d) => ({
          id: d.id, roomId: d.ref.parent.parent?.id, ...d.data(),
        })));
      }, (err) => console.error("schedules listener:", err))
    );
    unsubs.push(
      onSnapshot(collection(db, "events"), (snap) =>
        setEventsData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        (err) => console.error("events listener:", err))
    );
    unsubs.push(
      onSnapshot(collection(db, "reservationRequests"), (snap) =>
        setReservationsData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        (err) => console.error("reservations listener:", err))
    );
    unsubs.push(
      onSnapshot(collection(db, "roomReleases"), (snap) =>
        setReleasesData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        (err) => console.error("releases listener:", err))
    );
    unsubs.push(
      onSnapshot(collection(db, "roomReassignments"), (snap) =>
        setReassignmentsData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        (err) => console.error("reassignments listener:", err))
    );
    return () => unsubs.forEach((u) => u());
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

  const filteredBuildings = useMemo(() => {
    const q = buildingSearch.trim().toLowerCase();
    if (!q) return buildingOptions;
    return buildingOptions.filter((b) => String(b).toLowerCase().includes(q));
  }, [buildingOptions, buildingSearch]);

  const floorOptions = useMemo(() => {
    const set = new Set();
    roomsData
      .filter((r) =>
        selectedBuilding === "All Buildings" || r.building === selectedBuilding
      )
      .forEach((r) => r.floor && set.add(r.floor));
    return ["All Floors", ...Array.from(set).sort()];
  }, [roomsData, selectedBuilding]);

  useEffect(() => {
    if (!floorOptions.includes(selectedFloor)) {
      setSelectedFloor("All Floors");
    }
  }, [floorOptions, selectedFloor]);

  const processedRooms = useMemo(() => {
    if (roomsData.length === 0) return [];

    const selectedDay = new Date(selectedDate + "T00:00:00")
      .toLocaleDateString("en-US", { weekday: "short" })
      .toUpperCase();
    const selectedDateStr = selectedDate;

    const nowMinutes = getCurrentMinutes();
    let windowStart = startTime ? timeToMinutes(startTime) : endTime ? timeToMinutes(endTime) : nowMinutes;
    let windowEnd = endTime ? timeToMinutes(endTime) : startTime ? timeToMinutes(startTime) : nowMinutes;
    if (windowStart > windowEnd) [windowStart, windowEnd] = [windowEnd, windowStart];

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
      // ✅ Accepts "approved" AND "accepted"
      if (!isApprovedReassignment(data.status)) return;
      if (data.date !== selectedDate) return;
      const key = `${data.scheduleId}_${data.date}`;
      if (data.oldRoomId) {
        if (!reassignAwayMap.has(data.oldRoomId)) reassignAwayMap.set(data.oldRoomId, new Set());
        reassignAwayMap.get(data.oldRoomId).add(key);
      }
      if (data.newRoomId) {
        if (!reassignIntoMap.has(data.newRoomId)) reassignIntoMap.set(data.newRoomId, []);
        reassignIntoMap.get(data.newRoomId).push(data);
      }
    });

    const overlaps = (startMin, endMin) => startMin <= windowEnd && endMin >= windowStart;
    const result = [];

    roomsData.forEach((roomData) => {
      const roomId = roomData.id;
      const schedules = schedulesByRoom.get(roomId) || [];
      let occupied = false;
      let occupiedUntil = "";

      const releasesForRoom = releaseMap.get(roomId) || new Set();
      const reassignAwayForRoom = reassignAwayMap.get(roomId) || new Set();

      schedules.forEach((schedule) => {
        if (schedule.initialized) return;
        if (schedule.day?.toUpperCase() !== selectedDay) return;
        if (!isActiveOnDate(schedule, selectedDateStr)) return;
        const key = `${schedule.id}_${selectedDate}`;
        if (releasesForRoom.has(key)) return;
        if (reassignAwayForRoom.has(key)) return;
        const start = timeToMinutes(schedule.startTime);
        const end = timeToMinutes(schedule.endTime);
        if (overlaps(start, end)) { occupied = true; occupiedUntil = schedule.endTime; }
      });

      if (!occupied) {
        eventsData
          .filter((e) => e.roomId === roomId && e.date === selectedDate)
          .forEach((event) => {
            const start = timeToMinutes(event.startTime);
            const end = timeToMinutes(event.endTime);
            if (overlaps(start, end)) { occupied = true; occupiedUntil = event.endTime; }
          });
      }

      if (!occupied) {
        reservationsData
          .filter((res) =>
            res.roomId === roomId &&
            res.date === selectedDate &&
            String(res.status).toLowerCase() === "approved"
          )
          .forEach((reservation) => {
            const start = timeToMinutes(reservation.startTime);
            const end = timeToMinutes(reservation.endTime);
            if (overlaps(start, end)) { occupied = true; occupiedUntil = reservation.endTime; }
          });
      }

      if (!occupied) {
        const reassignIntoForRoom = reassignIntoMap.get(roomId) || [];
        reassignIntoForRoom.forEach((item) => {
          const start = timeToMinutes(item.startTime);
          const end = timeToMinutes(item.endTime);
          if (overlaps(start, end)) { occupied = true; occupiedUntil = item.endTime; }
        });
      }

      const maintenance = isUnderMaintenance(roomData);
      const status = maintenance ? "Under Maintenance" : occupied ? "Occupied" : "Available";

      result.push({ ...roomData, id: roomId, status, occupiedUntil });
    });

    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    roomsData, schedulesByRoom, eventsData, reservationsData,
    releasesData, reassignmentsData, selectedDate, startTime, endTime, nowTick,
  ]);

  const filteredRooms = useMemo(() => {
    let list = processedRooms;
    if (selectedBuilding !== "All Buildings") list = list.filter((r) => r.building === selectedBuilding);
    if (selectedFloor !== "All Floors") list = list.filter((r) => r.floor === selectedFloor);
    if (selectedStatus !== "All Status") list = list.filter((r) => r.status === selectedStatus);
    // ✅ Alphabetical order (numeric-aware)
    return sortRoomsByName(list);
  }, [processedRooms, selectedBuilding, selectedFloor, selectedStatus]);

  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedBuilding, selectedFloor, selectedStatus, selectedDate, startTime, endTime]);

  const totalItems = filteredRooms.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
  const paginatedRooms = filteredRooms.slice(startIndex, endIndex);

  const goToPage = (page) => setCurrentPage(Math.min(Math.max(1, page), totalPages));

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
    <div className="lr-academic-schedule">
      <div className="lr-page-header">
        <h1>Academic Schedule</h1>
        <p>View classroom schedules by building, floor, date, and time.</p>
      </div>

      <div className="white-box-rooms">
        <div className="building-floor-filter">
          <div className="filter-group building-group">
            <label className="filter-label">Building</label>

            {/* BUILDING PICKER */}
            <div className="avs-buildingpicker">
              <button
                type="button"
                className={`avs-building-trigger ${showBuildingPicker ? "open" : ""}`}
                onClick={() => { setBuildingSearch(""); setShowBuildingPicker((v) => !v); }}
              >
                <i className="fa-solid fa-building"></i>
                <span className="avs-building-trigger-text">
                  {selectedBuilding || "All Buildings"}
                </span>
                <i className={`fa-solid fa-chevron-down avs-building-caret ${showBuildingPicker ? "open" : ""}`}></i>
              </button>

              {showBuildingPicker && (
                <>
                  <div className="avs-picker-clickaway" onClick={() => setShowBuildingPicker(false)}></div>
                  <div className="avs-building-popover">
                    <span className="avs-popover-arrow"></span>

                    <div className="avs-search-wrap">
                      <i className="fa-solid fa-magnifying-glass"></i>
                      <input
                        type="text"
                        className="avs-search"
                        placeholder="Search building..."
                        value={buildingSearch}
                        onChange={(e) => setBuildingSearch(e.target.value)}
                        autoFocus
                      />
                      {buildingSearch && (
                        <button type="button" className="avs-search-clear" onClick={() => setBuildingSearch("")}>
                          <i className="fa-solid fa-xmark"></i>
                        </button>
                      )}
                    </div>

                    <div className="avs-building-list">
                      {filteredBuildings.length === 0 ? (
                        <div className="avs-picker-empty">
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
                              className={`avs-building-option ${isActive ? "is-active" : ""}`}
                              onClick={() => {
                                setSelectedBuilding(b);
                                setSelectedFloor("All Floors");
                                setShowBuildingPicker(false);
                                setBuildingSearch("");
                              }}
                            >
                              <div className="avs-building-option-icon">
                                <i className="fa-solid fa-building"></i>
                              </div>
                              <span className="avs-building-option-name">{b}</span>
                              {isActive && <i className="fa-solid fa-circle-check avs-building-option-check"></i>}
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
                className={`floor-btn-lr ${selectedFloor === f ? "active" : ""}`}
                onClick={() => setSelectedFloor(f)}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="lr-room-cards">
          {loading ? (
            <div className="room-empty">
              <i className="fa-solid fa-spinner fa-spin"></i>
              <h2>Loading Rooms</h2>
              <p>Please wait while we retrieve available rooms.</p>
            </div>
          ) : paginatedRooms.length === 0 ? (
            <div className="room-empty">
              <i className="fa-regular fa-building"></i>
              <h2>No Rooms Found</h2>
              <p>No rooms match the selected filters.</p>
            </div>
          ) : (
            paginatedRooms.map((room) => (
              <LRRoomCard
                key={room.id}
                roomName={room.roomName}
                photoUrl={room.photoUrl}      
                floor={room.floor}
                capacity={room.capacity}
                roomType={room.roomType}
                equipment={room.equipment}
                status={room.status}
                onClick={() =>
                  navigate("/admin/schedule-room-card", {
                    state: { roomId: room.id, room },
                  })
                }
              />
            ))
          )}
        </div>

        {!loading && totalItems > 0 && (
          <div className="pagination-schedule">
            <button className="page-btn" disabled={currentPage === 1} onClick={() => goToPage(currentPage - 1)}>
              <i className="fa-solid fa-chevron-left"></i>
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
              <button key={page} className={`page-btn ${page === currentPage ? "active" : ""}`} onClick={() => goToPage(page)}>
                {page}
              </button>
            ))}
            <button className="page-btn" disabled={currentPage === totalPages} onClick={() => goToPage(currentPage + 1)}>
              <i className="fa-solid fa-chevron-right"></i>
            </button>
            <span className="page-info">Showing {startIndex + 1}–{endIndex} of {totalItems}</span>
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
          <div className="filter-panel-overlay" onClick={() => setShowFilterPanel(false)} />
          <div className="filter-panel">
            <div className="filter-panel-header">
              <h3><i className="fa-solid fa-sliders"></i> Filters</h3>
              <button type="button" className="filter-panel-close" onClick={() => setShowFilterPanel(false)}>
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>

            <div className="filter-panel-body">
              {/* DATE PICKER */}
              <div className="filter-group">
                <label className="filter-label">Date</label>
                <div className="avs-datepicker">
                  <button
                    type="button"
                    className={`avs-date-trigger ${showDatePicker ? "open" : ""}`}
                    onClick={() => {
                      const base = selectedDate ? new Date(`${selectedDate}T00:00:00`) : new Date();
                      setCalendarCursor({ year: base.getFullYear(), month: base.getMonth() });
                      setShowDatePicker((v) => !v);
                    }}
                  >
                    <i className="fa-regular fa-calendar"></i>
                    <span>{selectedDate ? formatDateLong(selectedDate) : "Select a date"}</span>
                    <i className={`fa-solid fa-chevron-down avs-date-caret ${showDatePicker ? "open" : ""}`}></i>
                  </button>

                  {showDatePicker && (
                    <>
                      <div className="avs-picker-clickaway" onClick={() => setShowDatePicker(false)}></div>
                      <div className="avs-date-popover">
                        <span className="avs-popover-arrow"></span>

                        <div className="avs-cal-header">
                          <button type="button" className="avs-cal-nav" onClick={() =>
                            setCalendarCursor((c) => {
                              const m = c.month - 1;
                              return m < 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month: m };
                            })}>
                            <i className="fa-solid fa-chevron-left"></i>
                          </button>
                          <span className="avs-cal-title">{MONTH_NAMES[calendarCursor.month]} {calendarCursor.year}</span>
                          <button type="button" className="avs-cal-nav" onClick={() =>
                            setCalendarCursor((c) => {
                              const m = c.month + 1;
                              return m > 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: m };
                            })}>
                            <i className="fa-solid fa-chevron-right"></i>
                          </button>
                        </div>

                        <div className="avs-cal-weekdays">
                          {WEEKDAY_LABELS.map((w) => <span key={w}>{w}</span>)}
                        </div>

                        <div className="avs-cal-grid">
                          {buildCalendarGrid(calendarCursor.year, calendarCursor.month).map((cell, i) => {
                            const cellStr = toDateInputValue(cell.date);
                            const isSelected = cellStr === selectedDate;
                            const isPast = cellStr < getToday();

                            return (
                              <button
                                type="button"
                                key={i}
                                disabled={isPast}
                                className={[
                                  "avs-cal-day",
                                  !cell.inMonth && "is-outside",
                                  isSelected && "is-selected",
                                  isPast && "is-disabled",
                                ].filter(Boolean).join(" ")}
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
                    <input type="time" className="dropdown time-input" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                  </div>
                </div>
                <div className="filter-group">
                  <label className="filter-label">End Time</label>
                  <div className="dropdown-container">
                    <input type="time" className="dropdown time-input" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
                  </div>
                </div>
              </div>

              <div className="filter-group">
                <label className="filter-label">Status</label>
                <div className="status-pills">
                  {STATUS_OPTIONS.map((s) => (
                    <button key={s} type="button"
                      className={`status-pill ${selectedStatus === s ? "active" : ""}`}
                      onClick={() => setSelectedStatus(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="filter-panel-footer">
              <button type="button" className="panel-clear-btn" onClick={clearFilters}>
                <i className="fa-solid fa-rotate-left"></i> Clear
              </button>
        
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default AdminViewAcademicSchedule;