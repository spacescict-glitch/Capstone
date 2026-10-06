import { useNavigate } from "react-router-dom";
import { useState, useEffect, useRef } from "react";
import "./reservation-card.css";
import ConfirmPopup from "../../Popup/ConfirmPopup/ConfirmPopup";
import DenialPopup from "../../Popup/DenialPopup/DenialPopup";
import Toast from "../../Popup/Toast/Toast";
import {
  doc,
  updateDoc,
  getDoc,
  getDocs,
  collection,
  addDoc,
  query,
  where,
  serverTimestamp,
} from "firebase/firestore";
import { db, auth } from "../../firebase";
import { logActivity } from "../../utils/logActivity";

// ─── Status config: label, icon, css modifier ─────────────────────
const STATUS_CONFIG = {
  pending:   { label: "Pending",   icon: "fa-clock",        modifier: "pending" },
  approved:  { label: "Approved",  icon: "fa-circle-check", modifier: "approved" },
  rejected:  { label: "Denied",    icon: "fa-circle-xmark", modifier: "denied" },
  denied:    { label: "Denied",    icon: "fa-circle-xmark", modifier: "denied" },
  cancelled: { label: "Cancelled", icon: "fa-ban",          modifier: "cancelled" },
};

const getStatusConfig = (status) => {
  const key = status?.toLowerCase().trim() || "pending";
  return STATUS_CONFIG[key] || STATUS_CONFIG.pending;
};

// ─── Date helpers ────────────────────────────────────────────────
const formatDateCompact = (dateStr) => {
  if (!dateStr) return "—";
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
};

const format12Hour = (time) => {
  if (!time) return "—";
  const [hour, minute] = time.split(":").map(Number);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return time;
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return `${h}:${String(minute).padStart(2, "0")} ${suffix}`;
};

const formatTimeRange = (start, end) => {
  if (!start || !end) return "—";
  return `${format12Hour(start)} – ${format12Hour(end)}`;
};

