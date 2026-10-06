import { useState, useEffect, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import "./clerk-reassign-room.css";
import {
  collection, getDocs, addDoc, serverTimestamp, doc, getDoc,
} from "firebase/firestore";
import { logActivity } from "../../utils/logActivity";
import { auth, db } from "../../firebase";
import { findFacultyUserByName } from "../../utils/findFacultyUser";
import { formatFacultyName } from "../../utils/parseFacultyName";
import Toast from "../../Popup/Toast/Toast";

// ─── Helpers ────────────────────────────────────────────────────
const format12Hour = (time) => {
  if (!time) return "-";
  const [hour, minute] = time.split(":").map(Number);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return time;
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return `${h}:${String(minute).padStart(2, "0")} ${suffix}`;
};

const formatDateLong = (dateStr) => {
  if (!dateStr) return "-";
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", {
    weekday: "short", month: "long", day: "numeric", year: "numeric",
  });
};

const cvtMin = (t) => {
  if (!t) return 0;
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

const minToTime = (mins) => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

// ─── Floor normalization ────────────────────────────────────────
// Handles: "1st Floor", "1st", "1", 1, "Ground Floor", "GF", etc.
const normalizeFloor = (value) => {
  if (value == null) return "";
  const s = String(value).trim().toLowerCase();
  if (!s) return "";

  // Ground floor
  if (s.includes("ground") || s === "gf" || s === "g") return "0";

  // Basement
  if (s.includes("basement") || s.startsWith("b")) {
    const m = s.match(/\d+/);
    return m ? String(-parseInt(m[0], 10)) : "-1";
  }

  // Extract any digit (handles "1st Floor", "1st", "1", "Floor 1", etc.)
  const m = s.match(/\d+/);
  if (m) return String(parseInt(m[0], 10));

  return s;
};

// Friendly label for floor options
const formatFloorLabel = (normalized) => {
  if (normalized === "0") return "Ground Floor";
  if (normalized.startsWith("-")) return `Basement ${normalized.slice(1)}`;
  const n = parseInt(normalized, 10);
  if (Number.isNaN(n)) return normalized;
  const suffix = n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th";
  return `${n}${suffix} Floor`;
};

const isRoomMaintenance = (room) => {
  const status = String(room.roomStatus || "").toLowerCase().trim();
  const legacyStatus = String(room.status || "").toLowerCase().trim();
  return (
    room.maintenance === true ||
    status === "maintenance" ||
    legacyStatus === "under maintenance" ||
    legacyStatus === "maintenance"
  );
};

const isRoomInactive = (room) => {
  const status = String(room.roomStatus || "").toLowerCase().trim();
  return status === "inactive";
};

// ─── No-room modes ─────────────────────────────────────────────
const NO_ROOM_LABELS = {
  none_available: {
    label: "No Room Available",
    short: "No Room Available",
    desc: "All rooms are fully occupied during this time slot.",
    icon: "fa-door-closed",
  },
  none_suited: {
    label: "No Suitable Room",
    short: "No Suitable Room",
    desc: "Available rooms don't fit the requirements (capacity, type, equipment, etc.).",
    icon: "fa-circle-question",
  },
};

function ClerkReassignRoom() {
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  // ─── Floor filter state (normalized string, e.g. "1", "2", "0") ──
  const [floor, setFloor] = useState("");

  const [availableRooms, setAvailableRooms] = useState([]);
  const [allRooms, setAllRooms] = useState([]);              // ← for building floor options
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [skippedRooms, setSkippedRooms] = useState({ maintenance: 0, inactive: 0 });
  const location = useLocation();

  const [alreadyPending, setAlreadyPending] = useState(false);
  const [checkingPending, setCheckingPending] = useState(true);

  const [showPreview, setShowPreview] = useState(false);
  const [noRoomMode, setNoRoomMode] = useState(null);
  const [noRoomReason, setNoRoomReason] = useState("");

  const conflict = location.state?.conflict;
  const reassignType = location.state?.reassignType || "class";
  const from = location.state?.from || "/clerk/conflicts";

  const isEventReassign = reassignType === "event";

  const [toast, setToast] = useState({
    show: false, type: "success", title: "", message: "",
  });

  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    if (type !== "loading") {
      setTimeout(() => setToast((prev) => ({ ...prev, show: false })), 4000);
    }
  };

  const effectiveDate = isEventReassign
    ? (conflict?.event?.date || conflict?.date)
    : conflict?.date;
  const effectiveStart = isEventReassign
    ? (conflict?.event?.startTime || conflict?.startTime)
    : conflict?.startTime;
  const effectiveEnd = isEventReassign
    ? (conflict?.event?.endTime || conflict?.endTime)
    : conflict?.endTime;

  const conflictWindow = useMemo(() => {
    if (!conflict?.conflictStartTime || !conflict?.conflictEndTime) return null;
    const cs = cvtMin(conflict.conflictStartTime);
    const ce = cvtMin(conflict.conflictEndTime);
    if (ce <= cs) return null;
    return { start: cs, end: ce };
  }, [conflict]);

  // ═══════════════════════════════════════════════════════════════
  // FLOOR OPTIONS — built dynamically from actual room data
  // + each option shows how many rooms are on that floor
  // ═══════════════════════════════════════════════════════════════
  const floorOptions = useMemo(() => {
    const counts = new Map();
    allRooms.forEach((r) => {
      const normalized = normalizeFloor(r.floor);
      if (!normalized) return;
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    });

    return Array.from(counts.entries())
      .map(([value, count]) => ({
        value,
        label: formatFloorLabel(value),
        count,
      }))
      .sort((a, b) => {
        const na = parseInt(a.value, 10);
        const nb = parseInt(b.value, 10);
        if (Number.isNaN(na) && Number.isNaN(nb)) return a.value.localeCompare(b.value);
        if (Number.isNaN(na)) return 1;
        if (Number.isNaN(nb)) return -1;
        return na - nb;
      });
  }, [allRooms]);

  // ═══════════════════════════════════════════════════════════════
  // PENDING CHECK — fail-safe (always resets)
  // ═══════════════════════════════════════════════════════════════
    useEffect(() => {
      let cancelled = false;

      const run = async () => {
        const sid = conflict?.schedule?.id;
        const cdate = conflict?.date;

        if (!sid || !cdate) {
          setCheckingPending(false);
          return;
        }

        try {
          const snap = await getDocs(collection(db, "roomReassignments"));

          // Gather every reassignment for this exact schedule + date.
          const matching = [];
          snap.docs.forEach((d) => {
            const data = d.data() || {};
            if (
              String(data.scheduleId || "") === String(sid) &&
              String(data.date || "") === String(cdate)
            ) {
              matching.push({ id: d.id, ...data });
            }
          });

          // Sort newest-first using createdAt.
          const ms = (v) => {
            if (!v) return 0;
            if (typeof v === "number") return v;
            if (v?.seconds != null) return v.seconds * 1000;
            if (typeof v?.toDate === "function") return v.toDate().getTime();
            return 0;
          };
          matching.sort((a, b) => ms(b.createdAt) - ms(a.createdAt));

          // Only the newest decision matters.
          const latest = matching[0];
          const latestStatus = String(latest?.status || "").toLowerCase();

          // Block ONLY for genuinely pending statuses.
          // "needs_reassign" (returned by admin), "accepted", "declined",
          // "cancelled" → allow resubmission.
          const isPending =
            latestStatus === "pending_admin" || latestStatus === "pending_faculty";

          if (!cancelled) setAlreadyPending(isPending);
        } catch (err) {
          console.error("checkPendingReassignment failed:", err);
          if (!cancelled) setAlreadyPending(false);
        } finally {
          if (!cancelled) setCheckingPending(false);
        }
      };

      run();
      return () => { cancelled = true; };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [conflict?.schedule?.id, conflict?.date]);

  // Re-run load when floor changes
  useEffect(() => { loadAvailableRooms(); }, [floor]);

  const overlap = (aS, aE, bS, bE) =>
    cvtMin(aS) < cvtMin(bE) && cvtMin(aE) > cvtMin(bS);

  const formatTime = (time) => format12Hour(time);

  const loadAvailableRooms = async () => {
    setRoomsLoading(true);
    const roomSnap = await getDocs(collection(db, "rooms"));
    const eventSnap = await getDocs(collection(db, "events"));

    // Keep a copy of ALL rooms so floor options don't disappear
    // when a floor is currently selected
    const fetchedAllRooms = roomSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    setAllRooms(fetchedAllRooms);

    const available = [];
    const classStart = cvtMin(effectiveStart);
    const classEnd = cvtMin(effectiveEnd);

    let maintenanceSkipped = 0;
    let inactiveSkipped = 0;

    for (const roomDoc of roomSnap.docs) {
      const room = roomDoc.data();

      // ── FLOOR FILTER (normalized comparison) ──
      if (floor) {
        const roomFloorNorm = normalizeFloor(room.floor);
        if (roomFloorNorm !== floor) continue;
      }

      if (roomDoc.id === conflict.roomId) continue;
      if (isRoomMaintenance(room)) { maintenanceSkipped++; continue; }
      if (isRoomInactive(room)) { inactiveSkipped++; continue; }

      const blockers = [];

      const roomEvents = eventSnap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((e) => e.roomId === roomDoc.id && e.date === effectiveDate);
      for (const event of roomEvents) {
        if (conflict?.event?.id && event.id === conflict.event.id) continue;
        blockers.push({ start: cvtMin(event.startTime), end: cvtMin(event.endTime) });
      }

      const schedulesSnap = await getDocs(collection(db, "rooms", roomDoc.id, "schedules"));
      for (const schedDoc of schedulesSnap.docs) {
        const sched = schedDoc.data();
        if (schedDoc.id === conflict?.schedule?.id) continue;
        if (sched.day !== conflict.day) continue;
        blockers.push({ start: cvtMin(sched.startTime), end: cvtMin(sched.endTime) });
      }

      const overlaps = blockers
        .filter((b) => b.start < classEnd && b.end > classStart)
        .map((b) => ({ start: Math.max(b.start, classStart), end: Math.min(b.end, classEnd) }))
        .sort((a, b) => a.start - b.start);

      const merged = [];
      for (const o of overlaps) {
        if (merged.length === 0) merged.push({ ...o });
        else {
          const last = merged[merged.length - 1];
          if (o.start <= last.end) last.end = Math.max(last.end, o.end);
          else merged.push({ ...o });
        }
      }

      const freeWindows = [];
      let cursor = classStart;
      for (const block of merged) {
        if (block.start > cursor) freeWindows.push({ start: cursor, end: block.start });
        cursor = Math.max(cursor, block.end);
      }
      if (cursor < classEnd) freeWindows.push({ start: cursor, end: classEnd });
      if (freeWindows.length === 0) continue;

      const isFullyFree =
        freeWindows.length === 1 &&
        freeWindows[0].start === classStart &&
        freeWindows[0].end === classEnd;

      const primaryWindow = freeWindows.reduce((best, w) =>
        w.end - w.start > best.end - best.start ? w : best);

      available.push({
        id: roomDoc.id, ...room,
        _freeWindows: freeWindows,
        _primaryWindow: primaryWindow,
        _isPartial: !isFullyFree,
      });
    }

    // Sort alphabetically by room name
    available.sort((a, b) =>
      String(a.roomName || "").localeCompare(String(b.roomName || ""), undefined, {
        sensitivity: "base", numeric: true,
      })
    );

    setAvailableRooms(available);
    setSkippedRooms({ maintenance: maintenanceSkipped, inactive: inactiveSkipped });
    setRoomsLoading(false);
  };

  const classSubject = conflict?.subject || conflict?.schedule?.subject || "Unknown Subject";
  const eventSubject = conflict?.activityTitle || conflict?.event?.title || "Untitled Activity";
  const displaySubject = isEventReassign ? eventSubject : classSubject;
  const activityReason = conflict?.activityReason || conflict?.event?.reason || "";

  const reassignedWindow = useMemo(() => {
    if (!selectedRoom?._primaryWindow) return null;
    const w = selectedRoom._primaryWindow;
    return { start: minToTime(w.start), end: minToTime(w.end) };
  }, [selectedRoom]);

  const previewData = useMemo(() => {
    const reassignStart = reassignedWindow?.start || effectiveStart;
    const reassignEnd = reassignedWindow?.end || effectiveEnd;

    return {
      type: isEventReassign ? "Activity" : "Class",
      title: displaySubject,
      subtitle: isEventReassign ? (activityReason || "—") : (conflict?.section || "—"),
      faculty: conflict?.faculty || "TBA",
      day: conflict?.day || "—",
      date: effectiveDate || "—",
      originalTime:
        effectiveStart && effectiveEnd
          ? `${format12Hour(effectiveStart)} – ${format12Hour(effectiveEnd)}`
          : "—",
      reassignTime:
        reassignStart && reassignEnd
          ? `${format12Hour(reassignStart)} – ${format12Hour(reassignEnd)}`
          : "—",
      isPartial: !!selectedRoom?._isPartial,
      oldRoom: conflict?.roomName || "—",
      newRoom: selectedRoom?.roomName || "—",
      newRoomFloor: selectedRoom?.floor || "",
      newRoomCapacity: selectedRoom?.capacity || "",
    };
  }, [
    displaySubject, isEventReassign, activityReason, conflict,
    effectiveDate, effectiveStart, effectiveEnd, selectedRoom, reassignedWindow,
  ]);

  const handleSelectRoom = (room) => {
    setSelectedRoom(room);
    setNoRoomMode(null);
    setNoRoomReason("");
  };

  // Clear the selected room when floor changes (para hindi mag-conflict
  // yung dating selection sa bagong filter)
  const handleFloorChange = (value) => {
    setFloor(value);
    setSelectedRoom(null);
  };

  const openNoRoomMode = (mode) => {
    setNoRoomMode(mode);
    setNoRoomReason("");
    setSelectedRoom(null);
    setShowPreview(true);
  };

  const handleSubmitClick = () => {
    if (noRoomMode) { setShowPreview(true); return; }
    if (!selectedRoom) {
      showToast("error", "Select a Room", "Please choose a room to reassign to.");
      return;
    }
    if (alreadyPending) {
      showToast("error", "Already Pending",
        "There is already a pending reassignment for this class. Please wait.");
      return;
    }
    setShowPreview(true);
  };

  const closePreview = () => {
    if (loading) return;
    setShowPreview(false);
  };

  const handleConfirm = async () => {
    if (alreadyPending) {
      showToast("error", "Already Pending",
        "There is already a pending reassignment for this class. Please wait.");
      setShowPreview(false);
      return;
    }

    // ══════════════════════════════════════════════════════════════
    // NO-ROOM MODE
    // ══════════════════════════════════════════════════════════════
    if (noRoomMode) {
      if (!noRoomReason.trim()) {
        showToast("error", "Reason Required",
          "Please provide a short reason for the Admin.");
        return;
      }
      setLoading(true);
      showToast("loading", "Submitting", "Sending to Admin for review...");

      try {
        const usersSnap = await getDocs(collection(db, "users"));
        const facultyDoc = findFacultyUserByName(usersSnap, conflict.faculty);
        let facultyId = null;
        let facultyFullName = conflict.faculty || "TBA";
        if (facultyDoc) {
          facultyId = facultyDoc.id;
          const fd = facultyDoc.data();
          facultyFullName = formatFacultyName(`${fd.lastName}, ${fd.firstName}`);
        }

        const modeMeta = NO_ROOM_LABELS[noRoomMode];

        const reassignmentRef = await addDoc(collection(db, "roomReassignments"), {
          reassignType,
          requestedBy: "clerk",
          requestedById: auth.currentUser?.uid || null,

          facultyId,
          facultyName: conflict.faculty || "",

          courseTitle: isEventReassign ? "" : classSubject,
          section: isEventReassign ? "" : (conflict.section || ""),
          day: conflict.day || "",

          date: effectiveDate,
          startTime: effectiveStart,
          endTime: effectiveEnd,
          originalStartTime: effectiveStart,
          originalEndTime: effectiveEnd,

          oldRoomId: conflict.roomId,
          oldRoomName: conflict.roomName,

          newRoomId: null,
          newRoomName: null,

          noRoomOption: noRoomMode,
          clerkReason: noRoomReason.trim(),

          eventId: conflict?.event?.id || null,
          scheduleId: conflict?.schedule?.id || null,

          eventTitle: isEventReassign ? eventSubject : "",
          eventReason: isEventReassign ? activityReason : "",

          status: "pending_admin",
          adminNote: "",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        const admins = usersSnap.docs.filter(
          (d) => String(d.data().role || "").toLowerCase() === "admin"
        );
        await Promise.all(
          admins.map((admin) =>
            addDoc(collection(db, "notifications"), {
              userId: admin.id,
              ownerType: "admin",
              reassignmentId: reassignmentRef.id,
              title: `Clerk Report: ${modeMeta.short}`,
              message: `${facultyFullName} • ${displaySubject} • ${conflict.roomName}. Reason: ${noRoomReason.trim()}`,
              type: "room-reassignment-request",
              unread: true,
              archived: false,
              badge: "ACTION",
              createdAt: serverTimestamp(),
            })
          )
        );

        const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
        const userData = userDoc.data();
        await logActivity({
          user: `${userData.firstName} ${userData.lastName}`,
          role: userData.role,
          action: `Reported ${modeMeta.short.toLowerCase()}`,
          actionType: "edit",
          target: `${facultyFullName} • ${displaySubject} • ${conflict.roomName}`,
          status: "PENDING",
        });

        setShowPreview(false);
        setNoRoomMode(null);
        setNoRoomReason("");
        showToast("success", "Submitted to Admin",
          "The Admin will review this and decide on the next action.");
        setTimeout(() => navigate(from), 1500);
      } catch (err) {
        console.error(err);
        showToast("error", "Submission Failed",
          "Could not submit. Please try again.");
      } finally {
        setLoading(false);
      }
      return;
    }

    // ══════════════════════════════════════════════════════════════
    // NORMAL ROOM REASSIGNMENT
    // ══════════════════════════════════════════════════════════════
    if (!selectedRoom) {
      showToast("error", "Select a Room", "Please choose a room first.");
      return;
    }

    setLoading(true);
    showToast("loading", "Submitting", "Sending reassignment request...");

    try {
      const usersSnap = await getDocs(collection(db, "users"));
      const facultyDoc = findFacultyUserByName(usersSnap, conflict.faculty);

      let facultyId = null;
      let facultyFullName = conflict.faculty || "TBA";
      if (facultyDoc) {
        facultyId = facultyDoc.id;
        const fd = facultyDoc.data();
        facultyFullName = formatFacultyName(`${fd.lastName}, ${fd.firstName}`);
      }

      const reassignStart = reassignedWindow?.start || effectiveStart;
      const reassignEnd = reassignedWindow?.end || effectiveEnd;
      const isPartial = !!selectedRoom._isPartial;

      const reassignmentRef = await addDoc(collection(db, "roomReassignments"), {
        reassignType,
        requestedBy: "clerk",
        requestedById: auth.currentUser?.uid || null,

        facultyId,
        facultyName: conflict.faculty || "",

        courseTitle: isEventReassign ? "" : classSubject,
        section: isEventReassign ? "" : (conflict.section || ""),
        day: conflict.day || "",

        date: effectiveDate,
        startTime: reassignStart,
        endTime: reassignEnd,

        originalStartTime: effectiveStart,
        originalEndTime: effectiveEnd,
        isPartialReassignment: isPartial,
        freeWindows: (selectedRoom._freeWindows || []).map((w) => ({
          start: minToTime(w.start),
          end: minToTime(w.end),
        })),

        oldRoomId: conflict.roomId,
        oldRoomName: conflict.roomName,

        newRoomId: selectedRoom.id,
        newRoomName: selectedRoom.roomName,

        noRoomOption: null,
        clerkReason: "",

        eventId: conflict?.event?.id || null,
        scheduleId: conflict?.schedule?.id || null,

        eventTitle: isEventReassign ? eventSubject : "",
        eventReason: isEventReassign ? activityReason : "",

        status: "pending_admin",
        adminNote: "",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const admins = usersSnap.docs.filter(
        (d) => String(d.data().role || "").toLowerCase() === "admin"
      );
      const partialNote = isPartial
        ? ` (partial: ${format12Hour(reassignStart)} – ${format12Hour(reassignEnd)} only)`
        : "";
      await Promise.all(
        admins.map((admin) =>
          addDoc(collection(db, "notifications"), {
            userId: admin.id,
            ownerType: "admin",
            reassignmentId: reassignmentRef.id,
            title: isPartial
              ? "New Partial Room Reassignment Request"
              : "New Room Reassignment Request",
            message: `${facultyFullName} • ${displaySubject} • ${conflict.roomName} → ${selectedRoom.roomName}${partialNote}. Please review.`,
            type: "room-reassignment-request",
            unread: true,
            archived: false,
            badge: "NEW",
            createdAt: serverTimestamp(),
          })
        )
      );

      const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
      const userData = userDoc.data();
      await logActivity({
        user: `${userData.firstName} ${userData.lastName}`,
        role: userData.role,
        action: `Submitted ${isEventReassign ? "activity" : "class"} room reassignment${isPartial ? " (partial)" : ""}`,
        actionType: "edit",
        target: `${facultyFullName} • ${displaySubject} • ${conflict.roomName} → ${selectedRoom.roomName}${partialNote}`,
        status: "PENDING",
      });

      setShowPreview(false);
      showToast("success", "Submitted for Approval",
        isPartial
          ? `Partial reassignment (${format12Hour(reassignStart)} – ${format12Hour(reassignEnd)}) sent to Admin.`
          : "Your reassignment request has been sent to the Admin for review.");
      setTimeout(() => navigate(from), 1500);
    } catch (err) {
      console.error(err);
      showToast("error", "Submission Failed",
        "Could not submit the reassignment. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const courseTitle = conflict?.subject || conflict?.schedule?.subject || "—";
  const activityTitle = conflict?.activityTitle || conflict?.event?.title || "—";

  const showNoRoomButtons = !roomsLoading;

  // Submit disabled — fail-safe
  const submitDisabled =
    loading ||
    alreadyPending ||
    (!selectedRoom && !noRoomMode);

  // Active floor label for the room list
  const activeFloorLabel = useMemo(() => {
    if (!floor) return null;
    const found = floorOptions.find((o) => o.value === floor);
    return found ? found.label : formatFloorLabel(floor);
  }, [floor, floorOptions]);

  return (
    <>
      <div className="dept-reassign-room">
        <div className="dept-reassign-white-box">
          <div className="dept-reassign-heading">
            <span className={`dept-reassign-type-pill ${isEventReassign ? "is-event" : "is-class"}`}>
              <i className={`fa-solid ${isEventReassign ? "fa-calendar-plus" : "fa-chalkboard-user"}`}></i>
              {isEventReassign ? "Reassigning Activity" : "Reassigning Class"}
            </span>
            <h2 className="dept-reassign-title">
              {isEventReassign ? "Reassign Activity to New Room" : "Reassign Class to New Room"}
            </h2>
            <p className="dept-reassign-subtitle">
              {isEventReassign
                ? "Move the activity to another available room. The class stays in place and the faculty will be notified once approved."
                : "Move this class to another available room. The activity stays in place. Faculty will be notified once approved."}
            </p>
          </div>

          <div className="dept-reassign-summary">
            <div className="dept-reassign-summary-item">
              <span className="dept-reassign-summary-label">
                {isEventReassign ? "Activity Title" : "Course Title"}
              </span>
              <span className="dept-reassign-summary-value">
                {isEventReassign ? activityTitle : courseTitle}
              </span>
            </div>
            <div className="dept-reassign-summary-item">
              <span className="dept-reassign-summary-label">
                {isEventReassign ? "Reason" : "Section"}
              </span>
              <span className="dept-reassign-summary-value">
                {isEventReassign ? (activityReason || "—") : (conflict?.section || "—")}
              </span>
            </div>
            <div className="dept-reassign-summary-item">
              <span className="dept-reassign-summary-label">Faculty</span>
              <span className="dept-reassign-summary-value">{conflict?.faculty || "—"}</span>
            </div>
            <div className="dept-reassign-summary-item">
              <span className="dept-reassign-summary-label">Day</span>
              <span className="dept-reassign-summary-value">{conflict?.day || "—"}</span>
            </div>
            <div className="dept-reassign-summary-item">
              <span className="dept-reassign-summary-label">Date</span>
              <span className="dept-reassign-summary-value">{effectiveDate || "—"}</span>
            </div>
            <div className="dept-reassign-summary-item">
              <span className="dept-reassign-summary-label">Current Room</span>
              <span className="dept-reassign-summary-value">{conflict?.roomName || "—"}</span>
            </div>
            <div className="dept-reassign-summary-item">
              <span className="dept-reassign-summary-label">Time</span>
              <span className="dept-reassign-summary-value">
                {effectiveStart && effectiveEnd
                  ? `${formatTime(effectiveStart)} – ${formatTime(effectiveEnd)}`
                  : "—"}
              </span>
            </div>
            {conflictWindow && (
              <div className="dept-reassign-summary-item">
                <span className="dept-reassign-summary-label">Conflicting Slot</span>
                <span className="dept-reassign-summary-value dept-reassign-conflict-value">
                  {format12Hour(minToTime(conflictWindow.start))} –{" "}
                  {format12Hour(minToTime(conflictWindow.end))}
                </span>
              </div>
            )}
          </div>

          {alreadyPending && !checkingPending && (
            <div className="dept-reassign-notice">
              <i className="fa-solid fa-circle-info"></i>
              <span>
                There is already a <b>pending reassignment</b> for this class.
                Please wait for the Admin's decision before submitting another.
              </span>
            </div>
          )}

          <div className="dept-reassign-room-section">
            <div className="dept-reassign-room-section-header">
              <div className="dept-reassign-room-section-title">
                <span className="dept-venue-title">Select a New Room</span>
                <p className="dept-venue-hint">
                  Rooms tagged <b>Full</b> are free for the entire class. Rooms tagged{" "}
                  <b>Partial</b> are only free for part of the class — you can reassign
                  to those for the free window only.
                </p>
              </div>

              <div className="dept-floor-filter">
                <div className="dept-dropdown-wrapper-venue">
                  <i className="fa-solid fa-layer-group dept-floor-icon"></i>
                  <select
                    value={floor}
                    onChange={(e) => handleFloorChange(e.target.value)}
                    className="dept-dropdown-venue is-floor"
                    aria-label="Filter by floor"
                  >
                    <option value="">All Floors</option>
                    {floorOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <i className="fa-solid fa-angle-down dept-dropdown-icon-venue"></i>
                </div>
              </div>
            </div>

            {(skippedRooms.maintenance > 0 || skippedRooms.inactive > 0) &&
              availableRooms.length === 0 && !roomsLoading && !floor && (
                <div className="dept-reassign-hidden-note">
                  <i className="fa-solid fa-circle-info"></i>
                  <span>
                    {skippedRooms.maintenance > 0 && (
                      <>
                        <b>{skippedRooms.maintenance}</b> room
                        {skippedRooms.maintenance === 1 ? "" : "s"} hidden — under maintenance.
                      </>
                    )}
                    {skippedRooms.maintenance > 0 && skippedRooms.inactive > 0 && " "}
                    {skippedRooms.inactive > 0 && (
                      <>
                        <b>{skippedRooms.inactive}</b> room
                        {skippedRooms.inactive === 1 ? "" : "s"} hidden — inactive.
                      </>
                    )}
                  </span>
                </div>
              )}

            <div className="available-room-list">
              {roomsLoading ? (
                <div className="room-select-empty">
                  <i className="fa-solid fa-spinner fa-spin"></i>
                  <p>Checking room availability...</p>
                </div>
              ) : availableRooms.length === 0 ? (
                <div className="room-select-empty">
                  <i className="fa-regular fa-calendar-xmark"></i>
                  <p>
                    {floor
                      ? `No available rooms on ${activeFloorLabel} for this time slot.`
                      : "No available rooms found for this time slot."}
                  </p>
                  {floor && (
                    <button
                      type="button"
                      className="room-select-clear-floor"
                      onClick={() => handleFloorChange("")}
                    >
                      <i className="fa-solid fa-rotate-left"></i> Show all floors
                    </button>
                  )}
                </div>
              ) : (
                availableRooms.map((room) => {
                  const isSelected = selectedRoom?.id === room.id;
                  const w = room._primaryWindow;
                  const partial = room._isPartial;

                  return (
                    <button
                      type="button"
                      key={room.id}
                      className={`available-room-card ${isSelected ? "selected" : ""} ${partial ? "is-partial" : "is-full"}`}
                      onClick={() => handleSelectRoom(room)}
                    >
                      <div className="room-card-top">
                        <h4>{room.roomName}</h4>
                        {isSelected && <i className="fa-solid fa-circle-check"></i>}
                      </div>
                      <div className="room-card-meta">
                        <span className="room-card-floor">
                          <i className="fa-solid fa-building"></i>{room.floor}
                        </span>
                        {room.roomType && (
                          <span className="room-card-type">{room.roomType}</span>
                        )}
                        {room.capacity && (
                          <span className="room-card-capacity">
                            <i className="fa-solid fa-users"></i>{room.capacity}
                          </span>
                        )}
                      </div>
                      <div className={`room-card-availability ${partial ? "is-partial" : "is-full"}`}>
                        {partial ? (
                          <>
                            <i className="fa-solid fa-circle-half-stroke"></i>
                            <span>
                              Partial — free {format12Hour(minToTime(w.start))} –{" "}
                              {format12Hour(minToTime(w.end))}
                            </span>
                          </>
                        ) : (
                          <>
                            <i className="fa-solid fa-circle-check"></i>
                            <span>Full — free for the whole class</span>
                          </>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {showNoRoomButtons && (
              <div className="no-room-options">
                <div className="no-room-options-header">
                  <i className="fa-solid fa-triangle-exclamation"></i>
                  <div>
                    <span className="no-room-title">Can't find a room?</span>
                    <p className="no-room-subtitle">
                      If no room is available or none fit the requirements,
                      report it to the Admin. They will decide whether to
                      cancel the class or ask for another reassignment.
                    </p>
                  </div>
                </div>
                <div className="no-room-buttons">
                  <button
                    type="button"
                    className="no-room-btn is-unavailable"
                    onClick={() => openNoRoomMode("none_available")}
                    disabled={alreadyPending}
                  >
                    <i className="fa-solid fa-door-closed"></i>
                    <div>
                      <strong>No Room Available</strong>
                      <span>All rooms are occupied</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="no-room-btn is-unsuited"
                    onClick={() => openNoRoomMode("none_suited")}
                    disabled={alreadyPending}
                  >
                    <i className="fa-solid fa-circle-question"></i>
                    <div>
                      <strong>No Suitable Room</strong>
                      <span>None fit the requirements</span>
                    </div>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="dept-reassign-footer">
          <button
            className="dept-reassign-back-btn"
            onClick={() => navigate(from)}
            disabled={loading}
          >
            Back
          </button>
          <button
            className="dept-reassign-confirm-btn"
            onClick={handleSubmitClick}
            disabled={submitDisabled}
            title={
              alreadyPending
                ? "A reassignment for this class is already awaiting review."
                : !selectedRoom && !noRoomMode
                ? "Select a room or report 'No Room Available' first."
                : ""
            }
          >
            {loading ? (
              <>
                <i className="fa-solid fa-circle-notch fa-spin"></i> Submitting...
              </>
            ) : alreadyPending ? (
              <>
                <i className="fa-solid fa-lock"></i> Already Pending
              </>
            ) : (
              <>
                <i className="fa-solid fa-paper-plane"></i> Submit for Approval
              </>
            )}
          </button>
        </div>
      </div>

      {/* ═══════════════ PREVIEW MODAL ═══════════════ */}
      {showPreview && (
        <div className="crr-preview-overlay" onClick={closePreview}>
          <div className="crr-preview-modal" onClick={(e) => e.stopPropagation()}>
            {noRoomMode ? (
              <>
                <div className="crr-preview-header">
                  <div className="crr-preview-icon is-no-room">
                    <i className={`fa-solid ${NO_ROOM_LABELS[noRoomMode].icon}`}></i>
                  </div>
                  <h3>Report {NO_ROOM_LABELS[noRoomMode].short}</h3>
                  <p className="crr-preview-subtitle">
                    {NO_ROOM_LABELS[noRoomMode].desc} This will be sent to the
                    Admin for a decision.
                  </p>
                </div>

                <div className="crr-preview-body">
                  <div className="crr-preview-row">
                    <span className="crr-preview-label">Type</span>
                    <span className="crr-preview-value">
                      <span className={`crr-preview-type-pill ${isEventReassign ? "is-event" : "is-class"}`}>
                        {isEventReassign ? "Activity" : "Class"}
                      </span>
                    </span>
                  </div>
                  <div className="crr-preview-row">
                    <span className="crr-preview-label">
                      {isEventReassign ? "Activity Title" : "Course Title"}
                    </span>
                    <span className="crr-preview-value">{displaySubject}</span>
                  </div>
                  <div className="crr-preview-row">
                    <span className="crr-preview-label">Faculty</span>
                    <span className="crr-preview-value">{conflict?.faculty || "TBA"}</span>
                  </div>
                  <div className="crr-preview-row">
                    <span className="crr-preview-label">Day</span>
                    <span className="crr-preview-value">{conflict?.day || "—"}</span>
                  </div>
                  <div className="crr-preview-row">
                    <span className="crr-preview-label">Date</span>
                    <span className="crr-preview-value">{formatDateLong(effectiveDate)}</span>
                  </div>
                  <div className="crr-preview-row">
                    <span className="crr-preview-label">Time</span>
                    <span className="crr-preview-value">
                      {format12Hour(effectiveStart)} – {format12Hour(effectiveEnd)}
                    </span>
                  </div>
                  <div className="crr-preview-row">
                    <span className="crr-preview-label">Current Room</span>
                    <span className="crr-preview-value">{conflict?.roomName || "—"}</span>
                  </div>

                  <div className="no-room-reason-group">
                    <label className="no-room-reason-label">
                      Reason for Admin <span className="req">*</span>
                    </label>
                    <textarea
                      className="no-room-reason-textarea"
                      placeholder={
                        noRoomMode === "none_available"
                          ? "e.g. All rooms are occupied during this time slot — checked all floors."
                          : "e.g. Available rooms are too small for the class size or lack needed equipment."
                      }
                      rows={3}
                      value={noRoomReason}
                      onChange={(e) => setNoRoomReason(e.target.value)}
                      disabled={loading}
                    />
                  </div>

                  <div className="crr-preview-note">
                    <i className="fa-solid fa-circle-info"></i>
                    <span>
                      The Admin will review this report. They may either
                      <strong> cancel the class</strong> (with a reason shared
                      to you and the faculty) or <strong>ask you to reassign
                      again</strong>.
                    </span>
                  </div>
                </div>

                <div className="crr-preview-actions">
                  <button className="crr-preview-back-btn" onClick={closePreview} disabled={loading}>
                    <i className="fa-solid fa-pen-to-square"></i> Cancel
                  </button>
                  <button
                    className={`crr-preview-confirm-btn ${loading ? "is-loading" : ""}`}
                    onClick={handleConfirm}
                    disabled={loading || !noRoomReason.trim()}
                  >
                    {loading ? (
                      <><i className="fa-solid fa-circle-notch fa-spin"></i> Submitting...</>
                    ) : (
                      <><i className="fa-solid fa-paper-plane"></i> Submit to Admin</>
                    )}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="crr-preview-header">
                  <div className={`crr-preview-icon ${previewData.isPartial ? "is-partial" : ""}`}>
                    <i className={`fa-solid ${isEventReassign ? "fa-calendar-plus" : "fa-chalkboard-user"}`}></i>
                  </div>
                  <h3>
                    {previewData.isPartial ? "Review Partial Reassignment" : "Review Reassignment"}
                  </h3>
                  <p className="crr-preview-subtitle">
                    {previewData.isPartial
                      ? "This room is only free for part of the class. The reassignment will cover only that free window."
                      : "Please confirm the details below before submitting to the Admin."}
                  </p>
                </div>

                <div className="crr-preview-body">
                  <div className="crr-preview-row">
                    <span className="crr-preview-label">Type</span>
                    <span className="crr-preview-value">
                      <span className={`crr-preview-type-pill ${isEventReassign ? "is-event" : "is-class"}`}>
                        {previewData.type}
                      </span>
                    </span>
                  </div>
                  <div className="crr-preview-row">
                    <span className="crr-preview-label">
                      {isEventReassign ? "Activity Title" : "Course Title"}
                    </span>
                    <span className="crr-preview-value">{previewData.title}</span>
                  </div>
                  <div className="crr-preview-row">
                    <span className="crr-preview-label">
                      {isEventReassign ? "Reason" : "Section"}
                    </span>
                    <span className="crr-preview-value">{previewData.subtitle}</span>
                  </div>
                  <div className="crr-preview-row">
                    <span className="crr-preview-label">Faculty</span>
                    <span className="crr-preview-value">{previewData.faculty}</span>
                  </div>
                  <div className="crr-preview-row">
                    <span className="crr-preview-label">Day</span>
                    <span className="crr-preview-value">{previewData.day}</span>
                  </div>
                  <div className="crr-preview-row">
                    <span className="crr-preview-label">Date</span>
                    <span className="crr-preview-value">{formatDateLong(previewData.date)}</span>
                  </div>
                  <div className="crr-preview-row">
                    <span className="crr-preview-label">Original Class Time</span>
                    <span className="crr-preview-value">{previewData.originalTime}</span>
                  </div>
                  <div className="crr-preview-row">
                    <span className="crr-preview-label">
                      {previewData.isPartial ? "Reassigned Window" : "Reassigned Time"}
                    </span>
                    <span className={`crr-preview-value ${previewData.isPartial ? "crr-preview-value--partial" : ""}`}>
                      {previewData.reassignTime}
                      {previewData.isPartial && (
                        <span className="crr-preview-partial-tag">Partial</span>
                      )}
                    </span>
                  </div>

                  <div className="crr-preview-move">
                    <div className="crr-preview-move-item">
                      <span className="crr-preview-move-label">From</span>
                      <span className="crr-preview-move-value">{previewData.oldRoom}</span>
                    </div>
                    <div className="crr-preview-move-arrow">
                      <i className="fa-solid fa-arrow-right"></i>
                    </div>
                    <div className="crr-preview-move-item crr-preview-move-item--to">
                      <span className="crr-preview-move-label">To</span>
                      <span className="crr-preview-move-value">{previewData.newRoom}</span>
                      {previewData.newRoomFloor && (
                        <span className="crr-preview-move-meta">
                          {previewData.newRoomFloor}
                          {previewData.newRoomCapacity ? ` • ${previewData.newRoomCapacity} Seats` : ""}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="crr-preview-note">
                    <i className="fa-solid fa-circle-info"></i>
                    <span>
                      {previewData.isPartial ? (
                        <>
                          Only <strong>{previewData.reassignTime}</strong> will be
                          reassigned to <strong>{previewData.newRoom}</strong>. The
                          remaining time of <strong>{previewData.originalTime}</strong>{" "}
                          stays in the original room. Admin will review before it
                          takes effect.
                        </>
                      ) : (
                        <>
                          After submitting, this reassignment will be marked as{" "}
                          <strong>Pending Admin Approval</strong>. The faculty and
                          admin will be notified once it's processed.
                        </>
                      )}
                    </span>
                  </div>
                </div>

                <div className="crr-preview-actions">
                  <button className="crr-preview-back-btn" onClick={closePreview} disabled={loading}>
                    <i className="fa-solid fa-pen-to-square"></i> Edit
                  </button>
                  <button
                    className={`crr-preview-confirm-btn ${loading ? "is-loading" : ""}`}
                    onClick={handleConfirm}
                    disabled={loading}
                  >
                    {loading ? (
                      <><i className="fa-solid fa-circle-notch fa-spin"></i> Submitting...</>
                    ) : (
                      <><i className="fa-solid fa-circle-check"></i> Confirm & Submit</>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

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

export default ClerkReassignRoom;