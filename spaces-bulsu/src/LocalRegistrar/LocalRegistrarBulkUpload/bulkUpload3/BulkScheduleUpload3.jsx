import { useState, useRef, useEffect, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import "./bulk-schedule-upload3.css";

const steps = [
  { number: 1, label: "SETUP" },
  { number: 2, label: "UPLOAD" },
  { number: 3, label: "CALENDAR VIEW" },
  { number: 4, label: "CONFIRM" },
];

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const START_HOUR = 7;
const END_HOUR = 21;
const HOUR_HEIGHT = 60;
const SNAP_MINUTES = 15;

const MIN_TIME = "07:00";
const MAX_TIME = "20:00";
const MIN_SCHEDULE_MIN = 7 * 60;   // 7:00 AM
const MAX_SCHEDULE_MIN = 20 * 60;  // 8:00 PM

function getTopFromStart(hour, minute) {
  const startTotal = START_HOUR * 60;
  const total = hour * 60 + minute;
  const diff = total - startTotal;
  return (diff / 60) * HOUR_HEIGHT;
}

function getBlockHeight(startH, startM, endH, endM) {
  const startTotal = startH * 60 + startM;
  const endTotal = endH * 60 + endM;
  const duration = endTotal - startTotal;
  return (duration / 60) * HOUR_HEIGHT;
}

const colourPalette = [
  "#4a6cf7", "#f7b84d", "#f06548", "#3bc14a", "#e83e8c",
  "#6f42c1", "#fd7e14", "#20c997", "#d63384", "#6610f2"
];

function toTimeValue(h, m) {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function clampTimeValue(value) {
  if (!value) return MIN_TIME;
  if (value < MIN_TIME) return MIN_TIME;
  if (value > MAX_TIME) return MAX_TIME;
  return value;
}

function formatTime12Hour(hour, minute) {
  const suffix = hour >= 12 ? "PM" : "AM";
  let displayHour = hour % 12;
  if (displayHour === 0) displayHour = 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

// ─────────────────────────────────────────────────────────────
// DAY EXPANSION
// Accepts: "MON", "Monday", 3, "MWF", "M/W/F", "TTh", "Tue-Thu",
// "MTWThF", "SAT", "" ...
// Returns an array of day numbers (1..7). Empty array = unknown.
// ─────────────────────────────────────────────────────────────
const DAY_NUM = { MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6, SUN: 7 };
const DAY_NUM_FULL = {
  MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3,
  THURSDAY: 4, FRIDAY: 5, SATURDAY: 6, SUNDAY: 7,
};

function expandDays(raw) {
  if (raw === null || raw === undefined || raw === "") return [];
  if (typeof raw === "number") {
    return raw >= 1 && raw <= 7 ? [raw] : [];
  }
  const s = String(raw).toUpperCase().trim();
  if (!s) return [];

  if (DAY_NUM_FULL[s]) return [DAY_NUM_FULL[s]];
  if (DAY_NUM[s]) return [DAY_NUM[s]];

  // Run of abbreviations like "MWF", "MTWThF", "TTH"
  const stripped = s.replace(/[^A-Z]/g, "");
  const days = [];
  let i = 0;
  while (i < stripped.length) {
    const triple = stripped.slice(i, i + 3);
    if (DAY_NUM[triple]) { days.push(DAY_NUM[triple]); i += 3; continue; }

    const pair = stripped.slice(i, i + 2);
    if (pair === "TH") { days.push(4); i += 2; continue; } // Thurs
    if (pair === "TU") { days.push(2); i += 2; continue; } // Tues
    if (pair === "SA") { days.push(6); i += 2; continue; } // Sat
    if (pair === "SU") { days.push(7); i += 2; continue; } // Sun

    const ch = stripped[i];
    if (ch === "M") { days.push(1); i++; continue; }
    if (ch === "T") { days.push(2); i++; continue; } // ambiguous → Tue
    if (ch === "W") { days.push(3); i++; continue; }
    if (ch === "F") { days.push(5); i++; continue; }
    if (ch === "S") { days.push(6); i++; continue; } // ambiguous → Sat
    i++; // skip unknown
  }
  return [...new Set(days)];
}

// ─────────────────────────────────────────────────────────────
// OVERLAP HELPERS
// ─────────────────────────────────────────────────────────────
function findOverlap(candidate, schedules) {
  const cStart = candidate.startH * 60 + candidate.startM;
  const cEnd = candidate.endH * 60 + candidate.endM;
  if (cEnd <= cStart) return null;
  for (const s of schedules) {
    if (s.id === candidate.id) continue;
    if (s.day !== candidate.day) continue;
    const sStart = s.startH * 60 + s.startM;
    const sEnd = s.endH * 60 + s.endM;
    if (cStart < sEnd && sStart < cEnd) return s;
  }
  return null;
}

// Compute a side-by-side layout for one day's events.
// Returns Map<scheduleId, { slot, totalSlots }>.
// totalSlots > 1 means the event shares its row with other overlapping
// events — it will be rendered in a narrower column instead of stacking.
function layoutDayEvents(events) {
  const layout = new Map();
  if (events.length === 0) return layout;

  // Sort by start, then by duration descending (longer first → left slot)
  const sorted = [...events].sort((a, b) => {
    const aStart = a.startH * 60 + a.startM;
    const bStart = b.startH * 60 + b.startM;
    if (aStart !== bStart) return aStart - bStart;
    const aDur = a.endH * 60 + a.endM - aStart;
    const bDur = b.endH * 60 + b.endM - bStart;
    return bDur - aDur;
  });

  // Build clusters of events whose time ranges overlap (transitively)
  const clusters = [];
  let current = [];
  let clusterEnd = -1;

  for (const ev of sorted) {
    const evStart = ev.startH * 60 + ev.startM;
    const evEnd = ev.endH * 60 + ev.endM;
    if (current.length === 0 || evStart >= clusterEnd) {
      if (current.length > 0) clusters.push(current);
      current = [ev];
      clusterEnd = evEnd;
    } else {
      current.push(ev);
      if (evEnd > clusterEnd) clusterEnd = evEnd;
    }
  }
  if (current.length > 0) clusters.push(current);

  // Assign each event to the leftmost available column within its cluster
  for (const cluster of clusters) {
    if (cluster.length === 1) {
      layout.set(cluster[0].id, { slot: 0, totalSlots: 1 });
      continue;
    }

    const columnEndTimes = [];
    const assignments = [];

    for (const ev of cluster) {
      const evStart = ev.startH * 60 + ev.startM;
      const evEnd = ev.endH * 60 + ev.endM;

      let placedSlot = -1;
      for (let c = 0; c < columnEndTimes.length; c++) {
        if (columnEndTimes[c] <= evStart) {
          columnEndTimes[c] = evEnd;
          placedSlot = c;
          break;
        }
      }
      if (placedSlot === -1) {
        columnEndTimes.push(evEnd);
        placedSlot = columnEndTimes.length - 1;
      }
      assignments.push({ id: ev.id, slot: placedSlot });
    }

    const totalSlots = columnEndTimes.length;
    for (const a of assignments) {
      layout.set(a.id, { slot: a.slot, totalSlots });
    }
  }

  return layout;
}

// ---------- Edit Schedule Modal ----------
function EditScheduleModal({ schedule, otherSchedules, onSave, onClose }) {
  const [code, setCode] = useState(schedule.code || "");
  const [name, setName] = useState(schedule.name || "");
  const [day, setDay] = useState(schedule.day);
  const [startTime, setStartTime] = useState(toTimeValue(schedule.startH, schedule.startM));
  const [endTime, setEndTime] = useState(toTimeValue(schedule.endH, schedule.endM));
  const [faculty, setFaculty] = useState(schedule.faculty);
  const [section, setSection] = useState(schedule.section || "");

  const clampedStart = clampTimeValue(startTime);
  const clampedEnd = clampTimeValue(endTime);

  const { startH, startM, endH, endM } = useMemo(() => {
    const [sh, sm] = clampedStart.split(":").map(Number);
    const [eh, em] = clampedEnd.split(":").map(Number);
    return { startH: sh, startM: sm, endH: eh, endM: em };
  }, [clampedStart, clampedEnd]);

  const timeError = endH * 60 + endM <= startH * 60 + startM
    ? "End time must be after start time."
    : "";

  const conflict = useMemo(() => {
    if (timeError) return null;
    return findOverlap(
      { id: schedule.id, day: parseInt(day), startH, startM, endH, endM },
      otherSchedules
    );
  }, [schedule.id, day, startH, startM, endH, endM, timeError, otherSchedules]);

  const canSubmit = !timeError && !conflict;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!canSubmit) return;

    onSave({
      ...schedule,
      code: code.trim(),
      name: name.trim(),
      day: parseInt(day),
      startH,
      startM,
      endH,
      endM,
      faculty: faculty.trim() || "TBA",
      section: section.trim(),
    });
  };

  return (
    <div className="modal-overlay-LR" onClick={onClose}>
      <div className="modal-LR edit-modal-LR" onClick={(e) => e.stopPropagation()}>
        <div className="edit-modal-LR-scroll">
          <h3>Edit Schedule</h3>
          <form onSubmit={handleSubmit}>
            <div className="modal-grid">
              <div className="field-group">
                <label>Course Code</label>
                <input value={code} onChange={(e) => setCode(e.target.value)} required />
              </div>
              <div className="field-group">
                <label>Day</label>
                <select value={day} onChange={(e) => setDay(e.target.value)}>
                  {DAYS.map((d, idx) => (
                    <option key={idx} value={idx + 1}>{d}</option>
                  ))}
                </select>
              </div>
              <div className="time-row">
                <div className="time-box">
                  <label>Start Time</label>
                  <input
                    type="time"
                    className="time-native-input"
                    min={MIN_TIME}
                    max={MAX_TIME}
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    onBlur={(e) => setStartTime(clampTimeValue(e.target.value))}
                  />
                </div>
                <div className="time-box">
                  <label>End Time</label>
                  <input
                    type="time"
                    className="time-native-input"
                    min={MIN_TIME}
                    max={MAX_TIME}
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    onBlur={(e) => setEndTime(clampTimeValue(e.target.value))}
                  />
                </div>
                <p className="time-hint">
                  <i className="fa-regular fa-circle-info" /> Rooms are available 7:00 AM – 8:00 PM.
                  {timeError && <span className="time-hint-error"> {timeError}</span>}
                </p>
              </div>
              <div className="field-group">
                <label>Faculty</label>
                <input value={faculty} onChange={(e) => setFaculty(e.target.value)} />
              </div>
              <div className="field-group">
                <label>Section</label>
                <input value={section} onChange={(e) => setSection(e.target.value)} />
              </div>

              {conflict && (
                <div className="modal-overlap-warning">
                  <i className="fa-solid fa-triangle-exclamation" />
                  <span>
                    Conflicts with <strong>{conflict.code || "another class"}</strong>
                    {" "}({formatTime12Hour(conflict.startH, conflict.startM)} –{" "}
                    {formatTime12Hour(conflict.endH, conflict.endM)}) on{" "}
                    {DAYS[conflict.day - 1]}.
                  </span>
                </div>
              )}
            </div>
            <div className="modal-actions">
              <button type="button" onClick={onClose}>Cancel</button>
              <button type="submit" disabled={!canSubmit}>Save Changes</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ---------- Schedule block rendered on the calendar grid ----------
function CalendarEventBlock({ item, slot = 0, totalSlots = 1, onEdit, onPointerDown }) {
  const top = getTopFromStart(item.startH, item.startM);
  const height = getBlockHeight(item.startH, item.startM, item.endH, item.endM);
  const color = colourPalette[item.colorIdx % colourPalette.length];

  const isMini = height < 30;
  const isCompact = height < 46;
  const showFaculty = height >= 46;
  const showSection = height >= 64;

  const timeLabel = `${formatTime12Hour(item.startH, item.startM)} - ${formatTime12Hour(item.endH, item.endM)}`;
  const facultyLabel = item.faculty || "TBA";
  const tooltip = [
    item.section ? `${item.code} (${item.section})` : item.code,
    timeLabel,
    facultyLabel,
  ]
    .filter(Boolean)
    .join(" • ");

  // If this event shares its row with others, split the column horizontally.
  // Otherwise fall back to the CSS default (left/right: 6px).
  const style = {
    top: `${top}px`,
    height: `${height}px`,
    backgroundColor: color,
  };
  if (totalSlots > 1) {
    style.left = `calc(${(slot / totalSlots) * 100}% + 3px)`;
    style.right = `calc(${((totalSlots - slot - 1) / totalSlots) * 100}% + 3px)`;
  }

  const sharedProps = {
    style,
    onClick: () => onEdit(item),
    onPointerDown: (e) => onPointerDown(item, e),
    title: tooltip,
  };

  if (isMini) {
    return (
      <div className="calendar-event is-mini" {...sharedProps}>
        <span className="calendar-event-code">{item.code}</span>
        <span className="calendar-event-time">{timeLabel}</span>
      </div>
    );
  }

  return (
    <div
      className={`calendar-event ${isCompact ? "is-compact" : ""}`}
      {...sharedProps}
    >
      <span className="calendar-event-code">{item.code}</span>

      <span className="calendar-event-time">
        <i className="fa-regular fa-clock" aria-hidden="true" />
        <span>{timeLabel}</span>
      </span>

      {showFaculty && (
        <span className="calendar-event-faculty">
          <i className="fa-regular fa-user" aria-hidden="true" />
          <span>{facultyLabel}</span>
        </span>
      )}

      {showSection && item.section && (
        <span className="calendar-event-section-line">
          <i className="fa-solid fa-tag" aria-hidden="true" />
          <span>{item.section}</span>
        </span>
      )}
    </div>
  );
}

// ---------- Ghost block shown while dragging ----------
function DragPreviewBlock({ preview }) {
  const top = getTopFromStart(preview.startH, preview.startM);
  const height = getBlockHeight(preview.startH, preview.startM, preview.endH, preview.endM);
  const color = colourPalette[preview.colorIdx % colourPalette.length];
  const timeLabel = `${formatTime12Hour(preview.startH, preview.startM)} - ${formatTime12Hour(preview.endH, preview.endM)}`;

  return (
    <div
      className={`calendar-event drag-preview ${preview.hasConflict ? "has-conflict" : ""}`}
      style={{
        top: `${top}px`,
        height: `${height}px`,
        backgroundColor: preview.hasConflict ? "#ef4444" : color,
      }}
    >
      <span className="calendar-event-code">{preview.code}</span>
      <span className="calendar-event-time">
        <i className="fa-regular fa-clock" aria-hidden="true" />
        <span>{timeLabel}</span>
      </span>
      {preview.hasConflict && (
        <span className="drag-conflict-badge">
          <i className="fa-solid fa-triangle-exclamation" /> Conflict
        </span>
      )}
    </div>
  );
}

// ---------- Main Component ----------
export default function BulkScheduleUpload3() {
  const navigate = useNavigate();
  const location = useLocation();

  if (!location.state || !location.state.roomData) {
    return (
      <div className="bulk-upload-page-three">
        <h2>No data found.</h2>
        <button className="btn-next-three" onClick={() => navigate("/local-registrar/bulk-upload-2")}>
          Start Again
        </button>
      </div>
    );
  }

  const { semester, schoolYear, roomData } = location.state;

  const parseTime = (timeStr) => {
    if (!timeStr) return [7, 0];
    const cleaned = timeStr.trim().replace(/\s+/g, " ");
    const match = cleaned.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return [7, 0];
    let hour = parseInt(match[1]);
    let minute = parseInt(match[2]);
    const meridian = match[3].toUpperCase();
    if (meridian === "PM" && hour !== 12) hour += 12;
    if (meridian === "AM" && hour === 12) hour = 0;
    return [hour, minute];
  };

  // Convert raw AI output → placed schedules (day known) + unplaced (day unknown).
  // Handles multi-day strings ("MWF" → three objects), and does NOT silently
  // default unknown days to MON (that was the source of "patong patong").
  const convertSchedules = (data = []) => {
    const placed = [];
    const unplaced = [];
    let uid = 1;

    data.forEach((item) => {
      let startH = 7, startM = 0, endH = 8, endM = 0;
      if (item.time) {
        const parts = item.time.replace(/\s*-\s*/g, "-").split("-");
        if (parts.length === 2) {
          [startH, startM] = parseTime(parts[0]);
          [endH, endM] = parseTime(parts[1]);
        }
      } else if (item.startTime && item.endTime) {
        [startH, startM] = item.startTime.split(":").map(Number);
        [endH, endM] = item.endTime.split(":").map(Number);
      }

      const base = {
        code: item.code || item.subject || "",
        name: item.name || item.subject || "",
        section: item.section || "",
        faculty: item.faculty || "TBA",
        room: item.room || "",
        startH, startM, endH, endM,
        colorIdx: item.colorIdx ?? (uid % 10),
      };

      const dayList = expandDays(item.day);

      if (dayList.length === 0) {
        unplaced.push({ ...base, id: item.id || `unplaced-${uid++}`, day: null });
        return;
      }

      dayList.forEach((dayNum, idx) => {
        placed.push({
          ...base,
          id:
            dayList.length > 1
              ? `${item.id || "s"}-${uid}-${idx}`
              : (item.id || uid),
          day: dayNum,
        });
      });
      uid++;
    });

    // Dedupe exact duplicates (day + times + code + section).
    // Guards against AI returning the same row twice, which post-expansion
    // would produce visually identical stacked blocks.
    const seen = new Set();
    const deduped = placed.filter((s) => {
      const key = `${s.day}|${s.startH}:${s.startM}-${s.endH}:${s.endM}|${s.code}|${s.section}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { placed: deduped, unplaced };
  };

  const initialRoomsWithSchedules = roomData
    .filter((d) => d.schedules && d.schedules.length > 0)
    .map((d) => {
      const { placed, unplaced } = convertSchedules(d.schedules);
      return {
        room: d.room,
        schedules: placed,
        unplaced,
      };
    });

  const [roomsWithSchedules, setRoomsWithSchedules] = useState(initialRoomsWithSchedules);
  const [currentRoomIndex, setCurrentRoomIndex] = useState(0);
  const [editingSchedule, setEditingSchedule] = useState(null);

  // Drag-and-drop state
  const dragRef = useRef(null);
  const dragPreviewRef = useRef(null);
  const suppressClickRef = useRef(false);
  const dropErrorTimerRef = useRef(null);
  const [dragPreview, setDragPreview] = useState(null);
  const [dropError, setDropError] = useState("");

  const updatePreview = (p) => {
    dragPreviewRef.current = p;
    setDragPreview(p);
  };

  const showDropError = (msg) => {
    if (dropErrorTimerRef.current) clearTimeout(dropErrorTimerRef.current);
    setDropError(msg);
    dropErrorTimerRef.current = setTimeout(() => setDropError(""), 3200);
  };

  if (roomsWithSchedules.length === 0) {
    return (
      <div className="bulk-upload-page-three">
        <h2>No schedules found for any room.</h2>
        <button className="btn-next-three" onClick={() => navigate("/local-registrar/bulk-upload-2")}>
          Go Back
        </button>
      </div>
    );
  }

  const currentRoomData = roomsWithSchedules[currentRoomIndex];
  const { room, schedules, unplaced = [] } = currentRoomData;

  // Sum of unplaced across all rooms — the "some days have no schedule" bucket
  const totalUnplaced = roomsWithSchedules.reduce(
    (sum, r) => sum + (r.unplaced?.length || 0),
    0
  );
  const unplacedPreview = roomsWithSchedules
    .flatMap((r) => (r.unplaced || []).map((u) => ({ ...u, room: r.room })))
    .slice(0, 5);

  const handleUpdateSchedule = (updated) => {
    const updatedRooms = roomsWithSchedules.map((roomData, idx) => {
      if (idx === currentRoomIndex) {
        return {
          ...roomData,
          schedules: roomData.schedules.map((s) =>
            s.id === updated.id ? updated : s
          ),
        };
      }
      return roomData;
    });
    setRoomsWithSchedules(updatedRooms);
    setEditingSchedule(null);
  };

  const handleEventClick = (item) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setEditingSchedule(item);
  };

  const handlePointerDown = (item, e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    suppressClickRef.current = false;
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = {
      item,
      offsetY: e.clientY - rect.top,
      startX: e.clientX,
      startY: e.clientY,
      started: false,
    };
  };

  // Global pointer listeners for drag-and-drop
  useEffect(() => {
    const handleMove = (e) => {
      const drag = dragRef.current;
      if (!drag) return;

      if (!drag.started) {
        const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
        if (dist < 5) return;
        drag.started = true;
        suppressClickRef.current = true;
      }

      const el = document.elementFromPoint(e.clientX, e.clientY);
      const dayCol = el?.closest?.(".day-col");
      if (!dayCol) {
        updatePreview(null);
        return;
      }

      const dayIdx = parseInt(dayCol.dataset.dayIndex, 10);
      if (Number.isNaN(dayIdx)) {
        updatePreview(null);
        return;
      }

      const rect = dayCol.getBoundingClientRect();
      const y = e.clientY - rect.top - drag.offsetY;

      const duration =
        (drag.item.endH * 60 + drag.item.endM) -
        (drag.item.startH * 60 + drag.item.startM);

      let startMin = (y / HOUR_HEIGHT) * 60 + START_HOUR * 60;
      startMin = Math.round(startMin / SNAP_MINUTES) * SNAP_MINUTES;

      const maxStart = Math.max(MIN_SCHEDULE_MIN, MAX_SCHEDULE_MIN - duration);
      startMin = Math.max(MIN_SCHEDULE_MIN, Math.min(maxStart, startMin));

      const endMin = startMin + duration;

      const candidate = {
        id: drag.item.id,
        day: dayIdx + 1,
        startH: Math.floor(startMin / 60),
        startM: startMin % 60,
        endH: Math.floor(endMin / 60),
        endM: endMin % 60,
      };

      const conflict = findOverlap(candidate, schedules);

      updatePreview({
        scheduleId: drag.item.id,
        colorIdx: drag.item.colorIdx,
        code: drag.item.code,
        faculty: drag.item.faculty,
        section: drag.item.section,
        ...candidate,
        hasConflict: !!conflict,
        conflict,
      });
    };

    const handleUp = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;

      if (!drag.started) {
        updatePreview(null);
        return;
      }

      const preview = dragPreviewRef.current;
      updatePreview(null);
      if (!preview) return;

      if (preview.hasConflict) {
        const c = preview.conflict;
        showDropError(
          `Cannot move: conflicts with ${c.code || "another class"} on ${DAYS[c.day - 1]} ` +
          `(${formatTime12Hour(c.startH, c.startM)} – ${formatTime12Hour(c.endH, c.endM)}).`
        );
        return;
      }

      const original = schedules.find((s) => s.id === preview.scheduleId);
      if (!original) return;
      const unchanged =
        original.day === preview.day &&
        original.startH === preview.startH &&
        original.startM === preview.startM &&
        original.endH === preview.endH &&
        original.endM === preview.endM;
      if (unchanged) return;

      setRoomsWithSchedules((prev) =>
        prev.map((roomData, idx) => {
          if (idx !== currentRoomIndex) return roomData;
          return {
            ...roomData,
            schedules: roomData.schedules.map((sch) =>
              sch.id === preview.scheduleId
                ? {
                    ...sch,
                    day: preview.day,
                    startH: preview.startH,
                    startM: preview.startM,
                    endH: preview.endH,
                    endM: preview.endM,
                  }
                : sch
            ),
          };
        })
      );
    };

    document.addEventListener("pointermove", handleMove);
    document.addEventListener("pointerup", handleUp);
    document.addEventListener("pointercancel", handleUp);
    return () => {
      document.removeEventListener("pointermove", handleMove);
      document.removeEventListener("pointerup", handleUp);
      document.removeEventListener("pointercancel", handleUp);
    };
  }, [schedules, currentRoomIndex]);

  const totalGridHeight = (END_HOUR - START_HOUR) * HOUR_HEIGHT;

  const goPrevRoom = () => {
    setCurrentRoomIndex((prev) => (prev > 0 ? prev - 1 : roomsWithSchedules.length - 1));
  };
  const goNextRoom = () => {
    setCurrentRoomIndex((prev) => (prev < roomsWithSchedules.length - 1 ? prev + 1 : 0));
  };

  return (
    <div className="bulk-upload-page-three">
      <div className="bulk-header-three">
        <h1>Bulk Schedule Upload</h1>
        <p>Review schedules per room. Drag a block to change its day/time, or click it to edit.</p>
      </div>

      <div className="stepper-three">
        {steps.map((step, index) => (
          <div className="step-wrapper-three" key={step.number}>
            <div className="step-item-three">
              <div className={`step-circle-three ${step.number < 3 ? "completed" : ""} ${step.number === 3 ? "active" : ""}`}>
                {step.number < 3 ? <i className="fas fa-check" /> : step.number}
              </div>
              <span className={`step-label-three ${step.number === 3 ? "active" : ""}`}>{step.label}</span>
            </div>
            {index < steps.length - 1 && (
              <div className={`step-line-three ${step.number < 3 ? "completed" : ""}`} />
            )}
          </div>
        ))}
      </div>

      <div className="form-card-three calendar-card">
        <div className="calendar-header">
          <div className="room-nav">
            <i className="fa-solid fa-chevron-left" onClick={goPrevRoom} />
            <span className="room-name-pill">{room}</span>
            <i className="fa-solid fa-chevron-right" onClick={goNextRoom} />
          </div>
        </div>

        {unplaced.length > 0 && (
          <div className="unplaced-warning">
            <i className="fa-solid fa-triangle-exclamation" />
            <div>
              <strong>
                {unplaced.length} schedule{unplaced.length > 1 ? "s" : ""} skipped for this room
              </strong>{" "}
              — the day wasn't recognized in the source, so they were not placed on the calendar:
              <ul>
                {unplaced.slice(0, 5).map((s, i) => (
                  <li key={i}>
                    {s.code || "(no code)"} {s.section ? `· ${s.section}` : ""}
                    {s.startH !== undefined && (
                      <> — {formatTime12Hour(s.startH, s.startM)} – {formatTime12Hour(s.endH, s.endM)}</>
                    )}
                  </li>
                ))}
                {unplaced.length > 5 && <li>…and {unplaced.length - 5} more</li>}
              </ul>
              Fix the source file (clear day labels per row) and re-upload.
            </div>
          </div>
        )}

        <div className="calendar-scroll-x">
          <div className="days-header">
            <div className="time-offset" />
            {DAYS.map((d) => (
              <div className="day-cell" key={d}>
                <span className="day-name">{d}</span>
              </div>
            ))}
          </div>
          <hr className="days-divider" />

          <div className="scroll-area">
            <div className="cal-grid" style={{ height: totalGridHeight }}>
              <div className="time-col">
                {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => {
                  const h = START_HOUR + i;
                  const label = h < 12 ? `${String(h).padStart(2, "0")} AM` : h === 12 ? "12 PM" : `${String(h - 12).padStart(2, "0")} PM`;
                  return (
                    <div className="time-slot" key={h}>
                      <span>{label}</span>
                    </div>
                  );
                })}
              </div>

              {DAYS.map((_, dayIdx) => {
                const dayNumber = dayIdx + 1;
                const daySchedules = schedules.filter(
                  (s) => s.day === dayNumber && s.id !== dragPreview?.scheduleId
                );

                // Side-by-side layout for overlapping events on this day
                const layout = layoutDayEvents(daySchedules);

                return (
                  <div
                    className="day-col"
                    key={dayIdx}
                    data-day-index={dayIdx}
                    style={{ height: totalGridHeight, position: "relative" }}
                  >
                    {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => (
                      <div className="hour-line" key={i} style={{ top: i * HOUR_HEIGHT }} />
                    ))}

                    {daySchedules.map((item) => {
                      const { slot, totalSlots } = layout.get(item.id) || {
                        slot: 0,
                        totalSlots: 1,
                      };
                      return (
                        <CalendarEventBlock
                          key={item.id}
                          item={item}
                          slot={slot}
                          totalSlots={totalSlots}
                          onEdit={handleEventClick}
                          onPointerDown={handlePointerDown}
                        />
                      );
                    })}

                    {dragPreview && dragPreview.day === dayNumber && (
                      <DragPreviewBlock preview={dragPreview} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {editingSchedule && (
        <EditScheduleModal
          schedule={editingSchedule}
          otherSchedules={schedules.filter((s) => s.id !== editingSchedule.id)}
          onSave={handleUpdateSchedule}
          onClose={() => setEditingSchedule(null)}
        />
      )}

      {dropError && (
        <div className="drag-toast">
          <i className="fa-solid fa-triangle-exclamation" />
          <span>{dropError}</span>
        </div>
      )}

      <div className="bulk-footer-three step2-footer">
        <button className="btn-back-three" onClick={() => navigate(-1)}>Back</button>
        <button
          className="btn-next-three"
          onClick={() => {
            const allRoomsData = roomsWithSchedules.map((r) => ({
              room: r.room,
              schedules: r.schedules.map((s) => ({
                subject: s.code,
                section: s.section,
                faculty: s.faculty,
                day: DAYS[s.day - 1],
                startTime: `${String(s.startH).padStart(2, "0")}:${String(s.startM).padStart(2, "0")}`,
                endTime: `${String(s.endH).padStart(2, "0")}:${String(s.endM).padStart(2, "0")}`,
              })),
            }));
            navigate("/local-registrar/bulk-upload-4", {
              state: { semester, schoolYear, allRoomsData, totalUnplaced },
            });
          }}
        >
          Continue
        </button>
      </div>
    </div>
  );
}