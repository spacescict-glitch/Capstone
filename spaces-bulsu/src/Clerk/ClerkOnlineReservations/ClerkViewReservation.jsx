import "./clerk-view-reservation.css";
import { useNavigate, useLocation } from "react-router-dom";
import { useState, useRef, useEffect } from "react";
import {
  doc,
  updateDoc,
  collection,
  addDoc,
  serverTimestamp,
  getDoc,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { auth } from "../../firebase";
import { logActivity } from "../../utils/logActivity";
import DenialPopup from "../../Popup/DenialPopup/DenialPopup";
import ConfirmPopup from "../../Popup/ConfirmPopup/ConfirmPopup";
import Toast from "../../Popup/Toast/Toast";

// ─── Helper: find user by name ─────────────────────────────────────────
const findUserByName = async (name) => {
  if (!name) return null;
  const usersSnap = await getDocs(collection(db, "users"));
  const normalized = name.trim().toLowerCase();
  for (const doc of usersSnap.docs) {
    const data = doc.data();
    const fullName = `${data.firstName || ""} ${data.lastName || ""}`.trim().toLowerCase();
    if (fullName === normalized) return { id: doc.id, ...data };
  }
  return null;
};

// ─── Time helpers ──────────────────────────────────────────────────────
const parseTimeToMin = (t) => {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
};
const overlaps = (aS, aE, bS, bE) => aS < bE && aE > bS;
const format12Hour = (time) => {
  if (!time) return "—";
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return time;
  const suffix = h >= 12 ? "PM" : "AM";
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, "0")} ${suffix}`;
};

// ══════════════════════════════════════════════════════════════════════
// CONFLICT CHECK
// ──────────────────────────────────────────────────────────────────────
// Detects overlap between the reservation being approved and any:
//   1) Events in the same room on the same date
//   2) Accepted reassignments INTO the same room on the same date
//   3) Other approved reservations (walk-in + online) in the same room
//   4) Class schedules for the same weekday
// ══════════════════════════════════════════════════════════════════════
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

  const found = [];

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
      if (e.reservationId && e.reservationId === reservation.id) return;
      const s = parseTimeToMin(e.startTime);
      const en = parseTimeToMin(e.endTime);
      if (s == null || en == null) return;
      if (!overlaps(reqStart, reqEnd, s, en)) return;
      found.push({
        id: e.id,
        kind: "event",
        label: "Room Activity",
        title: e.title || e.purpose || "Room Activity",
        faculty: e.faculty || e.requestedByName || "Admin",
        startTime: e.startTime,
        endTime: e.endTime,
      });
    });

    // 2) Accepted reassignments INTO this room
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
      found.push({
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
      if (r.id === reservation.id) return;
      if (String(r.status || "").toLowerCase() !== "approved") return;
      if (!matchesRoom(r)) return;
      const s = parseTimeToMin(r.startTime);
      const en = parseTimeToMin(r.endTime);
      if (s == null || en == null) return;
      if (!overlaps(reqStart, reqEnd, s, en)) return;
      const isWalkIn = String(r.reservationType || "").toLowerCase() === "walk-in";
      found.push({
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
        found.push({
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

  return found;
};

function ClerkViewReservation() {
  const navigate = useNavigate();
  const { state } = useLocation();

  const reservation = state?.reservation;

  const [showDenial, setShowDenial] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // ─── Requester photo state ─────────────────────────────────────────
  const [requesterPhoto, setRequesterPhoto] = useState(null);

  // ─── Conflict state ────────────────────────────────────────────────
  const [conflicts, setConflicts] = useState([]);
  const [checkingConflicts, setCheckingConflicts] = useState(true);

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
        setToast((prev) => ({ ...prev, show: false }));
        toastTimeoutRef.current = null;
      }, 4000);
    }
  };

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  // ─── Fetch requester photo ─────────────────────────────────────────
  useEffect(() => {
    const fetchRequesterPhoto = async () => {
      if (!reservation) return;

      try {
        const inlinePhoto =
          reservation.userPhoto ||
          reservation.requesterPhoto ||
          reservation.facultyPhoto ||
          reservation.photoURL;

        if (inlinePhoto) {
          setRequesterPhoto(inlinePhoto);
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

        const userData = userSnap.data();
        setRequesterPhoto(
          userData.photoUrl ||
            userData.photoURL ||
            userData.profilePhoto ||
            userData.photo ||
            userData.profilePicture ||
            userData.avatar ||
            userData.imageUrl ||
            null
        );
      } catch (err) {
        console.error("Failed to fetch requester photo:", err);
      }
    };

    fetchRequesterPhoto();
  }, [reservation]);

  // ═════════════════════════════════════════════════════════════════
  // Conflict check on mount + whenever reservation changes.
  // Also skip for already-decided reservations.
  // ═════════════════════════════════════════════════════════════════
  useEffect(() => {
    let cancelled = false;
    const status = String(reservation?.status || "").toLowerCase();
    const decided =
      status === "approved" || status === "rejected" ||
      status === "denied" || status === "cancelled";

    if (decided || !reservation) {
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

  if (!reservation) {
    return (
      <div className="clerk-view-reservation">
        <h2>Reservation not found.</h2>
        <button onClick={() => navigate("/clerk/reservations")}>Back</button>
      </div>
    );
  }

  // ─── Notification helpers ──────────────────────────────────────────────

  const notifyReservationDecision = async (
    receiverId,
    ownerType,
    title,
    message,
    reservationId,
    type,
    badge = "INFO"
  ) => {
    if (!receiverId) {
      console.warn("Skipping notification: no receiverId");
      return;
    }
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
  };

  // ─── Send to all admins ───────────────────────────────────────────────
  const notifyAllAdmins = async (title, message, reservationId) => {
    const usersSnap = await getDocs(collection(db, "users"));
    const notifications = [];
    usersSnap.forEach((doc) => {
      const role = (doc.data().role || "").toLowerCase().trim();
      if (role === "admin") {
        notifications.push(
          addDoc(collection(db, "notifications"), {
            userId: doc.id,
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
    if (notifications.length > 0) {
      await Promise.all(notifications);
    }
  };

  // ═════════════════════════════════════════════════════════════════════
  // APPROVE — re-check conflicts right before proceeding.
  // ═════════════════════════════════════════════════════════════════════
  const approveReservation = async () => {
    setSubmitting(true);
    showToast("loading", "Processing", "Approving reservation...");

    try {
      // FINAL GUARD
      const fresh = await checkReservationConflicts(reservation);
      if (fresh.length > 0) {
        setConflicts(fresh);
        setShowConfirm(false);
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

      // Tag event with reservationId so this reservation isn't
      // flagged as its own conflict later.
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

      const firebaseUser = auth.currentUser;
      let currentUser = {};
      let clerkName = "Clerk";
      if (firebaseUser) {
        const userSnap = await getDoc(doc(db, "users", firebaseUser.uid));
        if (userSnap.exists()) {
          currentUser = userSnap.data();
          clerkName = `${currentUser.firstName || ""} ${currentUser.lastName || ""}`.trim() || "Clerk";
        }
      }

      await logActivity({
        userId: firebaseUser?.uid || "",
        user: clerkName,
        role: "Clerk",
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
        const user = await findUserByName(reservation.facultyName);
        if (user) facultyUserId = user.id;
      }

      if (facultyUserId) {
        await notifyReservationDecision(
          facultyUserId,
          "faculty",
          "Reservation Approved",
          `Your reservation request for ${reservation.roomName} on ${reservation.date} (${reservation.startTime} - ${reservation.endTime}) has been approved.`,
          reservation.id,
          "reservation-approved",
          "SUCCESS"
        );
      }

      if (firebaseUser?.uid) {
        await notifyReservationDecision(
          firebaseUser.uid,
          "clerk",
          "Reservation Approved",
          `You approved ${reservation.facultyName}'s reservation request for ${reservation.roomName}.`,
          reservation.id,
          "reservation-approved",
          "INFO"
        );
      }

      await notifyAllAdmins(
        "Reservation Approved",
        `${reservation.facultyName}'s reservation for ${reservation.roomName} was approved by Clerk.`,
        reservation.id
      );

      setShowConfirm(false);
      showToast("success", "Success", "Reservation approved successfully!");

      setTimeout(() => navigate("/clerk/reservations"), 1500);
    } catch (err) {
      console.error("Approve error:", err);
      showToast("error", "Error", err.message || "Failed to approve reservation.");
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Deny ──────────────────────────────────────────────────────────────

  const denyReservation = async (reason) => {
    setSubmitting(true);
    showToast("loading", "Processing", "Denying reservation...");

    try {
      await updateDoc(doc(db, "reservationRequests", reservation.id), {
        status: "Rejected",
        denialReason: reason,
      });

      const firebaseUser = auth.currentUser;
      let currentUser = {};
      let clerkName = "Clerk";
      if (firebaseUser) {
        const userSnap = await getDoc(doc(db, "users", firebaseUser.uid));
        if (userSnap.exists()) {
          currentUser = userSnap.data();
          clerkName = `${currentUser.firstName || ""} ${currentUser.lastName || ""}`.trim() || "Clerk";
        }
      }

      await logActivity({
        userId: firebaseUser?.uid || "",
        user: clerkName,
        role: "Clerk",
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
        const user = await findUserByName(reservation.facultyName);
        if (user) facultyUserId = user.id;
      }

      if (facultyUserId) {
        await notifyReservationDecision(
          facultyUserId,
          "faculty",
          "Reservation Rejected",
          `Your reservation request for ${reservation.roomName} was rejected.\nReason: ${reason}`,
          reservation.id,
          "reservation-rejected",
          "WARNING"
        );
      }

      if (firebaseUser?.uid) {
        await notifyReservationDecision(
          firebaseUser.uid,
          "clerk",
          "Reservation Rejected",
          `You rejected ${reservation.facultyName}'s reservation request.`,
          reservation.id,
          "reservation-rejected",
          "INFO"
        );
      }

      await notifyAllAdmins(
        "Reservation Rejected",
        `${reservation.facultyName}'s reservation for ${reservation.roomName} was rejected by Clerk.`,
        reservation.id
      );

      setShowDenial(false);
      showToast("success", "Success", "Reservation denied successfully.");

      setTimeout(() => navigate("/clerk/reservations"), 1500);
    } catch (err) {
      console.error("Deny error:", err);
      showToast("error", "Error", err.message || "Failed to deny reservation.");
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Duration helper ────────────────────────────────────────────────────

  const getDuration = (start, end) => {
    if (!start || !end) return "N/A";
    const [startHour, startMin] = start.split(":").map(Number);
    const [endHour, endMin] = end.split(":").map(Number);
    const diffMs = new Date().setHours(endHour, endMin, 0) - new Date().setHours(startHour, startMin, 0);
    if (diffMs <= 0) return "N/A";
    const totalMinutes = Math.floor(diffMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours && minutes) return `${hours} hr ${minutes} min`;
    if (hours) return `${hours} hr`;
    return `${minutes} min`;
  };

  const createdDate =
    reservation.createdAt?.seconds
      ? new Date(reservation.createdAt.seconds * 1000)
      : new Date(reservation.createdAt);

  const duration = getDuration(reservation.startTime, reservation.endTime);

  const status = String(reservation.status || "").toLowerCase();
  const isDecided =
    status === "approved" || status === "rejected" ||
    status === "denied" || status === "cancelled";
  const hasConflicts = conflicts.length > 0;

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <>
      <div className="clerk-view-reservation">
        <i
          className="fa-solid fa-arrow-left clerk-view-reservation-back"
          onClick={() => navigate(-1)}
        ></i>

        <div className="clerk-white-box-view-reservation">
          <div className="clerk-reservation-header">
            <div className="clerk-reservation-header-left">
              <div className="clerk-reservation-profile">
                {requesterPhoto ? (
                  <img
                    src={requesterPhoto}
                    alt={reservation.facultyName || reservation.requesterName || "Requester"}
                    className="clerk-reservation-profile-img"
                    onError={() => setRequesterPhoto(null)}
                  />
                ) : (
                  <i className="fa-solid fa-user"></i>
                )}
              </div>
              <span className="clerk-reservation-faculty-name">
                {reservation.facultyName || reservation.requesterName || "Unknown"}
              </span>
            </div>
            <div className="clerk-reservation-header-right">
              <button
                className="clerk-deny-request-btn"
                onClick={() => setShowDenial(true)}
                disabled={submitting}
              >
                Deny
              </button>
              <button
                className="clerk-approve-request-btn"
                onClick={() => {
                  if (checkingConflicts || hasConflicts) return;
                  setShowConfirm(true);
                }}
                disabled={submitting || checkingConflicts || hasConflicts || isDecided}
                title={
                  hasConflicts
                    ? "Resolve conflicts before approving"
                    : checkingConflicts
                    ? "Checking conflicts…"
                    : isDecided
                    ? "This reservation has already been decided"
                    : ""
                }
                style={
                  hasConflicts || isDecided
                    ? { opacity: 0.55, cursor: "not-allowed" }
                    : undefined
                }
              >
                {checkingConflicts ? "Checking…" : hasConflicts ? "Conflicts Found" : "Approve Request"}
              </button>
            </div>
          </div>

          <div className="clerk-reservation-info-boxes">
            <div className="clerk-reservation-info-box">
              <h3 className="clerk-info-box-title">Reservation Metadata</h3>
              <div className="clerk-info-box-content">
                <p>
                  Requested On: {createdDate.toLocaleDateString()} |{" "}
                  {createdDate.toLocaleTimeString()}
                </p>
                <p>Status: {reservation.status}</p>
              </div>
            </div>

            <div className="clerk-reservation-info-box">
              <h3 className="clerk-info-box-title">Reservation Details</h3>
              <div className="clerk-info-box-content">
                <div className="clerk-info-box-details">
                  <p>Room Name: {reservation.roomName}</p>
                  <p>Room Capacity: {reservation.roomCapacity}</p>
                  <p>Course Title: {reservation.courseTitle}</p>
                  <p>Date: {reservation.date}</p>
                  <p>Start Time: {reservation.startTime}</p>
                  <p>Total Duration: {duration}</p>
                  <p>End Time: {reservation.endTime}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="clerk-reservation-info-boxes">
            <div className="clerk-reservation-info-box">
              <h3 className="clerk-info-box-title">Reservation Purpose</h3>
              <div className="clerk-info-box-content">
                <p>
                  <strong>Audience Type:</strong> {reservation.audienceType}
                </p>

                {reservation.audienceType === "Class" && (
                  <>
                    <p>
                      <strong>Course:</strong> {reservation.attendees?.course}
                    </p>
                    <p>
                      <strong>Year/Section/Group:</strong>{" "}
                      {reservation.attendees?.yearSectionGroup}
                    </p>
                  </>
                )}

                {reservation.audienceType === "Organization" && (
                  <p>
                    <strong>Organization:</strong> {reservation.attendees?.organization}
                  </p>
                )}

                {reservation.audienceType === "Faculty" && (
                  <p>
                    <strong>Attendees:</strong> Faculty Members
                  </p>
                )}

                {reservation.audienceType === "Others" && (
                  <p>
                    <strong>Attendees:</strong> {reservation.attendees?.otherAudience}
                  </p>
                )}
                <p>
                  <strong>Purpose:</strong> {reservation.purpose}
                </p>
              </div>
            </div>

            {/* ═══════════ REAL CONFLICT CHECK BOX ═══════════ */}
            <div className="clerk-reservation-info-box conflict-check-box">
              <h3 className="clerk-info-box-title">Conflict Check</h3>
              <div className="clerk-info-box-content">
                {checkingConflicts ? (
                  <p style={{ color: "#6b7280" }}>
                    <i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }}></i>
                    Checking for conflicts…
                  </p>
                ) : !hasConflicts ? (
                  <p style={{ color: "#16a34a", fontWeight: 600 }}>
                    <i className="fa-solid fa-circle-check" style={{ marginRight: 6 }}></i>
                    No conflicts detected.
                  </p>
                ) : (
                  <>
                    <p style={{ color: "#b91c1c", fontWeight: 700, marginBottom: 8 }}>
                      <i className="fa-solid fa-triangle-exclamation" style={{ marginRight: 6 }}></i>
                      {conflicts.length} conflict{conflicts.length > 1 ? "s" : ""} detected — approval blocked
                    </p>
                    <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                      {conflicts.map((c) => (
                        <li
                          key={`${c.kind}-${c.id}`}
                          style={{
                            padding: "8px 10px",
                            background: "#fef2f2",
                            border: "1px solid #fecaca",
                            borderRadius: 8,
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
                              color: "#b91c1c",
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
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#16181d", marginTop: 3 }}>
                            {c.title}
                          </div>
                          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                            {format12Hour(c.startTime)} – {format12Hour(c.endTime)}
                            {c.faculty ? ` · ${c.faculty}` : ""}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {showDenial && (
        <DenialPopup
          onCancel={() => setShowDenial(false)}
          onConfirm={denyReservation}
        />
      )}

      {showConfirm && (
        <ConfirmPopup
          onCancel={() => setShowConfirm(false)}
          onConfirm={approveReservation}
        />
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

export default ClerkViewReservation;