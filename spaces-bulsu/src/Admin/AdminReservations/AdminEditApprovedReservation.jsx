import "./admin-edit-approved-reservation.css";
import { useNavigate, useLocation } from "react-router-dom";
import { useState, useEffect, useMemo, useRef } from "react";
import {
  doc, updateDoc, collection, getDocs, query, where,
  addDoc, serverTimestamp, getDoc, onSnapshot,
} from "firebase/firestore";
import { db, auth } from "../../firebase";
import { logActivity } from "../../utils/logActivity";
import { isRoomUnderMaintenance } from "../../utils/Roommaintenance";
import SavePopup from "../../Popup/SavePopup/SavePopup";
import Toast from "../../Popup/Toast/Toast";

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════
const convertToMinutes = (time) => {
  if (!time) return 0;
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

const normalize = (value) => value?.toString().trim().toLowerCase();

const getDayAbbrev = (dateStr) => {
  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  return days[new Date(dateStr).getDay()];
};

const overlap = (aStart, aEnd, bStart, bEnd) =>
  convertToMinutes(aStart) < convertToMinutes(bEnd) &&
  convertToMinutes(aEnd) > convertToMinutes(bStart);

const parseTimeToMin = (t) => {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
};

const format12Hour = (time) => {
  if (!time) return "—";
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return time;
  const suffix = h >= 12 ? "PM" : "AM";
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, "0")} ${suffix}`;
};

const getTodayLocal = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

const getNowTimeLocal = () => {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
};

const isPastDate = (dateStr) => !!dateStr && dateStr < getTodayLocal();

const isPastDateTime = (dateStr, timeStr) => {
  if (!dateStr || !timeStr) return false;
  return `${dateStr}T${timeStr}` < `${getTodayLocal()}T${getNowTimeLocal()}`;
};

const formatDateLong = (dateStr) => {
  if (!dateStr) return "—";
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });
};

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
  let nextDay = 1;
  while (cells.length < 42) {
    cells.push({ day: nextDay, inMonth: false, date: new Date(year, month + 1, nextDay) });
    nextDay++;
  }
  return cells;
};

const parseTime12 = (t) => {
  if (!t) return { hour: 12, minute: 0, period: "AM" };
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return { hour: h12, minute: m || 0, period };
};

const toTime24 = (hour12, minute, period) => {
  let h = hour12 % 12;
  if (period === "PM") h += 12;
  return `${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

const findUserByName = async (name) => {
  if (!name) return null;
  const usersSnap = await getDocs(collection(db, "users"));
  const normalized = name.trim().toLowerCase();
  for (const docu of usersSnap.docs) {
    const data = docu.data();
    const fullName = `${data.firstName || ""} ${data.lastName || ""}`.trim().toLowerCase();
    if (fullName === normalized) return { id: docu.id, ...data };
  }
  return null;
};

const sendNotification = async (userId, ownerType, title, message, type, badge = "INFO") => {
  if (!userId) return;
  await addDoc(collection(db, "notifications"), {
    userId, ownerType, title, message, type,
    unread: true, archived: false, badge,
    createdAt: serverTimestamp(),
  });
};

// ══════════════════════════════════════════════════════════════
// CONFLICT CHECK
// ══════════════════════════════════════════════════════════════
const checkReservationConflicts = async (reservation, skipReservationId) => {
  if (!reservation) return [];
  const roomId = reservation.roomId;
  const roomName = reservation.roomName;
  if (!roomId && !roomName) return [];
  if (!reservation.date || !reservation.startTime || !reservation.endTime) return [];

  const reqStart = parseTimeToMin(reservation.startTime);
  const reqEnd = parseTimeToMin(reservation.endTime);
  if (reqStart == null || reqEnd == null) return [];

  const matchesRoom = (r) =>
    (roomId && r.roomId === roomId) || (roomName && r.roomName === roomName);

  const conflicts = [];

  try {
    const [evSnap, reSnap, resSnap, schedSnap] = await Promise.all([
      getDocs(query(collection(db, "events"), where("date", "==", reservation.date))),
      getDocs(collection(db, "roomReassignments")),
      getDocs(query(collection(db, "reservationRequests"), where("date", "==", reservation.date))),
      roomId
        ? getDocs(collection(db, "rooms", roomId, "schedules"))
        : Promise.resolve({ docs: [] }),
    ]);

    evSnap.docs.forEach((d) => {
      const e = { id: d.id, ...d.data() };
      if (String(e.status || "").toLowerCase() === "cancelled") return;
      if (!matchesRoom(e)) return;
      if (skipReservationId && e.reservationId === skipReservationId) return;
      if (e.reservationId && e.reservationId === reservation.id) return;
      const s = parseTimeToMin(e.startTime);
      const en = parseTimeToMin(e.endTime);
      if (s == null || en == null) return;
      if (!overlap(reqStart, reqEnd, s, en)) return;
      conflicts.push({
        id: e.id, kind: "event", label: "Room Activity",
        title: e.title || e.purpose || "Room Activity",
        faculty: e.faculty || e.requestedByName || "Admin",
        startTime: e.startTime, endTime: e.endTime,
      });
    });

    reSnap.docs.forEach((d) => {
      const r = { id: d.id, ...d.data() };
      if (r.date !== reservation.date) return;
      const status = String(r.status || "").toLowerCase();
      if (status !== "accepted" && status !== "approved") return;
      const into = (roomId && r.newRoomId === roomId) || (roomName && r.newRoomName === roomName);
      if (!into) return;
      const s = parseTimeToMin(r.startTime);
      const en = parseTimeToMin(r.endTime);
      if (s == null || en == null) return;
      if (!overlap(reqStart, reqEnd, s, en)) return;
      conflicts.push({
        id: r.id, kind: "reassignment", label: "Reassigned Class",
        title: r.courseTitle || r.eventTitle || "Reassigned Class",
        faculty: r.facultyName || "-",
        startTime: r.startTime, endTime: r.endTime,
      });
    });

    resSnap.docs.forEach((d) => {
      const r = { id: d.id, ...d.data() };
      if (skipReservationId && r.id === skipReservationId) return;
      if (r.id === reservation.id) return;
      if (String(r.status || "").toLowerCase() !== "approved") return;
      if (!matchesRoom(r)) return;
      const s = parseTimeToMin(r.startTime);
      const en = parseTimeToMin(r.endTime);
      if (s == null || en == null) return;
      if (!overlap(reqStart, reqEnd, s, en)) return;
      const isWalkIn = String(r.reservationType || "").toLowerCase() === "walk-in";
      conflicts.push({
        id: r.id, kind: "reservation",
        label: isWalkIn ? "Walk-in Reservation" : "Faculty Reservation",
        title: r.customPurpose || r.courseTitle || r.purpose || "Reservation",
        faculty: r.requesterName || r.facultyName || "-",
        startTime: r.startTime, endTime: r.endTime,
      });
    });

    if (schedSnap.docs?.length) {
      const day = new Date(`${reservation.date}T00:00:00`)
        .toLocaleDateString("en-US", { weekday: "short" }).toUpperCase();
      schedSnap.docs.forEach((d) => {
        const s = { id: d.id, ...d.data() };
        if (s.cancelled || s.initialized) return;
        if (s.day !== day) return;
        const sT = parseTimeToMin(s.startTime);
        const eT = parseTimeToMin(s.endTime);
        if (sT == null || eT == null) return;
        if (!overlap(reqStart, reqEnd, sT, eT)) return;
        conflicts.push({
          id: s.id, kind: "schedule", label: "Class Schedule",
          title: s.subject || s.courseTitle || s.title || "Class",
          faculty: s.facultyName || s.faculty || "-",
          startTime: s.startTime, endTime: s.endTime,
        });
      });
    }
  } catch (err) {
    console.error("Conflict check failed:", err);
  }

  return conflicts;
};

// ══════════════════════════════════════════════════════════════
// TIME PICKER POPOVER
// ══════════════════════════════════════════════════════════════
function TimePickerPopover({ value, onChange, onClose, minTime }) {
  const parsed = parseTime12(value || "");
  const [hour, setHour] = useState(parsed.hour);
  const [minute, setMinute] = useState(parsed.minute);
  const [period, setPeriod] = useState(parsed.period);

  const hours = Array.from({ length: 12 }, (_, i) => i + 1);
  const minutes = Array.from({ length: 12 }, (_, i) => i * 5);

  const hourListRef = useRef(null);
  const minuteListRef = useRef(null);

  useEffect(() => {
    requestAnimationFrame(() => {
      hourListRef.current?.querySelector(".dh-time-item.is-active")
        ?.scrollIntoView({ block: "center", behavior: "instant" });
      minuteListRef.current?.querySelector(".dh-time-item.is-active")
        ?.scrollIntoView({ block: "center", behavior: "instant" });
    });
  }, []);

  const isDisabled = (h12, m, per) => {
    if (!minTime) return false;
    return toTime24(h12, m, per) < minTime;
  };

  const commit = (h = hour, m = minute, p = period) => onChange(toTime24(h, m, p));
  const handleHour = (h) => { if (!isDisabled(h, minute, period)) { setHour(h); commit(h, minute, period); } };
  const handleMinute = (m) => { if (!isDisabled(hour, m, period)) { setMinute(m); commit(hour, m, period); } };
  const handlePeriod = (p) => { if (!isDisabled(hour, minute, p)) { setPeriod(p); commit(hour, minute, p); } };

  return (
    <>
      <div className="dh-picker-clickaway" onClick={onClose} />
      <div className="dh-time-popover">
        <span className="dh-popover-arrow" />

        <div className="dh-time-period-row">
          <button type="button" className={`dh-time-period-btn ${period === "AM" ? "is-active" : ""}`} onClick={() => handlePeriod("AM")}>AM</button>
          <button type="button" className={`dh-time-period-btn ${period === "PM" ? "is-active" : ""}`} onClick={() => handlePeriod("PM")}>PM</button>
        </div>

        <div className="dh-time-columns">
          <div className="dh-time-col">
            <span className="dh-time-col-title">Hour</span>
            <div className="dh-time-list" ref={hourListRef}>
              {hours.map((h) => {
                const dis = isDisabled(h, minute, period);
                return (
                  <button key={h} type="button" disabled={dis}
                    className={`dh-time-item ${hour === h ? "is-active" : ""} ${dis ? "is-disabled" : ""}`}
                    onClick={() => handleHour(h)}>
                    {String(h).padStart(2, "0")}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="dh-time-col">
            <span className="dh-time-col-title">Minute</span>
            <div className="dh-time-list" ref={minuteListRef}>
              {minutes.map((m) => {
                const dis = isDisabled(hour, m, period);
                return (
                  <button key={m} type="button" disabled={dis}
                    className={`dh-time-item ${minute === m ? "is-active" : ""} ${dis ? "is-disabled" : ""}`}
                    onClick={() => handleMinute(m)}>
                    {String(m).padStart(2, "0")}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="dh-time-footer">
          <button type="button" className="dh-time-done-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </>
  );
}

// ══════════════════════════════════════════════════════════════
// DATE PICKER POPOVER
// ══════════════════════════════════════════════════════════════
function DatePickerPopover({ value, onChange, onClose, minDate }) {
  const base = value ? new Date(`${value}T00:00:00`) : new Date();
  const [cursor, setCursor] = useState({
    year: base.getFullYear(),
    month: base.getMonth(),
  });

  const min = minDate || getTodayLocal();

  return (
    <>
      <div className="dh-picker-clickaway" onClick={onClose} />
      <div className="dh-date-popover">
        <span className="dh-popover-arrow" />

        <div className="dh-date-quick-row">
          <button type="button" className={value === getTodayLocal() ? "active" : ""}
            onClick={() => { onChange(getTodayLocal()); onClose(); }}>
            Today
          </button>
          <button type="button" className={value === "" ? "active" : ""}
            onClick={() => { onChange(""); onClose(); }}>
            Clear
          </button>
        </div>

        <div className="dh-cal-header">
          <button type="button" className="dh-cal-nav"
            onClick={() => setCursor((c) => {
              const m = c.month - 1;
              return m < 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month: m };
            })}>
            <i className="fa-solid fa-chevron-left"></i>
          </button>
          <span className="dh-cal-title">{MONTH_NAMES[cursor.month]} {cursor.year}</span>
          <button type="button" className="dh-cal-nav"
            onClick={() => setCursor((c) => {
              const m = c.month + 1;
              return m > 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: m };
            })}>
            <i className="fa-solid fa-chevron-right"></i>
          </button>
        </div>

        <div className="dh-cal-weekdays">
          {WEEKDAY_LABELS.map((w) => <span key={w}>{w}</span>)}
        </div>

        <div className="dh-cal-grid">
          {buildCalendarGrid(cursor.year, cursor.month).map((cell, i) => {
            const cellStr = toDateInputValue(cell.date);
            const isSelected = cellStr === value;
            const dis = minDate && cellStr < min;
            return (
              <button type="button" key={i} disabled={dis}
                className={[
                  "dh-cal-day",
                  !cell.inMonth && "is-outside",
                  isSelected && "is-selected",
                  dis && "is-disabled",
                ].filter(Boolean).join(" ")}
                onClick={() => { onChange(cellStr); onClose(); }}>
                {cell.day}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ══════════════════════════════════════════════════════════════
// ROOM PICKER POPOVER
// ══════════════════════════════════════════════════════════════
function RoomPickerPopover({
  value,
  rooms,
  onChange,
  onClose,
  currentRoomName,
  currentRoomMissing,
  loadingRooms,
}) {
  const [search, setSearch] = useState("");

  const sorted = useMemo(() => {
    return [...rooms].sort((a, b) =>
      (a.roomName || "").localeCompare(b.roomName || "", undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );
  }, [rooms]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((r) => {
      const name = (r.roomName || "").toLowerCase();
      const floor = String(r.floor || "").toLowerCase();
      return name.includes(q) || floor.includes(q);
    });
  }, [sorted, search]);

  return (
    <>
      <div className="dh-picker-clickaway" onClick={onClose} />
      <div className="dh-room-popover-edit">
        <span className="dh-popover-arrow" />

        <div className="dh-search-wrap">
          <i className="fa-solid fa-magnifying-glass"></i>
          <input
            type="text"
            className="dh-search"
            placeholder="Search room or floor..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          {search && (
            <button type="button" className="dh-search-clear" onClick={() => setSearch("")}>
              <i className="fa-solid fa-xmark"></i>
            </button>
          )}
        </div>

        <div className="dh-room-list">
          {loadingRooms ? (
            <div className="dh-picker-loading">
              <i className="fa-solid fa-circle-notch fa-spin"></i>
              <span>Loading rooms…</span>
            </div>
          ) : (
            <>
              {currentRoomMissing && currentRoomName && !search && (
                <button
                  type="button"
                  className={`dh-room-option dh-room-option-warn ${value === currentRoomName ? "is-active" : ""}`}
                  onClick={() => { onChange(currentRoomName); onClose(); }}
                >
                  <div className="dh-room-option-icon dh-room-option-icon-warn">
                    <i className="fa-solid fa-triangle-exclamation"></i>
                  </div>
                  <div className="dh-room-option-body">
                    <span className="dh-room-option-name">{currentRoomName}</span>
                    <span className="dh-room-option-meta dh-room-option-meta-warn">
                      Current — not available for this slot
                    </span>
                  </div>
                  {value === currentRoomName && (
                    <i className="fa-solid fa-circle-check dh-room-option-check"></i>
                  )}
                </button>
              )}

              {filtered.length === 0 ? (
                <div className="dh-picker-empty">
                  <i className="fa-regular fa-face-frown"></i>
                  <span>No rooms match your search.</span>
                </div>
              ) : (
                filtered.map((r) => {
                  const isActive = r.roomName === value;
                  const isMaintenance = r.roomStatus === "maintenance";
                  return (
                    <button
                      type="button"
                      key={r.id}
                      className={`dh-room-option ${isActive ? "is-active" : ""}`}
                      onClick={() => { onChange(r.roomName); onClose(); }}
                    >
                      <div className="dh-room-option-icon">
                        <i className="fa-solid fa-door-open"></i>
                      </div>
                      <div className="dh-room-option-body">
                        <span className="dh-room-option-name">{r.roomName}</span>
                        <span className="dh-room-option-meta">
                          {r.floor && (<><i className="fa-solid fa-building"></i>{r.floor}</>)}
                          {r.capacity && (
                            <>
                              <span className="dh-room-dot">•</span>
                              <i className="fa-solid fa-users"></i>{r.capacity}
                            </>
                          )}
                          {isMaintenance && (
                            <>
                              <span className="dh-room-dot">•</span>
                              <i className="fa-solid fa-wrench"></i>Maintenance
                            </>
                          )}
                        </span>
                      </div>
                      {isActive && (
                        <i className="fa-solid fa-circle-check dh-room-option-check"></i>
                      )}
                    </button>
                  );
                })
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════
function AdminEditApprovedReservation() {
  const navigate = useNavigate();
  const location = useLocation();
  const initialReservation = location.state?.reservation;

  const [reservation, setReservation] = useState(initialReservation);

  const [toast, setToast] = useState({
    show: false, type: "success", title: "", message: "",
  });
  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    if (type !== "loading") {
      setTimeout(() => setToast((p) => ({ ...p, show: false })), 4000);
    }
  };

  const [editableFields, setEditableFields] = useState({
    roomName: "", date: "", startTime: "", endTime: "",
  });
  const [originalFields, setOriginalFields] = useState({
    roomName: "", date: "", startTime: "", endTime: "",
  });

  const [allRooms, setAllRooms] = useState([]);
  const [availableRooms, setAvailableRooms] = useState([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [loadingAvailable, setLoadingAvailable] = useState(false);

  const [conflicts, setConflicts] = useState([]);
  const [checkingConflicts, setCheckingConflicts] = useState(false);

  const [fieldError, setFieldError] = useState({ field: "", message: "" });
  const [conflictError, setConflictError] = useState("");
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saving, setSaving] = useState(false);

  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showStartTimePicker, setShowStartTimePicker] = useState(false);
  const [showEndTimePicker, setShowEndTimePicker] = useState(false);
  const [showRoomPicker, setShowRoomPicker] = useState(false);

  const purpose = reservation?.purpose || "";
  const isOtherActivity = purpose === "Other Activity";
  const customPurpose = reservation?.attendees?.customPurpose || "";
  const audienceType = reservation?.audienceType || "";
  const studentRange = reservation?.studentRange || "";
  const requiredEquipment = reservation?.requiredEquipment || [];
  const courseTitle = reservation?.courseTitle || "";
  const facultyName = reservation?.facultyName || reservation?.requesterName || "";

  const reservationIsPast = isPastDate(reservation?.date);

  const hasChanges = useMemo(
    () =>
      editableFields.roomName !== originalFields.roomName ||
      editableFields.date !== originalFields.date ||
      editableFields.startTime !== originalFields.startTime ||
      editableFields.endTime !== originalFields.endTime,
    [editableFields, originalFields]
  );

  const availabilityReady =
    !loadingRooms &&
    !loadingAvailable &&
    !!editableFields.date &&
    !!editableFields.startTime &&
    !!editableFields.endTime;

  const currentRoomUnavailable =
    availabilityReady &&
    !!editableFields.roomName &&
    !availableRooms.some((r) => r.roomName === editableFields.roomName);

  // Live listener
  useEffect(() => {
    if (!initialReservation?.id) return;
    const unsub = onSnapshot(
      doc(db, "reservationRequests", initialReservation.id),
      (snap) => {
        if (snap.exists()) setReservation({ id: snap.id, ...snap.data() });
      },
      (err) => console.warn("Live reservation listener failed:", err)
    );
    return () => unsub();
  }, [initialReservation?.id]);

  // Initial load
  useEffect(() => {
    if (!reservation) {
      navigate("/admin/reservations");
      return;
    }
    const initial = {
      roomName: reservation.roomName || "",
      date: reservation.date || "",
      startTime: reservation.startTime || "",
      endTime: reservation.endTime || "",
    };
    setEditableFields(initial);
    setOriginalFields(initial);
    loadAllRooms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservation?.id]);

  const loadAllRooms = async () => {
    setLoadingRooms(true);
    try {
      const snap = await getDocs(collection(db, "rooms"));
      const data = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setAllRooms(data);
      fetchAvailableRooms(data, editableFields.date, editableFields.startTime, editableFields.endTime);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingRooms(false);
    }
  };

  const fetchAvailableRooms = async (roomsList = allRooms, date, startTime, endTime) => {
    if (!date || !startTime || !endTime || roomsList.length === 0) {
      setAvailableRooms([]);
      return;
    }

    setLoadingAvailable(true);
    try {
      const dayAbbrev = getDayAbbrev(date);

      const [releaseSnap, reassignSnap, eventSnap, reservationSnap] = await Promise.all([
        getDocs(collection(db, "roomReleases")),
        getDocs(collection(db, "roomReassignments")),
        getDocs(query(collection(db, "events"), where("date", "==", date))),
        getDocs(query(
          collection(db, "reservationRequests"),
          where("date", "==", date),
          where("status", "==", "approved")
        )),
      ]);

      const releases = releaseSnap.docs.map((d) => d.data());
      const reassignments = reassignSnap.docs.map((d) => d.data())
        .filter((r) => normalize(r.status) === "approved");
      const events = eventSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const reservations = reservationSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .filter((r) => r.id !== reservation.id);

      const releaseKeys = new Set(
        releases.filter((r) => r.date === date).map((r) => `${r.scheduleId}_${r.date}`)
      );
      const reassignAwayKeys = new Set(
        reassignments.filter((r) => r.date === date && r.oldRoomId)
          .map((r) => `${r.scheduleId}_${r.date}`)
      );

      const reassignIntoMap = {};
      reassignments
        .filter((r) => r.date === date && r.newRoomId)
        .forEach((r) => {
          if (!reassignIntoMap[r.newRoomId]) reassignIntoMap[r.newRoomId] = [];
          reassignIntoMap[r.newRoomId].push(r);
        });

      const available = [];

      for (const room of roomsList) {
        if (isRoomUnderMaintenance(room, date, startTime, endTime)) continue;

        const scheduleSnap = await getDocs(collection(db, "rooms", room.id, "schedules"));
        const schedules = scheduleSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
          .filter((s) => !s.initialized && s.day === dayAbbrev);

        const hasScheduleConflict = schedules.some((sched) => {
          const key = `${sched.id}_${date}`;
          if (releaseKeys.has(key)) return false;
          if (reassignAwayKeys.has(key)) return false;
          return overlap(startTime, endTime, sched.startTime, sched.endTime);
        });
        if (hasScheduleConflict) continue;

        const hasEventConflict = events.some(
          (e) => e.roomId === room.id &&
            e.reservationId !== reservation.id &&
            overlap(startTime, endTime, e.startTime, e.endTime)
        );
        if (hasEventConflict) continue;

        const hasReservationConflict = reservations.some(
          (r) => r.roomId === room.id && overlap(startTime, endTime, r.startTime, r.endTime)
        );
        if (hasReservationConflict) continue;

        const reassignInto = reassignIntoMap[room.id] || [];
        const hasReassignConflict = reassignInto.some((r) =>
          overlap(startTime, endTime, r.startTime, r.endTime)
        );
        if (hasReassignConflict) continue;

        if (purpose === "Hands-on" && requiredEquipment.length > 0) {
          const roomEquipment = Object.entries(room.equipment || {})
            .filter(([, value]) => value === true)
            .map(([key]) => key.toLowerCase());
          const hasAllEquipment = requiredEquipment.every((eq) =>
            roomEquipment.includes(eq.toLowerCase())
          );
          if (!hasAllEquipment) continue;
        }

        if ((purpose === "Lecture" || purpose === "Examination") && studentRange) {
          const minCapacity = {
            "30-50": 30, "50-60": 50, "60-80": 60, "80-100": 80,
          }[studentRange] || 0;
          if (Number(room.capacity || 0) < minCapacity) continue;
        }

        available.push(room);
      }

      setAvailableRooms(available);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingAvailable(false);
    }
  };

  useEffect(() => {
    if (allRooms.length > 0 && editableFields.date && editableFields.startTime && editableFields.endTime) {
      fetchAvailableRooms(allRooms, editableFields.date, editableFields.startTime, editableFields.endTime);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editableFields.date, editableFields.startTime, editableFields.endTime, allRooms]);

  // Live conflict check — with sync flag
  useEffect(() => {
    if (!editableFields.roomName || !editableFields.date ||
        !editableFields.startTime || !editableFields.endTime) {
      setConflicts([]);
      setCheckingConflicts(false);
      return;
    }

    setCheckingConflicts(true);

    const timer = setTimeout(async () => {
      const roomObj = allRooms.find((r) => r.roomName === editableFields.roomName);
      const found = await checkReservationConflicts(
        {
          ...reservation,
          roomId: roomObj?.id || reservation.roomId,
          roomName: editableFields.roomName,
          date: editableFields.date,
          startTime: editableFields.startTime,
          endTime: editableFields.endTime,
        },
        reservation.id
      );
      setConflicts(found);
      setCheckingConflicts(false);
    }, 350);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editableFields, allRooms, reservation?.id]);

  const commitField = (field, value) => {
    setFieldError({ field: "", message: "" });
    setConflictError("");

    if (field === "date" && value && isPastDate(value)) {
      setFieldError({
        field: "date",
        message: "You cannot select a past date. Please choose today or a future date.",
      });
      return;
    }

    if (field === "startTime" && value && editableFields.date === getTodayLocal() &&
        isPastDateTime(editableFields.date, value)) {
      setFieldError({
        field: "startTime",
        message: "Start time cannot be in the past for today's date.",
      });
      return;
    }

    if (field === "endTime" && value && editableFields.startTime &&
        convertToMinutes(value) <= convertToMinutes(editableFields.startTime)) {
      setFieldError({
        field: "endTime",
        message: "End time must be after the start time.",
      });
      return;
    }

    setEditableFields((prev) => ({ ...prev, [field]: value }));
  };

  const checkConflicts = async () => {
    const { roomName, date, startTime, endTime } = editableFields;
    if (!roomName || !date || !startTime || !endTime) return "Please select a room, date, and time.";
    if (isPastDate(date)) return "Cannot schedule a past date.";
    if (date === getTodayLocal() && isPastDateTime(date, startTime)) return "Start time cannot be in the past.";
    if (convertToMinutes(endTime) <= convertToMinutes(startTime)) return "End time must be after the start time.";

    const room = allRooms.find((r) => r.roomName === roomName);
    if (!room) return "Selected room not found.";
    if (isRoomUnderMaintenance(room, date, startTime, endTime))
      return "This room is under maintenance during the selected time.";
    if (!availableRooms.some((r) => r.roomName === roomName))
      return "This room is not available for the selected date/time and purpose.";

    const live = await checkReservationConflicts(
      { ...reservation, roomId: room.id, roomName, date, startTime, endTime },
      reservation.id
    );
    if (live.length > 0) return `Conflicts detected (${live.length}). Resolve before saving.`;

    return null;
  };

  const handleSave = async () => {
    if (reservationIsPast) {
      showToast("error", "Edit Not Allowed",
        "This reservation's date has already passed and can no longer be edited.");
      setShowSaveModal(false);
      return;
    }

    setSaving(true);
    showToast("loading", "Saving", "Updating reservation...");

    try {
      const conflict = await checkConflicts();
      if (conflict) {
        setConflictError(conflict);
        showToast("error", "Conflict Detected", conflict);
        setSaving(false);
        return;
      }

      const firebaseUser = auth.currentUser;
      let currentUser = {};
      let adminName = "Admin";
      if (firebaseUser) {
        const userSnap = await getDoc(doc(db, "users", firebaseUser.uid));
        if (userSnap.exists()) {
          currentUser = userSnap.data();
          adminName = `${currentUser.firstName || ""} ${currentUser.lastName || ""}`.trim() || "Admin";
        }
      }

      const room = allRooms.find((r) => r.roomName === editableFields.roomName);

      await updateDoc(doc(db, "reservationRequests", reservation.id), {
        roomName: editableFields.roomName,
        roomId: room?.id || reservation.roomId,
        date: editableFields.date,
        startTime: editableFields.startTime,
        endTime: editableFields.endTime,
        updatedAt: serverTimestamp(),
        updatedBy: adminName,
      });

      // Sync generated event
      try {
        const evSnap = await getDocs(query(
          collection(db, "events"),
          where("reservationId", "==", reservation.id)
        ));
        for (const ev of evSnap.docs) {
          await updateDoc(doc(db, "events", ev.id), {
            roomName: editableFields.roomName,
            roomId: room?.id || reservation.roomId,
            date: editableFields.date,
            startTime: editableFields.startTime,
            endTime: editableFields.endTime,
            updatedAt: serverTimestamp(),
          });
        }
      } catch (err) {
        console.warn("Event sync failed:", err);
      }

      await logActivity({
        userId: firebaseUser?.uid || "",
        user: adminName,
        role: "Admin",
        action: "Updated Approved Reservation",
        actionType: "edit",
        target: `${editableFields.roomName} - ${courseTitle}`,
        status: "SUCCESS",
        details: {
          reservationId: reservation.id,
          previous: originalFields,
          updated: editableFields,
        },
      });

      // ─── Notifications ───────────────────────────────────────
      let facultyUserId = reservation.userId;
      if (!facultyUserId && facultyName) {
        const u = await findUserByName(facultyName);
        if (u) facultyUserId = u.id;
      }
      if (facultyUserId) {
        await sendNotification(
          facultyUserId, "faculty", "Reservation Updated",
          `Your reservation for ${editableFields.roomName} on ${editableFields.date} ` +
            `(${format12Hour(editableFields.startTime)} - ${format12Hour(editableFields.endTime)}) ` +
            `has been updated by Admin.`,
          "reservation-updated", "INFO"
        );
      }

      if (firebaseUser?.uid) {
        await sendNotification(
          firebaseUser.uid, "admin", "Reservation Updated",
          `You updated ${facultyName}'s reservation for ${editableFields.roomName}.`,
          "reservation-updated", "INFO"
        );
      }

      const usersSnap = await getDocs(collection(db, "users"));
      const clerkJobs = [];
      usersSnap.forEach((d) => {
        if (normalize(d.data().role) === "clerk") {
          clerkJobs.push(sendNotification(
            d.id, "clerk", "Reservation Updated",
            `${facultyName}'s reservation for ${editableFields.roomName} was updated by Admin.`,
            "reservation-updated", "INFO"
          ));
        }
      });
      await Promise.all(clerkJobs);

      setShowSaveModal(false);
      showToast("success", "Success", "Reservation updated successfully!");

      setTimeout(() => navigate("/admin/reservations"), 1500);
    } catch (err) {
      console.error(err);
      showToast("error", "Error", err.message || "Failed to update reservation.");
    } finally {
      setSaving(false);
    }
  };

  if (!reservation) {
    return (
      <div className="dph-edit-approved-room">
        <div className="white-box-edit-approved">
          <h2>Reservation not found.</h2>
          <button onClick={() => navigate("/admin/reservations")}>Back</button>
        </div>
      </div>
    );
  }

  // Synthetic unavailable-room conflict
  const effectiveConflicts = currentRoomUnavailable
    ? [
        {
          id: "unavailable-room",
          kind: "unavailable",
          label: "Room Unavailable",
          title: editableFields.roomName,
          faculty: "",
          startTime: editableFields.startTime,
          endTime: editableFields.endTime,
        },
        ...conflicts,
      ]
    : conflicts;

  const hasConflicts = effectiveConflicts.length > 0;
  const isChecking = loadingAvailable || checkingConflicts;
  const canSave = hasChanges && !hasConflicts && !isChecking && !saving && !reservationIsPast;
  const startTimeMin = editableFields.date === getTodayLocal() ? getNowTimeLocal() : null;

  return (
    <div className="dph-edit-approved-room">
      <div className="white-box-edit-approved">

        {/* Header */}
        <div className="dh-edit-header">
          <div>
            <h2 className="dph-edit-approved-title">Edit Approved Reservation</h2>
            <p className="dh-edit-subtitle">
              Update the room, date, or time. Conflicts are checked in real time.
            </p>
          </div>
        </div>

        {/* Banners */}
        {reservationIsPast && (
          <div className="dh-edit-locked-banner">
            <i className="fa-solid fa-triangle-exclamation"></i>
            <div className="dh-edit-locked-text">
              <strong>Past-dated Reservation</strong>
              <span>
                This reservation was scheduled on <b>{formatDateLong(reservation.date)}</b>.
                You can review the details, but you cannot change them to a past date/time.
              </span>
            </div>
          </div>
        )}

        {fieldError.message && (
          <div className="dh-edit-conflict-banner">
            <i className="fa-solid fa-circle-exclamation"></i>
            <span>{fieldError.message}</span>
          </div>
        )}

        {conflictError && !fieldError.message && (
          <div className="dh-edit-conflict-banner">
            <i className="fa-solid fa-triangle-exclamation"></i>
            <span>{conflictError}</span>
          </div>
        )}

        {/* Info Grid */}
        <div className="dh-edit-approved-info-grid">

          {/* Requester */}
          <div className="dh-edit-approved-info-box">
            <h3 className="dh-edit-approved-info-box-title">
              <i className="fa-solid fa-user"></i> Requester
            </h3>
            <div className="dh-edit-approved-info-box-content">
              <p><strong>Name:</strong> {facultyName || "Unknown"}</p>
              {audienceType === "Organization" && (
                <p><strong>Organization:</strong> {reservation.attendees?.organization || "N/A"}</p>
              )}
            </div>
          </div>

          {/* Course & Audience */}
          <div className="dh-edit-approved-info-box">
            <h3 className="dh-edit-approved-info-box-title">
              <i className="fa-solid fa-book"></i> Course & Audience
            </h3>
            <div className="dh-edit-approved-info-box-content">
              <p><strong>Course Title:</strong> {courseTitle || "N/A"}</p>
              <p><strong>Audience Type:</strong> {audienceType || "N/A"}</p>
              {audienceType === "Class" && (
                <>
                  <p><strong>Course:</strong> {reservation.attendees?.course || "N/A"}</p>
                  <p><strong>Year/Section:</strong> {reservation.attendees?.yearSectionGroup || "N/A"}</p>
                </>
              )}
            </div>
          </div>

          {/* Editable: Room & Schedule (full width) */}
          <div className="dh-edit-approved-info-box editable">
            <h3 className="dh-edit-approved-info-box-title editable-title">
              <i className="fa-solid fa-pen-to-square"></i> Room & Schedule
              <span className="dh-editable-pill">Editable</span>
            </h3>

            <div className="dh-edit-approved-info-box-content">
              <div className="dh-edit-fields-grid">
                {/* ROOM */}
                <div className="dh-edit-approved-form-group dh-edit-span-2">
                  <label>Room</label>
                  <div className="dh-picker-inline">
                    <div className="dh-roompicker">
                      <button
                        type="button"
                        className={`dh-trigger ${showRoomPicker ? "open" : ""} ${
                          currentRoomUnavailable ? "is-warn" : ""
                        }`}
                        onClick={() => {
                          setShowRoomPicker((v) => !v);
                          setShowDatePicker(false);
                          setShowStartTimePicker(false);
                          setShowEndTimePicker(false);
                        }}
                        disabled={loadingRooms || saving || reservationIsPast}
                      >
                        {currentRoomUnavailable ? (
                          <i className="fa-solid fa-triangle-exclamation trigger-warn-icon"></i>
                        ) : (
                          <i className="fa-solid fa-door-open"></i>
                        )}
                        <span>
                          {reservationIsPast
                            ? "Editing disabled (past date)"
                            : loadingRooms
                            ? "Loading rooms..."
                            : loadingAvailable
                            ? `${editableFields.roomName || "Room"} — checking…`
                            : editableFields.roomName || "Select a room"}
                        </span>
                        {loadingAvailable && !reservationIsPast && (
                          <span className="dh-trigger-loading">
                            <i className="fa-solid fa-circle-notch fa-spin"></i>
                          </span>
                        )}
                        <i className={`fa-solid fa-chevron-down dh-caret ${showRoomPicker ? "open" : ""}`}></i>
                      </button>

                      {showRoomPicker && (
                        <RoomPickerPopover
                          value={editableFields.roomName}
                          rooms={availableRooms}
                          currentRoomName={editableFields.roomName}
                          currentRoomMissing={currentRoomUnavailable}
                          loadingRooms={loadingRooms || loadingAvailable}
                          onChange={(v) => commitField("roomName", v)}
                          onClose={() => setShowRoomPicker(false)}
                        />
                      )}
                    </div>
                  </div>
                </div>

                {/* DATE */}
                <div className="dh-edit-approved-form-group">
                  <label>Date</label>
                  <div className="dh-picker-inline">
                    <div className="dh-datepicker">
                      <button
                        type="button"
                        className={`dh-trigger ${showDatePicker ? "open" : ""}`}
                        onClick={() => {
                          setShowDatePicker((v) => !v);
                          setShowStartTimePicker(false);
                          setShowEndTimePicker(false);
                          setShowRoomPicker(false);
                        }}
                        disabled={saving || reservationIsPast}
                      >
                        <i className="fa-regular fa-calendar"></i>
                        <span>
                          {editableFields.date
                            ? formatDateLong(editableFields.date)
                            : "Select date"}
                        </span>
                        <i className={`fa-solid fa-chevron-down dh-caret ${showDatePicker ? "open" : ""}`}></i>
                      </button>

                      {showDatePicker && (
                        <DatePickerPopover
                          value={editableFields.date}
                          minDate={getTodayLocal()}
                          onChange={(v) => commitField("date", v)}
                          onClose={() => setShowDatePicker(false)}
                        />
                      )}
                    </div>
                  </div>
                  {fieldError.field === "date" && (
                    <small style={{ color: "#dc2626", marginTop: "4px" }}>
                      {fieldError.message}
                    </small>
                  )}
                </div>

                {/* TIME ROW */}
                <div className="dh-edit-time-pair">
                  <div className="dh-edit-approved-form-group">
                    <label>Start Time</label>
                    <div className="dh-picker-inline">
                      <div className="dh-timepicker">
                        <button
                          type="button"
                          className={`dh-trigger ${showStartTimePicker ? "open" : ""}`}
                          onClick={() => {
                            setShowStartTimePicker((v) => !v);
                            setShowDatePicker(false);
                            setShowEndTimePicker(false);
                            setShowRoomPicker(false);
                          }}
                          disabled={saving || reservationIsPast}
                        >
                          <i className="fa-regular fa-clock"></i>
                          <span>
                            {editableFields.startTime
                              ? format12Hour(editableFields.startTime)
                              : "Select time"}
                          </span>
                          <i className={`fa-solid fa-chevron-down dh-caret ${showStartTimePicker ? "open" : ""}`}></i>
                        </button>

                        {showStartTimePicker && (
                          <TimePickerPopover
                            value={editableFields.startTime}
                            minTime={startTimeMin}
                            onChange={(v) => commitField("startTime", v)}
                            onClose={() => setShowStartTimePicker(false)}
                          />
                        )}
                      </div>
                    </div>
                    {fieldError.field === "startTime" && (
                      <small style={{ color: "#dc2626", marginTop: "4px" }}>
                        {fieldError.message}
                      </small>
                    )}
                  </div>

                  <div className="dh-edit-approved-form-group">
                    <label>End Time</label>
                    <div className="dh-picker-inline">
                      <div className="dh-timepicker">
                        <button
                          type="button"
                          className={`dh-trigger ${showEndTimePicker ? "open" : ""}`}
                          onClick={() => {
                            setShowEndTimePicker((v) => !v);
                            setShowDatePicker(false);
                            setShowStartTimePicker(false);
                            setShowRoomPicker(false);
                          }}
                          disabled={saving || reservationIsPast}
                        >
                          <i className="fa-regular fa-clock"></i>
                          <span>
                            {editableFields.endTime
                              ? format12Hour(editableFields.endTime)
                              : "Select time"}
                          </span>
                          <i className={`fa-solid fa-chevron-down dh-caret ${showEndTimePicker ? "open" : ""}`}></i>
                        </button>

                        {showEndTimePicker && (
                          <TimePickerPopover
                            value={editableFields.endTime}
                            minTime={editableFields.startTime || startTimeMin}
                            onChange={(v) => commitField("endTime", v)}
                            onClose={() => setShowEndTimePicker(false)}
                          />
                        )}
                      </div>
                    </div>
                    {fieldError.field === "endTime" && (
                      <small style={{ color: "#dc2626", marginTop: "4px" }}>
                        {fieldError.message}
                      </small>
                    )}
                  </div>
                </div>
              </div>

              {/* Live conflict indicator */}
              {!reservationIsPast && (
                <>
                  <div
                    className={`dh-conflict-status ${
                      isChecking ? "is-checking" : hasConflicts ? "is-error" : "is-ok"
                    }`}
                  >
                    {isChecking ? (
                      <>
                        <i className="fa-solid fa-circle-notch fa-spin"></i>
                        {loadingAvailable ? "Checking room availability…" : "Checking conflicts…"}
                      </>
                    ) : hasConflicts ? (
                      <>
                        <i className="fa-solid fa-triangle-exclamation"></i>
                        {effectiveConflicts.length} conflict{effectiveConflicts.length > 1 ? "s" : ""} detected — cannot save
                      </>
                    ) : (
                      <><i className="fa-solid fa-circle-check"></i> No conflicts detected</>
                    )}
                  </div>

                  {hasConflicts && !isChecking && (
                    <ul className="dh-conflict-list">
                      {effectiveConflicts.map((c) => (
                        <li key={`${c.kind}-${c.id}`} className="dh-conflict-item">
                          <span
                            className={`dh-conflict-label ${
                              c.kind === "event" ? "type-event"
                              : c.kind === "reassignment" ? "type-reassign"
                              : c.kind === "reservation" ? "type-res"
                              : c.kind === "unavailable" ? "type-unavailable"
                              : "type-sched"
                            }`}
                          >
                            <i
                              className={
                                c.kind === "event" ? "fa-solid fa-calendar-star"
                                : c.kind === "reassignment" ? "fa-solid fa-right-left"
                                : c.kind === "reservation" ? "fa-solid fa-book-bookmark"
                                : c.kind === "unavailable" ? "fa-solid fa-door-closed"
                                : "fa-solid fa-chalkboard-user"
                              }
                            ></i>
                            {c.label}
                          </span>
                          <div className="dh-conflict-title">
                            {c.kind === "unavailable"
                              ? `${c.title} is not available for this date/time`
                              : c.title}
                          </div>
                          <div className="dh-conflict-meta">
                            {c.startTime && c.endTime
                              ? `${format12Hour(c.startTime)} – ${format12Hour(c.endTime)}`
                              : "Please select another room or change the schedule."}
                            {c.faculty ? ` · ${c.faculty}` : ""}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Purpose */}
          <div className="dh-edit-approved-info-box">
            <h3 className="dh-edit-approved-info-box-title">
              <i className="fa-solid fa-pen"></i> Purpose
            </h3>
            <div className="dh-edit-approved-info-box-content">
              <p><strong>Purpose:</strong> {purpose || "N/A"}</p>
              {isOtherActivity && customPurpose && (
                <p><strong>Specified Activity:</strong> {customPurpose}</p>
              )}
              {requiredEquipment.length > 0 && (
                <p>
                  <strong>Required Equipment:</strong>{" "}
                  {requiredEquipment.map(
                    (eq) => ({
                      projector: "Projector", tvDisplay: "TV Display",
                      ac: "AC", computer: "Computer", smartBoard: "Smart Board",
                    }[eq] || eq)
                  ).join(", ")}
                </p>
              )}
              {studentRange && (
                <p><strong>Estimated Attendees:</strong> {studentRange}</p>
              )}
            </div>
          </div>

          {/* Metadata */}
          <div className="dh-edit-approved-info-box">
            <h3 className="dh-edit-approved-info-box-title">
              <i className="fa-solid fa-circle-info"></i> Metadata
            </h3>
            <div className="dh-edit-approved-info-box-content">
              <p>
                <strong>Status:</strong>{" "}
                <span className="dh-edit-approved-status-badge approved">Approved</span>
              </p>
              <p>
                <strong>Requested On:</strong>{" "}
                {new Date(reservation.createdAt?.seconds * 1000 || Date.now()).toLocaleDateString()}
              </p>
              {reservation.updatedAt && (
                <p>
                  <strong>Last Updated:</strong>{" "}
                  {new Date(reservation.updatedAt?.seconds * 1000 || Date.now()).toLocaleString()}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="dh-edit-approved-footer">
        <button
          className="dh-edit-approved-back-btn"
          onClick={() => navigate(-1)}
          disabled={saving}
        >
          Back
        </button>
        <button
          className="dh-edit-save-btn"
          onClick={() => {
            if (reservationIsPast) {
              showToast("error", "Edit Not Allowed",
                "This reservation's date has already passed and can no longer be edited.");
              return;
            }
            if (!editableFields.roomName) {
              setConflictError("Please select a room.");
              showToast("error", "Error", "Please select a room.");
              return;
            }
            if (isChecking) {
              setConflictError("Please wait — still checking availability and conflicts.");
              showToast("error", "Please Wait", "Still checking conflicts…");
              return;
            }
            if (currentRoomUnavailable) {
              const msg = `${editableFields.roomName} is not available for this date/time. Please select another room.`;
              setConflictError(msg);
              showToast("error", "Room Unavailable", msg);
              return;
            }
            if (hasConflicts) {
              setConflictError(
                `Cannot save — ${effectiveConflicts.length} conflict${effectiveConflicts.length > 1 ? "s" : ""} detected.`
              );
              showToast("error", "Conflicts Detected", "Resolve conflicts before saving.");
              return;
            }
            if (!hasChanges) {
              showToast("error", "No Changes", "No changes to save.");
              return;
            }
            setShowSaveModal(true);
          }}
          disabled={!canSave}
          title={
            reservationIsPast ? "Cannot edit — this reservation's date has passed"
            : hasConflicts ? "Resolve conflicts before saving"
            : !hasChanges ? "No changes to save"
            : isChecking ? "Checking conflicts…"
            : undefined
          }
        >
          {saving ? "Saving..."
            : reservationIsPast ? "Editing Locked"
            : isChecking ? "Checking…"
            : hasConflicts ? "Conflicts Found"
            : !hasChanges ? "No Changes"
            : "Save Changes"}
        </button>
      </div>

      {showSaveModal && (
        <SavePopup onCancel={() => setShowSaveModal(false)} onConfirm={handleSave} />
      )}

      <Toast
        show={toast.show} type={toast.type} title={toast.title} message={toast.message}
        onClose={() => setToast((p) => ({ ...p, show: false }))}
      />
    </div>
  );
}

export default AdminEditApprovedReservation;