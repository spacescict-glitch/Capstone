import { useState, useEffect } from "react";
import "./room-activity.css";
import Toast from "../../Popup/Toast/Toast";
import RoomActivityListModal from "../../Components/RoomActivityListModal/RoomActivityListModal";
import {
  collection, onSnapshot, addDoc, getDocs, serverTimestamp, doc, getDoc,
} from "firebase/firestore";
import { auth, db } from "../../firebase";
import { logActivity } from "../../utils/logActivity";
import { isRoomUnderMaintenance } from "../../utils/Roommaintenance";
import { findFacultyUser, findFacultyUserByName } from "../../utils/findFacultyUser";

// ═══════════════════════════════════════════════════════════════════
// Reassignment status helpers
//
// A reassignment is "in effect" only after the faculty ACCEPTS it.
// The Admin flow sets: pending_admin → pending_faculty → accepted
// (NOT "approved"). Legacy "approved" kept for backward-compat.
// ═══════════════════════════════════════════════════════════════════
const ACCEPTED_REASSIGN_STATUSES = new Set(["accepted", "approved"]);
const isAcceptedReassign = (r) =>
  ACCEPTED_REASSIGN_STATUSES.has(String(r.status || "").toLowerCase());

// Conflict kinds that HARD-BLOCK submission. Schedules & reassignments
// stay as warnings (the Admin decides whether to move or cancel them).
const BLOCKING_CONFLICT_KINDS = new Set(["event", "reservation"]);

// ─── Time helpers ────────────────────────────────────────────────
function parseTime(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}
function formatTime12(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${period}`;
}
function formatDuration(start, end) {
  const s = parseTime(start);
  const e = parseTime(end);
  if (s == null || e == null || e <= s) return "";
  const mins = e - s;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
function formatDateLong(dateStr) {
  if (!dateStr) return "";
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
}

const toDateInputValue = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const todayString = () => toDateInputValue(new Date());

const addDaysLocal = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toDateInputValue(d);
};

const ARCHIVE_AFTER_DAYS = 30;

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

const buildTimeOptions = () => {
  const options = [];
  for (let m = 7 * 60; m <= 20 * 60; m += 30) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    const value = `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    options.push({ value, label: formatTime12(value) });
  }
  return options;
};
const TIME_OPTIONS = buildTimeOptions();

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

const CONFLICT_KIND_ICON = {
  schedule: "fa-solid fa-chalkboard-user",
  event: "fa-solid fa-calendar-star",
  reservation: "fa-solid fa-book-bookmark",
  reassignment: "fa-solid fa-right-left",
};

