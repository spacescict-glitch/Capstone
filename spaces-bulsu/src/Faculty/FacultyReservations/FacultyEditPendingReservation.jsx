import "./faculty-edit-pending-reservation.css";
import { useNavigate, useLocation } from "react-router-dom";
import { useState, useEffect, useMemo, useRef } from "react";
import {
  doc,
  updateDoc,
  collection,
  getDocs,
  query,
  where,
  addDoc,
  serverTimestamp,
  getDoc,
  onSnapshot,
} from "firebase/firestore";
import { db, auth } from "../../firebase";
import { logActivity } from "../../utils/logActivity";
import { isRoomUnderMaintenance } from "../../utils/Roommaintenance";
import SavePopup from "../../Popup/SavePopup/SavePopup";
import Toast from "../../Popup/Toast/Toast";

// ─── Helpers ──────────────────────────────────────────────────────────
const convertToMinutes = (time) => {
  if (!time) return 0;
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

const normalize = (value) => value?.toString().trim().toLowerCase();

const getDayAbbrev = (dateStr) => {
  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  return days[new Date(dateStr).getDay()];
};

const overlap = (aStart, aEnd, bStart, bEnd) => {
  return (
    convertToMinutes(aStart) < convertToMinutes(bEnd) &&
    convertToMinutes(aEnd) > convertToMinutes(bStart)
  );
};

// ─── Date helpers ─────────────────────────────────────────────────────
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const toDateInputValue = (date) => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const addDaysLocal = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toDateInputValue(d);
};

const formatDateLong = (dateStr) => {
  if (!dateStr) return "-";
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });
};

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

