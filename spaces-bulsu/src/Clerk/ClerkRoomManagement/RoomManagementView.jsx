import { useState, useEffect } from "react";
import {
  collection,
  onSnapshot,
  getDocs,
  doc,
  updateDoc,
  deleteDoc,
  addDoc,
  serverTimestamp,
  query,
  where,
  getDoc,
} from "firebase/firestore";
import { auth, db } from "../../firebase";
import { logActivity } from "../../utils/logActivity";
import { useNavigate } from "react-router-dom";
import RoomManagementModals from "./Modals/RoomManagementModals";
import { useDeactivationModals } from "./hooks/useDeactivationModals";
import "./room-management-view.css";
import Toast from "../../Popup/Toast/Toast";
import DeleteRoomPopup from "../../Popup/DeleteRoomPopup/DeleteRoomPopup";
import { isActiveOnDate } from "../../utils/scheduleActivePeriod";

function getActiveRoomStyle(room) {
  const iconVariant = room.type === "lecture" ? "peach" : "orange";
  return { ...room, status: "active", inactive: false, iconVariant };
}

function getInactiveRoomStyle(room) {
  return { ...room, status: "inactive", inactive: true, iconVariant: "muted" };
}

const getStatusInfo = (status) => {
  switch (status) {
    case "active":
      return { label: "ACTIVE", className: "room-status--active" };
    case "inactive":
      return { label: "INACTIVE", className: "room-status--inactive" };
    case "maintenance":
      return { label: "MAINTENANCE", className: "room-status--maintenance" };
    default:
      return { label: "UNKNOWN", className: "room-status--unknown" };
  }
};

