// ============================================================
// FILE: FacultySubmitReservation.jsx (with preview modal + room pagination & floor filter)
// ============================================================
import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import "./faculty-submit-reservation.css";
import Toast from "../../Popup/Toast/Toast";
import { auth, db } from "../../firebase";
import { isRoomUnderMaintenance } from "../../utils/Roommaintenance";
import {
  collection,
  getDocs,
  addDoc,
  serverTimestamp,
  doc,
  getDoc,
  query,
  where,
} from "firebase/firestore";

// ─── 12-hour time formatter ─────────────────────────────────
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
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
};

// ─── Quick date helpers ─────────────────────────────────────
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

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

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

const buildTimeOptions = () => {
  const options = [];
  for (let m = 7 * 60; m <= 20 * 60; m += 30) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    const value = `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    options.push({ value, label: format12Hour(value) });
  }
  return options;
};
const TIME_OPTIONS = buildTimeOptions();

const PRESET_SLOTS = [
  { label: "7:00 – 8:30 AM",   start: "07:00", end: "08:30" },
  { label: "8:30 – 10:00 AM",  start: "08:30", end: "10:00" },
  { label: "10:00 – 11:30 AM", start: "10:00", end: "11:30" },
  { label: "11:30 – 1:00 PM",  start: "11:30", end: "13:00" },
  { label: "1:00 – 2:30 PM",   start: "13:00", end: "14:30" },
  { label: "2:30 – 4:00 PM",   start: "14:30", end: "16:00" },
  { label: "4:00 – 5:30 PM",   start: "16:00", end: "17:30" },
  { label: "5:30 – 7:00 PM",   start: "17:30", end: "19:00" },
];

// ─── Course options ────────────────────────────────────────
const COURSE_OPTIONS = ["BSIT", "BSIS", "BLIS", "Others"];

// ─── Pagination ─────────────────────────────────────────────
const ROOMS_PER_PAGE = 6;

// ─── Equipment label lookup (for preview) ─────────────────
const EQUIPMENT_LABELS = {
  projector: "Projector",
  tvDisplay: "TV Display",
  ac: "AC",
  computer: "Computer",
  smartBoard: "Smart Board",
};

function FacultySubmitReservation() {
  const navigate = useNavigate();

  const [purpose, setPurpose] = useState("");
  const [courseTitle, setCourseTitle] = useState("");

  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [showCustomTime, setShowCustomTime] = useState(false);

  const [showDatePicker, setShowDatePicker] = useState(false);
  const [calendarCursor, setCalendarCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const [showStartTimePicker, setShowStartTimePicker] = useState(false);
  const [showEndTimePicker, setShowEndTimePicker] = useState(false);

  const [selectedFloor, setSelectedFloor] = useState("");
  const [currentPage, setCurrentPage] = useState(1);

  const [rooms, setRooms] = useState([]);
  const [selectedRoom, setSelectedRoom] = useState(null);

  const [selectedEquipment, setSelectedEquipment] = useState([]);
  const [studentRange, setStudentRange] = useState("");
  const [audienceType, setAudienceType] = useState("Class"); // ✅ default Class
  const [course, setCourse] = useState("BSIT");              // ✅ default BSIT
  const [customCourse, setCustomCourse] = useState("");      // ✅ for "Others"
  const [yearSectionGroup, setYearSectionGroup] = useState("");
  const [organization, setOrganization] = useState("");
  const [customPurposeText, setCustomPurposeText] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [showPreview, setShowPreview] = useState(false);

  const [validationAttempted, setValidationAttempted] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});

  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [submittedReservation, setSubmittedReservation] = useState(null);

  const [toast, setToast] = useState({
    show: false,
    type: "success",
    title: "",
    message: "",
  });

  const [releasedKeys, setReleasedKeys] = useState(new Set());

  const [nowTick, setNowTick] = useState(() => new Date());

  useEffect(() => {
    const interval = setInterval(() => setNowTick(new Date()), 30000);
    return () => clearInterval(interval);
  }, []);

  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    if (type !== "loading") {
      setTimeout(() => setToast((prev) => ({ ...prev, show: false })), 4000);
    }
  };

  const EQUIPMENT_OPTIONS = [
    { id: "projector", label: "Projector", icon: "📽" },
    { id: "tvDisplay", label: "TV Display", icon: "📺" },
    { id: "ac", label: "AC", icon: "❄️" },
    { id: "computer", label: "Computer", icon: "💻" },
    { id: "smartBoard", label: "Smart Board", icon: "🖊" },
  ];

  const toggleEquipment = (id) => {
    setSelectedEquipment((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  // ✅ Derive room status label (single source of truth)
  const getRoomStatus = (room) => {
    if (room.maintenance) return "Under Maintenance";
    if (room.reservedByUser) return "Reserved";
    if (!room.available) return "Occupied";
    return "Available";
  };

  const checkUserConflict = async () => {
    const firebaseUser = auth.currentUser;
    if (!firebaseUser) return null;

    const start = convertToMinutes(startTime);
    const end = convertToMinutes(endTime);

    const q = query(
      collection(db, "reservationRequests"),
      where("userId", "==", firebaseUser.uid),
      where("date", "==", date)
    );

    const snapshot = await getDocs(q);
    const userReservations = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    for (const res of userReservations) {
      if (res.status === "Rejected") continue;

      const resStart = convertToMinutes(res.startTime);
      const resEnd = convertToMinutes(res.endTime);

      if (start < resEnd && end > resStart) {
        if (res.roomId === selectedRoom?.id) continue;

        return {
          conflict: true,
          existingRoom: res.roomName,
          existingDate: res.date,
          existingStart: res.startTime,
          existingEnd: res.endTime,
          status: res.status,
        };
      }
    }
    return { conflict: false };
  };

  useEffect(() => {
    loadAvailableRooms();
  }, [date, startTime, endTime, selectedFloor, purpose, selectedEquipment, studentRange]);

  const convertToMinutes = (time) => {
    if (!time) return 0;
    const [h, m] = time.split(":").map(Number);
    return h * 60 + m;
  };

  const isToday = (selectedDate) => {
    if (!selectedDate) return false;
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    return selectedDate === `${yyyy}-${mm}-${dd}`;
  };

  const getCurrentMinutes = () => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  };

  const getMinimumCapacity = (range) => {
    switch (range) {
      case "30-50": return 30;
      case "50-60": return 50;
      case "60-80": return 60;
      case "80-100": return 80;
      default: return 0;
    }
  };

  const isOverlapping = (start1, end1, start2, end2) => {
    const s1 = convertToMinutes(start1);
    const e1 = convertToMinutes(end1);
    const s2 = convertToMinutes(start2);
    const e2 = convertToMinutes(end2);
    return s1 < e2 && e1 > s2;
  };

  const getDay = (date) => {
    const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    return days[new Date(date).getDay()];
  };

  const loadAvailableRooms = async () => {
    if (!date || !startTime || !endTime) {
      setRooms([]);
      return;
    }

    setLoading(true);

    const firebaseUser = auth.currentUser;
    const currentUserId = firebaseUser?.uid;

    try {
      const roomSnapshot = await getDocs(collection(db, "rooms"));
      const activitySnapshot = await getDocs(collection(db, "events"));
      const requestSnapshot = await getDocs(collection(db, "reservationRequests"));

      const releaseSnap = await getDocs(collection(db, "roomReleases"));
      const releaseMap = new Map();

      releaseSnap.docs.forEach((d) => {
        const r = d.data();
        if (r.date !== date) return;
        const key = `${r.scheduleId}_${r.date}`;
        if (!releaseMap.has(r.roomId)) releaseMap.set(r.roomId, new Set());
        releaseMap.get(r.roomId).add(key);
      });

      const roomList = [];

      for (const roomDoc of roomSnapshot.docs) {
        const room = { id: roomDoc.id, ...roomDoc.data() };

        if (selectedFloor) {
          const roomFloor = String(room.floor).toLowerCase();
          const selected = selectedFloor.toLowerCase();
          if (!roomFloor.includes(selected)) continue;
        }

        if (purpose === "Hands-on" && selectedEquipment.length > 0) {
          const roomEquipment = Object.entries(room.equipment || {})
            .filter(([key, value]) => value === true)
            .map(([key]) => key.toLowerCase());

          const hasAllEquipment = selectedEquipment.every((eq) =>
            roomEquipment.includes(eq.toLowerCase())
          );
          if (!hasAllEquipment) continue;
        }

        if ((purpose === "Lecture" || purpose === "Examination") && studentRange) {
          const requiredCapacity = getMinimumCapacity(studentRange);
          if (Number(room.capacity || 0) < requiredCapacity) continue;
        }

        const underMaintenance = isRoomUnderMaintenance(room, date, startTime, endTime);

        if (underMaintenance) {
          roomList.push({
            ...room,
            available: false,
            maintenance: true,
            reservedByUser: false,
          });
          continue;
        }

        let occupied = false;
        let reservedByUser = false;

        const scheduleSnapshot = await getDocs(
          collection(db, "rooms", room.id, "schedules")
        );
        const releasesForRoom = releaseMap.get(room.id) || new Set();

        const hasScheduleConflict = scheduleSnapshot.docs.some((doc) => {
          const sched = doc.data();
          if (sched.initialized) return false;
          if (sched.day !== getDay(date)) return false;
          const releaseKey = `${doc.id}_${date}`;
          if (releasesForRoom.has(releaseKey)) return false;
          return isOverlapping(startTime, endTime, sched.startTime, sched.endTime);
        });
        if (hasScheduleConflict) occupied = true;

        if (!occupied) {
          const hasEventConflict = activitySnapshot.docs.some((doc) => {
            const event = doc.data();
            if (event.roomId !== room.id) return false;
            if (event.date !== date) return false;
            if (event.status === "Cancelled") return false;
            return isOverlapping(startTime, endTime, event.startTime, event.endTime);
          });
          if (hasEventConflict) occupied = true;
        }

        if (!occupied) {
          const conflictingReservations = [];
          requestSnapshot.docs.forEach((doc) => {
            const req = doc.data();
            if (req.roomId !== room.id) return;
            if (req.date !== date) return;
            if (req.status === "Rejected") return;
            if (isOverlapping(startTime, endTime, req.startTime, req.endTime)) {
              conflictingReservations.push(req);
            }
          });

          for (const req of conflictingReservations) {
            if (req.userId === currentUserId) {
              reservedByUser = true;
              break;
            } else if (req.status === "Approved") {
              occupied = true;
              break;
            }
          }
        }

        roomList.push({
          ...room,
          available: !occupied && !reservedByUser,
          maintenance: false,
          reservedByUser,
        });
      }

      setRooms(roomList);
    } catch (err) {
      console.error(err);
      showToast("error", "Error", "Unable to load rooms.");
    }

    setLoading(false);
  };

  // ✅ Only show rooms that are Available
  const filteredRooms = useMemo(() => {
    return rooms.filter((r) => getRoomStatus(r) === "Available");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms]);

  const totalRoomPages = Math.max(1, Math.ceil(filteredRooms.length / ROOMS_PER_PAGE));
  const safeRoomPage = Math.min(currentPage, totalRoomPages);
  const roomStartIdx = (safeRoomPage - 1) * ROOMS_PER_PAGE;
  const paginatedRooms = filteredRooms.slice(
    roomStartIdx,
    roomStartIdx + ROOMS_PER_PAGE
  );

  // Reset page kapag nagbago ang filters o rooms
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedFloor, date, startTime, endTime, rooms.length]);

  const validateFields = () => {
    const errors = {};

    if (!courseTitle) errors.courseTitle = "Course title is required.";
    if (!date) errors.date = "Select a reservation date.";
    if (!audienceType) errors.audienceType = "Select audience type.";

    if (audienceType === "Class") {
      if (!course) errors.course = "Select a course.";
      if (course === "Others" && !customCourse.trim()) {
        errors.customCourse = "Please specify the course.";
      }
      if (!yearSectionGroup) errors.yearSectionGroup = "Enter Year / Section Group.";
      if (!["Lecture", "Hands-on", "Examination"].includes(purpose)) {
        errors.purpose = "Select a valid purpose for Class (Lecture, Hands-on, Examination).";
      }
      if (purpose === "Hands-on" && selectedEquipment.length === 0) {
        errors.selectedEquipment = "Select at least one required equipment.";
      }
      if ((purpose === "Lecture" || purpose === "Examination") && !studentRange) {
        errors.studentRange = "Select the estimated number of students.";
      }
    }

    if (audienceType === "Organization") {
      if (!organization) errors.organization = "Enter organization name.";
      if (!["Workshop", "Training", "Meeting", "Other Activity"].includes(purpose)) {
        errors.purpose = "Select a valid purpose for Organization (Workshop, Training, Meeting, Other Activity).";
      }
      if (purpose === "Other Activity" && !customPurposeText.trim()) {
        errors.customPurposeText = "Please specify the activity.";
      }
      if (!studentRange) errors.studentRange = "Select the estimated number of attendees.";
    }

    if (date) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const selectedDate = new Date(date);
      selectedDate.setHours(0, 0, 0, 0);
      if (selectedDate < today) errors.date = "You cannot reserve a past date.";
    }

    if (!startTime) errors.startTime = "Select a start time.";
    if (!endTime) errors.endTime = "Select an end time.";

    if (startTime && endTime) {
      const start = convertToMinutes(startTime);
      const end = convertToMinutes(endTime);
      if (start < 420) errors.startTime = "Reservations can only start from 7:00 AM.";
      if (end > 1200) errors.endTime = "Reservations must end before 8:00 PM.";
      if (start >= end) errors.endTime = "End time must be after start time.";
      if (isToday(date) && start <= getCurrentMinutes()) {
        errors.startTime = "You cannot reserve a past time today.";
      }
    }

    if (!selectedRoom) errors.selectedRoom = "Select an available room.";

    return errors;
  };

  const revalidate = () => {
    if (validationAttempted) {
      const newErrors = validateFields();
      setFieldErrors(newErrors);
    }
  };

  const notifyClerkAndAdmin = async (title, message, reservationId) => {
    const usersSnap = await getDocs(collection(db, "users"));
    const notifications = [];

    usersSnap.forEach((userDoc) => {
      const user = userDoc.data();
      const role = (user.role || "").toLowerCase().trim();

      let ownerType = "";
      if (role === "clerk") ownerType = "clerk";
      else if (role === "admin") ownerType = "admin";
      else return;

      notifications.push(
        addDoc(collection(db, "notifications"), {
          userId: userDoc.id,
          ownerType,
          reservationId,
          title,
          message,
          type: "reservation-request",
          unread: true,
          archived: false,
          badge: "NEW",
          createdAt: serverTimestamp(),
        })
      );
    });

    await Promise.all(notifications);
  };

  const handleSubmit = async () => {
    const errors = validateFields();
    if (Object.keys(errors).length > 0) {
      setValidationAttempted(true);
      setFieldErrors(errors);
      const firstError = Object.values(errors)[0];
      showToast("error", "Validation Error", firstError);
      return;
    }

    const conflictCheck = await checkUserConflict();
    if (conflictCheck?.conflict) {
      showToast(
        "error",
        "Time Conflict Detected",
        `You already have a ${conflictCheck.status.toLowerCase()} reservation for "${conflictCheck.existingRoom}" on ${conflictCheck.existingDate} from ${conflictCheck.existingStart} to ${conflictCheck.existingEnd}. Please choose a different time.`
      );
      return;
    }

    setSubmitting(true);
    showToast("loading", "Submitting", "Please wait...");

    const userRef = doc(db, "users", auth.currentUser.uid);
    const userSnap = await getDoc(userRef);

    let facultyName = "";
    let userData = {};
    if (userSnap.exists()) {
      userData = userSnap.data();
      facultyName = `${userData.firstName} ${userData.lastName}`;
    }

    let finalPurpose = purpose;
    if (purpose === "Other Activity") {
      finalPurpose = customPurposeText.trim() || "Other Activity";
    }

    // ✅ Resolve course value
    const finalCourse = course === "Others" ? customCourse.trim() : course;

    try {
      const reservationRef = await addDoc(collection(db, "reservationRequests"), {
        userId: auth.currentUser.uid,
        facultyName,
        roomId: selectedRoom.id,
        roomName: selectedRoom.roomName,
        audienceType,
        attendees: {
          course: finalCourse,
          yearSectionGroup,
          organization,
          customPurpose: customPurposeText,
        },
        courseTitle,
        purpose: finalPurpose,
        requiredEquipment: selectedEquipment,
        studentRange,
        date,
        startTime,
        endTime,
        status: "Pending",
        createdAt: serverTimestamp(),
      });

      await notifyClerkAndAdmin(
        "New Reservation Request",
        `${facultyName} submitted a reservation request for "${courseTitle}" in ${selectedRoom.roomName} on ${date} from ${startTime} to ${endTime}.`,
        reservationRef.id
      );

      await addDoc(collection(db, "notifications"), {
        userId: auth.currentUser.uid,
        ownerType: "faculty",
        reservationId: reservationRef.id,
        title: "Reservation Submitted",
        message: `Your reservation request for ${selectedRoom.roomName} on ${date} (${startTime} - ${endTime}) has been submitted successfully and is waiting for approval.`,
        type: "reservation-submitted",
        unread: true,
        archived: false,
        badge: "INFO",
        createdAt: serverTimestamp(),
      });

      await addDoc(collection(db, "activityLogs"), {
        timestamp: serverTimestamp(),
        action: "Submitted Reservation Request",
        actionType: "success",
        user: facultyName,
        role: "Faculty",
        target: `${selectedRoom.roomName} | ${courseTitle}`,
        status: "SUCCESS",
        details: {
          courseTitle,
          room: selectedRoom.roomName,
          date,
          startTime,
          endTime,
          purpose: finalPurpose,
          audienceType,
        },
        userId: auth.currentUser.uid,
      });

      setShowPreview(false);

      setSubmittedReservation({
        courseTitle,
        roomName: selectedRoom.roomName,
        floor: selectedRoom.floor,
        date,
        startTime,
        endTime,
        purpose: finalPurpose,
        audienceType,
        course: finalCourse,
        yearSectionGroup,
        organization,
      });

      setToast((prev) => ({ ...prev, show: false }));
      setShowSuccessModal(true);

      // ✅ Reset form (keep defaults)
      setCourseTitle("");
      setAudienceType("Class");
      setCourse("BSIT");
      setCustomCourse("");
      setYearSectionGroup("");
      setOrganization("");
      setCustomPurposeText("");
      setPurpose("");
      setDate("");
      setStartTime("");
      setEndTime("");
      setSelectedRoom(null);
      setRooms([]);
      setSelectedEquipment([]);
      setStudentRange("");
      setShowCustomTime(false);
      setValidationAttempted(false);
      setFieldErrors({});
    } catch (err) {
      console.error(err);
      showToast("error", "Firestore Error", err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitClick = () => {
    if (submitting) return;
    setValidationAttempted(true);
    const errors = validateFields();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      const firstError = Object.values(errors)[0];
      showToast("error", "Validation Error", firstError);
      return;
    }
    setShowPreview(true);
  };

  const hasErrors = Object.keys(fieldErrors).length > 0;

  const isPresetActive = (slot) =>
    slot.start === startTime && slot.end === endTime;

  const handlePresetClick = (slot) => {
    setStartTime(slot.start);
    setEndTime(slot.end);
    setShowCustomTime(false);
    revalidate();
  };

  const handleCustomStartChange = (value) => {
    setStartTime(value);
    revalidate();
  };
  const handleCustomEndChange = (value) => {
    setEndTime(value);
    revalidate();
  };

  const isDateToday = date === toDateInputValue(nowTick);
  const liveCurrentMinutes = nowTick.getHours() * 60 + nowTick.getMinutes();

  const isPastStartValue = (value) =>
    isDateToday && convertToMinutes(value) <= liveCurrentMinutes;

  const isPastPreset = (slot) =>
    isDateToday && convertToMinutes(slot.start) <= liveCurrentMinutes;

  useEffect(() => {
    if (isDateToday && startTime && convertToMinutes(startTime) <= liveCurrentMinutes) {
      setStartTime("");
      setEndTime("");
      revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowTick]);

  // ═══════════════════════════════════════════════════════════
  // Preview payload
  // ═══════════════════════════════════════════════════════════
  const previewData = {
    courseTitle,
    audienceType,
    course: course === "Others" ? customCourse.trim() : course,
    yearSectionGroup,
    organization,
    purpose:
      purpose === "Other Activity"
        ? customPurposeText.trim() || "Other Activity"
        : purpose,
    roomName: selectedRoom?.roomName || "—",
    roomFloor: selectedRoom?.floor || "",
    roomCapacity: selectedRoom?.capacity || "",
    date,
    startTime,
    endTime,
    equipment: selectedEquipment
      .map((id) => EQUIPMENT_LABELS[id] || id)
      .join(", "),
    studentRange,
  };

  // ═══════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════

  return (
    <>
      <div className="faculty-reservations-request">
        <div className="fa-submit-header">
          <h1>Reservation Request</h1>
          <p>Submit a reservation request for approval.</p>
        </div>

        <div className="faculty-submit-box">
          <div className="faculty-submit-sections">
            {/* LEFT SIDE */}
            <div className="faculty-submit-section">
              {/* COURSE TITLE */}
              <div className="faculty-submit-form-group">
                <label>Course Title</label>
                <input
                  className={`faculty-submit-input ${validationAttempted && fieldErrors.courseTitle ? "error" : ""}`}
                  placeholder="Enter course title"
                  value={courseTitle}
                  onChange={(e) => {
                    setCourseTitle(e.target.value);
                    revalidate();
                  }}
                />
                {validationAttempted && fieldErrors.courseTitle && (
                  <span className="field-error-message">{fieldErrors.courseTitle}</span>
                )}
              </div>

              {/* AUDIENCE TYPE */}
              <div className="faculty-submit-form-group">
                <label>Audience Type</label>
                <div className="faculty-submit-dropdown-wrapper">
                  <select
                    className={`faculty-submit-input faculty-submit-dropdown ${validationAttempted && fieldErrors.audienceType ? "error" : ""}`}
                    value={audienceType}
                    onChange={(e) => {
                      setAudienceType(e.target.value);
                      setPurpose("");
                      setSelectedEquipment([]);
                      setStudentRange("");
                      setCourse("BSIT");
                      setCustomCourse("");
                      setYearSectionGroup("");
                      setOrganization("");
                      setCustomPurposeText("");
                      revalidate();
                    }}
                  >
                    <option value="Class">Class</option>
                    <option value="Organization">Organization</option>
                  </select>
                  <i className="fa-solid fa-angle-down faculty-submit-dropdown-icon"></i>
                </div>
                {validationAttempted && fieldErrors.audienceType && (
                  <span className="field-error-message">{fieldErrors.audienceType}</span>
                )}

                {audienceType === "Class" && (
                  <>
                    {/* ✅ COURSE DROPDOWN (BSIT default, Others → custom input) */}
                    <div className="faculty-submit-form-group">
                      <label>Course</label>
                      <div className="faculty-submit-dropdown-wrapper">
                        <select
                          className={`faculty-submit-input faculty-submit-dropdown ${validationAttempted && fieldErrors.course ? "error" : ""}`}
                          value={course}
                          onChange={(e) => {
                            setCourse(e.target.value);
                            if (e.target.value !== "Others") setCustomCourse("");
                            revalidate();
                          }}
                        >
                          {COURSE_OPTIONS.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                        <i className="fa-solid fa-angle-down faculty-submit-dropdown-icon"></i>
                      </div>
                      {validationAttempted && fieldErrors.course && (
                        <span className="field-error-message">{fieldErrors.course}</span>
                      )}

                      {course === "Others" && (
                        <input
                          className={`faculty-submit-input faculty-submit-custom-course ${validationAttempted && fieldErrors.customCourse ? "error" : ""}`}
                          placeholder="Specify course..."
                          value={customCourse}
                          onChange={(e) => {
                            setCustomCourse(e.target.value);
                            revalidate();
                          }}
                        />
                      )}
                      {course === "Others" && validationAttempted && fieldErrors.customCourse && (
                        <span className="field-error-message">{fieldErrors.customCourse}</span>
                      )}
                    </div>

                    <div className="faculty-submit-form-group">
                      <label>Year / Section Group</label>
                      <input
                        className={`faculty-submit-input ${validationAttempted && fieldErrors.yearSectionGroup ? "error" : ""}`}
                        placeholder="Ex. 3F-G2"
                        value={yearSectionGroup}
                        onChange={(e) => {
                          setYearSectionGroup(e.target.value);
                          revalidate();
                        }}
                      />
                      {validationAttempted && fieldErrors.yearSectionGroup && (
                        <span className="field-error-message">{fieldErrors.yearSectionGroup}</span>
                      )}
                    </div>
                  </>
                )}

                {audienceType === "Organization" && (
                  <div className="faculty-submit-form-group">
                    <label>Organization Name</label>
                    <input
                      className={`faculty-submit-input ${validationAttempted && fieldErrors.organization ? "error" : ""}`}
                      placeholder="Computer Society"
                      value={organization}
                      onChange={(e) => {
                        setOrganization(e.target.value);
                        revalidate();
                      }}
                    />
                    {validationAttempted && fieldErrors.organization && (
                      <span className="field-error-message">{fieldErrors.organization}</span>
                    )}
                  </div>
                )}
              </div>

              {/* PURPOSE */}
              <div className="faculty-submit-form-group">
                <label>Purpose</label>
                <div className="faculty-submit-dropdown-wrapper">
                  <select
                    className={`faculty-submit-input faculty-submit-dropdown ${validationAttempted && fieldErrors.purpose ? "error" : ""}`}
                    value={purpose}
                    onChange={(e) => {
                      setPurpose(e.target.value);
                      setSelectedEquipment([]);
                      setStudentRange("");
                      setCustomPurposeText("");
                      revalidate();
                    }}
                  >
                    <option value="">Select Purpose</option>
                    {audienceType === "Class" && (
                      <>
                        <option value="Lecture">Lecture</option>
                        <option value="Hands-on">Hands-on</option>
                        <option value="Examination">Examination</option>
                      </>
                    )}
                    {audienceType === "Organization" && (
                      <>
                        <option value="Workshop">Workshop</option>
                        <option value="Training">Training</option>
                        <option value="Meeting">Meeting</option>
                        <option value="Other Activity">Other Activity</option>
                      </>
                    )}
                  </select>
                  <i className="fa-solid fa-angle-down faculty-submit-dropdown-icon"></i>
                </div>
                {validationAttempted && fieldErrors.purpose && (
                  <span className="field-error-message">{fieldErrors.purpose}</span>
                )}
              </div>

              {/* CLASS SUB-OPTIONS */}
              {audienceType === "Class" && purpose === "Hands-on" && (
                <div className="faculty-submit-form-group">
                  <label>Required Equipment</label>
                  <div className="equipment-grid">
                    {EQUIPMENT_OPTIONS.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`equipment-card ${
                          selectedEquipment.includes(item.id) ? "selected" : ""
                        } ${validationAttempted && fieldErrors.selectedEquipment ? "error" : ""}`}
                        onClick={() => {
                          toggleEquipment(item.id);
                          revalidate();
                        }}
                      >
                        <span className="equipment-icon">{item.icon}</span>
                        <span className="equipment-name">{item.label}</span>
                      </button>
                    ))}
                  </div>
                  {validationAttempted && fieldErrors.selectedEquipment && (
                    <span className="field-error-message">{fieldErrors.selectedEquipment}</span>
                  )}
                </div>
              )}

              {audienceType === "Class" &&
                (purpose === "Lecture" || purpose === "Examination") && (
                  <div className="faculty-submit-form-group">
                    <label>Estimated Number of Students</label>
                    <div className="faculty-submit-dropdown-wrapper">
                      <select
                        className={`faculty-submit-input faculty-submit-dropdown ${validationAttempted && fieldErrors.studentRange ? "error" : ""}`}
                        value={studentRange}
                        onChange={(e) => {
                          setStudentRange(e.target.value);
                          revalidate();
                        }}
                      >
                        <option value="">Select Range</option>
                        <option value="30-50">30 - 50 Students</option>
                        <option value="50-60">50 - 60 Students</option>
                        <option value="60-80">60 - 80 Students</option>
                        <option value="80-100">80 - 100 Students</option>
                      </select>
                      <i className="fa-solid fa-angle-down faculty-submit-dropdown-icon"></i>
                    </div>
                    {validationAttempted && fieldErrors.studentRange && (
                      <span className="field-error-message">{fieldErrors.studentRange}</span>
                    )}
                  </div>
                )}

              {audienceType === "Organization" && purpose && (
                <div className="faculty-submit-form-group">
                  <label>Estimated Number of Attendees</label>
                  <div className="faculty-submit-dropdown-wrapper">
                    <select
                      className={`faculty-submit-input faculty-submit-dropdown ${validationAttempted && fieldErrors.studentRange ? "error" : ""}`}
                      value={studentRange}
                      onChange={(e) => {
                        setStudentRange(e.target.value);
                        revalidate();
                      }}
                    >
                      <option value="">Select Range</option>
                      <option value="1-30">1 - 30 Persons</option>
                      <option value="31-50">31 - 50 Persons</option>
                      <option value="51-80">51 - 80 Persons</option>
                      <option value="81-100">81 - 100 Persons</option>
                      <option value="101+">101+ Persons</option>
                    </select>
                    <i className="fa-solid fa-angle-down faculty-submit-dropdown-icon"></i>
                  </div>
                  {validationAttempted && fieldErrors.studentRange && (
                    <span className="field-error-message">{fieldErrors.studentRange}</span>
                  )}
                </div>
              )}

              {audienceType === "Organization" && purpose === "Other Activity" && (
                <div className="faculty-submit-form-group">
                  <label>Specify Activity</label>
                  <input
                    className={`faculty-submit-input ${validationAttempted && fieldErrors.customPurposeText ? "error" : ""}`}
                    placeholder="Describe the activity..."
                    value={customPurposeText}
                    onChange={(e) => {
                      setCustomPurposeText(e.target.value);
                      revalidate();
                    }}
                  />
                  {validationAttempted && fieldErrors.customPurposeText && (
                    <span className="field-error-message">{fieldErrors.customPurposeText}</span>
                  )}
                </div>
              )}

              {/* DATE */}
              <div className="faculty-submit-form-group">
                <div className="dt-section-header">
                  <label>Date</label>
                </div>

                <div className="fsr-datepicker">
                  <button
                    type="button"
                    className={`fsr-date-trigger ${validationAttempted && fieldErrors.date ? "error" : ""} ${showDatePicker ? "open" : ""}`}
                    onClick={() => {
                      const base = date ? new Date(`${date}T00:00:00`) : new Date();
                      setCalendarCursor({ year: base.getFullYear(), month: base.getMonth() });
                      setShowDatePicker((v) => !v);
                    }}
                  >
                    <i className="fa-regular fa-calendar"></i>
                    <span>{date ? formatDateLong(date) : "Select a date"}</span>
                    <i className={`fa-solid fa-chevron-down fsr-date-caret ${showDatePicker ? "open" : ""}`}></i>
                  </button>

                  {showDatePicker && (
                    <>
                      <div
                        className="fsr-date-clickaway"
                        onClick={() => setShowDatePicker(false)}
                      ></div>
                      <div className="fsr-date-popover">
                        <span className="fsr-date-popover-arrow"></span>

                        <div className="fsr-date-quick-row">
                          <button
                            type="button"
                            className={date === toDateInputValue(new Date()) ? "active" : ""}
                            onClick={() => {
                              setDate(toDateInputValue(new Date()));
                              setShowDatePicker(false);
                              revalidate();
                            }}
                          >
                            Today
                          </button>
                          <button
                            type="button"
                            className={
                              date === addDaysLocal(toDateInputValue(new Date()), 1) ? "active" : ""
                            }
                            onClick={() => {
                              setDate(addDaysLocal(toDateInputValue(new Date()), 1));
                              setShowDatePicker(false);
                              revalidate();
                            }}
                          >
                            Tomorrow
                          </button>
                        </div>

                        <div className="fsr-cal-header">
                          <button
                            type="button"
                            className="fsr-cal-nav"
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
                          <span className="fsr-cal-title">
                            {MONTH_NAMES[calendarCursor.month]} {calendarCursor.year}
                          </span>
                          <button
                            type="button"
                            className="fsr-cal-nav"
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

                        <div className="fsr-cal-weekdays">
                          {WEEKDAY_LABELS.map((w) => (
                            <span key={w}>{w}</span>
                          ))}
                        </div>

                        <div className="fsr-cal-grid">
                          {buildCalendarGrid(calendarCursor.year, calendarCursor.month).map(
                            (cell, i) => {
                              const cellStr = toDateInputValue(cell.date);
                              const isPast = cellStr < toDateInputValue(new Date());
                              const isSelected = cellStr === date;
                              return (
                                <button
                                  type="button"
                                  key={i}
                                  className={[
                                    "fsr-cal-day",
                                    !cell.inMonth && "is-outside",
                                    isSelected && "is-selected",
                                    isPast && "is-disabled",
                                  ]
                                    .filter(Boolean)
                                    .join(" ")}
                                  disabled={isPast}
                                  onClick={() => {
                                    setDate(cellStr);
                                    setShowDatePicker(false);
                                    revalidate();
                                  }}
                                >
                                  {cell.day}
                                </button>
                              );
                            }
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {validationAttempted && fieldErrors.date && (
                  <span className="field-error-message">{fieldErrors.date}</span>
                )}
              </div>

              {/* TIME */}
              <div className="faculty-submit-form-group">
                <div className="dt-section-header">
                  <label>Time</label>
                  {startTime && endTime && (
                    <span className="dt-selected-pill">
                      <i className="fa-regular fa-clock"></i>
                      {format12Hour(startTime)} – {format12Hour(endTime)}
                    </span>
                  )}
                </div>

                <div className="time-preset-grid">
                  {PRESET_SLOTS.map((slot) => {
                    const disabled = isPastPreset(slot);
                    return (
                      <button
                        key={slot.label}
                        type="button"
                        className={`time-preset-chip ${isPresetActive(slot) ? "active" : ""} ${disabled ? "disabled" : ""}`}
                        onClick={() => {
                          if (disabled) return;
                          handlePresetClick(slot);
                        }}
                        disabled={disabled}
                        title={disabled ? "This time slot has already passed today" : undefined}
                      >
                        {slot.label}
                      </button>
                    );
                  })}
                </div>

                <button
                  type="button"
                  className={`time-custom-toggle ${showCustomTime ? "open" : ""}`}
                  onClick={() => setShowCustomTime((v) => !v)}
                >
                  <i className="fa-solid fa-sliders"></i>
                  {showCustomTime ? "Hide custom time" : "Set a custom time instead"}
                  <i className={`fa-solid fa-chevron-down time-custom-chev ${showCustomTime ? "open" : ""}`}></i>
                </button>

                {showCustomTime && (
                  <div className="time-custom-grid">
                    <div className="time-custom-field">
                      <span className="time-custom-label">Start Time</span>
                      <div className="fsr-timepicker">
                        <button
                          type="button"
                          className={`fsr-time-trigger ${validationAttempted && fieldErrors.startTime ? "error" : ""} ${showStartTimePicker ? "open" : ""}`}
                          onClick={() => {
                            setShowStartTimePicker((v) => !v);
                            setShowEndTimePicker(false);
                          }}
                        >
                          <i className="fa-regular fa-clock"></i>
                          <span>{startTime ? format12Hour(startTime) : "Select time"}</span>
                          <i className={`fa-solid fa-chevron-down fsr-time-caret ${showStartTimePicker ? "open" : ""}`}></i>
                        </button>

                        {showStartTimePicker && (
                          <>
                            <div
                              className="fsr-time-clickaway"
                              onClick={() => setShowStartTimePicker(false)}
                            ></div>
                            <div className="fsr-time-popover">
                              <span className="fsr-date-popover-arrow"></span>
                              <div className="fsr-time-list">
                                {TIME_OPTIONS.map((t) => {
                                  const disabled = isPastStartValue(t.value);
                                  return (
                                    <button
                                      type="button"
                                      key={t.value}
                                      className={`fsr-time-option ${startTime === t.value ? "is-selected" : ""} ${disabled ? "is-disabled" : ""}`}
                                      disabled={disabled}
                                      onClick={() => {
                                        handleCustomStartChange(t.value);
                                        setShowStartTimePicker(false);
                                      }}
                                    >
                                      {t.label}
                                      {disabled && <span className="fsr-time-passed-tag">Passed</span>}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="time-custom-arrow">
                      <i className="fa-solid fa-arrow-right"></i>
                    </div>

                    <div className="time-custom-field">
                      <span className="time-custom-label">End Time</span>
                      <div className="fsr-timepicker">
                        <button
                          type="button"
                          className={`fsr-time-trigger ${validationAttempted && fieldErrors.endTime ? "error" : ""} ${showEndTimePicker ? "open" : ""}`}
                          onClick={() => {
                            setShowEndTimePicker((v) => !v);
                            setShowStartTimePicker(false);
                          }}
                        >
                          <i className="fa-regular fa-clock"></i>
                          <span>{endTime ? format12Hour(endTime) : "Select time"}</span>
                          <i className={`fa-solid fa-chevron-down fsr-time-caret ${showEndTimePicker ? "open" : ""}`}></i>
                        </button>

                        {showEndTimePicker && (
                          <>
                            <div
                              className="fsr-time-clickaway"
                              onClick={() => setShowEndTimePicker(false)}
                            ></div>
                            <div className="fsr-time-popover">
                              <span className="fsr-date-popover-arrow"></span>
                              <div className="fsr-time-list">
                                {TIME_OPTIONS.map((t) => {
                                  const disabled = startTime
                                    ? convertToMinutes(t.value) <= convertToMinutes(startTime)
                                    : false;
                                  return (
                                    <button
                                      type="button"
                                      key={t.value}
                                      className={`fsr-time-option ${endTime === t.value ? "is-selected" : ""} ${disabled ? "is-disabled" : ""}`}
                                      disabled={disabled}
                                      onClick={() => {
                                        handleCustomEndChange(t.value);
                                        setShowEndTimePicker(false);
                                      }}
                                    >
                                      {t.label}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {validationAttempted && fieldErrors.startTime && (
                  <span className="field-error-message">{fieldErrors.startTime}</span>
                )}
                {validationAttempted && fieldErrors.endTime && (
                  <span className="field-error-message">{fieldErrors.endTime}</span>
                )}
              </div>
            </div>

            {/* RIGHT SIDE — ROOMS */}
            <div className="faculty-submit-section">
              <div className="faculty-submit-venue-header">
                <span className="faculty-submit-venue-title">Available Rooms</span>

                <div className="faculty-submit-venue-filters">
                  <div className="faculty-submit-venue-dropdown-wrapper">
                    <select
                      className="faculty-submit-venue-dropdown"
                      value={selectedFloor}
                      onChange={(e) => {
                        setSelectedFloor(e.target.value);
                        revalidate();
                      }}
                    >
                      <option value="">All Floors</option>
                      <option value="1st">1st Floor</option>
                      <option value="3rd">3rd Floor</option>
                      <option value="4th">4th Floor</option>
                    </select>
                    <i className="fa-solid fa-angle-down faculty-submit-venue-dropdown-icon"></i>
                  </div>
                </div>
              </div>

              {loading ? (
                <div className="faculty-loading">Loading available rooms...</div>
              ) : !date || !startTime || !endTime ? (
                <div className="faculty-empty">
                  <i className="fa-regular fa-calendar"></i>
                  <p>Select a date and reservation time first.</p>
                </div>
              ) : filteredRooms.length === 0 ? (
                <div className="faculty-empty">
                  <i className="fa-solid fa-circle-xmark"></i>
                  <p>
                    No available rooms match your selected schedule, purpose,
                    equipment, capacity, or floor.
                  </p>
                </div>
              ) : (
                <>
                  <div className="room-grid">
                    {paginatedRooms.map((room) => {
                      const isSelected = selectedRoom?.id === room.id;
                      const isError = validationAttempted && fieldErrors.selectedRoom && !isSelected;

                      return (
                        <div
                          key={room.id}
                          className={`
                            room-card available
                            ${isSelected ? "selected" : ""}
                            ${isError ? "error" : ""}
                          `}
                          onClick={() => {
                            setSelectedRoom(room);
                            revalidate();
                          }}
                        >
                          <div className="room-name">
                            <i className="fa-solid fa-door-open"></i> {room.roomName}
                          </div>
                          <div className="room-floor">
                            <i className="fa-solid fa-building"></i> {room.floor} Floor
                          </div>
                          {room.capacity && (
                            <div className="room-floor">
                              <i className="fa-solid fa-users"></i> {room.capacity} Seats
                            </div>
                          )}
                          <div className="room-status">
                            <i className="fa-solid fa-circle-check"></i> Available
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {totalRoomPages > 1 && (
                    <div className="room-pagination">
                      <button
                        type="button"
                        className="room-page-nav"
                        disabled={safeRoomPage === 1}
                        onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                        aria-label="Previous page"
                      >
                        <i className="fa-solid fa-chevron-left"></i>
                      </button>

                      {Array.from({ length: totalRoomPages }, (_, i) => i + 1).map((p) => (
                        <button
                          type="button"
                          key={p}
                          className={`room-page-btn ${safeRoomPage === p ? "active" : ""}`}
                          onClick={() => setCurrentPage(p)}
                        >
                          {p}
                        </button>
                      ))}

                      <button
                        type="button"
                        className="room-page-nav"
                        disabled={safeRoomPage === totalRoomPages}
                        onClick={() => setCurrentPage((p) => Math.min(totalRoomPages, p + 1))}
                        aria-label="Next page"
                      >
                        <i className="fa-solid fa-chevron-right"></i>
                      </button>

                      <span className="room-page-info">
                        Showing {roomStartIdx + 1}–
                        {Math.min(roomStartIdx + ROOMS_PER_PAGE, filteredRooms.length)} of{" "}
                        {filteredRooms.length}
                      </span>
                    </div>
                  )}
                </>
              )}

              {validationAttempted && fieldErrors.selectedRoom && (
                <span className="field-error-message" style={{ marginTop: "10px" }}>
                  {fieldErrors.selectedRoom}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="faculty-submit-footer">
          <button className="faculty-submit-back-btn" onClick={() => window.history.back()}>
            Back
          </button>
          <button
            className={`faculty-submit-confirm-btn ${submitting ? "disabled" : ""} ${validationAttempted && hasErrors ? "has-errors" : ""}`}
            onClick={handleSubmitClick}
            disabled={submitting}
            title={validationAttempted && hasErrors ? "Please fix the errors above" : "Preview and submit your reservation request"}
          >
            {submitting ? "Submitting..." : "Submit Request"}
          </button>
        </div>

        {/* PREVIEW MODAL */}
        {showPreview && (
          <div
            className="fsr-preview-overlay"
            onClick={() => !submitting && setShowPreview(false)}
          >
            <div
              className="fsr-preview-modal"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="fsr-preview-header">
                <div className="fsr-preview-icon">
                  <i className="fa-solid fa-clipboard-check"></i>
                </div>
                <h3>Review Your Request</h3>
                <p className="fsr-preview-subtitle">
                  Please check the details below before submitting.
                </p>
              </div>

              <div className="fsr-preview-body">
                <div className="fsr-preview-row">
                  <span className="fsr-preview-label">Course Title</span>
                  <span className="fsr-preview-value">{previewData.courseTitle || "—"}</span>
                </div>

                <div className="fsr-preview-row">
                  <span className="fsr-preview-label">Audience</span>
                  <span className="fsr-preview-value">
                    {previewData.audienceType}
                    {previewData.audienceType === "Class" && previewData.course && (
                      <> — {previewData.course} {previewData.yearSectionGroup}</>
                    )}
                    {previewData.audienceType === "Organization" &&
                      previewData.organization && (
                        <> — {previewData.organization}</>
                      )}
                  </span>
                </div>

                <div className="fsr-preview-row">
                  <span className="fsr-preview-label">Purpose</span>
                  <span className="fsr-preview-value">{previewData.purpose || "—"}</span>
                </div>

                <div className="fsr-preview-row">
                  <span className="fsr-preview-label">Room</span>
                  <span className="fsr-preview-value">
                    {previewData.roomName}
                    {previewData.roomFloor ? ` — ${previewData.roomFloor} Floor` : ""}
                    {previewData.roomCapacity ? ` (${previewData.roomCapacity} Seats)` : ""}
                  </span>
                </div>

                <div className="fsr-preview-row">
                  <span className="fsr-preview-label">Date</span>
                  <span className="fsr-preview-value">{formatDateLong(previewData.date)}</span>
                </div>

                <div className="fsr-preview-row">
                  <span className="fsr-preview-label">Time</span>
                  <span className="fsr-preview-value">
                    {format12Hour(previewData.startTime)} – {format12Hour(previewData.endTime)}
                  </span>
                </div>

                {previewData.equipment && (
                  <div className="fsr-preview-row">
                    <span className="fsr-preview-label">Equipment</span>
                    <span className="fsr-preview-value">{previewData.equipment}</span>
                  </div>
                )}

                {previewData.studentRange && (
                  <div className="fsr-preview-row">
                    <span className="fsr-preview-label">
                      {previewData.audienceType === "Organization"
                        ? "Estimated Attendees"
                        : "Estimated Students"}
                    </span>
                    <span className="fsr-preview-value">{previewData.studentRange}</span>
                  </div>
                )}

                <div className="fsr-preview-note">
                  <i className="fa-solid fa-circle-info"></i>
                  <span>
                    After submitting, your request will be marked as{" "}
                    <strong>Pending</strong> and sent to the Clerk/Admin for approval.
                  </span>
                </div>
              </div>

              <div className="fsr-preview-actions">
                <button
                  className="fsr-preview-back-btn"
                  onClick={() => setShowPreview(false)}
                  disabled={submitting}
                >
                  <i className="fa-solid fa-pen-to-square"></i>
                  Edit Details
                </button>
                <button
                  className={`fsr-preview-confirm-btn ${submitting ? "disabled" : ""}`}
                  onClick={handleSubmit}
                  disabled={submitting}
                >
                  {submitting ? (
                    <>
                      <i className="fa-solid fa-spinner fa-spin"></i> Submitting...
                    </>
                  ) : (
                    <>
                      <i className="fa-solid fa-circle-check"></i> Confirm & Submit
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* SUCCESS DIALOG */}
        {showSuccessModal && submittedReservation && (
          <div className="rs-success-overlay">
            <div className="rs-success-modal">
              <div className="rs-success-icon">
                <i className="fa-solid fa-circle-check"></i>
              </div>

              <h3>Reservation Submitted!</h3>
              <p className="rs-success-subtitle">
                Your request has been sent for approval. You'll get a notification once it's reviewed.
              </p>

              <div className="rs-success-details">
                <div className="rs-success-row">
                  <span className="rs-success-label">Course Title</span>
                  <span className="rs-success-value">{submittedReservation.courseTitle}</span>
                </div>
                <div className="rs-success-row">
                  <span className="rs-success-label">Room</span>
                  <span className="rs-success-value">
                    {submittedReservation.roomName}
                    {submittedReservation.floor ? ` (${submittedReservation.floor} Floor)` : ""}
                  </span>
                </div>
                <div className="rs-success-row">
                  <span className="rs-success-label">Date</span>
                  <span className="rs-success-value">{formatDateLong(submittedReservation.date)}</span>
                </div>
                <div className="rs-success-row">
                  <span className="rs-success-label">Time</span>
                  <span className="rs-success-value">
                    {format12Hour(submittedReservation.startTime)} - {format12Hour(submittedReservation.endTime)}
                  </span>
                </div>
                <div className="rs-success-row">
                  <span className="rs-success-label">Purpose</span>
                  <span className="rs-success-value">{submittedReservation.purpose}</span>
                </div>
                <div className="rs-success-row">
                  <span className="rs-success-label">Audience</span>
                  <span className="rs-success-value">
                    {submittedReservation.audienceType}
                    {submittedReservation.audienceType === "Class" && submittedReservation.course
                      ? ` — ${submittedReservation.course} ${submittedReservation.yearSectionGroup || ""}`.trim()
                      : ""}
                    {submittedReservation.audienceType === "Organization" && submittedReservation.organization
                      ? ` — ${submittedReservation.organization}`
                      : ""}
                  </span>
                </div>
                <div className="rs-success-row">
                  <span className="rs-success-label">Status</span>
                  <span className="rs-status-pill">
                    <i className="fa-solid fa-clock"></i> Pending
                  </span>
                </div>
              </div>

              <div className="rs-success-actions">
                <button
                  className="rs-success-secondary"
                  onClick={() => {
                    setShowSuccessModal(false);
                    setSubmittedReservation(null);
                  }}
                >
                  Submit Another
                </button>
                <button className="rs-success-primary" onClick={() => navigate("/faculty")}>
                  Back to Dashboard
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
    </>
  );
}

export default FacultySubmitReservation;