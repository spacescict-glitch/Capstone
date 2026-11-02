// ============================================================
// FILE: FacultyReservationConflict.jsx (ENHANCED UI)
// ============================================================
import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  doc, getDoc, getDocs, updateDoc, serverTimestamp,
  addDoc, collection, query, where,
} from "firebase/firestore";
import { logActivity } from "../../utils/logActivity";
import { auth, db } from "../../firebase";
import Toast from "../../Popup/Toast/Toast";
import "./faculty-room-reassignment.css";
import "./faculty-reservation-conflict.css";

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
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
};

const getDayAbbrev = (dateStr) => {
  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  return days[new Date(`${dateStr}T00:00:00`).getDay()];
};

const initialOf = (name = "") =>
  String(name).trim().split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

const PRESET_DENIAL_REASONS = [
  "I need to hold this class as scheduled.",
  "The reservation time overlaps my exam.",
  "The room has equipment my class needs.",
  "Too short notice to relocate.",
  "No alternative schedule available.",
];

export default function FacultyReservationConflict() {
  const { consentId } = useParams();
  const navigate = useNavigate();

  const [consent, setConsent] = useState(null);
  const [reservationDetails, setReservationDetails] = useState(null);
  const [requesterUser, setRequesterUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);

  const [showDenyModal, setShowDenyModal] = useState(false);
  const [showAcceptModal, setShowAcceptModal] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const [toast, setToast] = useState({
    show: false, type: "success", title: "", message: "",
  });

  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    if (type !== "loading") {
      setTimeout(() => setToast((p) => ({ ...p, show: false })), 4000);
    }
  };

  const status = String(consent?.status || "").toLowerCase();
  const isPending = status === "pending";
  const isAccepted = status === "accepted";
  const isDeclined = status === "declined";

  useEffect(() => {
    const load = async () => {
      try {
        const snap = await getDoc(doc(db, "reservationConflictConsents", consentId));
        if (!snap.exists()) {
          showToast("error", "Not Found", "This conflict request does not exist.");
          setLoading(false);
          return;
        }
        const data = { id: snap.id, ...snap.data() };

        if (auth.currentUser && String(data.facultyId) !== String(auth.currentUser.uid)) {
          showToast("error", "Not Allowed", "You are not the affected faculty for this conflict.");
          setTimeout(() => navigate("/faculty"), 1500);
          return;
        }

        setConsent(data);

        if (data.reservationId) {
          try {
            const resSnap = await getDoc(doc(db, "reservationRequests", data.reservationId));
            if (resSnap.exists()) {
              setReservationDetails({ id: resSnap.id, ...resSnap.data() });
            }
          } catch (e) { console.warn("reservation fetch:", e); }
        }

        if (data.requestedById) {
          try {
            const userSnap = await getDoc(doc(db, "users", data.requestedById));
            if (userSnap.exists()) {
              setRequesterUser({ id: userSnap.id, ...userSnap.data() });
            }
          } catch (e) { console.warn("user fetch:", e); }
        }
      } catch (err) {
        console.error(err);
        showToast("error", "Error", "Could not load the conflict request.");
      } finally {
        setLoading(false);
      }
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consentId]);

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
            title, message,
            type: "reservation-conflict-status",
            unread: true, archived: false,
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

  const handleAccept = async () => {
    if (processing || !isPending) return;
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
      const myName = `${me.firstName || ""} ${me.lastName || ""}`.trim() || "Faculty";

      await updateDoc(doc(db, "reservationConflictConsents", consent.id), {
        status: "accepted",
        respondedAt: serverTimestamp(),
        respondedBy: currentUser.uid,
      });

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

      await notifyClerks(
        "Conflict Accepted — Room Released",
        `${myName} accepted the conflict for "${consent.conflictSubject}" on ${consent.date}. ${consent.roomName} is now available for ${consent.requestedByName}'s reservation — you may approve it now.`
      );

      await markRelatedNotifications("accepted");

      try {
        await logActivity({
          user: myName, userId: currentUser.uid, role: "Faculty",
          action: "Accepted reservation conflict", actionType: "success",
          target: `${consent.roomName} | ${consent.conflictSubject}`,
          status: "SUCCESS",
          details: {
            consentId: consent.id, reservationId: consent.reservationId,
            requestedBy: consent.requestedByName,
          },
        });
      } catch (logErr) { console.warn("logActivity:", logErr); }

      setConsent((prev) => ({ ...prev, status: "accepted" }));
      showToast("success", "Accepted", "Your class was released. Clerk has been notified.");
      setTimeout(() => navigate("/faculty"), 1500);
    } catch (err) {
      console.error(err);
      showToast("error", "Failed", "Could not process your response.");
    } finally {
      setProcessing(false);
      setShowAcceptModal(false);
    }
  };

  const handleDeny = async () => {
    if (processing || !isPending) return;
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
      const myName = `${me.firstName || ""} ${me.lastName || ""}`.trim() || "Faculty";
      const reason = rejectReason.trim() || "No reason provided";

      await updateDoc(doc(db, "reservationConflictConsents", consent.id), {
        status: "declined",
        respondedAt: serverTimestamp(),
        respondedBy: currentUser.uid,
        denialReason: reason,
      });

      await notifyClerks(
        "Conflict Declined",
        `${myName} declined the reservation conflict for "${consent.conflictSubject}" on ${consent.date}. Reason: "${reason}". The reservation by ${consent.requestedByName} still conflicts — please deny it using this reason.`
      );

      await markRelatedNotifications("declined");

      try {
        await logActivity({
          user: myName, userId: currentUser.uid, role: "Faculty",
          action: "Declined reservation conflict", actionType: "denied",
          target: `${consent.roomName} | ${consent.conflictSubject}`,
          status: "Declined",
          details: { consentId: consent.id, reason },
        });
      } catch (logErr) { console.warn("logActivity:", logErr); }

      setConsent((prev) => ({ ...prev, status: "declined", denialReason: reason }));
      setShowDenyModal(false);
      showToast("success", "Declined", "Your class was kept. Clerk has been notified.");
      setTimeout(() => navigate("/faculty"), 1500);
    } catch (err) {
      console.error(err);
      showToast("error", "Failed", "Could not process your response.");
    } finally {
      setProcessing(false);
    }
  };

  const requesterName = requesterUser?.firstName || consent?.requestedByName || "—";
  const requesterFullName = requesterUser
    ? `${requesterUser.firstName || ""} ${requesterUser.lastName || ""}`.trim()
    : consent?.requestedByName || "—";
  const requesterPhoto = requesterUser?.photoUrl || requesterUser?.photoURL || null;
  const requesterInitials = initialOf(requesterFullName);

  const equipment = useMemo(() => {
    const list = reservationDetails?.requiredEquipment;
    if (Array.isArray(list)) return list;
    return [];
  }, [reservationDetails]);

  const audienceLine = useMemo(() => {
    if (!reservationDetails) return null;
    const a = reservationDetails.audienceType;
    if (a === "Class") {
      const c = reservationDetails.attendees?.course || "";
      const y = reservationDetails.attendees?.yearSectionGroup || "";
      return `Class — ${c} ${y}`.trim();
    }
    if (a === "Organization") {
      return `Organization — ${reservationDetails.attendees?.organization || ""}`;
    }
    if (a === "Others") {
      return reservationDetails.attendees?.customAudience || "Other";
    }
    return null;
  }, [reservationDetails]);

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
        <div className="frc-header">
          <div className="frc-header-icon">
            <i className="fa-solid fa-triangle-exclamation"></i>
          </div>
          <div className="frc-header-text">
            <h1>Reservation Conflict</h1>
            <p>
              Another faculty wants to use your room during your scheduled class.
              Choose whether to release your class or keep it.
            </p>
          </div>
          {isPending && (
            <span className="frc-pending-badge">
              <i className="fa-regular fa-clock"></i> Action Required
            </span>
          )}
          {isAccepted && (
            <span className="frc-status-badge is-accepted">
              <i className="fa-solid fa-circle-check"></i> Accepted
            </span>
          )}
          {isDeclined && (
            <span className="frc-status-badge is-declined">
              <i className="fa-solid fa-circle-xmark"></i> Declined
            </span>
          )}
        </div>

        <div className="frc-requester-card">
          <div className="frc-requester-avatar">
            {requesterPhoto ? (
              <img
                src={requesterPhoto}
                alt={requesterFullName}
                onError={() => setRequesterUser({ ...requesterUser, photoUrl: null })}
              />
            ) : (
              <span>{requesterInitials || "?"}</span>
            )}
          </div>
          <div className="frc-requester-info">
            <div className="frc-requester-name">{requesterFullName}</div>
            <div className="frc-requester-role">
              <i className="fa-solid fa-user-tie"></i> Requesting Faculty
            </div>
          </div>
          <div className="frc-requester-meta">
            <span className="frc-meta-pill is-warn">
              <i className="fa-solid fa-triangle-exclamation"></i> Overlapping
            </span>
          </div>
        </div>

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
                {fmt12(consent.conflictStartTime)} – {fmt12(consent.conflictEndTime)}
              </span>
            </div>
          </div>
        </div>

        <div className="faculty-room-section">
          <h3>Requested Reservation</h3>
          <div className="faculty-room-grid">
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
            {audienceLine && (
              <div className="info-box">
                <label>Audience</label>
                <span>{audienceLine}</span>
              </div>
            )}
          </div>

          {equipment.length > 0 && (
            <div className="frc-equipment-block">
              <div className="frc-equipment-label">
                <i className="fa-solid fa-toolbox"></i> Required Equipment
              </div>
              <div className="frc-equipment-list">
                {equipment.map((e) => (
                  <span key={e} className="frc-equipment-chip">
                    <i className="fa-solid fa-check"></i> {e}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="faculty-room-section">
          <h3>Room</h3>
          <div className="room-change">
            <div className="room-box">
              <label>Currently booked to you</label>
              <h2>{consent.roomName}</h2>
            </div>
            <div className="arrow">
              <i className="fa-solid fa-arrow-right"></i>
            </div>
            <div className="room-box new">
              <label>Would be used by</label>
              <h2>{requesterName}</h2>
            </div>
          </div>
        </div>

        <div className="frc-next-steps">
          <div className="frc-next-title">
            <i className="fa-solid fa-circle-info"></i> What happens next?
          </div>
          <div className="frc-next-grid">
            <div className="frc-next-item is-accept">
              <div className="frc-next-badge">If you Accept</div>
              <p>
                Your class is released for this date. The Clerk is notified and
                can approve the reservation immediately.
              </p>
            </div>
            <div className="frc-next-item is-decline">
              <div className="frc-next-badge">If you Decline</div>
              <p>
                Your class stays. The Clerk will see your reason and deny the
                reservation with it.
              </p>
            </div>
          </div>
        </div>

        {isAccepted && (
          <div
            className="faculty-room-note"
            style={{
              marginTop: 30, background: "#ecfdf5",
              border: "1px solid #bbf7d0", color: "#065f46",
            }}
          >
            <i className="fa-solid fa-circle-check"></i>
            <span>
              <strong>You already accepted this conflict.</strong> Your class
              has been released and the Clerk has been notified.
            </span>
          </div>
        )}

        {isDeclined && (
          <div
            className="faculty-room-note"
            style={{
              marginTop: 30, background: "#fef2f2",
              border: "1px solid #fecaca", color: "#991b1b",
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

        {isPending && (
          <div className="faculty-room-actions">
            <button
              className="reject-btn"
              onClick={() => setShowDenyModal(true)}
              disabled={processing}
            >
              {processing ? (
                <><i className="fa-solid fa-circle-notch fa-spin"></i> Processing...</>
              ) : "Keep My Class"}
            </button>
            <button
              className="approve-btn"
              onClick={() => setShowAcceptModal(true)}
              disabled={processing}
            >
              {processing ? (
                <><i className="fa-solid fa-circle-notch fa-spin"></i> Processing...</>
              ) : "Release My Class"}
            </button>
          </div>
        )}
      </div>

      {showAcceptModal && (
        <div
          className="faculty-room-modal-overlay"
          onClick={() => !processing && setShowAcceptModal(false)}
        >
          <div className="faculty-room-modal" onClick={(e) => e.stopPropagation()}>
            <div className="faculty-room-modal-header">
              <h3>Release Your Class?</h3>
              <button
                className="faculty-room-modal-close"
                onClick={() => setShowAcceptModal(false)}
                disabled={processing}
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>
            <div className="faculty-room-modal-body">
              <div className="frc-accept-summary">
                <div className="frc-accept-summary-row">
                  <i className="fa-solid fa-door-open"></i>
                  <span>
                    <strong>{consent.roomName}</strong> will be released on{" "}
                    <strong>{fmtDateLong(consent.date)}</strong> for your class
                    &ldquo;{consent.conflictSubject}&rdquo;.
                  </span>
                </div>
                <div className="frc-accept-summary-row">
                  <i className="fa-solid fa-bell"></i>
                  <span>
                    <strong>{requesterFullName}</strong> and the Clerk will be
                    notified — Clerk can then approve the reservation.
                  </span>
                </div>
              </div>
              <div className="faculty-room-reason-note">
                <i className="fa-solid fa-circle-info"></i>
                <span>
                  This cannot be undone. If you need the room back, you&rsquo;ll
                  have to coordinate with the Clerk.
                </span>
              </div>
            </div>
            <div className="faculty-room-modal-footer">
              <button
                className="faculty-room-modal-cancel"
                onClick={() => setShowAcceptModal(false)}
                disabled={processing}
              >Cancel</button>
              <button
                className="approve-btn"
                onClick={handleAccept}
                disabled={processing}
                style={{ width: "auto", padding: "10px 20px" }}
              >
                {processing ? (
                  <><i className="fa-solid fa-circle-notch fa-spin"></i> Releasing...</>
                ) : "Yes, Release My Class"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDenyModal && (
        <div
          className="faculty-room-modal-overlay"
          onClick={() => !processing && setShowDenyModal(false)}
        >
          <div className="faculty-room-modal" onClick={(e) => e.stopPropagation()}>
            <div className="faculty-room-modal-header">
              <h3>Keep Your Class?</h3>
              <button
                className="faculty-room-modal-close"
                onClick={() => setShowDenyModal(false)}
                disabled={processing}
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>
            <div className="faculty-room-modal-body">
              <p>
                You are choosing to <strong>keep your class</strong> and{" "}
                <strong>decline</strong> the conflicting reservation. The Clerk
                will be notified and will deny it using your reason.
              </p>
              <div className="frc-quick-reason-block">
                <div className="frc-quick-reason-label">Quick reasons</div>
                <div className="frc-quick-reason-list">
                  {PRESET_DENIAL_REASONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      className={`frc-quick-reason ${rejectReason === r ? "is-active" : ""}`}
                      onClick={() => setRejectReason(r)}
                      disabled={processing}
                    >{r}</button>
                  ))}
                </div>
              </div>
              <div className="faculty-room-reason-group">
                <label>Custom Reason (optional)</label>
                <textarea
                  className="faculty-room-modal-textarea"
                  placeholder="Add details for the Clerk..."
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  rows={3}
                  disabled={processing}
                />
              </div>
              <div className="faculty-room-reason-note">
                <i className="fa-solid fa-info-circle"></i>
                <span>
                  The Clerk will see your reason and use it to deny the
                  reservation.
                </span>
              </div>
            </div>
            <div className="faculty-room-modal-footer">
              <button
                className="faculty-room-modal-cancel"
                onClick={() => setShowDenyModal(false)}
                disabled={processing}
              >Cancel</button>
              <button
                className="faculty-room-modal-confirm"
                onClick={handleDeny}
                disabled={processing}
              >
                {processing ? (
                  <><i className="fa-solid fa-circle-notch fa-spin"></i> Declining...</>
                ) : "Confirm — Keep My Class"}
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
        onClose={() => setToast((p) => ({ ...p, show: false }))}
      />
    </div>
  );
}