const sortRoomsByName = (list) =>
  [...list].sort((a, b) =>
    (a.id || "").localeCompare(b.id || "", undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );

function ToggleSwitch({ checked, onClick }) {
  return (
    <button
      type="button"
      className={`room-toggle ${checked ? "is-on" : "is-off"}`}
      onClick={onClick}
      aria-pressed={checked}
      aria-label={checked ? "Deactivate room" : "Activate room"}
    >
      <span className="room-toggle-thumb" />
    </button>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────
const fmt12 = (t) => {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const p = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, "0")} ${p}`;
};

const normalizeName = (name) =>
  name
    ?.toLowerCase()
    .replace(/\./g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim();

const flipName = (name) => {
  if (!name) return "";
  const parts = name.split(",");
  if (parts.length !== 2) return normalizeName(name);
  return normalizeName(`${parts[1]} ${parts[0]}`);
};

function RoomManagementView({
  onOpenDetails,
  onAddRoom,
  onEditRoom,
  onViewAffectedSchedules,
}) {
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const modals = useDeactivationModals();
  const [currentPage, setCurrentPage] = useState(1);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const itemsPerPage = 10;
  const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

  const getToday = () => DAYS[new Date().getDay()];

  const toMinutes = (time) => {
    if (!time) return 0;
    const [h, m] = time.split(":").map(Number);
    return h * 60 + m;
  };

  const isRoomOccupiedNow = (schedules = []) => {
    const today = getToday();
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    return schedules.some((schedule) => {
      if (schedule.day !== today) return false;
      const start = toMinutes(schedule.startTime);
      const end = toMinutes(schedule.endTime);
      return currentMinutes >= start && currentMinutes < end;
    });
  };

  const [toast, setToast] = useState({
    show: false,
    type: "",
    title: "",
    message: "",
  });

  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    if (type !== "loading") {
      setTimeout(() => {
        setToast({ show: false, type: "", title: "", message: "" });
      }, 3000);
    }
  };

  const navigate = useNavigate();

  useEffect(() => {
    setLoading(true);

    const roomListeners = [];

    const checkExpiredMaintenance = async () => {
      const roomSnapshot = await getDocs(collection(db, "rooms"));
      const now = new Date();
      for (const roomDoc of roomSnapshot.docs) {
        const room = roomDoc.data();
        if (room.roomStatus !== "maintenance") continue;
        if (!room.maintenanceEndDate || !room.maintenanceEndTime) continue;
        const endDateTime = new Date(
          `${room.maintenanceEndDate}T${room.maintenanceEndTime}`
        );
        if (now >= endDateTime) {
          await updateDoc(doc(db, "rooms", roomDoc.id), {
            roomStatus: "active",
            maintenanceStartDate: null,
            maintenanceStartTime: null,
            maintenanceEndDate: null,
            maintenanceEndTime: null,
          });
        }
      }
    };

    checkExpiredMaintenance();

    const unsubscribeRooms = onSnapshot(
      collection(db, "rooms"),
      (snapshot) => {
        roomListeners.forEach((u) => u());
        roomListeners.length = 0;

        if (snapshot.empty) {
          setRooms([]);
          setLoading(false);
          return;
        }

        const roomCache = [];

        snapshot.docs.forEach((roomDoc) => {
          const roomData = roomDoc.data();

          const unsub = onSnapshot(
            collection(db, "rooms", roomDoc.id, "schedules"),
            (scheduleSnapshot) => {
              const schedules = scheduleSnapshot.docs.map((doc) => ({
                id: doc.id,
                ...doc.data(),
              }));

              const index = roomCache.findIndex(
                (r) => r.firestoreId === roomDoc.id
              );

              const occupied = isRoomOccupiedNow(schedules);

              const room = {
                firestoreId: roomDoc.id,
                id: roomData.roomName,
                floor: roomData.floor,
                capacity: roomData.capacity,
                type: roomData.roomType === "Computer Lab" ? "lab" : "lecture",
                typeLabel: roomData.roomType,
                equipment: [
                  roomData.equipment?.projector && "PROJECTOR",
                  roomData.equipment?.ac && "AC",
                  roomData.equipment?.computer && "COMPUTER",
                  roomData.equipment?.smartBoard && "SMART BOARD",
                  roomData.equipment?.tvDisplay && "TV DISPLAY",
                ].filter(Boolean),
                schedules,
                occupied,
                roomStatus: (roomData.roomStatus || "active").toLowerCase(),
                status: occupied ? "OCCUPIED" : "AVAILABLE",
              };

              if (index >= 0) roomCache[index] = room;
              else roomCache.push(room);

              setRooms([...roomCache]);
              setLoading(false);
            }
          );

          roomListeners.push(unsub);
        });
      }
    );

    return () => {
      unsubscribeRooms();
      roomListeners.forEach((u) => u());
    };
  }, []);

  // ══════════════════════════════════════════════════════════════
  // DEACTIVATION — Notify ALL affected schedules
  // ══════════════════════════════════════════════════════════════
  const handleDeactivationConfirm = async () => {
    const room = rooms.find((r) => r.id === modals.roomName);
    if (!room) return;

    showToast("loading", "Processing...", "Putting room under maintenance...");

    try {
      const firebaseUser = auth.currentUser;
      const userSnap = await getDoc(doc(db, "users", firebaseUser.uid));
      const currentUser = userSnap.data();
      const fullName = `${currentUser.firstName} ${currentUser.lastName}`.trim();

      const now = new Date();
      const startDate = now.toISOString().split("T")[0];
      const startTime = now.toTimeString().slice(0, 5);

      await updateDoc(doc(db, "rooms", room.firestoreId), {
        roomStatus: "maintenance",
        maintenanceStartDate: startDate,
        maintenanceStartTime: startTime,
        maintenanceEndDate: null,
        maintenanceEndTime: null,
      });

      await logActivity({
        userId: firebaseUser.uid,
        user: fullName,
        role: currentUser.role,
        action: "Marked Room Under Maintenance",
        actionType: "warning",
        target: room.id,
        details: "Changed room status to Under Maintenance",
        status: "SUCCESS",
      });

      // ─── Identify all affected schedules ─────────────────────
      const activeSchedules = (room.schedules || []).filter((s) => {
        if (s.initialized) return false;
        if (!isActiveOnDate(s, startDate)) return false;
        return true;
      });

      // Group by faculty
      const usersSnap = await getDocs(collection(db, "users"));
      const facultySchedulesMap = new Map();

      for (const schedule of activeSchedules) {
        if (!schedule.faculty) continue;
        const facultyDoc = usersSnap.docs.find((docUser) => {
          const user = docUser.data();
          const fullname = normalizeName(`${user.firstName} ${user.lastName}`);
          return fullname === flipName(schedule.faculty);
        });
        if (!facultyDoc) continue;

        if (!facultySchedulesMap.has(facultyDoc.id)) {
          facultySchedulesMap.set(facultyDoc.id, {
            userData: facultyDoc.data(),
            schedules: [],
          });
        }
        facultySchedulesMap.get(facultyDoc.id).schedules.push(schedule);
      }

      // Send ONE notification per faculty
      let notifiedFacultyCount = 0;
      let totalSchedulesNotified = 0;

      for (const [facultyId, { schedules }] of facultySchedulesMap) {
        const scheduleLines = schedules
          .map((s) => {
            const subject = s.subject || s.courseTitle || "Class";
            const section = s.section ? ` (${s.section})` : "";
            return `• ${subject}${section} — ${s.day || ""} ${fmt12(s.startTime)}–${fmt12(s.endTime)}`;
          })
          .join("\n");

        await addDoc(collection(db, "notifications"), {
          userId: facultyId,
          ownerType: "faculty",
          title: "Room Under Maintenance",
          message:
            `Room ${room.id} is now under maintenance. ` +
            `The following ${schedules.length === 1 ? "class" : "classes"} may be affected:\n` +
            `${scheduleLines}\n\n` +
            `Please coordinate with the Clerk for a possible room reassignment.`,
          type: "room-maintenance",
          roomId: room.firestoreId,
          roomName: room.id,
          maintenanceStartDate: startDate,
          maintenanceStartTime: startTime,
          schedulesAffected: schedules.map((s) => ({
            scheduleId: s.id,
            subject: s.subject || s.courseTitle || "",
            section: s.section || "",
            day: s.day || "",
            startTime: s.startTime || "",
            endTime: s.endTime || "",
            semester: s.semester || "",
            schoolYear: s.schoolYear || "",
          })),
          unread: true,
          archived: false,
          badge: "URGENT",
          createdAt: serverTimestamp(),
        });

        notifiedFacultyCount++;
        totalSchedulesNotified += schedules.length;
      }

      // Clerk summary
      await addDoc(collection(db, "notifications"), {
        userId: firebaseUser.uid,
        ownerType: "clerk",
        title: "Room Under Maintenance",
        message:
          `You placed Room ${room.id} under maintenance. ` +
          `${notifiedFacultyCount} faculty notified — ` +
          `${totalSchedulesNotified} schedule${totalSchedulesNotified === 1 ? "" : "s"} affected.`,
        type: "room-maintenance-status",
        roomId: room.firestoreId,
        roomName: room.id,
        maintenanceStartDate: startDate,
        maintenanceStartTime: startTime,
        notifiedFacultyCount,
        totalSchedulesNotified,
        unread: true,
        archived: false,
        badge: "INFO",
        createdAt: serverTimestamp(),
      });

      showToast(
        "success",
        "Maintenance Active",
        `Room ${room.id} is now under maintenance. ${notifiedFacultyCount} faculty notified (${totalSchedulesNotified} schedule${totalSchedulesNotified === 1 ? "" : "s"}).`
      );
    } catch (err) {
      console.error(err);
      showToast("error", "Action Failed", "Failed to put room under maintenance.");
    }

    modals.closeAll();
  };

  const handleSwitchClick = (room) => {
    if (room.roomStatus === "active") {
      modals.openDeactivateFlow(room.id);
    } else {
      modals.openActivateFlow(room.id);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    const room = rooms.find((r) => r.id === deleteTarget);
    if (!room) {
      showToast("error", "Not Found", "Room not found.");
      setDeleteTarget(null);
      return;
    }

    showToast("loading", "Deleting...", `Deleting room ${room.id}...`);

    try {
      const firebaseUser = auth.currentUser;
      if (!firebaseUser) {
        showToast("error", "Error", "You must be logged in to delete a room.");
        return;
      }

      const userSnap = await getDoc(doc(db, "users", firebaseUser.uid));
      const currentUser = userSnap.exists() ? userSnap.data() : {};

      const fullName =
        `${currentUser.firstName || ""} ${currentUser.lastName || ""}`.trim() ||
        firebaseUser.displayName ||
        "Unknown";

      await deleteDoc(doc(db, "rooms", room.firestoreId));

      await logActivity({
        userId: firebaseUser.uid,
        user: fullName,
        role: currentUser.role || "Clerk",
        action: "Deleted Room",
        actionType: "failed",
        target: deleteTarget,
        status: "SUCCESS",
      });

      showToast("success", "Deleted", `Room "${deleteTarget}" deleted successfully.`);
    } catch (error) {
      console.error("Delete failed:", error);
      showToast("error", "Delete Failed", `Delete failed: ${error.message}`);
    } finally {
      setDeleteTarget(null);
    }
  };

  // ══════════════════════════════════════════════════════════════
  // ACTIVATION — Notify ALL affected faculty that room is BACK
  // ══════════════════════════════════════════════════════════════
  const handleActivateConfirm = async () => {
    const room = rooms.find((r) => r.id === modals.roomName);
    if (!room) return;

    showToast("loading", "Activating...", `Activating room ${room.id}...`);

    try {
      const firebaseUser = auth.currentUser;
      const userSnap = await getDoc(doc(db, "users", firebaseUser.uid));
      const currentUser = userSnap.data();
      const fullName = `${currentUser.firstName} ${currentUser.lastName}`.trim();

      const now = new Date();
      const restoredDate = now.toISOString().split("T")[0];
      const restoredTime = now.toTimeString().slice(0, 5);

      // ─── 1. Set room back to active ──────────────────────────
      await updateDoc(doc(db, "rooms", room.firestoreId), {
        roomStatus: "active",
        maintenanceStartDate: null,
        maintenanceStartTime: null,
        maintenanceEndDate: null,
        maintenanceEndTime: null,
      });

      await logActivity({
        userId: firebaseUser.uid,
        user: fullName,
        role: currentUser.role,
        action: "Activated Room",
        actionType: "success",
        target: room.id,
        details: "Restored room from maintenance back to Active",
        status: "SUCCESS",
      });

      // ─── 2. Identify affected schedules (same logic as deactivation) ─
      const activeSchedules = (room.schedules || []).filter((s) => {
        if (s.initialized) return false;
        if (!isActiveOnDate(s, restoredDate)) return false;
        return true;
      });

      // ─── 3. Match schedules → faculty user accounts ──────────
      const usersSnap = await getDocs(collection(db, "users"));
      const facultySchedulesMap = new Map();

      for (const schedule of activeSchedules) {
        if (!schedule.faculty) continue;
        const facultyDoc = usersSnap.docs.find((docUser) => {
          const user = docUser.data();
          const fullname = normalizeName(`${user.firstName} ${user.lastName}`);
          return fullname === flipName(schedule.faculty);
        });
        if (!facultyDoc) continue;

        if (!facultySchedulesMap.has(facultyDoc.id)) {
          facultySchedulesMap.set(facultyDoc.id, {
            userData: facultyDoc.data(),
            schedules: [],
          });
        }
        facultySchedulesMap.get(facultyDoc.id).schedules.push(schedule);
      }

      // ─── 4. Send ONE notification per faculty (room restored) ─
      let notifiedFacultyCount = 0;
      let totalSchedulesNotified = 0;

      for (const [facultyId, { schedules }] of facultySchedulesMap) {
        const scheduleLines = schedules
          .map((s) => {
            const subject = s.subject || s.courseTitle || "Class";
            const section = s.section ? ` (${s.section})` : "";
            return `• ${subject}${section} — ${s.day || ""} ${fmt12(s.startTime)}–${fmt12(s.endTime)}`;
          })
          .join("\n");

        await addDoc(collection(db, "notifications"), {
          userId: facultyId,
          ownerType: "faculty",
          title: "Room Available Again",
          message:
            `Good news! Room ${room.id} is now active and available for use again. ` +
            `Your following ${schedules.length === 1 ? "class is" : "classes are"} back on track:\n` +
            `${scheduleLines}\n\n` +
            `You may resume your classes in this room as originally scheduled.`,
          type: "room-restored",
          roomId: room.firestoreId,
          roomName: room.id,
          restoredDate,
          restoredTime,
          schedulesAffected: schedules.map((s) => ({
            scheduleId: s.id,
            subject: s.subject || s.courseTitle || "",
            section: s.section || "",
            day: s.day || "",
            startTime: s.startTime || "",
            endTime: s.endTime || "",
            semester: s.semester || "",
            schoolYear: s.schoolYear || "",
          })),
          unread: true,
          archived: false,
          badge: "RESOLVED",
          createdAt: serverTimestamp(),
        });

        notifiedFacultyCount++;
        totalSchedulesNotified += schedules.length;
      }

      // ─── 5. Clerk summary ─────────────────────────────────────
      await addDoc(collection(db, "notifications"), {
        userId: firebaseUser.uid,
        ownerType: "clerk",
        title: "Room Activated",
        message:
          `You activated Room ${room.id}. ` +
          `${notifiedFacultyCount} faculty notified — ` +
          `${totalSchedulesNotified} schedule${totalSchedulesNotified === 1 ? "" : "s"} back on track.`,
        type: "room-restored-status",
        roomId: room.firestoreId,
        roomName: room.id,
        restoredDate,
        restoredTime,
        notifiedFacultyCount,
        totalSchedulesNotified,
        unread: true,
        archived: false,
        badge: "SUCCESS",
        createdAt: serverTimestamp(),
      });

      showToast(
        "success",
        "Activated",
        `Room ${room.id} is now active. ${notifiedFacultyCount} faculty notified (${totalSchedulesNotified} schedule${totalSchedulesNotified === 1 ? "" : "s"} restored).`
      );
    } catch (err) {
      console.error(err);
      showToast("error", "Activation Failed", "Failed to activate room.");
    }

    modals.closeAll();
  };

  const activeRooms = rooms.filter(
    (room) => room.roomStatus === "active"
  ).length;

  const inactiveRooms = rooms.filter(
    (room) => room.roomStatus === "inactive"
  ).length;

  const maintenanceRooms = rooms.filter(
    (room) => room.roomStatus === "maintenance"
  ).length;
  const availableRooms = rooms.filter(
    (room) => room.roomStatus === "active" && room.status === "AVAILABLE"
  ).length;

  if (loading) {
    return <div className="rooms-loading">Loading rooms...</div>;
  }

  const sortedRooms = sortRoomsByName(rooms);
  const totalRooms = sortedRooms.length;
  const totalPages = Math.ceil(totalRooms / itemsPerPage) || 1;
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedRooms = sortedRooms.slice(startIndex, endIndex);

  const renderPages = () => {
    const pages = [];
    const startPage = Math.max(1, currentPage - 1);
    const endPage = Math.min(totalPages, startPage + 2);
    for (let i = startPage; i <= endPage; i++) {
      pages.push(i);
    }
    return pages;
  };

  return (
    <>
      <RoomManagementModals
        roomName={modals.roomName}
        showWarningModal={modals.showWarningModal}
        showActivationModal={modals.showActivationModal}
        showDeleteModal={modals.showDeleteModal}
        closeWarningModal={modals.closeWarningModal}
        closeActivationModal={modals.closeActivationModal}
        closeDeleteModal={modals.closeDeleteModal}
        onConfirmDeactivation={handleDeactivationConfirm}
        onActivateConfirm={handleActivateConfirm}
        onDeleteConfirm={handleDeleteConfirm}
      />

      {deleteTarget && (
        <DeleteRoomPopup
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDeleteConfirm}
        />
      )}

      <main className="dashboard-main rooms-page">
        <div className="dashboard-header">
          <div className="dashboard-header-text">
            <h1>Room Management</h1>
            <p className="page-subtitle">
              an overview of university facilities, technical status, and
              occupancy.
            </p>
          </div>

          <div className="dashboard-actions">
            <button
              type="button"
              className="action-pill primary"
              onClick={() => navigate("/clerk/add-room")}
            >
              <i className="fa-solid fa-plus" aria-hidden="true" />
              Add Room
            </button>
          </div>
        </div>

        <div className="dashboard-status-grid">
          <article className="summary-card">
            <span className="summary-label">ACTIVE ROOMS</span>
            <strong className="summary-value summary-value--orange">
              {activeRooms}
            </strong>
          </article>
          <article className="summary-card">
            <span className="summary-label">AVAILABLE NOW</span>
            <strong className="summary-value summary-value--green">
              {availableRooms}
            </strong>
          </article>
          <article className="summary-card">
            <span className="summary-label">UNDER MAINTENANCE</span>
            <strong className="summary-value summary-value--grey">
              {maintenanceRooms}
            </strong>
          </article>
        </div>

        <div className="dashboard-table-card">
          <div className="table-scroll">
            <table className="rooms-table">
              <thead>
                <tr>
                  <th>ROOM NAME</th>
                  <th>CAPACITY</th>
                  <th>TYPE</th>
                  <th>EQUIPMENT</th>
                  <th>STATUS</th>
                  <th>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {paginatedRooms.map((room) => (
                  <tr
                    key={room.firestoreId}
                    className={`rooms-row ${
                      room.roomStatus === "inactive"
                        ? "is-inactive"
                        : room.roomStatus === "maintenance"
                        ? "is-maintenance"
                        : "clickable-row"
                    }`}
                    onClick={() => {
                      if (
                        room.roomStatus === "active" &&
                        typeof onOpenDetails === "function"
                      ) {
                        onOpenDetails(room.id);
                      }
                    }}
                  >
                    <td>
                      <div className="room-name-cell">
                        <span>
                          <div className="rm-room-name">{room.id}</div>
                          <span className="room-floor">{room.floor}</span>
                        </span>
                      </div>
                    </td>
                    <td>{room.capacity} Seats</td>
                    <td>
                      <span
                        className={`type-pill type-pill--${room.type} ${room.roomStatus !== "active" ? "type-pill--inactive" : ""}`}
                      >
                        {room.typeLabel}
                      </span>
                    </td>
                    <td>
                      <div className="equipment-tags">
                        {room.equipment.map((item) => (
                          <span
                            key={item}
                            className={`equipment-pill ${room.roomStatus !== "active" ? "equipment-pill--inactive" : ""}`}
                          >
                            {item}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      {(() => {
                        const normalized = (
                          room.roomStatus || "active"
                        ).toLowerCase();
                        let label, className;
                        switch (normalized) {
                          case "active":
                            label = "ACTIVE";
                            className = "room-status--active";
                            break;
                          case "inactive":
                            label = "INACTIVE";
                            className = "room-status--inactive";
                            break;
                          case "maintenance":
                            label = "MAINTENANCE";
                            className = "room-status--maintenance";
                            break;
                          default:
                            label = "UNKNOWN";
                            className = "room-status--unknown";
                        }
                        return (
                          <span className={`room-status ${className}`}>
                            <span className="room-status-dot" />
                            {label}
                          </span>
                        );
                      })()}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="action-icon-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(
                              `/clerk/edit-room/${room.firestoreId}`
                            );
                          }}
                          aria-label={`Edit ${room.id}`}
                        >
                          <i className="fa-solid fa-pen" aria-hidden="true" />
                        </button>
                        <ToggleSwitch
                          checked={room.roomStatus === "active"}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSwitchClick(room);
                          }}
                        />
                        <button
                          type="button"
                          className="action-icon-btn danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTarget(room.id);
                          }}
                        >
                          <i className="fa-solid fa-trash" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pagination-row">
            <span>
              Showing {totalRooms === 0 ? 0 : startIndex + 1} to{" "}
              {Math.min(endIndex, totalRooms)} of {totalRooms} rooms
            </span>

            <div className="pagination-buttons">
              <button
                type="button"
                className="pagination-nav"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              >
                <i className="fa-solid fa-chevron-left" />
              </button>

              {renderPages().map((page) => (
                <button
                  key={page}
                  type="button"
                  className={`pagination-page ${currentPage === page ? "is-active" : ""}`}
                  onClick={() => setCurrentPage(page)}
                >
                  {page}
                </button>
              ))}

              <button
                type="button"
                className="pagination-nav"
                disabled={currentPage === totalPages}
                onClick={() =>
                  setCurrentPage((p) => Math.min(totalPages, p + 1))
                }
              >
                <i className="fa-solid fa-chevron-right" />
              </button>
            </div>
          </div>
        </div>
      </main>

      <Toast
        show={toast.show}
        type={toast.type}
        title={toast.title}
        message={toast.message}
        onClose={() => setToast({ show: false, type: "", title: "", message: "" })}
      />
    </>
  );
}

export default RoomManagementView;