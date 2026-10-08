import { useState, useEffect, useMemo, useRef } from "react";
import "./room-activity.css";
import { db, auth } from "../../firebase";
import Toast from "../../Popup/Toast/Toast";
import {
  collection,
  getDocs,
  doc,
  getDoc,
  updateDoc,
  addDoc,
  serverTimestamp,
  onSnapshot,
} from "firebase/firestore";
import { logActivity } from "../../utils/logActivity";
import { findFacultyUserByName } from "../../utils/findFacultyUser";
import { isActiveOnDate } from "../../utils/scheduleActivePeriod";

const ITEMS_PER_PAGE = 5;

const TABS = [
  { key: "all",           label: "All Requests" },
  { key: "pending_admin", label: "Needs Review" },
  { key: "approved",      label: "Approved" },
];

const SORT_OPTIONS = [
  { key: "newest",    label: "Newest First" },
  { key: "oldest",    label: "Oldest First" },
  { key: "date_asc",  label: "Schedule Date ↑" },
  { key: "date_desc", label: "Schedule Date ↓" },
];

// ─── Time helpers ────────────────────────────────────────────────
const parseTime = (t) => {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
};
const overlap = (aS, aE, bS, bE) => aS < bE && aE > bS;
const normDay = (d) => String(d || "").trim().toUpperCase().slice(0, 3);

const fmt12 = (t) => {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const p = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, "0")} ${p}`;
};
const fmtDate = (d) => {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
};

const toDateInputValue = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};
const todayStr = () => toDateInputValue(new Date());

// ═════════════════════════════════════════════════════════════════════
// ✅ Past date/time checker
// ═════════════════════════════════════════════════════════════════════
const isSlotInPast = (dateStr, startTimeStr) => {
  if (!dateStr) return false;
  const today = todayStr();
  if (dateStr < today) return true;
  if (dateStr > today) return false;
  if (!startTimeStr) return false;
  const startMin = parseTime(startTimeStr);
  if (startMin == null) return false;
  const now = new Date();
  return startMin < now.getHours() * 60 + now.getMinutes();
};

// ═════════════════════════════════════════════════════════════════════
// REASSIGNMENT STATUS HELPERS
// ═════════════════════════════════════════════════════════════════════
const ACCEPTED_REASSIGN_STATUSES = new Set(["accepted", "approved"]);
const isAcceptedReassign = (r) =>
  ACCEPTED_REASSIGN_STATUSES.has(String(r.status || "").toLowerCase());

// ═════════════════════════════════════════════════════════════════════
// ✅ Blocking conflict kinds (existing event or reservation)
// ═════════════════════════════════════════════════════════════════════
const BLOCKING_CONFLICT_KINDS = new Set(["event", "reservation"]);

// ═════════════════════════════════════════════════════════════════════
// RECENCY HELPERS
// ═════════════════════════════════════════════════════════════════════
const toMillis = (v) => {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "object" && typeof v.seconds === "number") {
    return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
  }
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
};

const recencyOf = (item) =>
  toMillis(item?.createdAt) ||
  toMillis(item?.updatedAt) ||
  (item?.date ? new Date(`${item.date}T00:00:00`).getTime() : 0);

// ═════════════════════════════════════════════════════════════════════
// CONFLICT DETECTION
// ═════════════════════════════════════════════════════════════════════
const detectConflicts = async ({ roomId, roomName, date, startTime, endTime }) => {
  if (!roomId || !date || !startTime || !endTime) return [];

  const reqStart = parseTime(startTime);
  const reqEnd = parseTime(endTime);
  if (reqStart == null || reqEnd == null) return [];

  const day = normDay(
    new Date(`${date}T00:00:00`).toLocaleDateString("en-US", {
      weekday: "short",
    })
  );

  const results = [];

  try {
    const [reSnap, schedSnap, evSnap, resSnap, relSnap] = await Promise.all([
      getDocs(collection(db, "roomReassignments")),
      getDocs(collection(db, "rooms", roomId, "schedules")),
      getDocs(collection(db, "events")),
      getDocs(collection(db, "reservationRequests")),
      getDocs(collection(db, "roomReleases")),
    ]);

    const allReassignments = reSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const allSchedules = schedSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const allEvents = evSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const allReservations = resSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const allReleases = relSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const reassignedAwayIds = new Set(
      allReassignments
        .filter(
          (r) =>
            isAcceptedReassign(r) &&
            r.date === date &&
            (r.oldRoomId === roomId || r.oldRoomName === roomName)
        )
        .map((r) => r.scheduleId)
        .filter(Boolean)
    );

    const releaseMap = new Map();
    allReleases
      .filter(
        (r) =>
          r.date === date &&
          (r.roomId === roomId || r.roomName === roomName)
      )
      .forEach((r) => {
        if (r.scheduleId) releaseMap.set(r.scheduleId, r);
      });

    const roomEventsForDate = allEvents.filter(
      (e) =>
        (e.roomId === roomId || e.roomName === roomName) &&
        e.date === date &&
        String(e.status || "").toLowerCase() !== "cancelled"
    );

    // 1) Class schedules
    allSchedules
      .filter((s) => {
        if (s.cancelled || s.initialized) return false;
        if (!isActiveOnDate(s, date)) return false;
        if (normDay(s.day) !== day) return false;
        if (reassignedAwayIds.has(s.id)) return false;

        const sStart = parseTime(s.startTime);
        let sEnd = parseTime(s.endTime);
        if (sStart == null || sEnd == null) return false;

        const release = releaseMap.get(s.id);
        if (release) {
          if (!release.effectiveEndTime) return false;
          const effectiveEnd = parseTime(release.effectiveEndTime);
          if (effectiveEnd == null || effectiveEnd <= sStart) return false;
          sEnd = effectiveEnd;
        }

        if (!overlap(reqStart, reqEnd, sStart, sEnd)) return false;

        const isOverriddenByEvent = roomEventsForDate.some((e) =>
          overlap(sStart, sEnd, parseTime(e.startTime), parseTime(e.endTime))
        );
        return !isOverriddenByEvent;
      })
      .forEach((s) => {
        const release = releaseMap.get(s.id);
        results.push({
          id: s.id,
          kind: "schedule",
          sourceLabel: release ? "Class Schedule (Released Early)" : "Class Schedule",
          subject: s.subject || s.title || "Class",
          section: s.section || "",
          faculty: s.facultyName || s.faculty || "",
          facultyLastName: s.facultyLastName || "",
          facultyFirstName: s.facultyFirstName || "",
          day: s.day,
          startTime: s.startTime,
          endTime: release?.effectiveEndTime || s.endTime,
          isReleased: !!release,
        });
      });

    // 2) Events
    roomEventsForDate
      .filter((e) =>
        overlap(reqStart, reqEnd, parseTime(e.startTime), parseTime(e.endTime))
      )
      .forEach((e) => {
        results.push({
          id: e.id,
          kind: "event",
          sourceLabel: "Room Activity",
          subject: e.title || e.purpose || "Room Activity",
          section: "",
          faculty: e.faculty || e.requestedByName || "Admin",
          day,
          startTime: e.startTime,
          endTime: e.endTime,
        });
      });

    // 3) Approved reservations
    allReservations
      .filter(
        (r) =>
          String(r.status || "").toLowerCase() === "approved" &&
          (r.roomId === roomId || r.roomName === roomName) &&
          r.date === date &&
          overlap(reqStart, reqEnd, parseTime(r.startTime), parseTime(r.endTime))
      )
      .forEach((r) => {
        const isWalkIn =
          String(r.reservationType || "").toLowerCase() === "walk-in";
        results.push({
          id: r.id,
          kind: "reservation",
          sourceLabel: isWalkIn ? "Walk-in Reservation" : "Faculty Reservation",
          subject: r.customPurpose || r.courseTitle || r.purpose || "Reservation",
          section: r.yearSectionGroup || r.attendees?.yearSectionGroup || "",
          faculty: r.requesterName || r.facultyName || "-",
          day,
          startTime: r.startTime,
          endTime: r.endTime,
        });
      });

    // 4) Accepted reassignments INTO this room
    allReassignments
      .filter(
        (r) =>
          isAcceptedReassign(r) &&
          r.date === date &&
          (r.newRoomId === roomId || r.newRoomName === roomName) &&
          overlap(reqStart, reqEnd, parseTime(r.startTime), parseTime(r.endTime))
      )
      .forEach((r) => {
        results.push({
          id: r.id,
          kind: "reassignment",
          sourceLabel: "Reassigned Class",
          subject: r.courseTitle || r.subject || "Class (Moved)",
          section: r.section || "",
          faculty: r.facultyName || "-",
          facultyLastName: r.facultyLastName || "",
          facultyFirstName: r.facultyFirstName || "",
          day,
          startTime: r.startTime,
          endTime: r.endTime,
        });
      });
  } catch (err) {
    console.error("Conflict detection failed:", err);
  }

  results.sort(
    (a, b) => (parseTime(a.startTime) ?? 0) - (parseTime(b.startTime) ?? 0)
  );
  return results;
};

// ═════════════════════════════════════════════════════════════════════
// CALENDAR HELPERS
// ═════════════════════════════════════════════════════════════════════
const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const WEEKDAY_LABELS = ["Su","Mo","Tu","We","Th","Fr","Sa"];

const formatDateLongLocal = (dateStr) => {
  if (!dateStr) return "";
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });
};
const buildCalendarGrid = (year, month) => {
  const first = new Date(year, month, 1);
  const startOffset = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < startOffset; i++) {
    cells.push({
      day: daysInPrev - startOffset + 1 + i,
      inMonth: false,
      date: new Date(year, month - 1, daysInPrev - startOffset + 1 + i),
    });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, inMonth: true, date: new Date(year, month, d) });
  }
  while (cells.length < 42) {
    const idx = cells.length - startOffset - daysInMonth + 1;
    cells.push({ day: idx, inMonth: false, date: new Date(year, month + 1, idx) });
  }
  return cells;
};

// ═════════════════════════════════════════════════════════════════════
// ✅ PRESET SLOTS + TIME OPTIONS (for the improved time picker)
// ═════════════════════════════════════════════════════════════════════
const PRESET_SLOTS = [
  { label: "7:00 – 8:30 AM",   start: "07:00", end: "08:30" },
  { label: "8:30 – 10:00 AM",  start: "08:30", end: "10:00" },
  { label: "10:00 – 11:30 AM", start: "10:00", end: "11:30" },
  { label: "11:30 – 1:00 PM",  start: "11:30", end: "13:00" },
  { label: "1:00 – 2:30 PM",   start: "13:00", end: "14:30" },
  { label: "2:30 – 4:00 PM",   start: "14:30", end: "16:00" },
  { label: "4:00 – 5:30 PM",   start: "16:00", end: "17:30" },
  { label: "5:30 – 7:00 PM",   start: "17:30", end: "19:00" },
];

const buildTimeOptions = () => {
  const options = [];
  for (let m = 7 * 60; m <= 20 * 60; m += 30) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    const value = `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    options.push({ value, label: fmt12(value) });
  }
  return options;
};
const TIME_OPTIONS = buildTimeOptions();