const getRelativeTime = (timestamp) => {
  if (!timestamp?.toDate) return "—";
  const date = timestamp.toDate();
  const now = new Date();
  const diff = Math.floor((now - date) / 1000);
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

// ─── Helper: find user by full name (faculty fallback) ────────────
const findUserByName = async (name) => {
  if (!name) return null;
  const usersSnap = await getDocs(collection(db, "users"));
  const normalized = name.trim().toLowerCase();
  for (const d of usersSnap.docs) {
    const data = d.data();
    const fullName = `${data.firstName || ""} ${data.lastName || ""}`
      .trim()
      .toLowerCase();
    if (fullName === normalized) return { id: d.id, ...data };
  }
  return null;
};

// ─── Helper: pick the first truthy photo field from a user doc ────
const extractUserPhoto = (userData) => {
  if (!userData) return null;
  return (
    userData.photoUrl ||
    userData.photoURL ||
    userData.profilePhoto ||
    userData.photo ||
    userData.profilePicture ||
    userData.avatar ||
    userData.imageUrl ||
    null
  );
};

// ─── Helper: get current clerk user ───────────────────────────────
const getCurrentUser = async () => {
  const firebaseUser = auth.currentUser;
  if (!firebaseUser) return { uid: "", name: "Clerk", role: "Clerk" };
  const snap = await getDoc(doc(db, "users", firebaseUser.uid));
  const data = snap.exists() ? snap.data() : {};
  return {
    uid: firebaseUser.uid,
    name:
      `${data.firstName || ""} ${data.lastName || ""}`.trim() || "Clerk",
    role: data.role || "Clerk",
  };
};

// ─── Helper: send one notification doc ────────────────────────────
const sendNotification = async ({
  receiverId,
  ownerType,
  title,
  message,
  reservationId,
  type,
  badge = "INFO",
}) => {
  if (!receiverId) return;
  try {
    await addDoc(collection(db, "notifications"), {
      userId: receiverId,
      ownerType,
      reservationId,
      title,
      message,
      type,
      unread: true,
      archived: false,
      badge,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn("Notification failed:", err);
  }
};

// ─── Helper: notify all admins ────────────────────────────────────
const notifyAllAdmins = async (title, message, reservationId) => {
  try {
    const usersSnap = await getDocs(collection(db, "users"));
    const jobs = [];
    usersSnap.forEach((d) => {
      const role = (d.data().role || "").toLowerCase().trim();
      if (role === "admin") {
        jobs.push(
          addDoc(collection(db, "notifications"), {
            userId: d.id,
            ownerType: "admin",
            reservationId,
            title,
            message,
            type: "reservation-decision",
            unread: true,
            archived: false,
            badge: "INFO",
            createdAt: serverTimestamp(),
          })
        );
      }
    });
    if (jobs.length) await Promise.all(jobs);
  } catch (err) {
    console.warn("notifyAllAdmins failed:", err);
  }
};

// ═══════════════════════════════════════════════════════════════
// CONFLICT CHECK — real-time scan of the reservation's room/date.
//
// Sources:
//   1. Events (room activity, reservation-generated events)
//   2. ACCEPTED reassignments INTO this room
//   3. Other APPROVED reservations (walk-in + online)
//   4. Class schedules on the matching weekday
//
// If ANY of these overlap → we surface a conflict. The Clerk cannot
// approve while conflicts exist.
// ═══════════════════════════════════════════════════════════════
const parseTimeToMin = (t) => {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
};
const overlaps = (aS, aE, bS, bE) => aS < bE && aE > bS;

const checkReservationConflicts = async (reservation) => {
  if (!reservation) return [];
  const roomId = reservation.roomId;
  const roomName = reservation.roomName;
  if (!roomId && !roomName) return [];
  if (!reservation.date || !reservation.startTime || !reservation.endTime) return [];

  const reqStart = parseTimeToMin(reservation.startTime);
  const reqEnd = parseTimeToMin(reservation.endTime);
  if (reqStart == null || reqEnd == null) return [];

  const matchesRoom = (r) =>
    (roomId && r.roomId === roomId) ||
    (roomName && r.roomName === roomName);

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

    // 1) Events
    evSnap.docs.forEach((d) => {
      const e = { id: d.id, ...d.data() };
      if (String(e.status || "").toLowerCase() === "cancelled") return;
      if (!matchesRoom(e)) return;
      // Skip the event that this very reservation created (post-approval)
      if (e.reservationId && e.reservationId === reservation.id) return;
      const s = parseTimeToMin(e.startTime);
      const en = parseTimeToMin(e.endTime);
      if (s == null || en == null) return;
      if (!overlaps(reqStart, reqEnd, s, en)) return;
      conflicts.push({
        id: e.id,
        kind: "event",
        label: "Room Activity",
        title: e.title || e.purpose || "Room Activity",
        faculty: e.faculty || e.requestedByName || "Admin",
        startTime: e.startTime,
        endTime: e.endTime,
      });
    });

    // 2) Accepted reassignments into this room
    reSnap.docs.forEach((d) => {
      const r = { id: d.id, ...d.data() };
      if (r.date !== reservation.date) return;
      const status = String(r.status || "").toLowerCase();
      if (status !== "accepted" && status !== "approved") return;
      const into =
        (roomId && r.newRoomId === roomId) ||
        (roomName && r.newRoomName === roomName);
      if (!into) return;
      const s = parseTimeToMin(r.startTime);
      const en = parseTimeToMin(r.endTime);
      if (s == null || en == null) return;
      if (!overlaps(reqStart, reqEnd, s, en)) return;
      conflicts.push({
        id: r.id,
        kind: "reassignment",
        label: "Reassigned Class",
        title: r.courseTitle || r.eventTitle || "Reassigned Class",
        faculty: r.facultyName || "-",
        startTime: r.startTime,
        endTime: r.endTime,
      });
    });

    // 3) Other approved reservations
    resSnap.docs.forEach((d) => {
      const r = { id: d.id, ...d.data() };
      if (r.id === reservation.id) return; // skip self
      if (String(r.status || "").toLowerCase() !== "approved") return;
      if (!matchesRoom(r)) return;
      const s = parseTimeToMin(r.startTime);
      const en = parseTimeToMin(r.endTime);
      if (s == null || en == null) return;
      if (!overlaps(reqStart, reqEnd, s, en)) return;
      const isWalkIn = String(r.reservationType || "").toLowerCase() === "walk-in";
      conflicts.push({
        id: r.id,
        kind: "reservation",
        label: isWalkIn ? "Walk-in Reservation" : "Faculty Reservation",
        title: r.customPurpose || r.courseTitle || r.purpose || "Reservation",
        faculty: r.requesterName || r.facultyName || "-",
        startTime: r.startTime,
        endTime: r.endTime,
      });
    });

    // 4) Class schedules on the matching weekday
    if (schedSnap.docs?.length) {
      const day = new Date(`${reservation.date}T00:00:00`)
        .toLocaleDateString("en-US", { weekday: "short" })
        .toUpperCase();
      schedSnap.docs.forEach((d) => {
        const s = { id: d.id, ...d.data() };
        if (s.cancelled || s.initialized) return;
        if (s.day !== day) return;
        const sT = parseTimeToMin(s.startTime);
        const eT = parseTimeToMin(s.endTime);
        if (sT == null || eT == null) return;
        if (!overlaps(reqStart, reqEnd, sT, eT)) return;
        conflicts.push({
          id: s.id,
          kind: "schedule",
          label: "Class Schedule",
          title: s.subject || s.courseTitle || s.title || "Class",
          faculty: s.facultyName || s.faculty || "-",
          startTime: s.startTime,
          endTime: s.endTime,
        });
      });
    }
  } catch (err) {
    console.error("Conflict check failed:", err);
  }

  return conflicts;
};

function ReservationCard({
  reservation,
  basePath = "/clerk/view-online-reservation",
  readOnly = false,
}) {
  const navigate = useNavigate();
  const [showConfirm, setShowConfirm] = useState(false);
  const [showDenial, setShowDenial] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // ─── Conflict state ───────────────────────────────────────────
  const [conflicts, setConflicts] = useState([]);
  const [checkingConflicts, setCheckingConflicts] = useState(true);
  const [showConflictModal, setShowConflictModal] = useState(false);

  // ─── Room photo state ─────────────────────────────────────────
  const [roomPhoto, setRoomPhoto] = useState(null);

  // ─── Requester photo state ────────────────────────────────────
  const [requesterPhoto, setRequesterPhoto] = useState(null);

  // ─── Toast state ──────────────────────────────────────────────
  const toastTimeoutRef = useRef(null);
  const [toast, setToast] = useState({
    show: false,
    type: "success",
    title: "",
    message: "",
  });

  const showToast = (type, title, message) => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = null;
    }
    setToast({ show: true, type, title, message });
    if (type !== "loading") {
      toastTimeoutRef.current = setTimeout(() => {
        setToast((p) => ({ ...p, show: false }));
        toastTimeoutRef.current = null;
      }, 4000);
    }
  };

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  const statusConfig = getStatusConfig(reservation?.status);

  // ═════════════════════════════════════════════════════════════
  // Run conflict check whenever the reservation changes.
  // We skip this for already-decided reservations (approved/denied)
  // since there's nothing to approve anymore.
  // ═════════════════════════════════════════════════════════════
  useEffect(() => {
    let cancelled = false;
    const status = String(reservation?.status || "").toLowerCase();
    const decided = status === "approved" || status === "rejected" ||
                    status === "denied" || status === "cancelled";

    if (decided) {
      setConflicts([]);
      setCheckingConflicts(false);
      return;
    }

    const run = async () => {
      setCheckingConflicts(true);
      const found = await checkReservationConflicts(reservation);
      if (!cancelled) {
        setConflicts(found);
        setCheckingConflicts(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [reservation]);

  // ═════════════════════════════════════════════════════════════
  // Re-check conflicts fresh every time the Clerk attempts to
  // approve. This is the safety net that catches slots that were
  // free at submission but got taken before approval.
  // ═════════════════════════════════════════════════════════════
  const handleApproveClick = async (e) => {
    e.stopPropagation();
    if (submitting) return;

    // Re-check live before showing confirm dialog
    const fresh = await checkReservationConflicts(reservation);
    setConflicts(fresh);

    if (fresh.length > 0) {
      setShowConflictModal(true);
      return;
    }
    setShowConfirm(true);
  };

  const handleDenyClick = (e) => {
    e.stopPropagation();
    if (submitting) return;
    setShowDenial(true);
  };

  // ─── Approve ──────────────────────────────────────────────────
  const approveReservation = async () => {
    setSubmitting(true);
    showToast("loading", "Processing", "Approving reservation...");

    try {
      // ⚠️ FINAL GUARD — re-check one more time to be safe.
      const finalConflicts = await checkReservationConflicts(reservation);
      if (finalConflicts.length > 0) {
        setConflicts(finalConflicts);
        setShowConfirm(false);
        setShowConflictModal(true);
        showToast(
          "error",
          "Conflicts Detected",
          "This reservation now overlaps another booking. Approval blocked."
        );
        return;
      }

      await updateDoc(doc(db, "reservationRequests", reservation.id), {
        status: "Approved",
      });

      // Tag the generated event with reservationId so we never flag
      // this same reservation as its own conflict later.
      await addDoc(collection(db, "events"), {
        roomId: reservation.roomId,
        roomName: reservation.roomName,
        facultyName: reservation.facultyName,
        courseTitle: reservation.courseTitle,
        purpose: reservation.purpose,
        date: reservation.date,
        startTime: reservation.startTime,
        endTime: reservation.endTime,
        createdAt: serverTimestamp(),
        source: "Reservation",
        reservationId: reservation.id,
      });

      const me = await getCurrentUser();

      await logActivity({
        userId: me.uid,
        user: me.name,
        role: me.role,
        action: "Approved Reservation",
        actionType: "success",
        target: `${reservation.roomName} - ${reservation.courseTitle}`,
        status: "SUCCESS",
        details: {
          reservationId: reservation.id,
          faculty: reservation.facultyName,
          course: reservation.courseTitle,
          date: reservation.date,
          time: `${reservation.startTime} - ${reservation.endTime}`,
        },
      });

      let facultyUserId = reservation.userId;
      if (!facultyUserId && reservation.facultyName) {
        const u = await findUserByName(reservation.facultyName);
        if (u) facultyUserId = u.id;
      }
      if (facultyUserId) {
        await sendNotification({
          receiverId: facultyUserId,
          ownerType: "faculty",
          title: "Reservation Approved",
          message: `Your reservation request for ${reservation.roomName} on ${reservation.date} (${reservation.startTime} - ${reservation.endTime}) has been approved.`,
          reservationId: reservation.id,
          type: "reservation-approved",
          badge: "SUCCESS",
        });
      }

      if (me.uid) {
        await sendNotification({
          receiverId: me.uid,
          ownerType: "clerk",
          title: "Reservation Approved",
          message: `You approved ${reservation.facultyName}'s reservation request for ${reservation.roomName}.`,
          reservationId: reservation.id,
          type: "reservation-approved",
          badge: "INFO",
        });
      }

      await notifyAllAdmins(
        "Reservation Approved",
        `${reservation.facultyName}'s reservation for ${reservation.roomName} was approved by Clerk.`,
        reservation.id
      );

      setShowConfirm(false);
      showToast("success", "Success", "Reservation approved successfully!");
    } catch (err) {
      console.error("Approve error:", err);
      showToast("error", "Error", err.message || "Failed to approve reservation.");
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Deny ─────────────────────────────────────────────────────
  const denyReservation = async (reason) => {
    setSubmitting(true);
    showToast("loading", "Processing", "Denying reservation...");

    try {
      await updateDoc(doc(db, "reservationRequests", reservation.id), {
        status: "Rejected",
        denialReason: reason,
      });

      const me = await getCurrentUser();

      await logActivity({
        userId: me.uid,
        user: me.name,
        role: me.role,
        action: "Rejected Reservation",
        actionType: "failed",
        target: `${reservation.roomName} - ${reservation.courseTitle}`,
        status: "FAILED",
        details: {
          reservationId: reservation.id,
          faculty: reservation.facultyName,
          reason,
        },
      });

      let facultyUserId = reservation.userId;
      if (!facultyUserId && reservation.facultyName) {
        const u = await findUserByName(reservation.facultyName);
        if (u) facultyUserId = u.id;
      }
      if (facultyUserId) {
        await sendNotification({
          receiverId: facultyUserId,
          ownerType: "faculty",
          title: "Reservation Rejected",
          message: `Your reservation request for ${reservation.roomName} was rejected.\nReason: ${reason}`,
          reservationId: reservation.id,
          type: "reservation-rejected",
          badge: "WARNING",
        });
      }

      if (me.uid) {
        await sendNotification({
          receiverId: me.uid,
          ownerType: "clerk",
          title: "Reservation Rejected",
          message: `You rejected ${reservation.facultyName}'s reservation request for ${reservation.roomName}.`,
          reservationId: reservation.id,
          type: "reservation-rejected",
          badge: "INFO",
        });
      }

      await notifyAllAdmins(
        "Reservation Rejected",
        `${reservation.facultyName}'s reservation for ${reservation.roomName} was rejected by Clerk.`,
        reservation.id
      );

      setShowDenial(false);
      showToast("success", "Success", "Reservation denied successfully.");
    } catch (err) {
      console.error("Deny error:", err);
      showToast("error", "Error", err.message || "Failed to deny reservation.");
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Fetch room photo ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const fetchRoomPhoto = async () => {
      if (!reservation) return;
      try {
        let roomData = null;

        if (reservation.roomId) {
          const snap = await getDoc(doc(db, "rooms", reservation.roomId));
          if (snap.exists()) roomData = snap.data();
        }

        if (!roomData && reservation.roomName) {
          const q = query(
            collection(db, "rooms"),
            where("roomName", "==", reservation.roomName.trim())
          );
          const snap = await getDocs(q);
          if (!snap.empty) roomData = snap.docs[0].data();
        }

        if (!roomData) return;
        const photo = roomData.photoUrl;
        if (photo && !cancelled) setRoomPhoto(photo);
      } catch (err) {
        console.error("Failed to fetch room photo:", err);
      }
    };

    fetchRoomPhoto();
    return () => {
      cancelled = true;
    };
  }, [reservation]);

  // ─── Fetch requester (faculty) photo ──────────────────────────
  useEffect(() => {
    let cancelled = false;

    const fetchRequesterPhoto = async () => {
      if (!reservation) return;

      try {
        const inlinePhoto =
          reservation.userPhoto ||
          reservation.requesterPhoto ||
          reservation.facultyPhoto ||
          reservation.photoURL;

        if (inlinePhoto) {
          if (!cancelled) setRequesterPhoto(inlinePhoto);
          return;
        }

        let userId = reservation.userId;

        if (!userId && (reservation.facultyName || reservation.requesterName)) {
          const user = await findUserByName(
            reservation.facultyName || reservation.requesterName
          );
          if (user) userId = user.id;
        }

        if (!userId) return;

        const userSnap = await getDoc(doc(db, "users", userId));
        if (!userSnap.exists()) return;

        const photo = extractUserPhoto(userSnap.data());
        if (photo && !cancelled) setRequesterPhoto(photo);
      } catch (err) {
        console.error("Failed to fetch requester photo:", err);
      }
    };

    fetchRequesterPhoto();
    return () => {
      cancelled = true;
    };
  }, [reservation]);

  const facultyDisplay =
    reservation.facultyName || reservation.requesterName || "Unknown";
  const facultyInitials = facultyDisplay
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase())
    .join("");

  const status = String(reservation?.status || "").toLowerCase();
  const isDecided =
    status === "approved" || status === "rejected" ||
    status === "denied" || status === "cancelled";
  const hasConflicts = conflicts.length > 0;

  return (
    <>
      <div
        className="reservation-card"
        onClick={() =>
          navigate(basePath, {
            state: { reservation },
          })
        }
      >
        {/* ─────── LEFT: Content ─────── */}
        <div className="reservation-card-left">
          {/* Header row: badges + relative time */}
          <div className="reservation-top-row">
            <span className="reservation-room-badge">
              <i className="fa-solid fa-door-open"></i>
              {reservation.roomName || "No Room"}
            </span>

            <span className={`reservation-status-badge ${statusConfig.modifier}`}>
              <i className={`fa-solid ${statusConfig.icon}`}></i>
              {statusConfig.label}
            </span>

            {/* ⚠️ CONFLICT BADGE */}
            {!isDecided && hasConflicts && (
              <span
                className="reservation-status-badge"
                style={{
                  background: "#fee2e2",
                  color: "#b91c1c",
                  border: "1px solid #fecaca",
                }}
                title="This reservation now overlaps another booking"
              >
                <i className="fa-solid fa-triangle-exclamation"></i>
                {conflicts.length} Conflict{conflicts.length > 1 ? "s" : ""}
              </span>
            )}

            <span className="reservation-created-chip">
              <i className="fa-regular fa-clock"></i>
              {getRelativeTime(reservation.createdAt)}
            </span>
          </div>

          {/* Faculty name with avatar / photo */}
          <div className="reservation-name-row">
            <div className="reservation-avatar">
              {requesterPhoto ? (
                <img
                  src={requesterPhoto}
                  alt={facultyDisplay}
                  className="reservation-avatar-img"
                  onError={() => setRequesterPhoto(null)}
                />
              ) : (
                <span className="reservation-avatar-initials">
                  {facultyInitials || "?"}
                </span>
              )}
            </div>
            <div className="reservation-name-text">
              <h3 className="reservation-name">{facultyDisplay}</h3>
              <span className="reservation-name-sub">Requested by</span>
            </div>
          </div>

          {/* Details grid — 2x2 on desktop */}
          <div className="reservation-details">
            <div className="reservation-detail">
              <div className="reservation-detail-icon">
                <i className="fa-regular fa-calendar"></i>
              </div>
              <div className="reservation-detail-text">
                <span className="reservation-detail-label">Date</span>
                <span className="reservation-detail-value">
                  {formatDateCompact(reservation.date)}
                </span>
              </div>
            </div>

            <div className="reservation-detail">
              <div className="reservation-detail-icon">
                <i className="fa-regular fa-clock"></i>
              </div>
              <div className="reservation-detail-text">
                <span className="reservation-detail-label">Time</span>
                <span className="reservation-detail-value">
                  {formatTimeRange(reservation.startTime, reservation.endTime)}
                </span>
              </div>
            </div>

            <div className="reservation-detail">
              <div className="reservation-detail-icon">
                <i className="fa-solid fa-book"></i>
              </div>
              <div className="reservation-detail-text">
                <span className="reservation-detail-label">Course</span>
                <span
                  className="reservation-detail-value"
                  title={reservation.courseTitle}
                >
                  {reservation.courseTitle || "N/A"}
                </span>
              </div>
            </div>

            <div className="reservation-detail">
              <div className="reservation-detail-icon">
                <i className="fa-solid fa-user-graduate"></i>
              </div>
              <div className="reservation-detail-text">
                <span className="reservation-detail-label">
                  {reservation.audienceType === "Organization"
                    ? "Audience"
                    : "Section"}
                </span>
                <span
                  className="reservation-detail-value"
                  title={
                    reservation.audienceType === "Organization"
                      ? reservation.attendees?.organization
                      : reservation.attendees?.yearSectionGroup
                  }
                >
                  {reservation.audienceType === "Organization"
                    ? reservation.attendees?.organization || "—"
                    : reservation.attendees?.yearSectionGroup || "—"}
                </span>
              </div>
            </div>
          </div>

          {/* Actions */}
          {!readOnly && (
            <div className="reservation-actions">
              <button
                className="approve-btn-reservation"
                onClick={handleApproveClick}
                disabled={submitting || checkingConflicts || hasConflicts}
                title={
                  hasConflicts
                    ? "Resolve conflicts before approving"
                    : ""
                }
                style={
                  hasConflicts
                    ? { opacity: 0.55, cursor: "not-allowed" }
                    : undefined
                }
              >
                {submitting ? (
                  <>
                    <i className="fa-solid fa-spinner fa-spin"></i> Please wait
                  </>
                ) : checkingConflicts ? (
                  <>
                    <i className="fa-solid fa-spinner fa-spin"></i> Checking…
                  </>
                ) : hasConflicts ? (
                  <>
                    <i className="fa-solid fa-ban"></i> Conflicts
                  </>
                ) : (
                  <>
                    <i className="fa-solid fa-circle-check"></i> Approve
                  </>
                )}
              </button>
              <button
                className="deny-btn-reservation"
                onClick={handleDenyClick}
                disabled={submitting}
              >
                {submitting ? (
                  <>
                    <i className="fa-solid fa-spinner fa-spin"></i> Please wait
                  </>
                ) : (
                  <>
                    <i className="fa-solid fa-circle-xmark"></i> Deny
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {/* ─────── RIGHT: Image ─────── */}
        <div className="reservation-card-right">
          <div className="reservation-image">
            {roomPhoto ? (
              <img
                src={roomPhoto}
                alt={reservation.roomName || "Room"}
                onError={() => setRoomPhoto(null)}
              />
            ) : (
              <div className="reservation-image-placeholder">
                <i className="fa-solid fa-door-open"></i>
                <span>{reservation.roomName || "No Room"}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {showConfirm && (
        <ConfirmPopup
          onCancel={() => !submitting && setShowConfirm(false)}
          onConfirm={submitting ? null : approveReservation}
        />
      )}

      {showDenial && (
        <DenialPopup
          onCancel={() => !submitting && setShowDenial(false)}
          onConfirm={submitting ? null : denyReservation}
        />
      )}

      {/* ═══════════ CONFLICT BLOCK MODAL ═══════════ */}
      {showConflictModal && (
        <div
          onClick={() => setShowConflictModal(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(20,18,15,0.5)",
            backdropFilter: "blur(2px)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff",
              borderRadius: 18,
              padding: 28,
              width: 460,
              maxWidth: "calc(100vw - 32px)",
              maxHeight: "85vh",
              overflowY: "auto",
              boxShadow: "0 20px 60px rgba(0,0,0,.25)",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: "50%",
                background: "#fee2e2",
                color: "#b91c1c",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 20,
              }}
            >
              <i className="fa-solid fa-triangle-exclamation"></i>
            </div>

            <h3 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: "#16181d" }}>
              Cannot Approve — Conflicts Found
            </h3>

            <p style={{ margin: 0, fontSize: 13, color: "#6b7280", lineHeight: 1.5 }}>
              This reservation now overlaps other bookings in{" "}
              <strong>{reservation.roomName}</strong>. Approving it would
              create a double booking. Please deny this reservation and ask
              the requester to choose a different slot, or resolve the
              conflict first.
            </p>

            <div
              style={{
                background: "#fafaf9",
                border: "1px solid #f0f0ee",
                borderRadius: 12,
                padding: "10px 14px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
                maxHeight: 240,
                overflowY: "auto",
              }}
            >
              {conflicts.map((c) => (
                <div
                  key={`${c.kind}-${c.id}`}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                    paddingBottom: 8,
                    borderBottom: "1px dashed #ececea",
                  }}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: 10.5,
                      fontWeight: 800,
                      letterSpacing: ".03em",
                      textTransform: "uppercase",
                      color:
                        c.kind === "event"
                          ? "#b91c1c"
                          : c.kind === "reassignment"
                          ? "#c2410c"
                          : c.kind === "reservation"
                          ? "#1d4ed8"
                          : "#b45309",
                    }}
                  >
                    <i
                      className={
                        c.kind === "event"
                          ? "fa-solid fa-calendar-star"
                          : c.kind === "reassignment"
                          ? "fa-solid fa-right-left"
                          : c.kind === "reservation"
                          ? "fa-solid fa-book-bookmark"
                          : "fa-solid fa-chalkboard-user"
                      }
                    ></i>
                    {c.label}
                  </span>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: "#16181d" }}>
                    {c.title}
                  </span>
                  <span style={{ fontSize: 12, color: "#6b7280" }}>
                    {format12Hour(c.startTime)} – {format12Hour(c.endTime)}
                    {c.faculty ? ` · ${c.faculty}` : ""}
                  </span>
                </div>
              ))}
            </div>

            <button
              onClick={() => setShowConflictModal(false)}
              style={{
                marginTop: 4,
                padding: "12px 18px",
                borderRadius: 10,
                border: "1.5px solid #dc2626",
                background: "#dc2626",
                color: "#fff",
                fontWeight: 700,
                fontSize: 14,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}

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

export default ReservationCard;