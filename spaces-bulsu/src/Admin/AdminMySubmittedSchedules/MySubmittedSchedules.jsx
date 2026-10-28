import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  collection,
  getDocs,
  doc,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../../firebase";
import Toast from "../../Popup/Toast/Toast";
import { todayStr, yesterdayStr } from "../../utils/scheduleActivePeriod";
import "./my-submitted-schedules.css";

export default function MySubmittedSchedules() {
  const navigate = useNavigate();

  const [folders, setFolders] = useState({});
  const [loading, setLoading] = useState(true);
  const [expandedSY, setExpandedSY] = useState({});
  const [expandedSem, setExpandedSem] = useState({});
  const [saving, setSaving] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null); // { sy, sem, activating }
  const [toast, setToast] = useState({
    show: false,
    type: "success",
    title: "",
    message: "",
  });

  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    if (type !== "loading") {
      setTimeout(() => setToast((p) => ({ ...p, show: false })), 3500);
    }
  };

  useEffect(() => {
    loadSchedules();
  }, []);

  const loadSchedules = async () => {
    setLoading(true);
    const roomSnapshot = await getDocs(collection(db, "rooms"));
    const grouped = {};

    for (const roomDoc of roomSnapshot.docs) {
      const room = { id: roomDoc.id, ...roomDoc.data() };
      const schedSnapshot = await getDocs(
        collection(db, "rooms", room.id, "schedules")
      );

      const schedules = schedSnapshot.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((s) => !s.initialized);

      schedules.forEach((schedule) => {
        const sy = schedule.schoolYear;
        const sem = schedule.semester;
        if (!sy || !sem) return;

        if (!grouped[sy]) grouped[sy] = {};
        if (!grouped[sy][sem]) {
          grouped[sy][sem] = {
            rooms: [],
            schedules: [],
            isActive: false,
            activeFrom: null,
            activeUntil: null,
          };
        }

        const bucket = grouped[sy][sem];
        bucket.schedules.push({
          ...schedule,
          roomId: room.id,
          roomName: room.roomName,
        });

        if (schedule.isActive) bucket.isActive = true;
        if (schedule.activeFrom && (!bucket.activeFrom || schedule.activeFrom < bucket.activeFrom)) {
          bucket.activeFrom = schedule.activeFrom;
        }
        if (schedule.activeUntil && (!bucket.activeUntil || schedule.activeUntil > bucket.activeUntil)) {
          bucket.activeUntil = schedule.activeUntil;
        }

        if (!bucket.rooms.find((r) => r.id === room.id)) {
          bucket.rooms.push(room);
        }
      });
    }

    setFolders(grouped);
    setLoading(false);
  };

  const toggleSY = (sy) => setExpandedSY((p) => ({ ...p, [sy]: !p[sy] }));
  const toggleSem = (k) => setExpandedSem((p) => ({ ...p, [k]: !p[k] }));

  // ─── Activate a SY/sem (deactivates any other active term) ─────
  const activateGroup = async (sy, sem) => {
    setSaving(true);
    showToast("loading", "Activating", "Please wait...");

    try {
      const today = todayStr();
      const yesterday = yesterdayStr();
      const roomSnapshot = await getDocs(collection(db, "rooms"));

      for (const roomDoc of roomSnapshot.docs) {
        const schedSnap = await getDocs(
          collection(db, "rooms", roomDoc.id, "schedules")
        );
        for (const sdoc of schedSnap.docs) {
          const data = sdoc.data();
          if (data.initialized) continue;

          const sameGroup =
            data.schoolYear === sy && data.semester === sem;

          if (sameGroup) {
            // Activate
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
            // Deactivate the previous active term
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

      showToast("success", "Activated", `${sem} ${sy} is now the active term.`);
      await loadSchedules();
    } catch (err) {
      console.error(err);
      showToast("error", "Activation Failed", err.message || "Try again.");
    } finally {
      setSaving(false);
    }
  };

  const deactivateGroup = async (sy, sem) => {
    setSaving(true);
    showToast("loading", "Deactivating", "Please wait...");

    try {
      const yesterday = yesterdayStr();
      const roomSnapshot = await getDocs(collection(db, "rooms"));

      for (const roomDoc of roomSnapshot.docs) {
        const schedSnap = await getDocs(
          collection(db, "rooms", roomDoc.id, "schedules")
        );
        for (const sdoc of schedSnap.docs) {
          const data = sdoc.data();
          if (data.schoolYear !== sy || data.semester !== sem) continue;
          if (!data.isActive) continue;

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

      showToast(
        "success",
        "Deactivated",
        `${sem} ${sy} stopped. Past dates will still show it.`
      );
      await loadSchedules();
    } catch (err) {
      console.error(err);
      showToast("error", "Deactivation Failed", err.message || "Try again.");
    } finally {
      setSaving(false);
    }
  };

  const confirmActivation = async () => {
    if (!confirmAction) return;
    const { sy, sem, activating } = confirmAction;
    setConfirmAction(null);
    if (activating) await activateGroup(sy, sem);
    else await deactivateGroup(sy, sem);
  };

  return (
    <div className="lr-submitted-schedules">
      <div className="lr-ss-page-header">
        <h1>My Submitted Schedules</h1>
        <p>
          View all schedules you've submitted per room, grouped by school year and semester. Activate a term to make it visible in the Academic Schedule.
        </p>
        <p>Only one term can be active at a time.        </p>
      </div>
      
      <div className="list-card">
        {loading ? (
          <div className="room-empty">
            <i className="fa-solid fa-spinner fa-spin"></i>
            <h2>Loading Submitted Schedules</h2>
            <p>Please wait while we retrieve submitted schedules.</p>
          </div>
        ) : Object.keys(folders).length === 0 ? (
          <div className="room-empty">
            <i className="fa-regular fa-folder-open"></i>
            <h2>No submitted schedules</h2>
            <p>Schedules you submit will appear here, grouped by school year and semester.</p>
          </div>
        ) : (
          Object.entries(folders).map(([schoolYear, semesters]) => (
            <div className="folder-block" key={schoolYear}>
              <div
                className="folder-title"
                onClick={() => toggleSY(schoolYear)}
              >
                <i
                  className={`fa-solid fa-chevron-right folder-chevron ${
                    expandedSY[schoolYear] ? "open" : ""
                  }`}
                ></i>
                <i
                  className={`fa-solid ${
                    expandedSY[schoolYear] ? "fa-folder-open" : "fa-folder"
                  }`}
                ></i>
                <span>{schoolYear}</span>
                <span className="folder-count">
                  {Object.keys(semesters).length} sem
                  {Object.keys(semesters).length > 1 ? "s" : ""}
                </span>
              </div>

              {expandedSY[schoolYear] && (
                <div className="semester-list">
                  {Object.entries(semesters).map(([semester, data]) => {
                    const key = schoolYear + semester;
                    const { rooms, isActive, activeFrom, activeUntil } = data;

                    return (
                      <div className="semester-block" key={semester}>
                        <div
                          className="semester-title"
                          onClick={() => toggleSem(key)}
                        >
                          <i
                            className={`fa-solid fa-chevron-right sem-chevron ${
                              expandedSem[key] ? "open" : ""
                            }`}
                          ></i>
                          <i className="fa-solid fa-layer-group"></i>
                          <span>{semester}</span>
                          <span className="room-count-pill">
                            <i className="fa-solid fa-door-open"></i>
                            {rooms.length}
                          </span>

                          {isActive ? (
                            <span className="sem-status-badge active">
                              <i className="fa-solid fa-circle"></i> Active
                            </span>
                          ) : activeFrom ? (
                            <span className="sem-status-badge inactive">
                              <i className="fa-solid fa-circle"></i> Inactive
                            </span>
                          ) : (
                            <span className="sem-status-badge draft">
                              <i className="fa-solid fa-circle"></i> Draft
                            </span>
                          )}
                        </div>

                        {expandedSem[key] && (
                          <div className="semester-content">
                            <div className="sem-activation-bar">
                              <div className="sem-activation-info">
                                <i className="fa-regular fa-calendar"></i>
                                {activeFrom ? (
                                  <span>
                                    <strong>{activeFrom}</strong>
                                    {activeUntil ? (
                                      <>
                                        {" "}
                                        <i className="fa-solid fa-arrow-right-long"></i>{" "}
                                        <strong>{activeUntil}</strong>
                                      </>
                                    ) : (
                                      <>
                                        {" "}
                                        <i className="fa-solid fa-arrow-right-long"></i>{" "}
                                        present
                                      </>
                                    )}
                                  </span>
                                ) : (
                                  <span>Not yet activated</span>
                                )}
                              </div>
                              <div className="sem-activation-actions">
                                {isActive ? (
                                  <button
                                    type="button"
                                    className="btn-deactivate"
                                    disabled={saving}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setConfirmAction({
                                        sy: schoolYear,
                                        sem: semester,
                                        activating: false,
                                      });
                                    }}
                                  >
                                    <i className="fa-solid fa-circle-pause"></i>
                                    Deactivate
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="btn-activate"
                                    disabled={saving}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setConfirmAction({
                                        sy: schoolYear,
                                        sem: semester,
                                        activating: true,
                                      });
                                    }}
                                  >
                                    <i className="fa-solid fa-circle-play"></i>
                                    Activate
                                  </button>
                                )}
                              </div>
                            </div>

                            <div className="room-grid">
                              {rooms.map((room) => (
                                <div
                                  key={room.id}
                                  className="room-item"
                                  onClick={() =>
                                    navigate("/admin/schedule-room-card", {
                                      state: {
                                        room,
                                        semester,
                                        schoolYear,
                                        isOriginal: true,
                                        canEdit: true,
                                      },
                                    })
                                  }
                                >
                                  <div className="room-item-icon">
                                    <i className="fa-solid fa-door-open"></i>
                                  </div>
                                  <span>{room.roomName}</span>
                                  <i className="fa-solid fa-pen-to-square room-edit-icon"></i>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {confirmAction && (
        <div
          className="msd-modal-overlay"
          onClick={() => setConfirmAction(null)}
        >
          <div className="msd-modal" onClick={(e) => e.stopPropagation()}>
            <div
              className={`msd-modal-icon ${
                confirmAction.activating ? "activate" : "deactivate"
              }`}
            >
              <i
                className={`fa-solid ${
                  confirmAction.activating
                    ? "fa-circle-play"
                    : "fa-circle-pause"
                }`}
              ></i>
            </div>
            <h3>
              {confirmAction.activating
                ? "Activate this schedule?"
                : "Deactivate this schedule?"}
            </h3>
            <p>
              {confirmAction.activating
                ? `Activating "${confirmAction.sem} ${confirmAction.sy}" will deactivate any currently active term and make this schedule appear starting today.`
                : `Deactivating "${confirmAction.sem} ${confirmAction.sy}" will stop this schedule from appearing on future dates. Past dates will still show it.`}
            </p>
            <div className="msd-modal-actions">
              <button
                className="msd-cancel-btn"
                onClick={() => setConfirmAction(null)}
              >
                Cancel
              </button>
              <button
                className={`msd-confirm-btn ${
                  confirmAction.activating ? "activate" : "deactivate"
                }`}
                onClick={confirmActivation}
              >
                {confirmAction.activating ? "Activate" : "Deactivate"}
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