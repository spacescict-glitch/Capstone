import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import "./bulk-schedule-upload4.css";
import ConfirmPopup from "../../../Popup/ConfirmPopup/ConfirmPopup";
import Toast from "../../../Popup/Toast/Toast";
import {
  collection,
  query,
  where,
  getDocs,
  addDoc,
  doc,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";
import { auth, db } from "../../../firebase";
import { findFacultyUser } from "../../../utils/findFacultyUser";
import { parseFacultyName } from "../../../utils/parseFacultyName";
import { todayStr, yesterdayStr } from "../../../utils/scheduleActivePeriod";

const steps = [
  { number: 1, label: "SETUP" },
  { number: 2, label: "UPLOAD" },
  { number: 3, label: "CALENDAR VIEW" },
  { number: 4, label: "CONFIRM" },
];

const formatTime12Hour = (time) => {
  if (!time) return "";
  const [hour, minute] = time.split(":").map(Number);
  const suffix = hour >= 12 ? "PM" : "AM";
  let displayHour = hour % 12;
  if (displayHour === 0) displayHour = 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
};

// ─── Send notifications ─────────────────────────────────────────────
const sendNotification = async (
  userId,
  ownerType,
  title,
  message,
  type,
  badge = "INFO"
) => {
  if (!userId) return;
  await addDoc(collection(db, "notifications"), {
    userId,
    ownerType,
    title,
    message,
    type,
    unread: true,
    archived: false,
    badge,
    createdAt: serverTimestamp(),
  });
};

export default function BulkScheduleUpload4() {
  const location = useLocation();
  const navigate = useNavigate();
  const { semester, schoolYear, allRoomsData } = location.state || {};

  const [showModal, setShowModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showActivatePrompt, setShowActivatePrompt] = useState(false);
  const [uploadedCount, setUploadedCount] = useState(0);
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

  const logActivity = async ({
    userId,
    user,
    role,
    action,
    actionType,
    target,
    status,
  }) => {
    try {
      await addDoc(collection(db, "activityLogs"), {
        userId,
        user,
        role,
        action,
        actionType,
        target,
        status,
        timestamp: serverTimestamp(),
      });
    } catch (err) {
      console.error("Activity log error:", err);
    }
  };

  const handleConfirm = async () => {
    if (isSaving) return;
    setIsSaving(true);
    showToast("loading", "Uploading", "Saving schedules...");

    try {
      // Get current user
      const currentUser = auth.currentUser;
      let currentUserData = {
        userId: "",
        user: "Unknown User",
        role: "",
      };
      if (currentUser) {
        const userQuery = query(
          collection(db, "users"),
          where("email", "==", currentUser.email)
        );
        const userSnapshot = await getDocs(userQuery);
        if (!userSnapshot.empty) {
          const userDoc = userSnapshot.docs[0].data();
          currentUserData = {
            userId: currentUser.uid,
            user: `${userDoc.firstName} ${userDoc.lastName}`,
            role: userDoc.role,
          };
        }
      }

      // Get all users for faculty matching
      const usersSnap = await getDocs(collection(db, "users"));
      const facultySet = new Set();

      // For each room, save schedules
      const allSaved = [];
      for (const roomData of allRoomsData) {
        const { room, schedules } = roomData;
        const roomQuery = query(
          collection(db, "rooms"),
          where("roomName", "==", room)
        );
        const roomSnapshot = await getDocs(roomQuery);
        if (roomSnapshot.empty) continue;
        const roomDoc = roomSnapshot.docs[0];
        const roomId = roomDoc.id;

        for (const schedule of schedules) {
          // Parse faculty name to extract last and first
          const parsed = parseFacultyName(schedule.faculty || "TBA");

          // KEEP original faculty name as-is (from the file)
          const originalFacultyName = schedule.faculty || "TBA";

          // Save to schedules
          const docRef = await addDoc(
            collection(db, "rooms", roomId, "schedules"),
            {
              subject: schedule.subject || "",
              section: schedule.section || "",
              faculty: originalFacultyName,
              facultyLastName: parsed.lastName || "",
              facultyFirstName: parsed.firstName || "",
              day: schedule.day || "",
              startTime: schedule.startTime || "",
              endTime: schedule.endTime || "",
              semester,
              schoolYear,
              // ── Activation state (not yet live) ──
              isActive: false,
              activeFrom: null,
              activeUntil: null,
              createdAt: serverTimestamp(),
            }
          );

          // Save to originalSchedules
          await addDoc(
            collection(db, "rooms", roomId, "originalSchedules"),
            {
              subject: schedule.subject || "",
              section: schedule.section || "",
              faculty: originalFacultyName,
              facultyLastName: parsed.lastName || "",
              facultyFirstName: parsed.firstName || "",
              day: schedule.day || "",
              startTime: schedule.startTime || "",
              endTime: schedule.endTime || "",
              semester,
              schoolYear,
              isActive: false,
              activeFrom: null,
              activeUntil: null,
              createdAt: serverTimestamp(),
            }
          );

          if (parsed.lastName && parsed.firstName) {
            facultySet.add({
              name: originalFacultyName,
              lastName: parsed.lastName,
              firstName: parsed.firstName,
            });
          }

          allSaved.push({
            room,
            ...schedule,
            docId: docRef.id,
            faculty: originalFacultyName,
            facultyLastName: parsed.lastName || "",
            facultyFirstName: parsed.firstName || "",
          });
        }
      }

      // ─── Activity log ──────────────────────────────────────────
      await logActivity({
        userId: currentUserData.userId,
        user: currentUserData.user,
        role: currentUserData.role,
        action: "Uploaded Bulk Schedules",
        actionType: "CREATE",
        target: `${allSaved.length} schedules across ${allRoomsData.length} rooms (${semester}, ${schoolYear})`,
        status: "SUCCESS",
      });

      // ─── Notify faculty ──────────────────────────────────────
      for (const faculty of facultySet) {
        const facultyUserDoc = findFacultyUser(
          usersSnap,
          faculty.lastName,
          faculty.firstName
        );
        if (facultyUserDoc) {
          const userId = facultyUserDoc.id;
          await sendNotification(
            userId,
            "faculty",
            "New Schedule Uploaded",
            `A schedule has been uploaded for ${faculty.name}.`,
            "schedule-upload",
            "NEW"
          );
        }
      }

      // ─── Notify admins ─────────────────────────────────────────
      const adminsSnap = await getDocs(
        query(collection(db, "users"), where("role", "==", "admin"))
      );
      const adminNotifications = [];
      adminsSnap.forEach((doc) => {
        adminNotifications.push(
          sendNotification(
            doc.id,
            "admin",
            "New Bulk Schedule Upload",
            `${currentUserData.user} uploaded ${allSaved.length} schedules for ${allRoomsData.length} rooms (${semester}, ${schoolYear}).`,
            "schedule-upload",
            "INFO"
          )
        );
      });
      await Promise.all(adminNotifications);

      // ─── Notify self ──────────────────────────────────────────
      if (currentUserData.userId) {
        await sendNotification(
          currentUserData.userId,
          "admin",
          "Bulk Upload Complete",
          `You successfully uploaded ${allSaved.length} schedules for ${allRoomsData.length} rooms.`,
          "schedule-upload",
          "SUCCESS"
        );
      }

      setUploadedCount(allSaved.length);
      showToast(
        "success",
        "Upload Complete",
        `${allSaved.length} schedules uploaded across ${allRoomsData.length} rooms.`
      );

      setIsSaving(false);
      setShowModal(false);
      setShowActivatePrompt(true);
    } catch (error) {
      console.error(error);
      showToast(
        "error",
        "Upload Failed",
        error.message || "Something went wrong."
      );
      setIsSaving(false);
    }
  };

  // ─── Activate the newly uploaded term immediately ──────────────
  const activateNow = async () => {
    setShowActivatePrompt(false);
    showToast("loading", "Activating", "Please wait...");

    try {
      const today = todayStr();
      const yesterday = yesterdayStr();
      const roomSnapAll = await getDocs(collection(db, "rooms"));

      for (const roomDoc of roomSnapAll.docs) {
        const schedSnap = await getDocs(
          collection(db, "rooms", roomDoc.id, "schedules")
        );
        for (const sdoc of schedSnap.docs) {
          const data = sdoc.data();
          if (data.initialized) continue;

          const sameGroup =
            data.schoolYear === schoolYear && data.semester === semester;

          if (sameGroup) {
            const update = {
              isActive: true,
              activeUntil: null,
              updatedAt: serverTimestamp(),
            };
            if (!data.activeFrom) update.activeFrom = today;
            await updateDoc(
              doc(db, "rooms", roomDoc.id, "schedules", sdoc.id),
              update
            );
          } else if (data.isActive) {
            await updateDoc(
              doc(db, "rooms", roomDoc.id, "schedules", sdoc.id),
              {
                isActive: false,
                activeUntil: yesterday,
                updatedAt: serverTimestamp(),
              }
            );
          }
        }
      }

      showToast(
        "success",
        "Activated",
        `${semester} ${schoolYear} is now the active term.`
      );
      setTimeout(() => navigate("/admin"), 1200);
    } catch (err) {
      console.error(err);
      showToast(
        "error",
        "Activation Failed",
        err.message || "Something went wrong."
      );
    }
  };

  const skipActivation = () => {
    setShowActivatePrompt(false);
    showToast(
      "success",
      "Saved as Draft",
      "You can activate it later from My Submitted Schedules."
    );
    setTimeout(() => navigate("/admin"), 1200);
  };

  if (!location.state || !allRoomsData) {
    return (
      <div className="bulk-upload-page-four">
        <h2>No data to confirm.</h2>
        <button onClick={() => navigate("/admin/bulk-upload-2")}>
          Start Over
        </button>
      </div>
    );
  }

  const totalSchedules = allRoomsData.reduce(
    (acc, r) => acc + r.schedules.length,
    0
  );
  const roomNames = allRoomsData.map((r) => r.room).join(", ");

  return (
    <div className="bulk-upload-page-four">
      <div className="bulk-header-four">
        <h1>Bulk Schedule Upload</h1>
        <p>Confirm extracted schedules before saving.</p>
      </div>

      <div className="stepper-four">
        {steps.map((step, index) => (
          <div className="step-wrapper-four" key={step.number}>
            <div className="step-item-four">
              <div
                className={`step-circle-four ${
                  step.number < 4 ? "completed" : ""
                } ${step.number === 4 ? "active" : ""}`}
              >
                {step.number < 4 ? <i className="fas fa-check" /> : step.number}
              </div>
              <span
                className={`step-label-four ${
                  step.number === 4 ? "active" : ""
                }`}
              >
                {step.label}
              </span>
            </div>
            {index < steps.length - 1 && (
              <div className="step-line-four completed" />
            )}
          </div>
        ))}
      </div>

      <div className="form-card-four">
        <div className="info-card">
          <span className="info-title">Upload Summary</span>
          <div className="info-row">
            <div className="info-group">
              <span className="info-label">Semester</span>
              <span className="info-value">{semester}</span>
            </div>
            <div className="info-group">
              <span className="info-label">School Year</span>
              <span className="info-value">{schoolYear}</span>
            </div>
            <div className="info-group">
              <span className="info-label">Rooms</span>
              <span className="info-value">{allRoomsData.length}</span>
            </div>
            <div className="info-group">
              <span className="info-label">Total Schedules</span>
              <span className="info-value">{totalSchedules}</span>
            </div>
          </div>
          <div className="info-group" style={{ marginTop: "8px" }}>
            <span className="info-label">Room List</span>
            <span className="info-value">{roomNames}</span>
          </div>
        </div>

        <div className="bulk4-preview">
          <div className="bulk4-preview-header">
            <h3>Schedule Preview</h3>
            <span className="bulk4-count">{totalSchedules} schedules</span>
          </div>

          {allRoomsData.map((roomData, idx) => (
            <div key={idx} style={{ marginBottom: "1.5rem" }}>
              <h4 style={{ marginBottom: "0.5rem" }}>Room: {roomData.room}</h4>
              <div className="bulk4-grid">
                {roomData.schedules.map((schedule, sIdx) => (
                  <div key={sIdx} className="bulk4-card">
                    <div className="bulk4-card-header">
                      <h4>{schedule.subject}</h4>
                      {schedule.section && (
                        <span className="bulk4-section">{schedule.section}</span>
                      )}
                    </div>
                    <div className="bulk4-card-body">
                      <div className="bulk4-item">
                        <i className="fa-regular fa-calendar" />
                        <span>{schedule.day}</span>
                      </div>
                      <div className="bulk4-item">
                        <i className="fa-regular fa-clock" />
                        <span>
                          {formatTime12Hour(schedule.startTime)} -{" "}
                          {formatTime12Hour(schedule.endTime)}
                        </span>
                      </div>
                      <div className="bulk4-item">
                        <i className="fa-regular fa-user" />
                        <span>{schedule.faculty || "TBA"}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bulk-footer-four">
        <button className="btn-back-four" onClick={() => navigate(-1)}>
          Back
        </button>
        <button
          className="btn-confirm-four"
          onClick={() => setShowModal(true)}
        >
          Confirm Upload
        </button>
      </div>

      {showModal && (
        <ConfirmPopup
          onCancel={() => setShowModal(false)}
          onConfirm={handleConfirm}
        />
      )}

      {/* ─── Activate-on-upload prompt ─────────────────────────── */}
      {showActivatePrompt && (
        <div className="msd-modal-overlay" onClick={skipActivation}>
          <div className="msd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="msd-modal-icon activate">
              <i className="fa-solid fa-circle-play"></i>
            </div>
            <h3>Activate this schedule?</h3>
            <p>
              Activate <strong>{semester} {schoolYear}</strong> now? It will
              become the visible term in Academic Schedule starting today
              ({todayStr()}), and any previously active term will stop from
              today onwards. Past dates of the previous term remain viewable.
            </p>
            <p style={{ fontSize: "12px", color: "#94a3b8" }}>
              {uploadedCount} schedules were uploaded.
            </p>
            <div className="msd-modal-actions">
              <button className="msd-cancel-btn" onClick={skipActivation}>
                Not now
              </button>
              <button className="msd-confirm-btn activate" onClick={activateNow}>
                Activate now
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