// ─── Send notification ──────────────────────────────────────────────
const sendNotification = async (
  userId,
  ownerType,
  title,
  message,
  type,
  badge = "INFO",
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

function FacultyEditPendingReservation() {
  const navigate = useNavigate();
  const location = useLocation();
  const reservationFromNav = location.state?.reservation;
  const reservationId = reservationFromNav?.id;

  // ─── Toast ────────────────────────────────────────────────────────
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

  // ─── Realtime reservation ─────────────────────────────────────────
  const [reservation, setReservation] = useState(reservationFromNav || null);
  const [liveStatus, setLiveStatus] = useState(reservationFromNav?.status || "Pending");
  const [loadingLive, setLoadingLive] = useState(true);

  // ─── Editable fields ──────────────────────────────────────────────
  const [editableFields, setEditableFields] = useState({
    roomName: "",
    date: "",
    startTime: "",
    endTime: "",
    purpose: "",
    studentRange: "",
    requiredEquipment: [],
  });

  const [allRooms, setAllRooms] = useState([]);
  const [availableRooms, setAvailableRooms] = useState([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [loadingAvailable, setLoadingAvailable] = useState(false);
  const [conflictError, setConflictError] = useState("");

  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saving, setSaving] = useState(false);

  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // ─── Custom pickers state ────────────────────────────────────────
  const [showRoomPicker, setShowRoomPicker] = useState(false);
  const [roomSearch, setRoomSearch] = useState("");
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [calendarCursor, setCalendarCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  // ─── Read-only fields ─────────────────────────────────────────────
  const facultyName =
    reservation?.facultyName || reservation?.requesterName || "";
  const audienceType = reservation?.audienceType || "";
  const courseTitle = reservation?.courseTitle || "";
  const course = reservation?.attendees?.course || "";
  const yearSectionGroup = reservation?.attendees?.yearSectionGroup || "";
  const organization = reservation?.attendees?.organization || "";

  // ─── Selected room object for picker trigger ─────────────────────
  const selectedRoom = useMemo(
    () => availableRooms.find((r) => r.roomName === editableFields.roomName) || null,
    [availableRooms, editableFields.roomName]
  );

  // ─── Filtered room list (for search inside picker) ───────────────
  const filteredAvailableRooms = useMemo(() => {
    const q = roomSearch.trim().toLowerCase();
    if (!q) return availableRooms;
    return availableRooms.filter((r) => {
      const name = (r.roomName || "").toLowerCase();
      const floor = String(r.floor || "").toLowerCase();
      const building = String(r.building || r.bldg || "").toLowerCase();
      return name.includes(q) || floor.includes(q) || building.includes(q);
    });
  }, [availableRooms, roomSearch]);

  // ══════════════════════════════════════════════════════════════════
  // REALTIME LISTENER — watch the reservation document
  // ══════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!reservationId) {
      navigate("/faculty/reservations");
      return;
    }

    setLoadingLive(true);

    const unsub = onSnapshot(
      doc(db, "reservationRequests", reservationId),
      (snap) => {
        if (!snap.exists()) {
          showToast("error", "Not Found", "This reservation no longer exists.");
          setTimeout(() => navigate("/faculty/reservations"), 1500);
          return;
        }

        const data = { id: snap.id, ...snap.data() };
        setReservation(data);
        setLiveStatus(data.status || "Pending");

        // If the status changed from Pending (approved/denied/cancelled by clerk/admin),
        // show a toast and prevent further editing
        const normalized = normalize(data.status);
        if (normalized !== "pending") {
          if (normalized === "approved") {
            showToast(
              "success",
              "Reservation Approved",
              "Your reservation has been approved. Redirecting...",
            );
          } else if (normalized === "rejected" || normalized === "denied") {
            showToast(
              "error",
              "Reservation Denied",
              "Your reservation was denied. Redirecting...",
            );
          } else if (normalized === "cancelled") {
            showToast(
              "error",
              "Reservation Cancelled",
              "This reservation has been cancelled. Redirecting...",
            );
          }
          setTimeout(() => navigate("/faculty/reservations"), 2200);
        }

        setLoadingLive(false);
      },
      (err) => {
        console.error("Realtime listener:", err);
        setLoadingLive(false);
      },
    );

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservationId]);

  // ─── Initial load of editable fields (only once) ──────────────────
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!reservation || initializedRef.current) return;
    if (normalize(reservation.status) !== "pending") return;

    setEditableFields({
      roomName: reservation.roomName || "",
      date: reservation.date || "",
      startTime: reservation.startTime || "",
      endTime: reservation.endTime || "",
      purpose: reservation.purpose || "",
      studentRange: reservation.studentRange || "",
      requiredEquipment: reservation.requiredEquipment || [],
    });

    initializedRef.current = true;
    loadAllRooms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservation]);

  // ─── Load all rooms ────────────────────────────────────────────────
  const loadAllRooms = async () => {
    setLoadingRooms(true);
    try {
      const snap = await getDocs(collection(db, "rooms"));
      const data = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setAllRooms(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingRooms(false);
    }
  };

  // ─── Fetch available rooms based on date, time, purpose ───────────
  const fetchAvailableRooms = async (
    roomsList = allRooms,
    date,
    startTime,
    endTime,
  ) => {
    if (!date || !startTime || !endTime || roomsList.length === 0) {
      setAvailableRooms([]);
      return;
    }

    setLoadingAvailable(true);
    try {
      const dayAbbrev = getDayAbbrev(date);
      const purpose = editableFields.purpose;
      const studentRange = editableFields.studentRange;
      const requiredEquipment = editableFields.requiredEquipment;

      const [releaseSnap, reassignSnap, eventSnap, reservationSnap] =
        await Promise.all([
          getDocs(collection(db, "roomReleases")),
          getDocs(collection(db, "roomReassignments")),
          getDocs(query(collection(db, "events"), where("date", "==", date))),
          getDocs(
            query(
              collection(db, "reservationRequests"),
              where("date", "==", date),
              where("status", "==", "approved"),
            ),
          ),
        ]);

      const releases = releaseSnap.docs.map((d) => d.data());
      const reassignments = reassignSnap.docs
        .map((d) => d.data())
        .filter((r) => normalize(r.status) === "approved");
      const events = eventSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const reservations = reservationSnap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((r) => r.id !== reservationId);

      const releaseKeys = new Set(
        releases
          .filter((r) => r.date === date)
          .map((r) => `${r.scheduleId}_${r.date}`),
      );

      const reassignAwayKeys = new Set(
        reassignments
          .filter((r) => r.date === date && r.oldRoomId)
          .map((r) => `${r.scheduleId}_${r.date}`),
      );

      const reassignIntoMap = {};
      reassignments
        .filter((r) => r.date === date && r.newRoomId)
        .forEach((r) => {
          if (!reassignIntoMap[r.newRoomId]) reassignIntoMap[r.newRoomId] = [];
          reassignIntoMap[r.newRoomId].push(r);
        });

      const available = [];

      for (const room of roomsList) {
        if (isRoomUnderMaintenance(room, date, startTime, endTime)) continue;

        const scheduleSnap = await getDocs(
          collection(db, "rooms", room.id, "schedules"),
        );
        const schedules = scheduleSnap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((s) => !s.initialized && s.day === dayAbbrev);

        const hasScheduleConflict = schedules.some((sched) => {
          const key = `${sched.id}_${date}`;
          if (releaseKeys.has(key)) return false;
          if (reassignAwayKeys.has(key)) return false;
          return overlap(startTime, endTime, sched.startTime, sched.endTime);
        });
        if (hasScheduleConflict) continue;

        const hasEventConflict = events.some(
          (e) =>
            e.roomId === room.id &&
            overlap(startTime, endTime, e.startTime, e.endTime),
        );
        if (hasEventConflict) continue;

        const hasReservationConflict = reservations.some(
          (r) =>
            r.roomId === room.id &&
            overlap(startTime, endTime, r.startTime, r.endTime),
        );
        if (hasReservationConflict) continue;

        const reassignInto = reassignIntoMap[room.id] || [];
        const hasReassignConflict = reassignInto.some((r) =>
          overlap(startTime, endTime, r.startTime, r.endTime),
        );
        if (hasReassignConflict) continue;

        if (purpose === "Hands-on" && requiredEquipment.length > 0) {
          const roomEquipment = Object.entries(room.equipment || {})
            .filter(([key, value]) => value === true)
            .map(([key]) => key.toLowerCase());

          const hasAllEquipment = requiredEquipment.every((eq) =>
            roomEquipment.includes(eq.toLowerCase()),
          );
          if (!hasAllEquipment) continue;
        }

        if (
          (purpose === "Lecture" || purpose === "Examination") &&
          studentRange
        ) {
          const minCapacity =
            {
              "30-50": 30,
              "50-60": 50,
              "60-80": 60,
              "80-100": 80,
            }[studentRange] || 0;
          if (Number(room.capacity || 0) < minCapacity) continue;
        }

        available.push(room);
      }

      setAvailableRooms(available);

      // If the currently selected room is not available anymore, clear it
      setEditableFields((prev) => {
        if (
          prev.roomName &&
          !available.some((r) => r.roomName === prev.roomName)
        ) {
          setConflictError(
            "The previously selected room is no longer available for the chosen date/time.",
          );
          return { ...prev, roomName: "" };
        }
        return prev;
      });
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingAvailable(false);
    }
  };

  // ─── Re-fetch available rooms when date/time/purpose changes ──────
  useEffect(() => {
    if (
      allRooms.length > 0 &&
      editableFields.date &&
      editableFields.startTime &&
      editableFields.endTime
    ) {
      fetchAvailableRooms(
        allRooms,
        editableFields.date,
        editableFields.startTime,
        editableFields.endTime,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    allRooms,
    editableFields.date,
    editableFields.startTime,
    editableFields.endTime,
    editableFields.purpose,
    editableFields.studentRange,
    editableFields.requiredEquipment,
  ]);

  // ─── Handle field changes ─────────────────────────────────────────
  const handleChange = (field) => (e) => {
    const value = e.target.value;
    setEditableFields((prev) => ({ ...prev, [field]: value }));
    setConflictError("");
  };

  const handleEquipmentChange = (e) => {
    const value = e.target.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    setEditableFields((prev) => ({ ...prev, requiredEquipment: value }));
    setConflictError("");
  };

  // ─── Check conflicts ──────────────────────────────────────────────
  const checkConflicts = async () => {
    const { roomName, date, startTime, endTime } = editableFields;
    if (!roomName || !date || !startTime || !endTime)
      return "Please select a room, date, and time.";

    const room = allRooms.find((r) => r.roomName === roomName);
    if (!room) return "Selected room not found.";

    if (isRoomUnderMaintenance(room, date, startTime, endTime)) {
      return "This room is under maintenance during the selected time.";
    }

    if (!availableRooms.some((r) => r.roomName === roomName)) {
      return "This room is not available for the selected date/time and purpose.";
    }

    return null;
  };

  // ══════════════════════════════════════════════════════════════════
  // SAVE — Update the reservation
  // ══════════════════════════════════════════════════════════════════
  const handleSave = async () => {
    setSaving(true);
    showToast("loading", "Saving", "Updating reservation...");

    try {
      const conflict = await checkConflicts();
      if (conflict) {
        setConflictError(conflict);
        showToast("error", "Conflict Detected", conflict);
        setSaving(false);
        return;
      }

      const firebaseUser = auth.currentUser;
      let currentUser = {};
      let facultyNameFull = "Faculty";
      if (firebaseUser) {
        const userSnap = await getDoc(doc(db, "users", firebaseUser.uid));
        if (userSnap.exists()) {
          currentUser = userSnap.data();
          facultyNameFull =
            `${currentUser.firstName || ""} ${currentUser.lastName || ""}`.trim() ||
            "Faculty";
        }
      }

      const room = allRooms.find((r) => r.roomName === editableFields.roomName);
      const roomId = room ? room.id : null;

      await updateDoc(doc(db, "reservationRequests", reservationId), {
        roomName: editableFields.roomName,
        roomId: roomId || reservation.roomId,
        date: editableFields.date,
        startTime: editableFields.startTime,
        endTime: editableFields.endTime,
        purpose: editableFields.purpose,
        studentRange: editableFields.studentRange,
        requiredEquipment: editableFields.requiredEquipment,
        updatedAt: serverTimestamp(),
      });

      await logActivity({
        userId: firebaseUser?.uid || "",
        user: facultyNameFull,
        role: "Faculty",
        action: "Updated Pending Reservation",
        actionType: "edit",
        target: `${editableFields.roomName} - ${courseTitle}`,
        status: "SUCCESS",
        details: {
          reservationId,
          previous: {
            room: reservation.roomName,
            date: reservation.date,
            startTime: reservation.startTime,
            endTime: reservation.endTime,
            purpose: reservation.purpose,
          },
          updated: {
            room: editableFields.roomName,
            date: editableFields.date,
            startTime: editableFields.startTime,
            endTime: editableFields.endTime,
            purpose: editableFields.purpose,
          },
        },
      });

      // Notify self
      if (firebaseUser?.uid) {
        await sendNotification(
          firebaseUser.uid,
          "faculty",
          "Reservation Updated",
          `Your reservation for ${editableFields.roomName} on ${editableFields.date} (${editableFields.startTime} - ${editableFields.endTime}) has been updated.`,
          "reservation-updated",
          "INFO",
        );
      }

      // Notify clerks & admins
      const usersSnap = await getDocs(collection(db, "users"));
      const adminNotifications = [];
      usersSnap.forEach((doc) => {
        const role = normalize(doc.data().role);
        if (role === "clerk" || role === "admin") {
          adminNotifications.push(
            sendNotification(
              doc.id,
              role === "clerk" ? "clerk" : "admin",
              "Reservation Updated",
              `${facultyNameFull} updated their reservation for ${editableFields.roomName}.`,
              "reservation-updated",
              "INFO",
            ),
          );
        }
      });
      await Promise.all(adminNotifications);

      setShowSaveModal(false);
      showToast("success", "Success", "Reservation updated successfully!");

      setTimeout(() => navigate("/faculty/reservations"), 1500);
    } catch (err) {
      console.error(err);
      showToast("error", "Error", err.message || "Failed to update reservation.");
    } finally {
      setSaving(false);
    }
  };

  // ══════════════════════════════════════════════════════════════════
  // CANCEL — Cancel the reservation
  // ══════════════════════════════════════════════════════════════════
  const handleCancelReservation = async () => {
    setCancelling(true);
    showToast("loading", "Cancelling", "Cancelling reservation...");

    try {
      const firebaseUser = auth.currentUser;
      let currentUser = {};
      let facultyNameFull = "Faculty";
      if (firebaseUser) {
        const userSnap = await getDoc(doc(db, "users", firebaseUser.uid));
        if (userSnap.exists()) {
          currentUser = userSnap.data();
          facultyNameFull =
            `${currentUser.firstName || ""} ${currentUser.lastName || ""}`.trim() ||
            "Faculty";
        }
      }

      await updateDoc(doc(db, "reservationRequests", reservationId), {
        status: "cancelled",
        cancelledAt: serverTimestamp(),
        cancelledBy: firebaseUser?.uid || "",
        cancelledByName: facultyNameFull,
        updatedAt: serverTimestamp(),
      });

      await logActivity({
        userId: firebaseUser?.uid || "",
        user: facultyNameFull,
        role: "Faculty",
        action: "Cancelled Pending Reservation",
        actionType: "cancel",
        target: `${reservation.roomName} - ${courseTitle}`,
        status: "SUCCESS",
        details: {
          reservationId,
          reservationData: {
            room: reservation.roomName,
            date: reservation.date,
            startTime: reservation.startTime,
            endTime: reservation.endTime,
            purpose: reservation.purpose,
          },
        },
      });

      if (firebaseUser?.uid) {
        await sendNotification(
          firebaseUser.uid,
          "faculty",
          "Reservation Cancelled",
          `You cancelled your reservation for ${reservation.roomName} on ${reservation.date}.`,
          "reservation-cancelled",
          "WARNING",
        );
      }

      const usersSnap = await getDocs(collection(db, "users"));
      const adminNotifications = [];
      usersSnap.forEach((doc) => {
        const role = normalize(doc.data().role);
        if (role === "clerk" || role === "admin") {
          adminNotifications.push(
            sendNotification(
              doc.id,
              role === "clerk" ? "clerk" : "admin",
              "Reservation Cancelled",
              `${facultyNameFull} cancelled their reservation for ${reservation.roomName} on ${reservation.date}.`,
              "reservation-cancelled",
              "WARNING",
            ),
          );
        }
      });
      await Promise.all(adminNotifications);

      setShowCancelModal(false);
      showToast("success", "Cancelled", "Reservation cancelled successfully!");

      setTimeout(() => navigate("/faculty/reservations"), 1500);
    } catch (err) {
      console.error(err);
      showToast("error", "Error", err.message || "Failed to cancel reservation.");
    } finally {
      setCancelling(false);
    }
  };

  // ─── Guard: no reservation ────────────────────────────────────────
  if (!reservation) {
    return (
      <div className="faculty-edit-pending-room">
        <div className="fepr-loading-full">
          <i className="fa-solid fa-circle-notch fa-spin"></i>
          <p>Loading reservation...</p>
        </div>
      </div>
    );
  }

  // ─── Guard: not pending anymore ───────────────────────────────────
  const isPending = normalize(liveStatus) === "pending";

  // ─── Render ────────────────────────────────────────────────────────
  return (
    <div className="faculty-edit-pending-room">
      <i
        className="fa-solid fa-arrow-left faculty-edit-pending-back-arrow"
        onClick={() => navigate(-1)}
        style={{ cursor: "pointer", fontSize: "20px", marginBottom: "12px" }}
      ></i>

      <div className="white-box-edit-pending">
        <div className="fepr-header">
          <div>
            <h2 className="faculty-edit-pending-title">
              Edit Pending Reservation
            </h2>
            <p className="fepr-subtitle">
              Update the room, schedule, or details of your pending reservation.
            </p>
          </div>
        </div>

        {loadingLive && (
          <div className="fepr-loading-inline">
            <i className="fa-solid fa-circle-notch fa-spin"></i>
            Syncing with server...
          </div>
        )}

        {!isPending && (
          <div className="faculty-edit-conflict-banner">
            <i className="fa-solid fa-circle-exclamation"></i>
            <span>
              This reservation is no longer pending (status:{" "}
              <b>{liveStatus}</b>). Editing is disabled.
            </span>
          </div>
        )}

        {conflictError && (
          <div className="faculty-edit-conflict-banner">
            <i className="fa-solid fa-triangle-exclamation"></i>
            <span>{conflictError}</span>
          </div>
        )}

        <div className="faculty-edit-pending-info-grid">
          {/* ─── Read-only: Requester ────────────────────────────── */}
          <div className="faculty-edit-pending-info-box">
            <h3 className="faculty-edit-pending-info-box-title">
              <i className="fa-solid fa-user"></i> Requester
            </h3>
            <div className="faculty-edit-pending-info-box-content">
              <p>
                <strong>Name:</strong> {facultyName || "Unknown"}
              </p>
              {audienceType === "Organization" && (
                <p>
                  <strong>Organization:</strong> {organization || "N/A"}
                </p>
              )}
            </div>
          </div>

          {/* ─── Read-only: Course & Audience ────────────────────── */}
          <div className="faculty-edit-pending-info-box">
            <h3 className="faculty-edit-pending-info-box-title">
              <i className="fa-solid fa-book"></i> Course & Audience
            </h3>
            <div className="faculty-edit-pending-info-box-content">
              <p>
                <strong>Course Title:</strong> {courseTitle || "N/A"}
              </p>
              <p>
                <strong>Audience Type:</strong> {audienceType || "N/A"}
              </p>
              {audienceType === "Class" && (
                <>
                  <p>
                    <strong>Course:</strong> {course || "N/A"}
                  </p>
                  <p>
                    <strong>Year/Section:</strong> {yearSectionGroup || "N/A"}
                  </p>
                </>
              )}
            </div>
          </div>

          {/* ─── Editable: Room & Schedule ───────────────────────── */}
          <div className="faculty-edit-pending-info-box editable">
            <h3 className="faculty-edit-pending-info-box-title">
              <i className="fa-solid fa-calendar-days"></i> Room & Schedule
            </h3>
            <div className="faculty-edit-pending-info-box-content">
              {/* Custom Room Picker */}
              <div className="faculty-edit-pending-form-group">
                <label>Room</label>

                <div className="fepr-roompicker">
                  <button
                    type="button"
                    className={`fepr-room-trigger ${
                      showRoomPicker ? "open" : ""
                    }`}
                    onClick={() => {
                      if (
                        loadingRooms ||
                        loadingAvailable ||
                        saving ||
                        cancelling ||
                        !isPending
                      )
                        return;
                      setRoomSearch("");
                      setShowRoomPicker((v) => !v);
                    }}
                    disabled={
                      loadingRooms ||
                      loadingAvailable ||
                      saving ||
                      cancelling ||
                      !isPending
                    }
                  >
                    <i className="fa-solid fa-door-open"></i>
                    <span className="fepr-room-trigger-text">
                      {loadingAvailable
                        ? "Checking availability..."
                        : selectedRoom
                        ? selectedRoom.roomName
                        : editableFields.roomName || "Select a room"}
                    </span>
                    {selectedRoom?.floor && (
                      <span className="fepr-room-trigger-floor">
                        {selectedRoom.floor}
                      </span>
                    )}
                    <i
                      className={`fa-solid fa-chevron-down fepr-room-caret ${
                        showRoomPicker ? "open" : ""
                      }`}
                    ></i>
                  </button>

                  {showRoomPicker && (
                    <>
                      <div
                        className="fepr-picker-clickaway"
                        onClick={() => setShowRoomPicker(false)}
                      ></div>
                      <div className="fepr-room-popover">
                        <span className="fepr-popover-arrow"></span>

                        <div className="fepr-search-wrap">
                          <i className="fa-solid fa-magnifying-glass"></i>
                          <input
                            type="text"
                            className="fepr-search"
                            placeholder="Search room, floor, building..."
                            value={roomSearch}
                            onChange={(e) => setRoomSearch(e.target.value)}
                            autoFocus
                          />
                          {roomSearch && (
                            <button
                              type="button"
                              className="fepr-search-clear"
                              onClick={() => setRoomSearch("")}
                            >
                              <i className="fa-solid fa-xmark"></i>
                            </button>
                          )}
                        </div>

                        <div className="fepr-room-list">
                          {filteredAvailableRooms.length === 0 ? (
                            <div className="fepr-picker-empty">
                              <i className="fa-regular fa-face-frown"></i>
                              <span>
                                {availableRooms.length === 0
                                  ? "No rooms available for this slot."
                                  : "No rooms match your search."}
                              </span>
                            </div>
                          ) : (
                            filteredAvailableRooms.map((r) => {
                              const isActive =
                                r.roomName === editableFields.roomName;
                              return (
                                <button
                                  type="button"
                                  key={r.id}
                                  className={`fepr-room-option ${
                                    isActive ? "is-active" : ""
                                  }`}
                                  onClick={() => {
                                    setEditableFields((prev) => ({
                                      ...prev,
                                      roomName: r.roomName,
                                    }));
                                    setShowRoomPicker(false);
                                    setRoomSearch("");
                                    setConflictError("");
                                  }}
                                >
                                  <div className="fepr-room-option-icon">
                                    <i className="fa-solid fa-door-open"></i>
                                  </div>
                                  <div className="fepr-room-option-body">
                                    <span className="fepr-room-option-name">
                                      {r.roomName}
                                    </span>
                                    <span className="fepr-room-option-meta">
                                      {r.floor && (
                                        <>
                                          <i className="fa-solid fa-building"></i>
                                          {r.floor}
                                        </>
                                      )}
                                      {r.capacity && (
                                        <>
                                          <span className="fepr-room-dot">•</span>
                                          <i className="fa-solid fa-users"></i>
                                          {r.capacity} Seats
                                        </>
                                      )}
                                    </span>
                                  </div>
                                  {isActive && (
                                    <i className="fa-solid fa-circle-check fepr-room-option-check"></i>
                                  )}
                                </button>
                              );
                            })
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {loadingAvailable && (
                  <small className="fepr-helper">
                    <i className="fa-solid fa-spinner fa-spin"></i> Checking
                    availability...
                  </small>
                )}
                {availableRooms.length === 0 &&
                  !loadingAvailable &&
                  editableFields.date &&
                  editableFields.startTime &&
                  editableFields.endTime && (
                    <small className="fepr-helper fepr-helper--error">
                      No rooms available for the selected date, time, and
                      purpose.
                    </small>
                  )}
              </div>

              {/* Custom Date Picker */}
              <div className="faculty-edit-pending-form-group">
                <label>Date</label>

                <div className="fepr-datepicker">
                  <button
                    type="button"
                    className={`fepr-date-trigger ${
                      showDatePicker ? "open" : ""
                    }`}
                    onClick={() => {
                      if (saving || cancelling || !isPending) return;
                      const base = editableFields.date
                        ? new Date(`${editableFields.date}T00:00:00`)
                        : new Date();
                      setCalendarCursor({
                        year: base.getFullYear(),
                        month: base.getMonth(),
                      });
                      setShowDatePicker((v) => !v);
                    }}
                    disabled={saving || cancelling || !isPending}
                  >
                    <i className="fa-regular fa-calendar"></i>
                    <span>
                      {editableFields.date
                        ? formatDateLong(editableFields.date)
                        : "Select a date"}
                    </span>
                    <i
                      className={`fa-solid fa-chevron-down fepr-date-caret ${
                        showDatePicker ? "open" : ""
                      }`}
                    ></i>
                  </button>

                  {showDatePicker && (
                    <>
                      <div
                        className="fepr-picker-clickaway"
                        onClick={() => setShowDatePicker(false)}
                      ></div>
                      <div className="fepr-date-popover">
                        <span className="fepr-popover-arrow"></span>

                        <div className="fepr-date-quick-row">
                          <button
                            type="button"
                            className={
                              editableFields.date ===
                              toDateInputValue(new Date())
                                ? "active"
                                : ""
                            }
                            onClick={() => {
                              setEditableFields((prev) => ({
                                ...prev,
                                date: toDateInputValue(new Date()),
                              }));
                              setShowDatePicker(false);
                              setConflictError("");
                            }}
                          >
                            Today
                          </button>
                          <button
                            type="button"
                            className={
                              editableFields.date ===
                              addDaysLocal(toDateInputValue(new Date()), 1)
                                ? "active"
                                : ""
                            }
                            onClick={() => {
                              setEditableFields((prev) => ({
                                ...prev,
                                date: addDaysLocal(
                                  toDateInputValue(new Date()),
                                  1,
                                ),
                              }));
                              setShowDatePicker(false);
                              setConflictError("");
                            }}
                          >
                            Tomorrow
                          </button>
                        </div>

                        <div className="fepr-cal-header">
                          <button
                            type="button"
                            className="fepr-cal-nav"
                            onClick={() =>
                              setCalendarCursor((c) => {
                                const m = c.month - 1;
                                return m < 0
                                  ? { year: c.year - 1, month: 11 }
                                  : { year: c.year, month: m };
                              })
                            }
                          >
                            <i className="fa-solid fa-chevron-left"></i>
                          </button>
                          <span className="fepr-cal-title">
                            {MONTH_NAMES[calendarCursor.month]}{" "}
                            {calendarCursor.year}
                          </span>
                          <button
                            type="button"
                            className="fepr-cal-nav"
                            onClick={() =>
                              setCalendarCursor((c) => {
                                const m = c.month + 1;
                                return m > 11
                                  ? { year: c.year + 1, month: 0 }
                                  : { year: c.year, month: m };
                              })
                            }
                          >
                            <i className="fa-solid fa-chevron-right"></i>
                          </button>
                        </div>

                        <div className="fepr-cal-weekdays">
                          {WEEKDAY_LABELS.map((w) => (
                            <span key={w}>{w}</span>
                          ))}
                        </div>

                        <div className="fepr-cal-grid">
                          {buildCalendarGrid(
                            calendarCursor.year,
                            calendarCursor.month,
                          ).map((cell, i) => {
                            const cellStr = toDateInputValue(cell.date);
                            const isPast =
                              cellStr < toDateInputValue(new Date());
                            const isSelected =
                              cellStr === editableFields.date;
                            return (
                              <button
                                type="button"
                                key={i}
                                className={[
                                  "fepr-cal-day",
                                  !cell.inMonth && "is-outside",
                                  isSelected && "is-selected",
                                  isPast && "is-disabled",
                                ]
                                  .filter(Boolean)
                                  .join(" ")}
                                disabled={isPast}
                                onClick={() => {
                                  setEditableFields((prev) => ({
                                    ...prev,
                                    date: cellStr,
                                  }));
                                  setShowDatePicker(false);
                                  setConflictError("");
                                }}
                              >
                                {cell.day}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="faculty-edit-pending-time-row">
                <div className="faculty-edit-pending-form-group half">
                  <label>Start Time</label>
                  <input
                    type="time"
                    className="faculty-edit-pending-form-input"
                    value={editableFields.startTime}
                    onChange={handleChange("startTime")}
                    disabled={saving || cancelling || !isPending}
                  />
                </div>
                <div className="faculty-edit-pending-form-group half">
                  <label>End Time</label>
                  <input
                    type="time"
                    className="faculty-edit-pending-form-input"
                    value={editableFields.endTime}
                    onChange={handleChange("endTime")}
                    disabled={saving || cancelling || !isPending}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* ─── Editable: Purpose & Details ─────────────────────── */}
          <div className="faculty-edit-pending-info-box editable">
            <h3 className="faculty-edit-pending-info-box-title">
              <i className="fa-solid fa-pen"></i> Purpose & Details
            </h3>
            <div className="faculty-edit-pending-info-box-content">
              <div className="faculty-edit-pending-form-group">
                <label>Purpose</label>
                <select
                  className="faculty-edit-pending-form-input"
                  value={editableFields.purpose}
                  onChange={handleChange("purpose")}
                  disabled={saving || cancelling || !isPending}
                >
                  <option value="">Select Purpose</option>
                  <option value="Lecture">Lecture</option>
                  <option value="Hands-on">Hands-on</option>
                  <option value="Examination">Examination</option>
                </select>
              </div>

              {editableFields.purpose === "Hands-on" && (
                <div className="faculty-edit-pending-form-group">
                  <label>Required Equipment (comma separated)</label>
                  <input
                    type="text"
                    className="faculty-edit-pending-form-input"
                    placeholder="e.g. Projector, Computer"
                    value={editableFields.requiredEquipment.join(", ")}
                    onChange={handleEquipmentChange}
                    disabled={saving || cancelling || !isPending}
                  />
                </div>
              )}

              {(editableFields.purpose === "Lecture" ||
                editableFields.purpose === "Examination") && (
                <div className="faculty-edit-pending-form-group">
                  <label>Estimated Number of Students</label>
                  <select
                    className="faculty-edit-pending-form-input"
                    value={editableFields.studentRange}
                    onChange={handleChange("studentRange")}
                    disabled={saving || cancelling || !isPending}
                  >
                    <option value="">Select Range</option>
                    <option value="30-50">30 - 50</option>
                    <option value="50-60">50 - 60</option>
                    <option value="60-80">60 - 80</option>
                    <option value="80-100">80 - 100</option>
                  </select>
                </div>
              )}
            </div>
          </div>

          {/* ─── Metadata ────────────────────────────────────────── */}
          <div className="faculty-edit-pending-info-box">
            <h3 className="faculty-edit-pending-info-box-title">
              <i className="fa-solid fa-circle-info"></i> Metadata
            </h3>
            <div className="faculty-edit-pending-info-box-content">
              <p>
                <strong>Status:</strong>{" "}
                <span
                  className={`faculty-edit-pending-status-badge ${normalize(
                    liveStatus,
                  )}`}
                >
                  {liveStatus}
                </span>
              </p>
              <p>
                <strong>Requested On:</strong>{" "}
                {new Date(
                  reservation.createdAt?.seconds * 1000 || Date.now(),
                ).toLocaleDateString()}
              </p>
              {reservation.updatedAt?.seconds && (
                <p>
                  <strong>Last Updated:</strong>{" "}
                  {new Date(
                    reservation.updatedAt.seconds * 1000,
                  ).toLocaleString()}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="faculty-edit-pending-footer">
        <button
          className="faculty-edit-pending-back-btn"
          onClick={() => navigate(-1)}
          disabled={saving || cancelling}
        >
          Back
        </button>

        <button
          className="faculty-edit-pending-cancel-btn"
          onClick={() => setShowCancelModal(true)}
          disabled={saving || cancelling || !isPending}
        >
          <i className="fa-solid fa-ban"></i> Cancel Reservation
        </button>

        <button
          className="faculty-edit-pending-save-btn"
          onClick={() => {
            if (!editableFields.roomName) {
              setConflictError("Please select a room.");
              showToast("error", "Error", "Please select a room.");
              return;
            }
            if (
              !availableRooms.some(
                (r) => r.roomName === editableFields.roomName,
              )
            ) {
              setConflictError(
                "The selected room is not available for the chosen date/time and purpose.",
              );
              showToast("error", "Error", "Selected room is not available.");
              return;
            }
            setShowSaveModal(true);
          }}
          disabled={saving || loadingAvailable || cancelling || !isPending}
        >
          {saving ? (
            <>
              <i className="fa-solid fa-circle-notch fa-spin"></i> Saving...
            </>
          ) : (
            <>
              <i className="fa-solid fa-floppy-disk"></i> Save Changes
            </>
          )}
        </button>
      </div>

      {/* ─── Save confirmation modal ──────────────────────────────── */}
      {showSaveModal && (
        <SavePopup
          onCancel={() => setShowSaveModal(false)}
          onConfirm={handleSave}
        />
      )}

      {/* ─── Cancel confirmation modal ────────────────────────────── */}
      {showCancelModal && (
        <div className="faculty-edit-pending-modal-overlay">
          <div className="faculty-edit-pending-modal">
            <div className="fepr-modal-icon fepr-modal-icon--danger">
              <i className="fa-solid fa-triangle-exclamation"></i>
            </div>
            <h3>Cancel Reservation?</h3>
            <p>
              This will permanently cancel your reservation for{" "}
              <b>{reservation.roomName}</b> on{" "}
              <b>{formatDateLong(reservation.date)}</b> (
              {reservation.startTime} – {reservation.endTime}).
            </p>
            <p className="fepr-modal-warning">
              <i className="fa-solid fa-circle-info"></i> This action cannot be
              undone. The Clerk and Admin will be notified.
            </p>
            <div className="faculty-edit-pending-modal-actions">
              <button
                className="faculty-edit-pending-modal-btn secondary"
                onClick={() => setShowCancelModal(false)}
                disabled={cancelling}
              >
                No, Keep It
              </button>
              <button
                className="faculty-edit-pending-modal-btn danger"
                onClick={handleCancelReservation}
                disabled={cancelling}
              >
                {cancelling ? (
                  <>
                    <i className="fa-solid fa-circle-notch fa-spin"></i>{" "}
                    Cancelling...
                  </>
                ) : (
                  <>
                    <i className="fa-solid fa-ban"></i> Yes, Cancel
                  </>
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

export default FacultyEditPendingReservation;