export default function RoomActivity() {
  const [toast, setToast] = useState({ show: false, type: "success", title: "", message: "" });
  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    if (type !== "loading") setTimeout(() => setToast((p) => ({ ...p, show: false })), 4000);
  };

  const [rooms, setRooms] = useState([]);
  const [conflicts, setConflicts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showListModal, setShowListModal] = useState(false);
  const [showCustomTime, setShowCustomTime] = useState(false);

  // NEW: true when the selected room/time has a hard-blocking booking
  // (existing event or approved reservation).
  const [hasBlockingConflict, setHasBlockingConflict] = useState(false);

  const [showRoomPicker, setShowRoomPicker] = useState(false);
  const [roomSearch, setRoomSearch] = useState("");

  const [showDatePicker, setShowDatePicker] = useState(false);
  const [calendarCursor, setCalendarCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const [form, setForm] = useState({
    title: "", room: "", date: "", startTime: "", endTime: "", reason: "",
  });

  const [showModal, setShowModal] = useState(false);
  const [error, setError] = useState("");
  const [maintenanceBlocked, setMaintenanceBlocked] = useState(false);

  const filteredRooms = rooms
    .filter((r) => {
      const q = roomSearch.trim().toLowerCase();
      if (!q) return true;
      const name = String(r.roomName || r.name || "").toLowerCase();
      const floor = String(r.floor || "").toLowerCase();
      const building = String(r.building || r.bldg || "").toLowerCase();
      return name.includes(q) || floor.includes(q) || building.includes(q);
    })
    .sort((a, b) =>
      String(a.roomName || a.name || "").localeCompare(
        String(b.roomName || b.name || ""),
        undefined,
        { sensitivity: "base", numeric: true }
      )
    );

  const selectedRoom = rooms.find(
    (r) => (r.roomName || r.name) === form.room
  );

  // Aggregate counts so the conflict card can render correctly.
  const blockingConflicts = conflicts.filter((c) =>
    BLOCKING_CONFLICT_KINDS.has(c.kind)
  );
  const warningConflicts = conflicts.filter(
    (c) => !BLOCKING_CONFLICT_KINDS.has(c.kind)
  );

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "rooms"), (snap) => {
      setRooms(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
    return () => unsub();
  }, []);

  // ═════════════════════════════════════════════════════════════
  // CONFLICT DETECTION — strictly scoped to the SELECTED ROOM only.
  // Sources:
  //   1) Class schedules (this room, this weekday)
  //   2) Events (this room, this date)
  //   3) Approved reservations (walk-in + online)
  //   4) ACCEPTED reassignments into this room
  //   5) ACCEPTED reassignments away from this room (exclude)
  // ═════════════════════════════════════════════════════════════
  useEffect(() => {
    const checkConflict = async () => {
      setError("");
      if (!form.room || !form.date || !form.startTime || !form.endTime) {
        setConflicts([]);
        setHasBlockingConflict(false);
        return;
      }
      const room = rooms.find((r) => (r.roomName || r.name) === form.room);
      if (!room) return;

      setCheckingConflicts(true);
      const reqStart = parseTime(form.startTime);
      const reqEnd = parseTime(form.endTime);
      const day = new Date(`${form.date}T00:00:00`)
        .toLocaleDateString("en-US", { weekday: "short" })
        .toUpperCase();

      const results = [];
      const roomLabel = room.roomName || room.name;

      try {
        const [reSnap, schedSnap, evSnap, resSnap, relSnap] = await Promise.all([
          getDocs(collection(db, "roomReassignments")),
          getDocs(collection(db, "rooms", room.id, "schedules")),
          getDocs(collection(db, "events")),
          getDocs(collection(db, "reservationRequests")),
          getDocs(collection(db, "roomReleases")),
        ]);

        const allReassignments = reSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const allSchedules = schedSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const allEvents = evSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const allReservations = resSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const allReleases = relSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

        // ── Schedule IDs reassigned AWAY from this room on this date ──
        // ✅ FIX: include "accepted" (not just "approved").
        const reassignedAwayIds = new Set(
          allReassignments
            .filter(
              (r) =>
                isAcceptedReassign(r) &&
                r.date === form.date &&
                (r.oldRoomId === room.id || r.oldRoomName === roomLabel)
            )
            .map((r) => r.scheduleId)
            .filter(Boolean)
        );

        // ── Map of scheduleId → release info (for THIS date) ──
        const releaseMap = new Map();
        allReleases
          .filter(
            (r) =>
              r.date === form.date &&
              (r.roomId === room.id || r.roomName === roomLabel)
          )
          .forEach((r) => {
            if (r.scheduleId) releaseMap.set(r.scheduleId, r);
          });

        // ── Events happening IN THIS room on THIS date ──
        const roomEventsForDate = allEvents.filter(
          (e) =>
            (e.roomId === room.id || e.roomName === roomLabel) &&
            e.date === form.date
        );

        // ── 1) Class schedules (this room only) ──
        allSchedules
          .filter((s) => {
            if (s.cancelled || s.initialized) return false;
            if (s.day !== day) return false;
            if (reassignedAwayIds.has(s.id)) return false;

            const sStart = parseTime(s.startTime);
            let sEnd = parseTime(s.endTime);

            const release = releaseMap.get(s.id);
            if (release) {
              if (!release.effectiveEndTime) return false;
              const effectiveEnd = parseTime(release.effectiveEndTime);
              if (effectiveEnd <= sStart) return false;
              sEnd = effectiveEnd;
            }

            if (!overlap(reqStart, reqEnd, sStart, sEnd)) return false;

            const isOverriddenByEvent = roomEventsForDate.some((e) =>
              overlap(sStart, sEnd, parseTime(e.startTime), parseTime(e.endTime))
            );
            return !isOverriddenByEvent;
          })
          .forEach((s) => {
            const sStart = parseTime(s.startTime);
            let sEnd = parseTime(s.endTime);
            const release = releaseMap.get(s.id);
            let isReleased = false;
            if (release && release.effectiveEndTime) {
              const effectiveEnd = parseTime(release.effectiveEndTime);
              if (effectiveEnd > sStart) {
                sEnd = effectiveEnd;
                isReleased = true;
              }
            }

            results.push({
              id: s.id,
              kind: "schedule",
              sourceLabel: isReleased ? "Class Schedule (Released Early)" : "Class Schedule",
              subject: s.subject || s.title || "Class",
              section: s.section || "",
              faculty: s.facultyName || s.faculty || "",
              facultyLastName: s.facultyLastName || "",
              facultyFirstName: s.facultyFirstName || "",
              day: s.day,
              startTime: s.startTime,
              endTime: release?.effectiveEndTime || s.endTime,
              isReleased,
            });
          });

        // ── 2) Events happening in this room on this date ──
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

        // ── 3) Approved reservations for this room on this date ──
        // Includes BOTH walk-in (auto-approved) and online reservations
        // that the Clerk approved. Status can be "approved" or "Approved".
        allReservations
          .filter(
            (r) =>
              String(r.status || "").toLowerCase() === "approved" &&
              (r.roomId === room.id || r.roomName === roomLabel) &&
              r.date === form.date &&
              overlap(reqStart, reqEnd, parseTime(r.startTime), parseTime(r.endTime))
          )
          .forEach((r) => {
            const isWalkIn =
              String(r.reservationType || "").toLowerCase() === "walk-in";
            results.push({
              id: r.id,
              kind: "reservation",
              sourceLabel: isWalkIn
                ? "Walk-in Reservation"
                : "Faculty Reservation",
              subject:
                r.customPurpose || r.courseTitle || r.purpose || "Reservation",
              section: r.yearSectionGroup || r.attendees?.yearSectionGroup || "",
              faculty: r.requesterName || r.facultyName || "-",
              day,
              startTime: r.startTime,
              endTime: r.endTime,
            });
          });

        // ── 4) ACCEPTED reassignments INTO this room on this date ──
        // ✅ FIX: "accepted" is now included so accepted reassignments
        //    surface as conflicts in the new room.
        allReassignments
          .filter(
            (r) =>
              isAcceptedReassign(r) &&
              r.date === form.date &&
              (r.newRoomId === room.id || r.newRoomName === roomLabel) &&
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

      // Sort for a stable UI
      results.sort((a, b) => parseTime(a.startTime) - parseTime(b.startTime));

      setConflicts(results);
      setHasBlockingConflict(
        results.some((c) => BLOCKING_CONFLICT_KINDS.has(c.kind))
      );
      setCheckingConflicts(false);
    };
    checkConflict();
  }, [form, rooms]);

  useEffect(() => {
    if (!form.room || !form.date || !form.startTime || !form.endTime) {
      setMaintenanceBlocked(false);
      return;
    }
    const room = rooms.find((r) => (r.roomName || r.name) === form.room);
    if (!room) { setMaintenanceBlocked(false); return; }
    setMaintenanceBlocked(isRoomUnderMaintenance(room, form.date, form.startTime, form.endTime));
  }, [form.room, form.date, form.startTime, form.endTime, rooms]);

  const handleChange = (field) => (e) =>
    setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const validate = () => {
    if (!form.title) return "Title is required";
    if (!form.room) return "Please select a room";
    if (!form.date) return "Date is required";
    if (form.date < todayString())
      return "Past dates are not allowed. Please select today or a future date.";
    if (!form.startTime || !form.endTime) return "Time is required";
    if (parseTime(form.startTime) >= parseTime(form.endTime)) return "Invalid time range";
    if (maintenanceBlocked) return "This room is under maintenance during the selected date/time.";

    // HARD BLOCK: existing event or approved reservation overlaps.
    if (hasBlockingConflict) {
      return "This room is already booked for the selected time (event or reservation). Please pick a different room or time.";
    }
    return null;
  };

  const canSubmit = form.title && form.room && form.date && form.startTime && form.endTime;
  const submitDisabled = maintenanceBlocked || !canSubmit || hasBlockingConflict;

  const handleConfirm = async () => {
    try {
      const err = validate();
      if (err) { setError(err); return; }
      const roomDoc = rooms.find((r) => (r.roomName || r.name) === form.room);
      if (!roomDoc) { showToast("error", "Error", "Room not found"); return; }
      if (isRoomUnderMaintenance(roomDoc, form.date, form.startTime, form.endTime)) {
        showToast("error", "Room Unavailable", "This room is under maintenance.");
        return;
      }
      if (hasBlockingConflict) {
        showToast(
          "error",
          "Room Already Booked",
          "An existing event or reservation occupies this room at the selected time."
        );
        return;
      }
      const firebaseUser = auth.currentUser;
      if (!firebaseUser) { showToast("error", "Error", "No authenticated user."); return; }

      setSubmitting(true);
      const userSnap = await getDoc(doc(db, "users", firebaseUser.uid));
      const currentUser = userSnap.data();
      const fullName = `${currentUser.firstName} ${currentUser.lastName}`.trim();

      const usersSnap = await getDocs(collection(db, "users"));

      const enrichedConflicts = conflicts.map((c) => {
        let facultyId = "";
        if (c.facultyLastName && c.facultyFirstName) {
          const fDoc = findFacultyUser(usersSnap, c.facultyLastName, c.facultyFirstName);
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

      const roomLabel = roomDoc.roomName || roomDoc.name;

      const requestRef = await addDoc(collection(db, "roomActivityRequests"), {
        title: form.title.trim(),
        reason: form.reason.trim(),
        roomId: roomDoc.id,
        roomName: roomLabel,
        floor: roomDoc.floor || "",
        date: form.date,
        startTime: form.startTime,
        endTime: form.endTime,
        requestedById: firebaseUser.uid,
        requestedByName: fullName,
        requestedByRole: currentUser.role || "Clerk",
        status: "pending_admin",
        archived: false,
        archivedAt: null,
        conflicts: enrichedConflicts,
        reassignHistory: [],
        facultyResponses: [],
        eventId: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await logActivity({
        userId: firebaseUser.uid, user: fullName, role: currentUser.role,
        action: "Submitted Room Activity Request", actionType: "create",
        target: `${form.title} (${roomLabel})`, status: "PENDING",
        details: {
          requestId: requestRef.id,
          room: roomLabel,
          date: form.date,
          startTime: form.startTime,
          endTime: form.endTime,
          conflictCount: enrichedConflicts.length,
        },
      });

      const admins = usersSnap.docs.filter(
        (d) => String(d.data().role || "").toLowerCase() === "admin"
      );
      for (const admin of admins) {
        await addDoc(collection(db, "notifications"), {
          userId: admin.id, ownerType: "admin",
          activityRequestId: requestRef.id,
          title: "New Room Activity Request",
          message: `${fullName} submitted "${form.title}" for ${roomLabel} on ${form.date} (${formatTime12(form.startTime)} – ${formatTime12(form.endTime)}). ${enrichedConflicts.length} conflict(s) detected.`,
          type: "room-activity-request", unread: true, archived: false, badge: "NEW",
          createdAt: serverTimestamp(),
        });
      }

      showToast("success", "Submitted for Approval", "Room activity sent to Admin.");
      setShowModal(false);
      setForm({ title: "", room: "", date: "", startTime: "", endTime: "", reason: "" });
      setConflicts([]);
      setHasBlockingConflict(false);
      setShowCustomTime(false);
      setTimeout(() => setShowListModal(true), 900);
    } catch (error) {
      console.error(error);
      showToast("error", "Firestore Error", error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const duration = formatDuration(form.startTime, form.endTime);
  const isPresetActive = (slot) => slot.start === form.startTime && slot.end === form.endTime;
  const handlePresetClick = (slot) => {
    setForm((f) => ({ ...f, startTime: slot.start, endTime: slot.end }));
    setShowCustomTime(false);
  };

  return (
    <div className="ra-page">
      <div className="ra-header">
        <div>
          <h1 className="ra-title">Room Activity Request</h1>
          <p className="ra-subtitle">
            Submit a room activity request — it will be reviewed by the Admin before faculty are notified.
          </p>
        </div>
        <button className="ra-secondary-btn" onClick={() => setShowListModal(true)}>
          <i className="fa-solid fa-list"></i> View All Requests
        </button>
      </div>

      {error && (
        <div className="ra-banner ra-banner-error">
          <i className="fa-solid fa-circle-exclamation"></i>
          <span>{error}</span>
        </div>
      )}
      {maintenanceBlocked && !error && (
        <div className="ra-banner ra-banner-warning">
          <i className="fa-solid fa-triangle-exclamation"></i>
          <span>This room is under maintenance during the selected date/time.</span>
        </div>
      )}
      {hasBlockingConflict && !error && !maintenanceBlocked && (
        <div className="ra-banner ra-banner-error">
          <i className="fa-solid fa-circle-xmark"></i>
          <span>
            <strong>This room is already booked</strong> — an existing event
            or reservation overlaps the selected time. Please pick a
            different room or time.
          </span>
        </div>
      )}

      <div className="ra-approval-notice">
        <div className="ra-approval-head">
          <div className="ra-approval-icon">
            <i className="fa-solid fa-diagram-project"></i>
          </div>
          <div className="ra-approval-headtext">
            <h4 className="ra-approval-title">How your request gets processed</h4>
            <p className="ra-approval-desc">
              Every room activity request goes through a short review cycle so
              schedules stay fair, conflicts are caught early, and only the
              faculty who are actually affected get notified. Here's exactly
              what happens after you hit <strong>Submit</strong>:
            </p>
          </div>
        </div>

        <div className="ra-approval-steps">
          <div className="ra-approval-step">
            <div className="ra-step-num">1</div>
            <div className="ra-step-body">
              <div className="ra-step-title">
                <i className="fa-solid fa-paper-plane"></i>
                You submit the request
              </div>
              <p className="ra-step-text">
                Fill in the activity title, room, date, and time slot. The
                system instantly checks for conflicts with existing{" "}
                <strong>class schedules</strong>, <strong>room activities</strong>,{" "}
                <strong>approved reservations</strong>, and{" "}
                <strong>reassigned classes</strong> — all scoped to the
                selected room only.
              </p>
            </div>
          </div>

          <div className="ra-step-connector">
            <i className="fa-solid fa-arrow-right-long"></i>
          </div>

          <div className="ra-approval-step">
            <div className="ra-step-num">2</div>
            <div className="ra-step-body">
              <div className="ra-step-title">
                <i className="fa-solid fa-user-shield"></i>
                Admin reviews and decides
              </div>
              <p className="ra-step-text">
                The Admin sees your request together with any detected
                conflicts. They can <strong>approve</strong> it outright,{" "}
                <strong>deny</strong> it, or <strong>reassign</strong> the
                conflicting classes before approving. You'll see the decision
                on your "View All Requests" list.
              </p>
            </div>
          </div>

          <div className="ra-step-connector">
            <i className="fa-solid fa-arrow-right-long"></i>
          </div>

          <div className="ra-approval-step">
            <div className="ra-step-num">3</div>
            <div className="ra-step-body">
              <div className="ra-step-title">
                <i className="fa-solid fa-bell"></i>
                Faculty are notified (if affected)
              </div>
              <p className="ra-step-text">
                Only faculty whose classes overlap with your activity are
                notified. If there are no conflicts,{" "}
                <strong>no one else is disturbed</strong> — the room is simply
                booked for your activity.
              </p>
            </div>
          </div>
        </div>

        <div className="ra-approval-footnote">
          <i className="fa-solid fa-circle-info"></i>
          <span>
            <strong>Note:</strong> Request records older than{" "}
            <strong>{ARCHIVE_AFTER_DAYS} days</strong> are automatically
            hidden from the "View All Requests" list to keep it clean.
          </span>
        </div>
      </div>

      <div className="ra-layout">
        <div className="ra-card">
          <div className="ra-card-title">
            <span className="ra-card-bar"></span> Activity Details
          </div>

          <div className="ra-form">
            <div className="ra-field">
              <label>Activity Title</label>
              <div className="ra-icon-input">
                <i className="fa-solid fa-bookmark"></i>
                <input className="ra-plain-input" placeholder="e.g. Freshmen Orientation"
                  value={form.title} onChange={handleChange("title")} />
              </div>
            </div>

            <div className="ra-field">
              <label>Room</label>

              <div className="rut-roompicker ra-roompicker">
                <button
                  type="button"
                  className={`rut-room-trigger ${showRoomPicker ? "open" : ""}`}
                  onClick={() => {
                    setRoomSearch("");
                    setShowDatePicker(false);
                    setShowRoomPicker((v) => !v);
                  }}
                  disabled={loading}
                >
                  <i className="fa-solid fa-door-open"></i>
                  <span className="rut-room-trigger-text">
                    {form.room || (loading ? "Loading rooms…" : "Select a room")}
                  </span>
                  {selectedRoom?.floor && (
                    <span className="rut-room-trigger-floor">
                      {selectedRoom.floor} Floor
                    </span>
                  )}
                  <i className={`fa-solid fa-chevron-down rut-room-caret ${showRoomPicker ? "open" : ""}`}></i>
                </button>

                {showRoomPicker && (
                  <>
                    <div className="rut-room-clickaway" onClick={() => setShowRoomPicker(false)}></div>
                    <div className="rut-room-popover">
                      <span className="rut-room-popover-arrow"></span>
                      <div className="rut-room-search-wrap">
                        <i className="fa-solid fa-magnifying-glass"></i>
                        <input
                          type="text"
                          className="rut-room-search"
                          placeholder="Search room, floor, building..."
                          value={roomSearch}
                          onChange={(e) => setRoomSearch(e.target.value)}
                          autoFocus
                        />
                        {roomSearch && (
                          <button type="button" className="rut-room-search-clear" onClick={() => setRoomSearch("")} aria-label="Clear search">
                            <i className="fa-solid fa-xmark"></i>
                          </button>
                        )}
                      </div>
                      <div className="rut-room-list">
                        {filteredRooms.length === 0 ? (
                          <div className="rut-room-empty">
                            <i className="fa-regular fa-face-frown"></i>
                            <span>No rooms match your search.</span>
                          </div>
                        ) : (
                          filteredRooms.map((r) => {
                            const name = r.roomName || r.name;
                            const isActive = name === form.room;
                            return (
                              <button
                                type="button"
                                key={r.id}
                                className={`rut-room-option ${isActive ? "is-active" : ""}`}
                                onClick={() => {
                                  setForm((prev) => ({ ...prev, room: name }));
                                  setShowRoomPicker(false);
                                  setRoomSearch("");
                                }}
                              >
                                <div className="rut-room-option-icon"><i className="fa-solid fa-door-open"></i></div>
                                <div className="rut-room-option-body">
                                  <span className="rut-room-option-name">{name}</span>
                                  <span className="rut-room-option-meta">
                                    {r.floor && (
                                      <>
                                        <i className="fa-solid fa-building"></i>
                                        {r.floor} Floor
                                      </>
                                    )}
                                    {r.capacity && (
                                      <>
                                        <span className="rut-room-dot">•</span>
                                        <i className="fa-solid fa-users"></i>
                                        {r.capacity} Seats
                                      </>
                                    )}
                                  </span>
                                </div>
                                {isActive && <i className="fa-solid fa-circle-check rut-room-option-check"></i>}
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

            <div className="ra-field">
              <div className="dt-section-header">
                <label>Date</label>
                {form.date && (
                  <span className="dt-selected-pill">
                    <i className="fa-regular fa-calendar-check"></i>
                    {formatDateLong(form.date)}
                  </span>
                )}
              </div>

              <div className="rut-datepicker ra-datepicker">
                <button
                  type="button"
                  className={`rut-date-trigger ${showDatePicker ? "open" : ""}`}
                  onClick={() => {
                    const base = form.date ? new Date(`${form.date}T00:00:00`) : new Date();
                    setCalendarCursor({ year: base.getFullYear(), month: base.getMonth() });
                    setShowRoomPicker(false);
                    setShowDatePicker((v) => !v);
                  }}
                >
                  <i className="fa-regular fa-calendar"></i>
                  <span>{form.date ? formatDateLong(form.date) : "Select a date"}</span>
                  <i className={`fa-solid fa-chevron-down rut-date-caret ${showDatePicker ? "open" : ""}`}></i>
                </button>

                {showDatePicker && (
                  <>
                    <div className="rut-date-clickaway" onClick={() => setShowDatePicker(false)}></div>
                    <div className="rut-date-popover">
                      <span className="rut-date-popover-arrow"></span>

                      <div className="rut-date-quick-row">
                        <button
                          type="button"
                          className={form.date === todayString() ? "active" : ""}
                          onClick={() => {
                            setForm((prev) => ({ ...prev, date: todayString() }));
                            setShowDatePicker(false);
                          }}
                        >Today</button>
                        <button
                          type="button"
                          className={form.date === addDaysLocal(todayString(), 1) ? "active" : ""}
                          onClick={() => {
                            setForm((prev) => ({ ...prev, date: addDaysLocal(todayString(), 1) }));
                            setShowDatePicker(false);
                          }}
                        >Tomorrow</button>
                      </div>

                      <div className="rut-cal-header">
                        <button
                          type="button"
                          className="rut-cal-nav"
                          disabled={calendarCursor.year === new Date().getFullYear() && calendarCursor.month === new Date().getMonth()}
                          onClick={() => setCalendarCursor((c) => {
                            const current = new Date();
                            const previous = c.month === 0
                              ? { year: c.year - 1, month: 11 }
                              : { year: c.year, month: c.month - 1 };
                            if (
                              previous.year < current.getFullYear() ||
                              (previous.year === current.getFullYear() && previous.month < current.getMonth())
                            ) return c;
                            return previous;
                          })}
                          aria-label="Previous month"
                        ><i className="fa-solid fa-chevron-left"></i></button>

                        <span className="rut-cal-title">{MONTH_NAMES[calendarCursor.month]} {calendarCursor.year}</span>

                        <button
                          type="button"
                          className="rut-cal-nav"
                          onClick={() => setCalendarCursor((c) => {
                            const m = c.month + 1;
                            return m > 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: m };
                          })}
                          aria-label="Next month"
                        ><i className="fa-solid fa-chevron-right"></i></button>
                      </div>

                      <div className="rut-cal-weekdays">
                        {WEEKDAY_LABELS.map((w) => <span key={w}>{w}</span>)}
                      </div>

                      <div className="rut-cal-grid">
                        {buildCalendarGrid(calendarCursor.year, calendarCursor.month).map((cell, i) => {
                          const cellStr = toDateInputValue(cell.date);
                          const isPast = cellStr < todayString();
                          const isSelected = cellStr === form.date;
                          return (
                            <button
                              type="button"
                              key={i}
                              disabled={isPast}
                              className={[
                                "rut-cal-day",
                                !cell.inMonth && "is-outside",
                                isSelected && "is-selected",
                                isPast && "is-disabled",
                              ].filter(Boolean).join(" ")}
                              onClick={() => {
                                if (isPast) return;
                                setForm((prev) => ({ ...prev, date: cellStr }));
                                setShowDatePicker(false);
                              }}
                            >{cell.day}</button>
                          );
                        })}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="ra-field">
              <div className="dt-section-header">
                <label>Time</label>
                {form.startTime && form.endTime && (
                  <span className="dt-selected-pill">
                    <i className="fa-regular fa-clock"></i>
                    {formatTime12(form.startTime)} – {formatTime12(form.endTime)}
                  </span>
                )}
              </div>
              <div className="time-preset-grid">
                {PRESET_SLOTS.map((slot) => (
                  <button key={slot.label} type="button"
                    className={`time-preset-chip ${isPresetActive(slot) ? "active" : ""}`}
                    onClick={() => handlePresetClick(slot)}>{slot.label}</button>
                ))}
              </div>
              <button type="button"
                className={`time-custom-toggle ${showCustomTime ? "open" : ""}`}
                onClick={() => setShowCustomTime((v) => !v)}>
                <i className="fa-solid fa-sliders"></i>
                {showCustomTime ? "Hide custom time" : "Set a custom time instead"}
                <i className={`fa-solid fa-chevron-down time-custom-chev ${showCustomTime ? "open" : ""}`}></i>
              </button>
              {showCustomTime && (
                <div className="time-custom-grid">
                  <div className="time-custom-field">
                    <span className="time-custom-label">Start Time</span>
                    <div className="ra-select-wrap">
                      <select className="ra-select" value={form.startTime}
                        onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))}>
                        <option value="">Select start time</option>
                        {TIME_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                      <i className="fa-solid fa-chevron-down ra-chevron"></i>
                    </div>
                  </div>
                  <div className="time-custom-arrow"><i className="fa-solid fa-arrow-right"></i></div>
                  <div className="time-custom-field">
                    <span className="time-custom-label">End Time</span>
                    <div className="ra-select-wrap">
                      <select className="ra-select" value={form.endTime}
                        onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))}>
                        <option value="">Select end time</option>
                        {TIME_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                      <i className="fa-solid fa-chevron-down ra-chevron"></i>
                    </div>
                  </div>
                </div>
              )}
              {duration && (
                <div className="ra-duration-chip">
                  <i className="fa-solid fa-hourglass-half"></i> Duration: {duration}
                </div>
              )}
            </div>

            <div className="ra-field">
              <label>Reason</label>
              <textarea value={form.reason} onChange={handleChange("reason")}
                className="ra-textarea" placeholder="Briefly explain why this activity needs the room…" />
            </div>
          </div>

          <div className="ra-footer">
            <button className="ra-confirm-btn" onClick={() => setShowModal(true)}
              disabled={submitDisabled}
              title={
                hasBlockingConflict
                  ? "This room is already booked during the selected time."
                  : ""
              }>
              <i className="fa-solid fa-paper-plane"></i> Submit for Approval
            </button>
          </div>
        </div>

        <div className="ra-side">
          {selectedRoom && (
            <div className="ra-room-summary">
              <div className="ra-room-summary-header">
                <i className="fa-solid fa-building"></i>
                <span>{selectedRoom.roomName || selectedRoom.name}</span>
              </div>
              <div className={`ra-status-pill ${
                String(selectedRoom.roomStatus || "").toLowerCase() === "maintenance"
                  ? "is-maintenance"
                  : "is-available"
              }`}>
                {String(selectedRoom.roomStatus || "").toLowerCase() === "maintenance"
                  ? "Under Maintenance"
                  : "Available"}
              </div>
            </div>
          )}
          {checkingConflicts && (
            <div className="ra-checking">
              <span className="ra-spinner" /> Checking schedules, events, reservations, reassignments & releases…
            </div>
          )}

          {!checkingConflicts && conflicts.length > 0 && (
            <div
              className="ra-conflict-card"
              style={
                hasBlockingConflict
                  ? {
                      background: "#fef2f2",
                      borderColor: "#fecaca",
                    }
                  : undefined
              }
            >
              <div
                className="ra-conflict-title"
                style={hasBlockingConflict ? { color: "#b91c1c" } : undefined}
              >
                <i
                  className={`fa-solid ${
                    hasBlockingConflict
                      ? "fa-circle-xmark"
                      : "fa-triangle-exclamation"
                  }`}
                ></i>
                {hasBlockingConflict
                  ? `Cannot submit — ${blockingConflicts.length} existing booking${
                      blockingConflicts.length > 1 ? "s" : ""
                    }`
                  : `${conflicts.length} Conflict${conflicts.length > 1 ? "s" : ""} Detected`}
              </div>
              <p className="ra-conflict-desc">
                {hasBlockingConflict ? (
                  <>
                    This room is already booked during your requested slot in{" "}
                    <strong>{form.room}</strong>. You cannot submit an
                    overlapping activity here — please choose a different room
                    or time.
                  </>
                ) : (
                  <>
                    These existing items overlap with your requested slot in{" "}
                    <strong>{form.room}</strong>. Once approved, affected
                    faculty will be notified.
                  </>
                )}
              </p>
              <div className="ra-conflict-list">
                {conflicts.map((c) => {
                  const isBlocking = BLOCKING_CONFLICT_KINDS.has(c.kind);
                  return (
                    <div
                      key={`${c.kind}-${c.id}`}
                      className="ra-conflict-item"
                      style={
                        isBlocking
                          ? {
                              background: "#fff",
                              borderColor: "#fecaca",
                            }
                          : undefined
                      }
                    >
                      <div className="ra-conflict-item-main">
                        <span className={`ra-conflict-kind ra-conflict-kind--${c.kind}`}>
                          <i className={CONFLICT_KIND_ICON[c.kind] || "fa-solid fa-circle-info"}></i>
                          {c.sourceLabel}
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
                              }}
                            >
                              BLOCKING
                            </span>
                          )}
                        </span>
                        <div className="ra-conflict-code">
                          {c.subject || c.title || "Untitled"}
                          {c.section ? ` (${c.section})` : ""}
                        </div>
                        <div className="ra-conflict-time">
                          {formatTime12(c.startTime)} – {formatTime12(c.endTime)}
                          {c.faculty ? ` · ${c.faculty}` : ""}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!checkingConflicts && conflicts.length === 0 && form.room && form.date && form.startTime && form.endTime && !maintenanceBlocked && (
            <div className="ra-clear-card">
              <i className="fa-solid fa-circle-check"></i> No conflicts in {form.room} — clean schedule.
            </div>
          )}
        </div>
      </div>

      {showModal && (
        <div className="ra-modal-overlay">
          <div className="ra-modal">
            <div className="ra-modal-icon"><i className="fa-solid fa-paper-plane"></i></div>
            <h3 className="ra-modal-title">Submit for Approval?</h3>
            <p className="ra-modal-text">
              Your request will be sent to the Admin for review
              {warningConflicts.length > 0
                ? ` — ${warningConflicts.length} schedule conflict${warningConflicts.length > 1 ? "s" : ""} will be reported.`
                : "."}
            </p>
            <div className="ra-modal-summary">
              <div className="ra-modal-summary-row"><i className="fa-solid fa-bookmark"></i><span>{form.title || "Untitled"}</span></div>
              <div className="ra-modal-summary-row"><i className="fa-solid fa-door-open"></i><span>{form.room}</span></div>
              <div className="ra-modal-summary-row"><i className="fa-solid fa-calendar-days"></i><span>{formatDateLong(form.date)}</span></div>
              <div className="ra-modal-summary-row"><i className="fa-solid fa-clock"></i><span>{formatTime12(form.startTime)} – {formatTime12(form.endTime)}{duration ? ` (${duration})` : ""}</span></div>
            </div>
            <div className="ra-modal-actions">
              <button className="ra-modal-cancel" onClick={() => setShowModal(false)} disabled={submitting}>Cancel</button>
              <button className="ra-modal-confirm" onClick={handleConfirm} disabled={submitting}>
                {submitting ? (<><span className="ra-spinner ra-spinner-light" />Submitting…</>) : "Submit"}
              </button>
            </div>
          </div>
        </div>
      )}

      <RoomActivityListModal open={showListModal} onClose={() => setShowListModal(false)} />
      <Toast show={toast.show} type={toast.type} title={toast.title} message={toast.message}
        onClose={() => setToast((p) => ({ ...p, show: false }))} />
    </div>
  );
}