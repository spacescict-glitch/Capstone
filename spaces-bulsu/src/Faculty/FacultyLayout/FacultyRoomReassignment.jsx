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
import { auth } from "../../firebase";
import { db } from "../../firebase";
import Toast from "../../Popup/Toast/Toast";
import "./faculty-room-reassignment.css";

export default function FacultyRoomReassignment() {
  const { assignmentId } = useParams();
  const navigate = useNavigate();

  const [assignment, setAssignment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);

  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  // ── Toast state ──────────────────────────────────────────────
  const [toast, setToast] = useState({
    show: false,
    type: "success",
    title: "",
    message: "",
  });

  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    if (type !== "loading") {
      setTimeout(
        () => setToast((prev) => ({ ...prev, show: false })),
        4000
      );
    }
  };

  const isExpired = () => {
    if (!assignment) return false;
    const scheduleDate = new Date(
      `${assignment.date}T${assignment.endTime}`
    );
    return new Date() > scheduleDate;
  };

  // ✅ Check kung pwede pa mag-decide
  const isPending = () => {
    if (!assignment) return false;
    const s = String(assignment.status || "").toLowerCase();
    return s === "pending_faculty" || s === "pending_admin" || s === "pending";
  };

  const isAlreadyAccepted = () => {
    if (!assignment) return false;
    return String(assignment.status || "").toLowerCase() === "accepted";
  };

  const isAlreadyDeclined = () => {
    if (!assignment) return false;
    return String(assignment.status || "").toLowerCase() === "declined";
  };

  const isCancelled = () => {
    if (!assignment) return false;
    return String(assignment.status || "").toLowerCase() === "cancelled";
  };

  const isNeedsReassign = () => {
    if (!assignment) return false;
    return String(assignment.status || "").toLowerCase() === "needs_reassign";
  };

  // ✅ Combined: pwedeng mag-decide?
  const canDecide = () => isPending() && !isExpired();

  useEffect(() => {
    const loadAssignment = async () => {
      try {
        const snap = await getDoc(
          doc(db, "roomReassignments", assignmentId)
        );
        if (snap.exists()) {
          setAssignment({ id: snap.id, ...snap.data() });
        }
      } catch (err) {
        console.log(err);
      }
      setLoading(false);
    };
    loadAssignment();
  }, [assignmentId]);

  // ─── Mark the notification(s) as decided ─────────────────────
  // Ito yung pang-block sa View button. Hinahanap lahat ng notifications
  // na tumutugma sa assignmentId na ito at hindi pa naka-mark as decided,
  // saka nila ina-update. Kapag bagong reassignment (fresh doc), wala
  // itong maapektuhan.
  const markRelatedNotifications = async (decision) => {
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) return;

      const q = query(
        collection(db, "notifications"),
        where("assignmentId", "==", assignment.id),
        where("type", "==", "room-reassignment")
      );

      const snap = await getDocs(q);
      let markedCount = 0;

      for (const notifDoc of snap.docs) {
        const data = notifDoc.data();

        // ✅ Skip kapag decided na
        if (data.decided === true) continue;

        // ✅ Skip kapag hindi para sa user na ito
        if (data.userId !== currentUser.uid) continue;

        await updateDoc(notifDoc.ref, {
          decided: true,
          decidedAt: serverTimestamp(),
          badge: decision.toUpperCase(),
        });
        markedCount++;
      }

      console.log(
        `[FacultyRoomReassignment] Marked ${markedCount} notification(s) as decided.`
      );
    } catch (err) {
      console.warn(
        "[FacultyRoomReassignment] Failed to mark notifications:",
        err
      );
    }
  };

  // ─── Send notifications ───────────────────────────────────────
  const sendDecisionNotifications = async (decision) => {
    const currentUser = auth.currentUser;
    if (!currentUser) return;

    const facultySnap = await getDoc(doc(db, "users", currentUser.uid));
    const faculty = facultySnap.data() || {};
    const facultyName = `${faculty.firstName || ""} ${
      faculty.lastName || ""
    }`.trim();

    const isAccepted = decision === "accepted";
    const verb = isAccepted ? "accepted" : "declined";

    // Self notification (record)
    await addDoc(collection(db, "notifications"), {
      userId: currentUser.uid,
      ownerType: "faculty",
      assignmentId: assignment.id,
      reassignmentId: assignment.id,
      title: "Room Reassignment",
      message: `You ${verb} the room reassignment for ${assignment.courseTitle}.`,
      type: "room-reassignment-status",
      badge: decision.toUpperCase(),
      unread: true,
      archived: false,
      decided: true,
      createdAt: serverTimestamp(),
    });

    // Notify Admins
    const usersSnap = await getDocs(collection(db, "users"));
    for (const userDoc of usersSnap.docs) {
      const role = String(userDoc.data().role || "").toLowerCase();
      if (role !== "admin") continue;

      await addDoc(collection(db, "notifications"), {
        userId: userDoc.id,
        ownerType: "admin",
        assignmentId: assignment.id,
        reassignmentId: assignment.id,
        title: "Faculty Response",
        message: `${facultyName} ${verb} the room reassignment request for ${assignment.courseTitle}.`,
        type: "room-reassignment-status",
        badge: isAccepted ? "ACCEPTED" : "DECLINED",
        unread: true,
        archived: false,
        createdAt: serverTimestamp(),
      });
    }

    // Notify Clerk
    if (assignment.requestedById) {
      await addDoc(collection(db, "notifications"), {
        userId: assignment.requestedById,
        ownerType: "clerk",
        assignmentId: assignment.id,
        reassignmentId: assignment.id,
        title: isAccepted
          ? "Faculty Accepted Reassignment"
          : "Faculty Declined Reassignment",
        message: `${facultyName} ${verb} the reassignment for ${assignment.courseTitle} (${assignment.oldRoomName} → ${assignment.newRoomName}).`,
        type: "room-reassignment-status",
        badge: isAccepted ? "ACCEPTED" : "DECLINED",
        unread: true,
        archived: false,
        createdAt: serverTimestamp(),
      });
    }
  };

  // ─── Accept ───────────────────────────────────────────────────
  const approveAssignment = async () => {
    if (processing) return;

    if (!canDecide()) {
      showToast(
        "error",
        "Not Allowed",
        isAlreadyAccepted()
          ? "You already accepted this reassignment."
          : isAlreadyDeclined()
          ? "You already declined this reassignment."
          : isCancelled()
          ? "This reassignment has been cancelled."
          : isNeedsReassign()
          ? "This reassignment is being re-processed."
          : "This reassignment is no longer active."
      );
      return;
    }

    if (isExpired()) {
      showToast(
        "error",
        "Expired",
        "This room reassignment has already expired."
      );
      return;
    }

    setProcessing(true);
    showToast("loading", "Accepting", "Saving your response...");

    try {
      await updateDoc(doc(db, "roomReassignments", assignment.id), {
        status: "accepted",
        acceptedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // ✅ Resolve the conflict on accept
      if (assignment.eventId) {
        await updateDoc(doc(db, "events", assignment.eventId), {
          conflictResolved: true,
          resolution: "approved",
          resolutionReason: "Accepted by faculty",
          resolvedAt: serverTimestamp(),
        });
      }

      await sendDecisionNotifications("accepted");

      // 🆕 Mark the original request notification as decided
      await markRelatedNotifications("accepted");

      const userSnap = await getDoc(doc(db, "users", auth.currentUser.uid));
      const userData = userSnap.data();

      await logActivity({
        user: `${userData.firstName} ${userData.lastName}`,
        role: userData.role,
        action: "Accepted room reassignment",
        actionType: "success",
        target: `${assignment.courseTitle} | ${assignment.oldRoomName} → ${assignment.newRoomName}`,
        status: "Success",
        details: { decision: "accepted" },
      });

      // Update local state para reflective agad yung UI
      setAssignment((prev) => ({
        ...prev,
        status: "accepted",
        acceptedAt: new Date(),
      }));

      showToast(
        "success",
        "Accepted",
        "Room reassignment accepted successfully."
      );
      setTimeout(() => navigate("/faculty"), 1200);
    } catch (err) {
      console.log(err);
      showToast(
        "error",
        "Failed",
        "Could not accept the reassignment. Please try again."
      );
    } finally {
      setProcessing(false);
    }
  };

  // ─── Decline ──────────────────────────────────────────────────
  const rejectAssignment = async () => {
    if (processing) return;

    if (!canDecide()) {
      showToast(
        "error",
        "Not Allowed",
        isAlreadyAccepted()
          ? "You already accepted this reassignment."
          : isAlreadyDeclined()
          ? "You already declined this reassignment."
          : isCancelled()
          ? "This reassignment has been cancelled."
          : isNeedsReassign()
          ? "This reassignment is being re-processed."
          : "This reassignment is no longer active."
      );
      return;
    }

    if (isExpired()) {
      showToast(
        "error",
        "Expired",
        "This room reassignment has already expired."
      );
      return;
    }

    setProcessing(true);
    showToast("loading", "Declining", "Saving your response...");

    try {
      const reason = rejectReason.trim() || "No reason provided";

      await updateDoc(doc(db, "roomReassignments", assignment.id), {
        status: "declined",
        declinedAt: serverTimestamp(),
        denialReason: reason,
        updatedAt: serverTimestamp(),
      });

      // ✅ DO NOT resolve the event here.
      // The conflict stays unresolved until the Admin decides to
      // cancel the class.

      await sendDecisionNotifications("declined");

      // 🆕 Mark the original request notification as decided
      await markRelatedNotifications("declined");

      const userSnap = await getDoc(doc(db, "users", auth.currentUser.uid));
      const userData = userSnap.data();

      await logActivity({
        user: `${userData.firstName} ${userData.lastName}`,
        role: userData.role,
        action: "Declined room reassignment",
        actionType: "denied",
        target: `${assignment.courseTitle} | ${assignment.oldRoomName} → ${assignment.newRoomName}`,
        status: "Declined",
        details: { reason },
      });

      // Update local state
      setAssignment((prev) => ({
        ...prev,
        status: "declined",
        declinedAt: new Date(),
        denialReason: reason,
      }));

      setShowRejectModal(false);
      showToast(
        "success",
        "Declined",
        "Room reassignment declined. Admin will review and take action."
      );
      setTimeout(() => navigate("/faculty"), 1500);
    } catch (err) {
      console.log(err);
      showToast(
        "error",
        "Failed",
        "Could not decline the reassignment. Please try again."
      );
    } finally {
      setProcessing(false);
    }
  };

  if (loading) {
    return (
      <div className="faculty-room-loading">
        <div className="spinner"></div>
        <p>Loading room reassignment...</p>
      </div>
    );
  }

  if (!assignment) {
    return (
      <div className="faculty-room-loading">
        <h2>Room reassignment not found.</h2>
      </div>
    );
  }

  return (
    <div className="faculty-room-page">
      <div className="faculty-room-card">
        <div className="faculty-room-header">
          <h1>Room Reassignment Request</h1>
          <p>
            The Admin has proposed a temporary room change for one of your
            classes.
          </p>
        </div>

        <div className="faculty-room-section">
          <h3>Class Information</h3>
          <div className="faculty-room-grid">
            <div className="info-box">
              <label>Course</label>
              <span>{assignment.courseTitle}</span>
            </div>
            <div className="info-box">
              <label>Section</label>
              <span>{assignment.section}</span>
            </div>
            <div className="info-box">
              <label>Date</label>
              <span>{assignment.date}</span>
            </div>
            <div className="info-box">
              <label>Time</label>
              <span>
                {assignment.startTime} - {assignment.endTime}
              </span>
            </div>
          </div>
        </div>

        <div className="faculty-room-section">
          <h3>Room Change</h3>
          <div className="room-change">
            <div className="room-box">
              <label>Current Room</label>
              <h2>{assignment.oldRoomName}</h2>
            </div>
            <div className="arrow">
              <i className="fa-solid fa-arrow-right"></i>
            </div>
            <div className="room-box new">
              <label>Suggested Room</label>
              <h2>{assignment.newRoomName}</h2>
            </div>
          </div>
        </div>

        <div className="faculty-room-note">
          <i className="fa-solid fa-circle-info"></i>
          <span>
            This reassignment only applies to this scheduled class. Your
            regular weekly room assignment will remain unchanged.
          </span>
        </div>

        {/* ═══════════════════════════════════════════════════════
            STATE RENDERING — buttons vs. locked states
            ═══════════════════════════════════════════════════════ */}

        {isAlreadyAccepted() && (
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
              <strong>You already accepted this reassignment.</strong> The
              class has been moved to <b>{assignment.newRoomName}</b>.
            </span>
          </div>
        )}

        {isAlreadyDeclined() && (
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
              <strong>You already declined this reassignment.</strong>
              {assignment.denialReason
                ? ` Reason: ${assignment.denialReason}`
                : ""}{" "}
              The Admin will review this request.
            </span>
          </div>
        )}

        {isCancelled() && (
          <div
            className="faculty-room-note"
            style={{
              marginTop: 30,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
            }}
          >
            <i className="fa-solid fa-ban"></i>
            <span>
              <strong>This reassignment was cancelled.</strong> No further
              action is required.
            </span>
          </div>
        )}

        {isNeedsReassign() && (
          <div
            className="faculty-room-note"
            style={{
              marginTop: 30,
              background: "#fef3c7",
              border: "1px solid #fcd34d",
              color: "#92400e",
            }}
          >
            <i className="fa-solid fa-rotate-left"></i>
            <span>
              <strong>This reassignment is being re-processed.</strong> The
              Clerk is finding a different room. You will receive a new
              notification once ready.
            </span>
          </div>
        )}

        {canDecide() && (
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
                "Reject"
              )}
            </button>
            <button
              className="approve-btn"
              onClick={approveAssignment}
              disabled={processing}
            >
              {processing ? (
                <>
                  <i className="fa-solid fa-circle-notch fa-spin"></i>{" "}
                  Processing...
                </>
              ) : (
                "Accept Room"
              )}
            </button>
          </div>
        )}

        {/* Fallback: pending pa rin pero expired na */}
        {isPending() && isExpired() && (
          <div
            className="faculty-room-note"
            style={{
              marginTop: 30,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
            }}
          >
            <i className="fa-solid fa-clock"></i>
            <span>
              This room reassignment has already ended. The response period is
              now closed.
            </span>
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
              <h3>Reject Room Reassignment</h3>
              <button
                className="faculty-room-modal-close"
                onClick={() => setShowRejectModal(false)}
                disabled={processing}
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>
            <div className="faculty-room-modal-body">
              <p>Please provide a reason for rejecting this room reassignment.</p>

              <div className="faculty-room-reason-group">
                <label>Quick Reason</label>
                <select
                  className="faculty-room-reason-select"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  disabled={processing}
                >
                  <option value="">Select a reason (optional)</option>
                  <option value="Schedule conflict">Schedule conflict</option>
                  <option value="Room not suitable">Room not suitable</option>
                  <option value="Already have a class">
                    Already have a class
                  </option>
                  <option value="Equipment not available">
                    Equipment not available
                  </option>
                  <option value="Too far from my office">
                    Too far from my office
                  </option>
                  <option value="Need a different room capacity">
                    Need a different room capacity
                  </option>
                </select>
              </div>

              <div className="faculty-room-reason-group">
                <label>Custom Reason (optional)</label>
                <textarea
                  className="faculty-room-modal-textarea"
                  placeholder="Enter additional details or custom reason..."
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  rows={3}
                  disabled={processing}
                />
              </div>

              <div className="faculty-room-reason-note">
                <i className="fa-solid fa-info-circle"></i>
                <span>
                  Your reason will be shared with the Admin for clarity. The
                  conflict will remain open until the Admin reviews it.
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
                onClick={rejectAssignment}
                disabled={processing}
              >
                {processing ? (
                  <>
                    <i className="fa-solid fa-circle-notch fa-spin"></i>{" "}
                    Declining...
                  </>
                ) : (
                  "Confirm Reject"
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