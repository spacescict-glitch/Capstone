import React, { useEffect, useMemo, useState, useRef } from "react";
import "./admin-dashboard.css";
import { useNavigate } from "react-router-dom";
import { collection, onSnapshot, query, orderBy, limit } from "firebase/firestore";
import { db } from "../../firebase";
import classroomImg from "../../assets/Classroom.jpeg";

const ROOMS_PER_PAGE = 8;

// ═════════════════════════════════════════════════════════════════════
// INLINE SEARCH SELECT — popover with search
// ═════════════════════════════════════════════════════════════════════
function InlineSearchSelect({
  value,
  onChange,
  options = [],
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  icon = "fa-solid fa-door-open",
  emptyText = "No options found",
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapRef = useRef(null);

  useEffect(() => {
    const handle = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const selected = options.find((o) => o.value === value) || null;
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        (o.label || "").toLowerCase().includes(q) ||
        (o.meta || "").toLowerCase().includes(q)
    );
  }, [options, search]);

  const toggle = () => {
    setSearch("");
    setOpen((v) => !v);
  };

  return (
    <div className="ash-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`ash-trigger ${open ? "open" : ""}`}
        onClick={toggle}
      >
        <i className={selected?.icon || icon}></i>
        <span className={`ash-text ${!selected ? "is-placeholder" : ""}`}>
          {selected?.label || placeholder}
        </span>
        <i className={`fa-solid fa-chevron-down ash-caret ${open ? "open" : ""}`}></i>
      </button>

      {open && (
        <div className="ash-popover">
          <span className="ash-arrow"></span>

          <div className="ash-search-wrap">
            <i className="fa-solid fa-magnifying-glass"></i>
            <input
              type="text"
              className="ash-search"
              placeholder={searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            {search && (
              <button
                type="button"
                className="ash-search-clear"
                onClick={() => setSearch("")}
                aria-label="Clear search"
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
            )}
          </div>

          <div className="ash-list">
            {filtered.length === 0 ? (
              <div className="ash-empty">
                <i className="fa-regular fa-face-frown"></i>
                <span>{emptyText}</span>
              </div>
            ) : (
              filtered.map((o) => {
                const isActive = o.value === value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    className={`ash-option ${isActive ? "is-active" : ""}`}
                    onClick={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                  >
                    <div className="ash-option-icon">
                      <i className={o.icon || icon}></i>
                    </div>
                    <div className="ash-option-body">
                      <span className="ash-option-label">{o.label}</span>
                      {o.meta && <span className="ash-option-meta">{o.meta}</span>}
                    </div>
                    {isActive && (
                      <i className="fa-solid fa-circle-check ash-option-check"></i>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────
const getCurrentDay = () => {
  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  return days[new Date().getDay()];
};

const getTodayLocal = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const normalize = (value) => value?.toString().trim().toLowerCase();

const toMinutes = (time) => {
  if (!time) return 0;
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

const format12Hour = (time) => {
  if (!time) return "";
  let [hour, minute] = time.split(":").map(Number);
  const ampm = hour >= 12 ? "PM" : "AM";
  hour %= 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute.toString().padStart(2, "0")} ${ampm}`;
};

// Kunin yung photo URL mula sa iba't-ibang possible fields
const getRoomPhoto = (room) =>
  room?.photoUrl ||
  room?.image ||
  room?.roomPhoto ||
  room?.photo ||
  room?.roomImage ||
  null;

const getActivityIcon = (type) => {
  switch (type) {
    case "success": return "fa-solid fa-circle-check";
    case "edit": return "fa-solid fa-pen";
    case "failed": return "fa-solid fa-circle-xmark";
    default: return "fa-solid fa-circle";
  }
};

const getActivityColor = (type) => {
  switch (type) {
    case "success": return "green";
    case "edit": return "blue";
    case "failed": return "red";
    default: return "gray";
  }
};

const formatTimestamp = (timestamp) => {
  if (!timestamp?.toDate) return "";
  return timestamp.toDate().toLocaleString();
};

// ─── Main Component ──────────────────────────────────────────────────────
export default function AdminDashboard() {
  const navigate = useNavigate();

  const [activeBuilding, setActiveBuilding] = useState("All Buildings");
  const [activeFloor, setActiveFloor] = useState("All Floors");
  const [currentPage, setCurrentPage] = useState(1);

  const [roomsData, setRoomsData] = useState([]);
  const [eventsData, setEventsData] = useState([]);
  const [allReservations, setAllReservations] = useState([]);
  const [releasesData, setReleasesData] = useState([]);
  const [reassignmentsData, setReassignmentsData] = useState([]);

  const [recentActivity, setRecentActivity] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(new Date());

  const [, setTick] = useState(0);
  const [loading, setLoading] = useState(true);

  const today = getTodayLocal();
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const todayAbbrev = getCurrentDay();

  // ─── Listeners ─────────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    const roomUnsubs = [];

    const unsubRooms = onSnapshot(collection(db, "rooms"), (snapshot) => {
      let list = [];

      snapshot.docs.forEach((roomDoc) => {
        const room = roomDoc.data();

        const unsubSchedules = onSnapshot(
          collection(db, "rooms", roomDoc.id, "schedules"),
          (scheduleSnap) => {
            const schedules = scheduleSnap.docs
              .map((doc) => ({ id: doc.id, ...doc.data() }))
              .filter((s) => !s.initialized);

            list = list.filter((r) => r.docId !== roomDoc.id);
            list.push({
              docId: roomDoc.id,
              roomName: room.roomName,
              roomType: room.roomType,
              building: room.building || room.bldg || "",
              floor: room.floor,
              statusField: room.roomStatus,
              image: getRoomPhoto(room),     // ← use helper
              schedules,
            });

            setRoomsData([...list]);
            setLoading(false);
          }
        );
        roomUnsubs.push(unsubSchedules);
      });
    });

    return () => {
      unsubRooms();
      roomUnsubs.forEach((u) => u());
    };
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "events"), (snap) => {
      setEventsData(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "reservationRequests"), (snap) => {
      setAllReservations(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "roomReleases"), (snap) => {
      setReleasesData(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "roomReassignments"), (snap) => {
      const data = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((r) => normalize(r.status) === "approved");
      setReassignmentsData(data);
    });
    return unsub;
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setTick((t) => t + 1);
      setLastUpdated(new Date());
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const q = query(
      collection(db, "activityLogs"),
      orderBy("timestamp", "desc"),
      limit(6)
    );
    const unsub = onSnapshot(q, (snapshot) => {
      const logs = snapshot.docs.map((doc) => {
        const d = doc.data();
        return {
          icon: getActivityIcon(d.actionType),
          color: getActivityColor(d.actionType),
          title: d.action,
          sub: `${d.user} • ${d.target}`,
          time: formatTimestamp(d.timestamp),
        };
      });
      setRecentActivity(logs);
    });
    return () => unsub();
  }, []);

  // ─── Lookups ──────────────────────────────────────────────────────────
  const releaseKeysToday = useMemo(() => {
    return new Set(
      releasesData
        .filter((r) => r.date === today)
        .map((r) => `${r.scheduleId}_${r.date}`)
    );
  }, [releasesData, today]);

  const reassignAwayKeysToday = useMemo(() => {
    return new Set(
      reassignmentsData
        .filter((r) => r.date === today && r.oldRoomId)
        .map((r) => `${r.scheduleId}_${r.date}`)
    );
  }, [reassignmentsData, today]);

  const reassignIntoByRoom = useMemo(() => {
    const map = {};
    reassignmentsData
      .filter((r) => r.date === today && r.newRoomId)
      .forEach((r) => {
        if (!map[r.newRoomId]) map[r.newRoomId] = [];
        map[r.newRoomId].push(r);
      });
    return map;
  }, [reassignmentsData, today]);

  // ─── Compute rooms ────────────────────────────────────────────────────
  const rooms = useMemo(() => {
    return roomsData.map((r) => {
      if (normalize(r.statusField) === "maintenance") {
        return {
          id: r.docId,
          roomName: r.roomName,
          roomType: r.roomType,
          building: r.building,
          floor: r.floor,
          image: r.image,
          status: "maintenance",
          liveMessage: "Under Maintenance",
          currentSubject: "",
        };
      }

      const filteredSchedules = r.schedules.filter((s) => {
        const key = `${s.id}_${today}`;
        return !releaseKeysToday.has(key) && !reassignAwayKeysToday.has(key);
      });

      const busyItems = [];

      filteredSchedules
        .filter((s) => s.day === todayAbbrev)
        .forEach((s) => {
          busyItems.push({
            startTime: s.startTime,
            endTime: s.endTime,
            label: s.section ? `${s.subject} • ${s.section}` : s.subject,
            source: "schedule",
          });
        });

      eventsData
        .filter((e) => e.roomId === r.docId && e.date === today)
        .forEach((e) => {
          busyItems.push({
            startTime: e.startTime,
            endTime: e.endTime,
            label: e.title || e.purpose || "Room Activity",
            source: "event",
          });
        });

      const approvedReservations = allReservations.filter(
        (res) =>
          res.roomId === r.docId &&
          res.date === today &&
          normalize(res.status) === "approved"
      );

      approvedReservations.forEach((res) => {
        busyItems.push({
          startTime: res.startTime,
          endTime: res.endTime,
          label: res.customPurpose || res.courseTitle || res.purpose || "Reservation",
          source: "reservation",
        });
      });

      (reassignIntoByRoom[r.docId] || []).forEach((re) => {
        busyItems.push({
          startTime: re.startTime,
          endTime: re.endTime,
          label: `${re.courseTitle || "Class"} (Moved)`,
          source: "reassignment",
        });
      });

      busyItems.sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));

      let status = "free";
      let message = "Available all day";
      let currentSubject = "";
      let foundStatus = false;
      let previousEndTime = null;

      for (const item of busyItems) {
        const start = toMinutes(item.startTime);
        const end = toMinutes(item.endTime);

        if (currentMinutes >= start && currentMinutes < end) {
          status = "occupied";
          message = `Occupied until ${format12Hour(item.endTime)}`;
          currentSubject = item.label;
          foundStatus = true;
          break;
        }

        if (currentMinutes < start) {
          status = "free";
          currentSubject = "";
          if (previousEndTime) {
            message = `Available from ${format12Hour(previousEndTime)} to ${format12Hour(item.startTime)}`;
          } else {
            message = `Available until ${format12Hour(item.startTime)}`;
          }
          foundStatus = true;
          break;
        }

        previousEndTime = item.endTime;
      }

      if (!foundStatus) {
        status = "free";
        currentSubject = "";
        if (previousEndTime) {
          message = `Available from ${format12Hour(previousEndTime)} onwards`;
        } else {
          message = "Available all day";
        }
      }

      return {
        id: r.docId,
        roomName: r.roomName,
        roomType: r.roomType,
        building: r.building,
        floor: r.floor,
        image: r.image,
        status,
        liveMessage: message,
        currentSubject,
      };
    });
  }, [
    roomsData,
    eventsData,
    allReservations,
    releasesData,
    reassignmentsData,
    releaseKeysToday,
    reassignAwayKeysToday,
    reassignIntoByRoom,
    today,
    todayAbbrev,
    currentMinutes,
  ]);

  // ─── Stats ─────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    let occupied = 0, available = 0, maintenance = 0;
    rooms.forEach((r) => {
      if (r.status === "occupied") occupied++;
      else if (r.status === "maintenance") maintenance++;
      else available++;
    });

    const pending = allReservations.filter(
      (r) => normalize(r.status) === "pending"
    ).length;

    const roomActivitiesToday = eventsData.filter((e) => e.date === today).length;

    return {
      totalRooms: rooms.length,
      occupied,
      available,
      maintenance,
      pending,
      roomActivitiesToday,
    };
  }, [rooms, allReservations, eventsData, today]);

  // ─── Dynamic filter options ────────────────────────────────────────────
  const buildingOptions = useMemo(() => {
    const set = new Set(
      roomsData.map((r) => (r.building || "").trim()).filter(Boolean)
    );
    return ["All Buildings", ...Array.from(set).sort()];
  }, [roomsData]);

  const floorOptions = useMemo(() => {
    const set = new Set(
      roomsData.map((r) => (r.floor || "").trim()).filter(Boolean)
    );
    const sorted = Array.from(set).sort((a, b) => {
      const na = parseInt(a, 10) || 0;
      const nb = parseInt(b, 10) || 0;
      return na - nb;
    });
    return ["All Floors", ...sorted];
  }, [roomsData]);

  // Filter rooms
  const filteredRooms = useMemo(() => {
    let base = rooms;
    if (activeBuilding !== "All Buildings") {
      base = base.filter(
        (room) => normalize(room.building) === normalize(activeBuilding)
      );
    }
    if (activeFloor !== "All Floors") {
      base = base.filter(
        (room) => normalize(room.floor) === normalize(activeFloor)
      );
    }
    return [...base].sort((a, b) =>
      a.roomName.localeCompare(b.roomName, undefined, { numeric: true })
    );
  }, [rooms, activeBuilding, activeFloor]);

  useEffect(() => {
    setCurrentPage(1);
  }, [activeBuilding, activeFloor]);

  // ─── Pagination ───────────────────────────────────────────────────────
  const totalPages = Math.max(1, Math.ceil(filteredRooms.length / ROOMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const startIdx = (safePage - 1) * ROOMS_PER_PAGE;
  const visibleRooms = filteredRooms.slice(startIdx, startIdx + ROOMS_PER_PAGE);
  const goToPage = (p) => setCurrentPage(Math.max(1, Math.min(totalPages, p)));

  const statTooltips = {
    totalRooms: "Total number of rooms in the system.",
    occupied: "Rooms currently occupied (class, reservation, or room activity).",
    available: "Rooms that are free right now.",
    maintenance: "Rooms under maintenance and not available.",
    pending: "Reservation requests waiting for approval.",
    roomActivitiesToday: "Room activities scheduled for today (created by Department Head).",
  };

  // ─── Picker options ───────────────────────────────────────────────────
  const buildingPickerOptions = useMemo(
    () =>
      buildingOptions.map((b) => ({
        value: b,
        label: b,
        icon:
          b === "All Buildings"
            ? "fa-solid fa-building-columns"
            : "fa-solid fa-building",
      })),
    [buildingOptions]
  );

  const floorPickerOptions = useMemo(
    () =>
      floorOptions.map((f) => ({
        value: f,
        label: f,
        icon:
          f === "All Floors" ? "fa-solid fa-layer-group" : "fa-solid fa-stairs",
      })),
    [floorOptions]
  );

  // ─── Render ────────────────────────────────────────────────────────────
  return (
    <div className="dept-db-dashboard">
      <div className="dept-db-header">
        <div>
          <h1 className="dept-db-title">Admin Dashboard</h1>
          <p className="dept-db-subtitle">
            Monitor room status and system activities.
          </p>
        </div>
      </div>

      {/* STATS */}
      <div className="dept-db-stats-row">
        {[
          { key: "totalRooms", icon: "fa-solid fa-building", label: "Total Rooms", value: stats.totalRooms, color: "orange" },
          { key: "occupied", icon: "fa-solid fa-location-dot", label: "Occupied", value: stats.occupied, color: "red" },
          { key: "available", icon: "fa-solid fa-circle-check", label: "Available", value: stats.available, color: "green" },
          { key: "maintenance", icon: "fa-solid fa-users", label: "Under Maintenance", value: stats.maintenance, color: "gray" },
          { key: "pending", icon: "fa-solid fa-clock", label: "Pending", value: stats.pending, color: "orange" },
          { key: "roomActivitiesToday", icon: "fa-solid fa-calendar-plus", label: "Room Activity", value: stats.roomActivitiesToday, color: "orange" },
        ].map((s) => (
          <div className="dept-db-stat-card" key={s.key} title={statTooltips[s.key] || ""}>
            <div className={`dept-db-stat-icon ${s.color}`}>
              <i className={s.icon}></i>
            </div>
            <p className="dept-db-stat-label">{s.label}</p>
            <h2 className={`dept-db-stat-value ${s.color}`}>{s.value}</h2>
          </div>
        ))}
      </div>

      {/* BOTTOM GRID */}
      <div className="dept-db-bottom-grid">
        {/* ─── LIVE ROOM STATUS PANEL ─── */}
        <div className="dept-db-panel dept-db-room-status-panel">
          <div className="dept-db-panel-header">
            <div className="dept-db-panel-title">
              <i className="fa-solid fa-table-columns"></i>
              <h3>Current Room Status</h3>
            </div>
            <div className="dept-db-legend">
              <span className="dept-db-legend-item green">AVAILABLE</span>
              <span className="dept-db-legend-item red">OCCUPIED</span>
              <span
                className="dept-db-legend-item"
                style={{ background: "#f3f4f6", color: "#6b7280", border: "1px solid #d1d5db" }}
              >
                MAINTENANCE
              </span>
            </div>
          </div>

          {(buildingOptions.length > 1 || floorOptions.length > 1) && (
            <div className="dept-db-filter-inline">
              {buildingOptions.length > 1 && (
                <div className="dept-db-picker-cell">
                  <InlineSearchSelect
                    value={activeBuilding}
                    onChange={setActiveBuilding}
                    options={buildingPickerOptions}
                    placeholder="All Buildings"
                    searchPlaceholder="Search building..."
                    icon="fa-solid fa-building"
                    emptyText="No buildings found"
                  />
                </div>
              )}

              {floorOptions.length > 1 && (
                <div className="dept-db-picker-cell">
                  <InlineSearchSelect
                    value={activeFloor}
                    onChange={setActiveFloor}
                    options={floorPickerOptions}
                    placeholder="All Floors"
                    searchPlaceholder="Search floor..."
                    icon="fa-solid fa-layer-group"
                    emptyText="No floors found"
                  />
                </div>
              )}

              {(activeBuilding !== "All Buildings" || activeFloor !== "All Floors") && (
                <button
                  className="dept-db-filter-clear"
                  onClick={() => {
                    setActiveBuilding("All Buildings");
                    setActiveFloor("All Floors");
                  }}
                >
                  <i className="fa-solid fa-xmark"></i> Clear
                </button>
              )}
            </div>
          )}

          <div className="dept-db-rooms-grid">
            {loading ? (
              <div className="dept-db-loading">
                <div className="spinner"></div>
                Loading rooms...
              </div>
            ) : visibleRooms.length === 0 ? (
              <div className="dept-db-loading">No rooms found.</div>
            ) : (
              visibleRooms.map((room) => (
                <div key={room.id} className={`dept-db-room-card ${room.status}`}>
                  <div className="dept-db-room-card-header">
                    <span className="dept-db-room-id">{room.roomName}</span>
                    <span className={`dept-db-status-dot ${room.status}`}></span>
                  </div>

                  <div className="dept-db-room-card-img">
                    {room.image ? (
                      <img
                        src={room.image}
                        alt={room.roomName}
                        className="dept-db-room-img"
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                          e.currentTarget.parentElement.classList.add(
                            "dept-db-room-img-fallback"
                          );
                        }}
                      />
                    ) : (
                      <div className="dept-db-room-img-fallback">
                        <span>{room.roomName}</span>
                      </div>
                    )}
                  </div>

                  <p className="dept-db-room-type">{room.roomType}</p>

                  <p className={`dept-db-room-label ${room.status}`}>
                    {room.liveMessage}
                  </p>

                  {room.currentSubject && (
                    <small className="dept-db-room-subject">
                      {room.currentSubject}
                    </small>
                  )}
                </div>
              ))
            )}
          </div>

          <p className="dept-db-last-updated">
            Last Updated: {lastUpdated.toLocaleTimeString()}
          </p>

          {totalPages > 1 && (
            <div className="dept-db-pagination">
              <span className="dept-db-page-info">
                Showing {startIdx + 1}–
                {Math.min(startIdx + ROOMS_PER_PAGE, filteredRooms.length)} of{" "}
                {filteredRooms.length} rooms
              </span>
              <div className="dept-db-page-controls">
                <button
                  disabled={safePage === 1}
                  onClick={() => goToPage(safePage - 1)}
                  aria-label="Previous page"
                >
                  <i className="fa-solid fa-chevron-left"></i>
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <button
                    key={p}
                    className={safePage === p ? "active" : ""}
                    onClick={() => goToPage(p)}
                  >
                    {p}
                  </button>
                ))}
                <button
                  disabled={safePage === totalPages}
                  onClick={() => goToPage(safePage + 1)}
                  aria-label="Next page"
                >
                  <i className="fa-solid fa-chevron-right"></i>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ─── RECENT ACTIVITY PANEL ─── */}
        <div className="dept-db-panel dept-db-activity-panel">
          <div className="dept-db-activity-header">
            <i className="fa-solid fa-calendar-days"></i>
            <h3>Recent Activity</h3>
          </div>

          <div className="dept-db-activity-list">
            {recentActivity.length === 0 ? (
              <p className="dept-db-activity-empty">No recent activity.</p>
            ) : (
              recentActivity.map((a, i) => (
                <div className="dept-db-activity-item" key={i}>
                  <div className={`dept-db-activity-icon ${a.color}`}>
                    <i className={a.icon}></i>
                  </div>
                  <div className="dept-db-activity-content">
                    <p className="dept-db-activity-title">{a.title}</p>
                    <p className="dept-db-activity-sub">{a.sub}</p>
                    <span className="dept-db-activity-time">{a.time}</span>
                  </div>
                </div>
              ))
            )}
          </div>
          <button
            className="dept-db-view-all-btn"
            onClick={() => navigate("/admin/activity-log")}
          >
            View All Activity
          </button>
        </div>
      </div>
    </div>
  );
}