// ═════════════════════════════════════════════════════════════════════
// INLINE DATE PICKER
// ═════════════════════════════════════════════════════════════════════
function InlineDatePicker({ value, onChange, placeholder = "Select date", icon = "fa-regular fa-calendar" }) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => {
    const base = value ? new Date(`${value}T00:00:00`) : new Date();
    return { year: base.getFullYear(), month: base.getMonth() };
  });
  const wrapRef = useRef(null);

  useEffect(() => {
    const handle = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const todayInputStr = toDateInputValue(new Date());

  const toggle = () => {
    const base = value ? new Date(`${value}T00:00:00`) : new Date();
    setCursor({ year: base.getFullYear(), month: base.getMonth() });
    setOpen((v) => !v);
  };
  const pick = (v) => { onChange(v); setOpen(false); };

  return (
    <div className="ra-mp-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`ra-mp-trigger ${open ? "open" : ""}`}
        onClick={toggle}
      >
        <i className={icon}></i>
        <span className={`ra-mp-text ${!value ? "is-placeholder" : ""}`}>
          {value ? formatDateLongLocal(value) : placeholder}
        </span>
        <i className={`fa-solid fa-chevron-down ra-mp-caret ${open ? "open" : ""}`}></i>
      </button>

      {open && (
        <div className="ra-mp-popover ra-mp-date-popover">
          <span className="ra-mp-arrow"></span>

          <div className="ra-mp-quick">
            <button
              type="button"
              className={value === todayInputStr ? "active" : ""}
              onClick={() => pick(todayInputStr)}
            >
              Today
            </button>
            <button type="button" onClick={() => pick("")}>
              Clear
            </button>
          </div>

          <div className="ra-mp-cal-header">
            <button
              type="button"
              className="ra-mp-cal-nav"
              onClick={() =>
                setCursor((c) =>
                  c.month === 0
                    ? { year: c.year - 1, month: 11 }
                    : { year: c.year, month: c.month - 1 }
                )
              }
            >
              <i className="fa-solid fa-chevron-left"></i>
            </button>
            <span className="ra-mp-cal-title">
              {MONTH_NAMES[cursor.month]} {cursor.year}
            </span>
            <button
              type="button"
              className="ra-mp-cal-nav"
              onClick={() =>
                setCursor((c) =>
                  c.month === 11
                    ? { year: c.year + 1, month: 0 }
                    : { year: c.year, month: c.month + 1 }
                )
              }
            >
              <i className="fa-solid fa-chevron-right"></i>
            </button>
          </div>

          <div className="ra-mp-cal-weekdays">
            {WEEKDAY_LABELS.map((w) => <span key={w}>{w}</span>)}
          </div>

          <div className="ra-mp-cal-grid">
            {buildCalendarGrid(cursor.year, cursor.month).map((cell, i) => {
              const cellStr = toDateInputValue(cell.date);
              const isPast = cellStr < todayInputStr;
              const isSelected = cellStr === value;
              return (
                <button
                  type="button"
                  key={i}
                  disabled={isPast}
                  className={`ra-mp-cal-day ${!cell.inMonth ? "is-outside" : ""} ${isSelected ? "is-selected" : ""} ${isPast ? "is-disabled" : ""}`}
                  onClick={() => { if (!isPast) pick(cellStr); }}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// INLINE ROOM PICKER
// ═════════════════════════════════════════════════════════════════════
function InlineRoomPicker({ value, valueId, onChange, rooms = [], placeholder = "Select room" }) {
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

  const sortedRooms = useMemo(
    () =>
      [...rooms].sort((a, b) =>
        (a.roomName || "").localeCompare(b.roomName || "", undefined, {
          numeric: true,
          sensitivity: "base",
        })
      ),
    [rooms]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sortedRooms;
    return sortedRooms.filter((r) => (r.roomName || "").toLowerCase().includes(q));
  }, [sortedRooms, search]);

  const toggle = () => { setSearch(""); setOpen((v) => !v); };

  return (
    <div className="ra-mp-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`ra-mp-trigger ${open ? "open" : ""}`}
        onClick={toggle}
      >
        <i className="fa-solid fa-door-open"></i>
        <span className={`ra-mp-text ${!value ? "is-placeholder" : ""}`}>
          {value || placeholder}
        </span>
        <i className={`fa-solid fa-chevron-down ra-mp-caret ${open ? "open" : ""}`}></i>
      </button>

      {open && (
        <div className="ra-mp-popover ra-mp-room-popover">
          <span className="ra-mp-arrow"></span>

          <div className="ra-mp-search-wrap">
            <i className="fa-solid fa-magnifying-glass"></i>
            <input
              type="text"
              className="ra-mp-search-input"
              placeholder="Search room..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            {search && (
              <button
                type="button"
                className="ra-mp-search-clear"
                onClick={() => setSearch("")}
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
            )}
          </div>

          <div className="ra-mp-room-list">
            {filtered.length === 0 ? (
              <div className="ra-mp-empty">
                <i className="fa-regular fa-face-frown"></i>
                <span>No rooms match.</span>
              </div>
            ) : (
              filtered.map((r) => {
                const rId = r.id || r.docId || r.roomId;
                const isActive = rId === valueId || r.roomName === value;
                return (
                  <button
                    type="button"
                    key={rId || r.roomName}
                    className={`ra-mp-room-option ${isActive ? "is-active" : ""}`}
                    onClick={() => {
                      onChange(r.roomName, rId);
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    <div className="ra-mp-room-icon">
                      <i className="fa-solid fa-door-open"></i>
                    </div>
                    <div className="ra-mp-room-body">
                      <span className="ra-mp-room-name">{r.roomName}</span>
                      {(r.floor || r.building) && (
                        <span className="ra-mp-room-meta">
                          {r.floor && <>Floor {r.floor}</>}
                          {r.floor && r.building && <span className="ra-mp-dot">•</span>}
                          {r.building && <>{r.building}</>}
                        </span>
                      )}
                    </div>
                    {isActive && (
                      <i className="fa-solid fa-circle-check ra-mp-room-check"></i>
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

// ═════════════════════════════════════════════════════════════════════
// ✅ INLINE TIME PICKER — preset slots + custom dropdowns
// ═════════════════════════════════════════════════════════════════════
function InlineTimePicker({ startValue, endValue, onChange }) {
  const [showCustom, setShowCustom] = useState(false);

  const isPresetActive = (slot) =>
    slot.start === startValue && slot.end === endValue;

  const handlePreset = (slot) => {
    onChange(slot.start, slot.end);
    setShowCustom(false);
  };

  return (
    <div className="ra-time-picker">
      <div className="time-preset-grid">
        {PRESET_SLOTS.map((slot) => (
          <button
            key={slot.label}
            type="button"
            className={`time-preset-chip ${isPresetActive(slot) ? "active" : ""}`}
            onClick={() => handlePreset(slot)}
          >
            {slot.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        className={`time-custom-toggle ${showCustom ? "open" : ""}`}
        onClick={() => setShowCustom((v) => !v)}
      >
        <i className="fa-solid fa-sliders"></i>
        {showCustom ? "Hide custom time" : "Set a custom time instead"}
        <i className={`fa-solid fa-chevron-down time-custom-chev ${showCustom ? "open" : ""}`}></i>
      </button>

      {showCustom && (
        <div className="time-custom-grid">
          <div className="time-custom-field">
            <span className="time-custom-label">Start Time</span>
            <div className="ra-select-wrap">
              <select
                className="ra-select"
                value={startValue || ""}
                onChange={(e) => onChange(e.target.value, endValue)}
              >
                <option value="">Select start time</option>
                {TIME_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <i className="fa-solid fa-chevron-down ra-chevron"></i>
            </div>
          </div>
          <div className="time-custom-arrow">
            <i className="fa-solid fa-arrow-right"></i>
          </div>
          <div className="time-custom-field">
            <span className="time-custom-label">End Time</span>
            <div className="ra-select-wrap">
              <select
                className="ra-select"
                value={endValue || ""}
                onChange={(e) => onChange(startValue, e.target.value)}
              >
                <option value="">Select end time</option>
                {TIME_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <i className="fa-solid fa-chevron-down ra-chevron"></i>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// CONFLICT ROW
// ═════════════════════════════════════════════════════════════════════
function ConflictRow({ conflict }) {
  const kindIcon = {
    schedule: "fa-solid fa-chalkboard-user",
    event: "fa-solid fa-calendar-star",
    reservation: "fa-solid fa-book-bookmark",
    reassignment: "fa-solid fa-right-left",
  };
  const isBlocking = BLOCKING_CONFLICT_KINDS.has(conflict.kind);
  return (
    <div
      className="ra-conflict-row"
      style={isBlocking ? { borderColor: "#fecaca", background: "#fff" } : undefined}
    >
      <div
        className="ra-conflict-row-icon"
        style={isBlocking ? { background: "#fee2e2", color: "#b91c1c" } : undefined}
      >
        <i className={kindIcon[conflict.kind] || "fa-solid fa-triangle-exclamation"}></i>
      </div>
      <div className="ra-conflict-row-body">
        <div className="ra-conflict-row-title">
          {conflict.subject || "Untitled class"}
          {isBlocking && (
            <span
              style={{
                marginLeft: 6,
                fontSize: 9.5,
                fontWeight: 800,
                padding: "1px 6px",
                borderRadius: 999,
                background: "#fee2e2",
                color: "#b91c1c",
                letterSpacing: ".05em",
                verticalAlign: "middle",
              }}
            >
              BLOCKING
            </span>
          )}
        </div>
        <div className="ra-conflict-row-meta">
          {conflict.sourceLabel && (
            <span>
              <i className="fa-solid fa-tag"></i>
              {conflict.sourceLabel}
            </span>
          )}
          {conflict.faculty && (
            <span>
              <i className="fa-regular fa-user"></i>
              {conflict.faculty}
            </span>
          )}
          {conflict.section && (
            <span>
              <i className="fa-solid fa-users"></i>
              {conflict.section}
            </span>
          )}
          {(conflict.startTime || conflict.endTime) && (
            <span>
              <i className="fa-regular fa-clock"></i>
              {fmt12(conflict.startTime)} – {fmt12(conflict.endTime)}
            </span>
          )}
          {conflict.roomName && (
            <span>
              <i className="fa-solid fa-door-open"></i>
              {conflict.roomName}
            </span>
          )}
          {conflict.date && (
            <span>
              <i className="fa-regular fa-calendar"></i>
              {conflict.date}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═════════════════════════════════════════════════════════════════════
function RoomActivity() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("all");

  const [searchTerm, setSearchTerm] = useState("");
  const [roomFilter, setRoomFilter] = useState("");
  const [sortOrder, setSortOrder] = useState("newest");
  const [currentPage, setCurrentPage] = useState(1);

  const [showRoomPicker, setShowRoomPicker] = useState(false);
  const [roomSearch, setRoomSearch] = useState("");
  const [roomsList, setRoomsList] = useState([]);

  const [reviewing, setReviewing] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState({});
  const [processing, setProcessing] = useState(false);

  const [draftConflicts, setDraftConflicts] = useState([]);
  const [checkingDraftConflicts, setCheckingDraftConflicts] = useState(false);

  const [toast, setToast] = useState({ show: false, type: "success", title: "", message: "" });
  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    if (type !== "loading") setTimeout(() => setToast((p) => ({ ...p, show: false })), 4000);
  };

  useEffect(() => {
    setLoading(true);
    const unsub = onSnapshot(
      collection(db, "roomActivityRequests"),
      (snap) => {
        setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (err) => {
        console.error(err);
        showToast("error", "Load Failed", "Could not load room activity requests.");
        setLoading(false);
      }
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "rooms"),
      (snap) => setRoomsList(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => console.warn("Rooms listener failed:", err)
    );
    return () => unsub();
  }, []);

  // ═════════════════════════════════════════════════════════════════
  // LIVE CONFLICT DETECTION — rerun on draft change
  // ═════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!reviewing) {
      setDraftConflicts([]);
      return;
    }

    const { roomId, roomName, date, startTime, endTime } = draft;

    if (!roomId || !date || !startTime || !endTime) {
      setDraftConflicts([]);
      return;
    }

    let cancelled = false;
    const run = async () => {
      setCheckingDraftConflicts(true);
      try {
        const found = await detectConflicts({ roomId, roomName, date, startTime, endTime });
        if (!cancelled) setDraftConflicts(found);
      } catch (err) {
        console.error("Draft conflict detection failed:", err);
        if (!cancelled) setDraftConflicts([]);
      } finally {
        if (!cancelled) setCheckingDraftConflicts(false);
      }
    };
    run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    reviewing,
    draft.roomId,
    draft.roomName,
    draft.date,
    draft.startTime,
    draft.endTime,
  ]);

  const counts = useMemo(() => ({
    pending_admin: items.filter((i) => i.status === "pending_admin").length,
    approved:      items.filter((i) => i.status === "approved").length,
    all:           items.length,
  }), [items]);

  const roomOptions = useMemo(() => {
    const set = new Set();
    items.forEach((i) => { if (i.roomName) set.add(i.roomName); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [items]);

  const filteredRoomOptions = useMemo(() => {
    const q = roomSearch.trim().toLowerCase();
    if (!q) return roomOptions;
    return roomOptions.filter((r) => r.toLowerCase().includes(q));
  }, [roomOptions, roomSearch]);

  const filtered = useMemo(() => {
    let list = activeTab === "all" ? items : items.filter((i) => i.status === activeTab);
    if (roomFilter) list = list.filter((i) => i.roomName === roomFilter);
    if (searchTerm.trim()) {
      const s = searchTerm.toLowerCase();
      list = list.filter((i) =>
        (i.title || "").toLowerCase().includes(s) ||
        (i.roomName || "").toLowerCase().includes(s) ||
        (i.requestedByName || "").toLowerCase().includes(s) ||
        (i.reason || "").toLowerCase().includes(s)
      );
    }
    const sorted = [...list];

    if (sortOrder === "newest") {
      sorted.sort((a, b) => {
        const diff = recencyOf(b) - recencyOf(a);
        if (diff !== 0) return diff;
        const dateDiff = String(b.date || "").localeCompare(String(a.date || ""));
        if (dateDiff !== 0) return dateDiff;
        return String(b.id || "").localeCompare(String(a.id || ""));
      });
    } else if (sortOrder === "oldest") {
      sorted.sort((a, b) => {
        const diff = recencyOf(a) - recencyOf(b);
        if (diff !== 0) return diff;
        return String(a.date || "").localeCompare(String(b.date || ""));
      });
    } else if (sortOrder === "date_asc") {
      sorted.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    } else if (sortOrder === "date_desc") {
      sorted.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    }
    return sorted;
  }, [items, activeTab, searchTerm, roomFilter, sortOrder]);

  useEffect(() => { setCurrentPage(1); }, [activeTab, searchTerm, roomFilter, sortOrder]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const startIdx = (safePage - 1) * ITEMS_PER_PAGE;
  const paginated = filtered.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  const hasActiveFilters = searchTerm || roomFilter || sortOrder !== "newest";
  const clearAllFilters = () => { setSearchTerm(""); setRoomFilter(""); setSortOrder("newest"); };

  const startReview = (item) => {
    setReviewing({ item });
    setEditMode(false);
    setDraft({
      title: item.title || "",
      roomName: item.roomName || "",
      roomId: item.roomId || "",
      date: item.date || "",
      startTime: item.startTime || "",
      endTime: item.endTime || "",
      reason: item.reason || "",
    });
  };

  // ═════════════════════════════════════════════════════════════════
  // ✅ Derived: past date/time + blocking conflict sa DRAFT
  // ═════════════════════════════════════════════════════════════════
  const draftIsPastDate = !!draft.date && draft.date < todayStr();
  const draftIsPastTimeToday =
    draft.date === todayStr() &&
    !!draft.startTime &&
    isSlotInPast(draft.date, draft.startTime);
  const draftPastBlocked = draftIsPastDate || draftIsPastTimeToday;

  const draftBlockingConflicts = useMemo(
    () => draftConflicts.filter((c) => BLOCKING_CONFLICT_KINDS.has(c.kind)),
    [draftConflicts]
  );
  const draftHasBlockingConflict = draftBlockingConflicts.length > 0;

  const approveDisabled =
    processing ||
    checkingDraftConflicts ||
    draftPastBlocked ||
    draftHasBlockingConflict ||
    !draft.roomId ||
    !draft.date ||
    !draft.startTime ||
    !draft.endTime;

  const handleApprove = async () => {
    if (!reviewing) return;

    // ═════════════════════════════════════════════════════════════
    // Final safety net — reject invalid draft before doing anything
    // ═════════════════════════════════════════════════════════════
    if (draftPastBlocked) {
      showToast(
        "error",
        "Invalid Date / Time",
        "Cannot approve a request with a past date or past start time."
      );
      return;
    }
    if (draftHasBlockingConflict) {
      showToast(
        "error",
        "Room Already Booked",
        "This room already has an event or reservation in the selected slot. Change the room/time before approving."
      );
      return;
    }

    const { item } = reviewing;
    setProcessing(true);
    try {
      const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
      const me = userDoc.data();
      const myName = `${me.firstName} ${me.lastName}`;

      const usersSnap = await getDocs(collection(db, "users"));

      const enrichedConflicts = draftConflicts.map((c) => {
        let facultyId = "";
        if (c.facultyLastName && c.facultyFirstName) {
          const fDoc = usersSnap.docs.find((d) => {
            const fd = d.data();
            const ln = String(fd.lastName || "").trim().toLowerCase();
            const fn = String(fd.firstName || "").trim().toLowerCase();
            return (
              ln === String(c.facultyLastName).trim().toLowerCase() &&
              fn.startsWith(String(c.facultyFirstName).trim().toLowerCase().split(" ")[0])
            );
          });
          if (fDoc) facultyId = fDoc.id;
        }
        if (!facultyId && c.faculty) {
          const fDoc = findFacultyUserByName(usersSnap, c.faculty);
          if (fDoc) facultyId = fDoc.id;
        }
        return {
          scheduleId: c.id,
          kind: c.kind,
          sourceLabel: c.sourceLabel,
          subject: c.subject || c.title || "",
          section: c.section || "",
          faculty: c.faculty || "",
          facultyId,
          day: c.day,
          startTime: c.startTime,
          endTime: c.endTime,
          isReleased: !!c.isReleased,
          status: "pending",
        };
      });

      await updateDoc(doc(db, "roomActivityRequests", item.id), {
        title: draft.title.trim(),
        roomName: draft.roomName,
        roomId: draft.roomId,
        date: draft.date,
        startTime: draft.startTime,
        endTime: draft.endTime,
        reason: draft.reason.trim(),
        status: "approved",
        conflicts: enrichedConflicts,
        approvedById: auth.currentUser.uid,
        approvedByName: myName,
        approvedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      let eventId = item.eventId;
      if (!eventId) {
        const eventRef = await addDoc(collection(db, "events"), {
          roomId: draft.roomId,
          roomName: draft.roomName,
          title: draft.title.trim(),
          reason: draft.reason.trim(),
          date: draft.date,
          startTime: draft.startTime,
          endTime: draft.endTime,
          status: "active",
          createdById: item.requestedById,
          createdByName: item.requestedByName,
          approvedById: auth.currentUser.uid,
          createdAt: serverTimestamp(),
        });
        eventId = eventRef.id;
        await updateDoc(doc(db, "roomActivityRequests", item.id), { eventId });
      }

      let notified = 0;
      for (const conflict of enrichedConflicts) {
        let facultyDoc = null;
        if (conflict.facultyId)
          facultyDoc = usersSnap.docs.find((d) => d.id === conflict.facultyId) || null;
        if (!facultyDoc && conflict.faculty)
          facultyDoc = findFacultyUserByName(usersSnap, conflict.faculty);
        if (!facultyDoc) continue;

        await addDoc(collection(db, "notifications"), {
          userId: facultyDoc.id,
          ownerType: "faculty",
          activityId: eventId,
          title: "Room Activity Override",
          message: `${draft.title} will use ${draft.roomName} on ${draft.date} (${fmt12(draft.startTime)} - ${fmt12(draft.endTime)}). Your scheduled class may be affected.`,
          type: "room-activity",
          unread: true,
          archived: false,
          badge: "NEW",
          roomId: draft.roomId,
          roomName: draft.roomName,
          activityTitle: draft.title,
          activityReason: draft.reason,
          activityDate: draft.date,
          activityStart: draft.startTime,
          activityEnd: draft.endTime,
          affectedScheduleId: conflict.scheduleId,
          affectedSubject: conflict.subject,
          affectedFaculty: conflict.faculty,
          createdAt: serverTimestamp(),
        });
        notified++;
      }

      if (item.requestedById) {
        await addDoc(collection(db, "notifications"), {
          userId: item.requestedById,
          ownerType: "clerk",
          activityRequestId: item.id,
          title: "Room Activity Approved",
          message: `"${draft.title}" was approved for ${draft.roomName} on ${draft.date}. ${notified} faculty notified.`,
          type: "room-activity-status",
          unread: true,
          archived: false,
          badge: "INFO",
          createdAt: serverTimestamp(),
        });
      }

      await logActivity({
        user: myName, role: me.role,
        action: "Approved room activity request", actionType: "approve",
        target: `${draft.title} (${draft.roomName})`, status: "SUCCESS",
      });

      showToast("success", "Approved", `Activity approved. ${notified} faculty notified.`);
      setReviewing(null);
    } catch (err) {
      console.error(err);
      showToast("error", "Failed", "Could not approve request.");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <>
      <div className="ra-review-page">
        <div className="ra-review-header">
          <div>
            <h1 className="ra-review-title">Room Activity Requests</h1>
            <p className="ra-review-subtitle">
              Review requests submitted by the Clerk. Approve with optional edits before finalizing.
            </p>
          </div>
        </div>

        <div className="ra-review-tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`ra-review-tab ${activeTab === t.key ? "active" : ""}`}
              onClick={() => setActiveTab(t.key)}>
              {t.label}
              <span className="ra-review-tab-count">{counts[t.key] ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="ra-review-toolbar">
          <div className="ra-review-search">
            <i className="fa-solid fa-magnifying-glass"></i>
            <input type="text" placeholder="Search title, room, requester, or reason…"
              value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
            {searchTerm && (
              <button className="ra-review-search-clear" onClick={() => setSearchTerm("")} aria-label="Clear">
                <i className="fa-solid fa-xmark"></i>
              </button>
            )}
          </div>

          <div className="ra-review-filters">
            <div className="ra-review-roompicker">
              <button type="button"
                className={`ra-review-room-trigger ${showRoomPicker ? "open" : ""}`}
                onClick={() => { setRoomSearch(""); setShowRoomPicker((v) => !v); }}>
                <i className="fa-solid fa-door-open"></i>
                <span className="ra-review-room-trigger-text">{roomFilter || "All Rooms"}</span>
                <i className={`fa-solid fa-chevron-down ra-review-room-caret ${showRoomPicker ? "open" : ""}`}></i>
              </button>

              {showRoomPicker && (
                <>
                  <div className="ra-review-picker-clickaway" onClick={() => setShowRoomPicker(false)}></div>
                  <div className="ra-review-room-popover">
                    <span className="ra-review-popover-arrow"></span>

                    <div className="ra-review-room-search-wrap">
                      <i className="fa-solid fa-magnifying-glass"></i>
                      <input type="text" className="ra-review-room-search-input" placeholder="Search room..."
                        value={roomSearch} onChange={(e) => setRoomSearch(e.target.value)} autoFocus />
                      {roomSearch && (
                        <button type="button" className="ra-review-room-search-clear" onClick={() => setRoomSearch("")}>
                          <i className="fa-solid fa-xmark"></i>
                        </button>
                      )}
                    </div>

                    <div className="ra-review-room-list">
                      <button type="button"
                        className={`ra-review-room-option ${!roomFilter ? "is-active" : ""}`}
                        onClick={() => { setRoomFilter(""); setShowRoomPicker(false); setRoomSearch(""); }}>
                        <div className="ra-review-room-option-icon"><i className="fa-solid fa-layer-group"></i></div>
                        <span className="ra-review-room-option-name">All Rooms</span>
                        {!roomFilter && <i className="fa-solid fa-circle-check ra-review-room-option-check"></i>}
                      </button>

                      {filteredRoomOptions.length === 0 && roomSearch ? (
                        <div className="ra-review-picker-empty">
                          <i className="fa-regular fa-face-frown"></i>
                          <span>No rooms match.</span>
                        </div>
                      ) : (
                        filteredRoomOptions.map((r) => {
                          const isActive = r === roomFilter;
                          return (
                            <button type="button" key={r}
                              className={`ra-review-room-option ${isActive ? "is-active" : ""}`}
                              onClick={() => { setRoomFilter(r); setShowRoomPicker(false); setRoomSearch(""); }}>
                              <div className="ra-review-room-option-icon"><i className="fa-solid fa-door-open"></i></div>
                              <span className="ra-review-room-option-name">{r}</span>
                              {isActive && <i className="fa-solid fa-circle-check ra-review-room-option-check"></i>}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="ra-review-select">
              <i className="fa-solid fa-arrow-down-short-wide"></i>
              <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value)}>
                {SORT_OPTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
              <i className="fa-solid fa-angle-down ra-review-select-chev"></i>
            </div>

            {hasActiveFilters && (
              <button className="ra-review-clear-all" onClick={clearAllFilters}>
                <i className="fa-solid fa-filter-circle-xmark"></i> Clear
              </button>
            )}
          </div>

          <span className="ra-review-result-count">
            {filtered.length} result{filtered.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="ra-review-body">
          {loading ? (
            <div className="ra-review-empty">
              <i className="fa-solid fa-spinner fa-spin"></i><p>Loading requests…</p>
            </div>
          ) : paginated.length === 0 ? (
            <div className="ra-review-empty">
              <i className="fa-regular fa-folder-open"></i>
              <p>{searchTerm || roomFilter ? "No matches for your filters." : "No requests in this view."}</p>
            </div>
          ) : (
            paginated.map((item) => (
              <ReviewCard key={item.id} item={item} onReview={() => startReview(item)} />
            ))
          )}
        </div>

        {!loading && totalPages > 1 && (
          <div className="ra-review-pagination">
            <span className="ra-review-page-info">
              Showing {startIdx + 1}–{Math.min(startIdx + ITEMS_PER_PAGE, filtered.length)} of {filtered.length}
            </span>
            <div className="ra-review-page-controls">
              <button disabled={safePage === 1} onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}>
                <i className="fa-solid fa-chevron-left"></i>
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <button key={p} className={safePage === p ? "active" : ""} onClick={() => setCurrentPage(p)}>{p}</button>
              ))}
              <button disabled={safePage === totalPages} onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}>
                <i className="fa-solid fa-chevron-right"></i>
              </button>
            </div>
          </div>
        )}
      </div>

      {reviewing && (
        <div className="ra-modal-overlay">
          <div className="ra-modal ra-modal-wide">
            {/* ═════════════ SCROLLABLE BODY ═════════════ */}
            <div className="ra-modal-scroll">
              <div className="ra-modal-header">
                <div className="ra-modal-icon">
                  <i className="fa-solid fa-check"></i>
                </div>
                <h3 className="ra-modal-title">
                  {editMode ? "Edit & Approve" : "Approve Request"}
                </h3>
                <p className="ra-modal-text">
                  You can adjust details before approving. Only affected faculty will be notified.
                </p>
              </div>

              {/* ═════ PAST DATE / TIME WARNING ═════ */}
              {draftPastBlocked && (
                <div
                  className="ra-conflict-panel"
                  style={{ background: "#fef2f2", borderColor: "#fecaca" }}
                >
                  <div
                    className="ra-conflict-panel-header"
                    style={{ borderBottomColor: "#fecaca" }}
                  >
                    <i
                      className={`fa-solid ${
                        draftIsPastDate ? "fa-calendar-xmark" : "fa-clock-rotate-left"
                      }`}
                      style={{ color: "#b91c1c" }}
                    ></i>
                    <div>
                      <strong style={{ color: "#991b1b" }}>
                        {draftIsPastDate
                          ? "Past date is not allowed"
                          : "Start time is already in the past"}
                      </strong>
                      <p style={{ color: "#b91c1c" }}>
                        {draftIsPastDate
                          ? "Cannot approve a room activity scheduled on a past date. Update the date to today or a future date."
                          : `The start time (${fmt12(draft.startTime)}) has already passed. Change the time or pick a different date before approving.`}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* ═════ LIVE CONFLICT PANEL ═════ */}
              {!draftPastBlocked && (
                <>
                  {checkingDraftConflicts ? (
                    <div className="ra-conflict-panel">
                      <div className="ra-conflict-panel-header">
                        <i className="fa-solid fa-spinner fa-spin"></i>
                        <div>
                          <strong>Checking for conflicts…</strong>
                          <p>Scanning schedules, events, reservations, reassignments, and releases.</p>
                        </div>
                      </div>
                    </div>
                  ) : draftHasBlockingConflict ? (
                    <div
                      className="ra-conflict-panel"
                      style={{ background: "#fef2f2", borderColor: "#fecaca" }}
                    >
                      <div
                        className="ra-conflict-panel-header"
                        style={{ borderBottomColor: "#fecaca" }}
                      >
                        <i className="fa-solid fa-circle-xmark" style={{ color: "#b91c1c" }}></i>
                        <div>
                          <strong style={{ color: "#991b1b" }}>
                            Cannot approve — {draftBlockingConflicts.length} existing booking
                            {draftBlockingConflicts.length > 1 ? "s" : ""}
                          </strong>
                          <p style={{ color: "#b91c1c" }}>
                            This room already has an event or reservation during the
                            selected slot. Change the room, date, or time before approving.
                          </p>
                        </div>
                      </div>

                      <div className="ra-conflict-panel-list ra-conflict-panel-list--compact">
                        {draftBlockingConflicts.map((conflict, i) => (
                          <ConflictRow
                            key={`${conflict.kind}-${conflict.id || i}`}
                            conflict={{
                              ...conflict,
                              roomName: draft.roomName,
                              date: draft.date,
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  ) : draftConflicts.length > 0 ? (
                    <div className="ra-conflict-panel">
                      <div className="ra-conflict-panel-header">
                        <i className="fa-solid fa-triangle-exclamation"></i>
                        <div>
                          <strong>
                            {draftConflicts.length} conflicting{" "}
                            {draftConflicts.length === 1 ? "schedule" : "schedules"}
                          </strong>
                          <p>
                            These classes will be overridden. Affected faculty will
                            be notified after approval.
                          </p>
                        </div>
                      </div>

                      <div className="ra-conflict-panel-list ra-conflict-panel-list--compact">
                        {draftConflicts.map((conflict, i) => (
                          <ConflictRow
                            key={`${conflict.kind}-${conflict.id || i}`}
                            conflict={{
                              ...conflict,
                              roomName: draft.roomName,
                              date: draft.date,
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div
                      className="ra-conflict-panel"
                      style={{ background: "#ecfdf5", borderColor: "#a7f3d0" }}
                    >
                      <div
                        className="ra-conflict-panel-header"
                        style={{ borderBottomColor: "#a7f3d0" }}
                      >
                        <i className="fa-solid fa-circle-check" style={{ color: "#16a34a" }}></i>
                        <div>
                          <strong style={{ color: "#065f46" }}>No conflicts detected</strong>
                          <p style={{ color: "#047857" }}>
                            The selected room, date, and time are clear.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}

              <button className="ra-edit-toggle" onClick={() => setEditMode((v) => !v)}>
                <i className={`fa-solid ${editMode ? "fa-eye" : "fa-pen-to-square"}`}></i>
                {editMode ? "Preview only" : "Edit before approving"}
              </button>

              {editMode ? (
                <div className="ra-edit-grid">
                  <label>
                    Title
                    <input
                      value={draft.title}
                      onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    />
                  </label>

                  <label>
                    Room
                    <InlineRoomPicker
                      value={draft.roomName}
                      valueId={draft.roomId}
                      rooms={roomsList}
                      onChange={(roomName, roomId) =>
                        setDraft({ ...draft, roomName, roomId })
                      }
                      placeholder="Select room"
                    />
                  </label>

                  <label>
                    Date
                    <InlineDatePicker
                      value={draft.date}
                      onChange={(v) => setDraft({ ...draft, date: v })}
                      placeholder="Select date"
                    />
                  </label>

                  {/* ✅ UPDATED: preset slots + custom time picker */}
                  <div className="ra-edit-time-block">
                    <span className="ra-edit-label-text">Time</span>
                    <InlineTimePicker
                      startValue={draft.startTime}
                      endValue={draft.endTime}
                      onChange={(s, e) => setDraft({ ...draft, startTime: s, endTime: e })}
                    />
                  </div>

                  <label>
                    Reason
                    <textarea
                      rows={3}
                      value={draft.reason}
                      onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                    />
                  </label>
                </div>
              ) : (
                <div className="ra-modal-summary">
                  <div className="ra-modal-summary-row"><i className="fa-solid fa-bookmark"></i><span>{draft.title || "Untitled"}</span></div>
                  <div className="ra-modal-summary-row"><i className="fa-solid fa-door-open"></i><span>{draft.roomName}</span></div>
                  <div className="ra-modal-summary-row"><i className="fa-regular fa-calendar"></i><span>{fmtDate(draft.date)}</span></div>
                  <div className="ra-modal-summary-row"><i className="fa-regular fa-clock"></i><span>{fmt12(draft.startTime)} – {fmt12(draft.endTime)}</span></div>
                </div>
              )}
            </div>

            {/* ═════════════ FIXED FOOTER ═════════════ */}
            <div className="ra-modal-actions">
              <button
                className="ra-modal-cancel"
                onClick={() => setReviewing(null)}
                disabled={processing}
              >
                Cancel
              </button>
              <button
                className="ra-modal-confirm"
                onClick={handleApprove}
                disabled={approveDisabled}
                title={
                  draftPastBlocked
                    ? "Cannot approve — past date or past start time."
                    : draftHasBlockingConflict
                    ? "Cannot approve — this room is already booked during the selected slot."
                    : checkingDraftConflicts
                    ? "Checking conflicts…"
                    : ""
                }
              >
                {processing
                  ? "Approving…"
                  : checkingDraftConflicts
                  ? "Checking…"
                  : draftPastBlocked
                  ? "Past Date/Time"
                  : draftHasBlockingConflict
                  ? "Conflicts Found"
                  : "Approve Request"}
              </button>
            </div>
          </div>
        </div>
      )}

      <Toast show={toast.show} type={toast.type} title={toast.title} message={toast.message}
        onClose={() => setToast((p) => ({ ...p, show: false }))} />
    </>
  );
}

function ReviewCard({ item, onReview }) {
  const statusMeta = {
    pending_admin:   { label: "Needs Review", cls: "is-pending" },
    pending_faculty: { label: "With Faculty", cls: "is-pending-faculty" },
    approved:        { label: "Approved",     cls: "is-approved" },
    denied:          { label: "Denied",       cls: "is-denied" },
    cancelled:       { label: "Cancelled",    cls: "is-cancelled" },
  }[item.status] || {
    label: String(item.status || "Unknown").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    cls: "",
  };

  const conflicts = item.conflicts || [];

  return (
    <div className={`ra-review-card ${statusMeta.cls}`}>
      <div className="ra-review-card-top">
        <div className="ra-review-card-title-block">
          <div className="ra-review-card-title">{item.title}</div>
          <div className="ra-review-card-sub">
            <span>
              <i className="fa-regular fa-user"></i>
              {item.requestedByName || "Unknown"}
              {item.requestedByRole && (
                <span className="ra-role-pill" style={{ marginLeft: 8 }}>
                  {item.requestedByRole}
                </span>
              )}
            </span>
          </div>
        </div>
        <span className={`ra-review-status ${statusMeta.cls}`}>{statusMeta.label}</span>
      </div>

      <div className="ra-review-info-grid">
        <div className="ra-review-info-item">
          <div className="ra-review-info-icon">
            <i className="fa-solid fa-door-open"></i>
          </div>
          <div className="ra-review-info-text">
            <span className="ra-review-info-label">Room</span>
            <span className="ra-review-info-value">{item.roomName || "—"}</span>
          </div>
        </div>

        <div className="ra-review-info-item">
          <div className="ra-review-info-icon">
            <i className="fa-regular fa-calendar"></i>
          </div>
          <div className="ra-review-info-text">
            <span className="ra-review-info-label">Date</span>
            <span className="ra-review-info-value">{fmtDate(item.date)}</span>
          </div>
        </div>

        <div className="ra-review-info-item">
          <div className="ra-review-info-icon">
            <i className="fa-regular fa-clock"></i>
          </div>
          <div className="ra-review-info-text">
            <span className="ra-review-info-label">Time</span>
            <span className="ra-review-info-value">
              {fmt12(item.startTime)} – {fmt12(item.endTime)}
            </span>
          </div>
        </div>

        <div className="ra-review-info-item">
          <div className="ra-review-info-icon">
            <i className="fa-solid fa-triangle-exclamation"></i>
          </div>
          <div className="ra-review-info-text">
            <span className="ra-review-info-label">Conflicts</span>
            <span className="ra-review-info-value">
              {conflicts.length > 0
                ? `${conflicts.length} schedule${conflicts.length > 1 ? "s" : ""}`
                : "None"}
            </span>
          </div>
        </div>
      </div>

      {conflicts.length > 0 && (
        <div className="ra-review-conflict-preview">
          <div className="ra-review-conflict-preview-title">
            <i className="fa-solid fa-triangle-exclamation"></i>
            Conflicts with
          </div>
          {conflicts.slice(0, 3).map((conflict, i) => (
            <div key={conflict.scheduleId || i} className="ra-review-conflict-line">
              <span className="ra-cp-subject">{conflict.subject || "Untitled"}</span>
              <span className="ra-cp-dot">•</span>
              <span className="ra-cp-faculty">{conflict.faculty || "Unknown"}</span>
              {(conflict.startTime || conflict.endTime) && (
                <>
                  <span className="ra-cp-dot">•</span>
                  <span className="ra-cp-time">
                    {fmt12(conflict.startTime)} – {fmt12(conflict.endTime)}
                  </span>
                </>
              )}
            </div>
          ))}
          {conflicts.length > 3 && (
            <div className="ra-review-conflict-more">
              +{conflicts.length - 3} more
            </div>
          )}
        </div>
      )}

      {item.reason && (
        <div className="ra-review-reason">
          <i className="fa-solid fa-note-sticky"></i>
          <span>{item.reason}</span>
        </div>
      )}

      {item.status === "pending_admin" && (
        <div className="ra-review-actions">
          <button className="ra-review-btn is-approve" onClick={onReview}>
            <i className="fa-solid fa-circle-check"></i> Review & Approve
          </button>
        </div>
      )}
    </div>
  );
}

export default RoomActivity;