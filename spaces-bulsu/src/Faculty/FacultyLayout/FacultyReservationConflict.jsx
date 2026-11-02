// ============================================================
// FILE: FacultyReservationConflict.jsx
// - Faculty responds to a reservation conflict from another faculty
// - Accept → auto-releases affected schedule (creates roomReleases doc)
//            → notifies Clerk → Clerk can approve reservation
// - Deny   → notifies Clerk → conflict remains → Clerk decides
// ============================================================
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  doc,
  getDoc,
  getDocs,
  updateDoc,
  serverTimestamp,
  addDoc,
  collection,
  query,
  where,
} from "firebase/firestore";
import { logActivity } from "../../utils/logActivity";
import { auth, db } from "../../firebase";
import Toast from "../../Popup/Toast/Toast";
import "./faculty-room-reassignment.css";

const fmt12 = (time) => {
  if (!time) return "—";
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return time;
  const suffix = h >= 12 ? "PM" : "AM";
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, "0")} ${suffix}`;
};

const fmtDateLong = (dateStr) => {
  if (!dateStr) return "—";
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
};

const getDayAbbrev = (dateStr) => {
  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  return days[new Date(`${dateStr}T00:00:00`).getDay()];
};

export default function FacultyReservationConflict() {
  const { consentId } = useParams();
  const navigate = useNavigate();

  const [consent, setConsent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);

  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const [toast, setToast] = useState({
    show: false,
    type: "success",
    title: "",
    message: "",
  });

  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    if (type !== "loading") {
      setTimeout(() => setToast((prev) => ({ ...prev, show: false })), 4000);
    }
  };

  const isPending = () => {
    if (!consent) return false;
    return String(consent.status || "").toLowerCase() === "pending";
  };

  const isAccepted = () => {
    if (!consent) return false;
    return String(consent.status || "").toLowerCase() === "accepted";
  };

  const isDeclined = () => {
    if (!consent) return false;
    return String(consent.status || "").toLowerCase() === "declined";
  };

  useEffect(() => {
    const loadConsent = async () => {
      try {
        const snap = await getDoc(
          doc(db, "reservationConflictConsents", consentId)
        );
        if (snap.exists()) {
          const data = { id: snap.id, ...snap.data() };

          // Security: only the affected faculty can view
          if (
            auth.currentUser &&
            String(data.facultyId) !== String(auth.currentUser.uid)
          ) {
            showToast(
              "error",
              "Not Allowed",
              "You are not the affected faculty for this conflict."
            );
            setTimeout(() => navigate("/faculty"), 1500);
            return;
          }

          setConsent(data);
        } else {
          showToast("error", "Not Found", "This conflict request does not exist.");
        }
      } catch (err) {
        console.error(err);
        showToast("error", "Error", "Could not load the conflict request.");
      }
      setLoading(false);
    };
    loadConsent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consentId]);

  // ─── Mark the original notification as decided ──────────────
  const markRelatedNotifications = async (decision) => {
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) return;

      const q = query(
        collection(db, "notifications"),
        where("conflictConsentId", "==", consent.id)
      );

      const snap = await getDocs(q);
      for (const notifDoc of snap.docs) {
        const data = notifDoc.data();
        if (data.userId !== currentUser.uid) continue;
        if (String(data.type || "").toLowerCase() !== "reservation-conflict") continue;
        if (data.decided === true) continue;

        await updateDoc(notifDoc.ref, {
          decided: true,
          decidedAt: serverTimestamp(),
          badge: decision.toUpperCase(),
        });
      }
    } catch (err) {
      console.error("Failed to mark notifications:", err);
    }
  };

  // ─── Notify all clerks ─────────────────────────────────────
  const notifyClerks = async (title, message) => {
    try {
      const usersSnap = await getDocs(collection(db, "users"));
      const jobs = [];
      usersSnap.forEach((d) => {
        const role = String(d.data().role || "").toLowerCase();
        if (role !== "clerk") return;
        jobs.push(
          addDoc(collection(db, "notifications"), {
            userId: d.id,
            ownerType: "clerk",
            reservationId: consent.reservationId,
            conflictConsentId: consent.id,
            title,
            message,
            type: "reservation-conflict-status",
            unread: true,
            archived: false,
            badge: title.includes("Accepted") ? "RESOLVED" : "WARNING",
            createdAt: serverTimestamp(),
          })
        );
      });
      await Promise.all(jobs);
    } catch (err) {
      console.warn("notifyClerks failed:", err);
    }
  };

  // ─── Accept ────────────────────────────────────────────────
  const handleAccept = async () => {
    if (processing || !isPending()) return;
    setProcessing(true);
    showToast("loading", "Processing", "Releasing your class...");

    try {
      const currentUser = auth.currentUser;
      if (!currentUser) {
        showToast("error", "Error", "Session expired. Please log in again.");
        return;
      }

      const userSnap = await getDoc(doc(db, "users", currentUser.uid));
      const me = userSnap.exists() ? userSnap.data() : {};
      const myName =
        `${me.firstName || ""} ${me.lastName || ""}`.trim() || "Faculty";

      // 1. Update consent status
      await updateDoc(doc(db, "reservationConflictConsents", consent.id), {
        status: "accepted",
        respondedAt: serverTimestamp(),
        respondedBy: currentUser.uid,
      });

      // 2. Auto-release the affected schedule
      await addDoc(collection(db, "roomReleases"), {
        scheduleId: consent.scheduleId,
        roomId: consent.roomId,
        roomName: consent.roomName,
        date: consent.date,
        day: getDayAbbrev(consent.date),
        subject: consent.conflictSubject,
        section: consent.conflictSection,
        startTime: consent.conflictStartTime,
        endTime: consent.conflictEndTime,
        effectiveEndTime: null,
        faculty: consent.facultyName,
        releasedBy: currentUser.uid,
        releasedByName: myName,
        reason: "Approved conflicting reservation",
        details: `Consented to release this class so ${consent.requestedByName} could use the room.`,
        status: "released",
        releasedAt: serverTimestamp(),
        releaseType: "conflict-consent",
      });

      // 3. Notify clerk
      await notifyClerks(
        "Conflict Accepted — Room Released",
        `${myName} accepted the conflict for "${consent.conflictSubject}" on ${consent.date}. ${consent.roomName} is now available for the reservation by ${consent.requestedByName}.`
      );

      // 4. Mark notification decided
      await markRelatedNotifications("accepted");

      // 5. Log activity
      try {
        await logActivity({
          user: myName,
          userId: currentUser.uid,
          role: "Faculty",
          action: "Accepted reservation conflict",
          actionType: "success",
          target: `${consent.roomName} | ${consent.conflictSubject}`,
          status: "SUCCESS",
          details: {
            consentId: consent.id,
            reservationId: consent.reservationId,
            requestedBy: consent.requestedByName,
          },
        });
      } catch (logErr) {
        console.warn("logActivity failed:", logErr);
      }

      setConsent((prev) => ({ ...prev, status: "accepted" }));
      showToast(
        "success",
        "Accepted",
        "Your class has been released. Clerk has been notified."
      );
      setTimeout(() => navigate("/faculty"), 1500);
    } catch (err) {
      console.error(err);
      showToast("error", "Failed", "Could not process your response.");
    } finally {
      setProcessing(false);
    }
  };

  // ─── Deny ──────────────────────────────────────────────────
  const handleDeny = async () => {
    if (processing || !isPending()) return;
    setProcessing(true);
    showToast("loading", "Processing", "Saving your response...");

    try {
      const currentUser = auth.currentUser;
      if (!currentUser) {
        showToast("error", "Error", "Session expired. Please log in again.");
        return;
      }

      const userSnap = await getDoc(doc(db, "users", currentUser.uid));
      const me = userSnap.exists() ? userSnap.data() : {};
      const myName =
        `${me.firstName || ""} ${me.lastName || ""}`.trim() || "Faculty";

      const reason = rejectReason.trim() || "No reason provided";

      await updateDoc(doc(db, "reservationConflictConsents", consent.id), {
        status: "declined",
        respondedAt: serverTimestamp(),
        respondedBy: currentUser.uid,
        denialReason: reason,
      });

      await notifyClerks(
        "Conflict Declined",
        `${myName} declined the reservation conflict for "${consent.conflictSubject}" on ${consent.date}. The reservation by ${consent.requestedByName} still has an unresolved conflict.`
      );

      await markRelatedNotifications("declined");

      try {
        await logActivity({
          user: myName,
          userId: currentUser.uid,
          role: "Faculty",
          action: "Declined reservation conflict",
          actionType: "denied",
          target: `${consent.roomName} | ${consent.conflictSubject}`,
          status: "Declined",
          details: { consentId: consent.id, reason },
        });
      } catch (logErr) {
        console.warn("logActivity failed:", logErr);
      }

      setConsent((prev) => ({
        ...prev,
        status: "declined",
        denialReason: reason,
      }));
      setShowRejectModal(false);
      showToast(
        "success",
        "Declined",
        "Your class was kept. Clerk has been notified."
      );
      setTimeout(() => navigate("/faculty"), 1500);
    } catch (err) {
      console.error(err);
      showToast("error", "Failed", "Could not process your response.");
    } finally {
      setProcessing(false);
    }
  };

  if (loading) {
    return (
      <div className="faculty-room-loading">
        <div className="spinner"></div>
        <p>Loading conflict request...</p>
      </div>
    );
  }

  if (!consent) {
    return (
      <div className="faculty-room-loading">
        <h2>Conflict request not found.</h2>
        <button className="approve-btn" onClick={() => navigate("/faculty")}>
          Back to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="faculty-room-page">
      <div className="faculty-room-card">
        <div className="faculty-room-header">
          <h1>Reservation Conflict</h1>
          <p>
            Another faculty wants to use your room during your scheduled class.
            Choose whether to release your class or keep it.
          </p>
        </div>

        {/* ── Your class ─────────────────────────────── */}
        <div className="faculty-room-section">
          <h3>Your Class (affected)</h3>
          <div className="faculty-room-grid">
            <div className="info-box">
              <label>Subject</label>
              <span>{consent.conflictSubject || "Class"}</span>
            </div>
            <div className="info-box">
              <label>Section</label>
              <span>{consent.conflictSection || "—"}</span>
            </div>
            <div className="info-box">
              <label>Date</label>
              <span>{fmtDateLong(consent.date)}</span>
            </div>
            <div className="info-box">
              <label>Overlap</label>
              <span>
                {fmt12(consent.conflictStartTime)} –{" "}
                {fmt12(consent.conflictEndTime)}
              </span>
            </div>
          </div>
        </div>

        {/* ── Requesting reservation ─────────────────── */}
        <div className="faculty-room-section">
          <h3>Requested Reservation</h3>
          <div className="faculty-room-grid">
            <div className="info-box">
              <label>Requested by</label>
              <span>{consent.requestedByName}</span>
            </div>
            <div className="info-box">
              <label>Course Title</label>
              <span>{consent.courseTitle || "—"}</span>
            </div>
            <div className="info-box">
              <label>Purpose</label>
              <span>{consent.purpose || "—"}</span>
            </div>
            <div className="info-box">
              <label>Reservation Time</label>
              <span>
                {fmt12(consent.startTime)} – {fmt12(consent.endTime)}
              </span>
            </div>
          </div>
        </div>

        {/* ── Room ───────────────────────────────────── */}
        <div className="faculty-room-section">
          <h3>Room</h3>
          <div className="room-change">
            <div className="room-box">
              <label>Your room</label>
              <h2>{consent.roomName}</h2>
            </div>
            <div className="arrow">
              <i className="fa-solid fa-arrow-right"></i>
            </div>
            <div className="room-box new">
              <label>Would be used by</label>
              <h2>{consent.requestedByName}</h2>
            </div>
          </div>
        </div>

        <div className="faculty-room-note">
          <i className="fa-solid fa-circle-info"></i>
          <span>
            <strong>If you Accept:</strong> Your class will be released for this
            date, and the Clerk will be able to approve the reservation.
            <br />
            <strong>If you Decline:</strong> Your class stays, and the Clerk
            will be notified that you declined.
          </span>
        </div>

        {/* ── State ──────────────────────────────────── */}
        {isAccepted() && (
          <div
            className="faculty-room-note"
            style={{
              marginTop: 30,
              background: "#ecfdf5",
              border: "1px solid #bbf7d0",
              color: "#065f46",
            }}
          >
            <i className="fa-solid fa-circle-check"></i>
            <span>
              <strong>You already accepted this conflict.</strong> Your class
              has been released and the Clerk has been notified.
            </span>
          </div>
        )}

        {isDeclined() && (
          <div
            className="faculty-room-note"
            style={{
              marginTop: 30,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
            }}
          >
            <i className="fa-solid fa-circle-xmark"></i>
            <span>
              <strong>You already declined this conflict.</strong>
              {consent.denialReason ? ` Reason: ${consent.denialReason}` : ""}{" "}
              The Clerk will review and decide on the reservation.
            </span>
          </div>
        )}

        {isPending() && (
          <div className="faculty-room-actions">
            <button
              className="reject-btn"
              onClick={() => setShowRejectModal(true)}
              disabled={processing}
            >
              {processing ? (
                <>
                  <i className="fa-solid fa-circle-notch fa-spin"></i>{" "}
                  Processing...
                </>
              ) : (
                "Keep My Class"
              )}
            </button>
            <button
              className="approve-btn"
              onClick={handleAccept}
              disabled={processing}
            >
              {processing ? (
                <>
                  <i className="fa-solid fa-circle-notch fa-spin"></i>{" "}
                  Processing...
                </>
              ) : (
                "Release My Class"
              )}
            </button>
          </div>
        )}
      </div>

      {showRejectModal && (
        <div
          className="faculty-room-modal-overlay"
          onClick={() => !processing && setShowRejectModal(false)}
        >
          <div
            className="faculty-room-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="faculty-room-modal-header">
              <h3>Keep Your Class?</h3>
              <button
                className="faculty-room-modal-close"
                onClick={() => setShowRejectModal(false)}
                disabled={processing}
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>
            <div className="faculty-room-modal-body">
              <p>
                You are choosing to <strong>keep your class</strong> and{" "}
                <strong>decline</strong> the conflicting reservation. The Clerk
                will be notified and will decide what to do with the reservation.
              </p>

              <div className="faculty-room-reason-group">
                <label>Reason (optional)</label>
                <textarea
                  className="faculty-room-modal-textarea"
                  placeholder="Why do you need to keep your class?..."
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  rows={3}
                  disabled={processing}
                />
              </div>

              <div className="faculty-room-reason-note">
                <i className="fa-solid fa-info-circle"></i>
                <span>
                  The Clerk will see your reason and decide how to handle the
                  conflicting reservation.
                </span>
              </div>
            </div>
            <div className="faculty-room-modal-footer">
              <button
                className="faculty-room-modal-cancel"
                onClick={() => setShowRejectModal(false)}
                disabled={processing}
              >
                Cancel
              </button>
              <button
                className="faculty-room-modal-confirm"
                onClick={handleDeny}
                disabled={processing}
              >
                {processing ? (
                  <>
                    <i className="fa-solid fa-circle-notch fa-spin"></i>{" "}
                    Declining...
                  </>
                ) : (
                  "Confirm — Keep My Class"
                )}
              </button>
            </div>
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
    </div>
  );
}