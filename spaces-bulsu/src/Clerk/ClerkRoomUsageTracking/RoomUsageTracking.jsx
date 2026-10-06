import "./room-usage-tracking.css";
import { useEffect, useMemo, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../../firebase";

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import Toast from "../../Popup/Toast/Toast";
import ExportModal from "../../Components/ExportModal/ExportModal";
import universityLogo from "../../assets/BSU-Logo.png";
import collegeLogo from "../../assets/CICT-Logo.png";

const SCHOOL_HEADER = {
  universityLogoUrl: universityLogo,
  collegeLogoUrl: collegeLogo,
  universityName: "Bulacan State University",
  collegeName: "College of Information and Communications Technology",
  systemName: "SpaceS CICT",
};

const DAY_ABBR = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const todayString = () => new Date().toISOString().split("T")[0];

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const WEEKDAY_LABELS = ["Su","Mo","Tu","We","Th","Fr","Sa"];

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
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
};

const buildCalendarGrid = (year, month) => {
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < startOffset; i++) {
    cells.push({ day: daysInPrevMonth - startOffset + 1 + i, inMonth: false, date: new Date(year, month - 1, daysInPrevMonth - startOffset + 1 + i) });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, inMonth: true, date: new Date(year, month, d) });
  }
  while (cells.length % 7 !== 0 || cells.length < 42) {
    const nextIndex = cells.length - startOffset - daysInMonth + 1;
    cells.push({ day: nextIndex, inMonth: false, date: new Date(year, month + 1, nextIndex) });
    if (cells.length >= 42) break;
  }
  return cells;
};

const getDayAbbrev = (dateStr) => {
  const d = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
  return DAY_ABBR[d.getDay()];
};

const timeToMinutes = (time) => {
  if (!time) return 0;
  const [clock, period] = time.trim().split(" ");
  let [hour, minute] = clock.split(":").map(Number);
  if (period === "PM" && hour !== 12) hour += 12;
  if (period === "AM" && hour === 12) hour = 0;
  return hour * 60 + minute;
};

const format12Hour = (time) => {
  if (!time) return "-";
  const [hour, minute] = time.split(":").map(Number);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return time;
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return `${h}:${String(minute).padStart(2, "0")} ${suffix}`;
};

const getCurrentMinutes = () => {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
};

const getStatus = (dateStr, start, end) => {
  const today = todayString();
  if (dateStr && dateStr < today) return "COMPLETED";
  if (dateStr && dateStr > today) return "UPCOMING";
  const current = getCurrentMinutes();
  const startMin = timeToMinutes(start);
  const endMin = timeToMinutes(end);
  if (current >= startMin && current <= endMin) return "ONGOING";
  if (current < startMin) return "UPCOMING";
  return "COMPLETED";
};

const normalizeSchedule = (s) => ({
  id: s.id, kind: "schedule", sourceLabel: "Class Schedule",
  roomName: s.roomName, day: s.day, date: s.date || null,
  startTime: s.startTime, endTime: s.endTime,
  subject: s.subject || "Class",
  facultyName: s.facultyName || s.faculty || "-",
  faculty: s.facultyName || s.faculty || "-",
  section: s.section || "", semester: s.semester || "", schoolYear: s.schoolYear || "",
  organization: null, scheduleId: s.id,
});

const normalizeEvent = (e) => ({
  id: e.id, kind: "event", sourceLabel: "Room Activity",
  roomName: e.roomName, day: null, date: e.date,
  startTime: e.startTime, endTime: e.endTime,
  subject: e.title || e.purpose || "Room Activity",
  facultyName: e.faculty || "Admin", section: "", organization: null,
});

const normalizeReservation = (r) => ({
  id: r.id, kind: "reservation",
  sourceLabel: r.reservationType === "walk-in" ? "Walk-in Reservation" : "Faculty Reservation",
  roomName: r.roomName, day: null, date: r.date,
  startTime: r.startTime, endTime: r.endTime,
  subject: r.customPurpose || r.courseTitle || r.purpose || "Reservation",
  facultyName: r.requesterName || r.facultyName || "-",
  section: r.yearSectionGroup || r.attendees?.yearSectionGroup || "",
  organization: r.organizationName || r.attendees?.organization || null,
});

const normalizeRelease = (r) => ({
  id: r.id, scheduleId: r.scheduleId, roomId: r.roomId,
  date: r.date, effectiveEndTime: r.effectiveEndTime || null,
});

const normalizeReassignment = (r) => ({
  id: r.id, scheduleId: r.scheduleId, oldRoomId: r.oldRoomId, newRoomId: r.newRoomId,
  date: r.date, startTime: r.startTime, endTime: r.endTime,
  facultyName: r.facultyName || "-", subject: r.courseTitle || "Class (Moved)",
  sourceLabel: "Reassigned", roomName: r.newRoomName,
});

const HISTORY_PAGE_SIZE = 10;

export default function RoomUsageTracking() {
  const [activeTab, setActiveTab] = useState("current");
  const [rooms, setRooms] = useState([]);
  const [room, setRoom] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [allSchedules, setAllSchedules] = useState([]);
  const [allEvents, setAllEvents] = useState([]);
  const [allReservations, setAllReservations] = useState([]);
  const [allReleases, setAllReleases] = useState([]);
  const [allReassignments, setAllReassignments] = useState([]);
  const [currentSchedule, setCurrentSchedule] = useState(null);
  const [nextSchedule, setNextSchedule] = useState(null);
  const [history, setHistory] = useState([]);
  const [lastUser, setLastUser] = useState(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [upcomingSchedules, setUpcomingSchedules] = useState([]);
  const [analytics, setAnalytics] = useState({ totalSchedules: 0, completed: 0, ongoing: 0, upcoming: 0 });
  const [exporting, setExporting] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [showExportModal, setShowExportModal] = useState(false);

  const [showRoomPicker, setShowRoomPicker] = useState(false);
  const [roomSearch, setRoomSearch] = useState("");

  const [showDatePicker, setShowDatePicker] = useState(false);
  const [calendarCursor, setCalendarCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const [toast, setToast] = useState({ show: false, type: "", title: "", message: "" });
  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    if (type !== "loading") setTimeout(() => setToast((prev) => ({ ...prev, show: false })), 3000);
  };

  const isToday = (date || todayString()) === todayString();

  const filteredRooms = useMemo(() => {
    const q = roomSearch.trim().toLowerCase();
    if (!q) return rooms;
    return rooms.filter((r) => {
      const name = (r.roomName || r.name || "").toLowerCase();
      const floor = String(r.floor || "").toLowerCase();
      const building = String(r.building || r.bldg || "").toLowerCase();
      return name.includes(q) || floor.includes(q) || building.includes(q);
    });
  }, [rooms, roomSearch]);

  const selectedRoomObj = useMemo(
    () => rooms.find((r) => (r.roomName || r.name) === room) || null,
    [rooms, room]
  );

  useEffect(() => {
    loadRooms();
    const interval = setInterval(() => loadRooms(true), 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!room) return;
    trackRoom(); buildHistory(); buildAnalytics();
  }, [room, date, allSchedules, allEvents, allReservations, allReleases, allReassignments]);

  useEffect(() => { setHistoryPage(1); }, [room]);

  const loadRooms = async (silent = false) => {
    if (!silent) setRefreshing(true);
    if (rooms.length === 0) setLoading(true);

    try {
      const roomSnap = await getDocs(collection(db, "rooms"));
      const roomList = [];
      const scheduleList = [];

      for (const roomDoc of roomSnap.docs) {
        const roomData = { id: roomDoc.id, ...roomDoc.data() };
        roomList.push(roomData);

        const scheduleSnap = await getDocs(collection(db, "rooms", roomDoc.id, "schedules"));
        scheduleSnap.forEach((doc) => {
          const data = doc.data();
          if (data.initialized) return;
          scheduleList.push(normalizeSchedule({
            id: doc.id, roomId: roomDoc.id, roomName: roomData.roomName || roomData.name, ...data,
          }));
        });
      }

      const eventSnap = await getDocs(collection(db, "events"));
      const eventList = eventSnap.docs.map((d) => normalizeEvent({ id: d.id, ...d.data() }));

      const reservationSnap = await getDocs(collection(db, "reservationRequests"));
      const reservationList = reservationSnap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((r) => String(r.status || "").toLowerCase() === "approved")
        .map((r) => normalizeReservation(r));

      const releaseSnap = await getDocs(collection(db, "roomReleases"));
      const releaseList = releaseSnap.docs.map((d) => normalizeRelease({ id: d.id, ...d.data() }));

      const reassignSnap = await getDocs(collection(db, "roomReassignments"));
      const reassignList = reassignSnap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((r) => String(r.status || "").toLowerCase() === "approved")
        .map((r) => normalizeReassignment(r));

      const sortedRoomList = [...roomList].sort((a, b) =>
        (a.roomName || a.name || "").localeCompare(b.roomName || b.name || "", undefined, { sensitivity: "base", numeric: true })
      );

      setRooms(sortedRoomList);
      setAllSchedules(scheduleList);
      setAllEvents(eventList);
      setAllReservations(reservationList);
      setAllReleases(releaseList);
      setAllReassignments(reassignList);

      setRoom((prev) => prev || (sortedRoomList.length ? sortedRoomList[0].roomName || sortedRoomList[0].name : ""));

      if (!silent) showToast("success", "Data Refreshed", `Loaded ${roomList.length} rooms successfully.`);
    } catch (err) {
      console.log(err);
      if (!silent) showToast("error", "Refresh Failed", "Could not reload data.");
    }
    setLoading(false);
    if (!silent) setRefreshing(false);
  };

  const getOccurrencesForDate = (targetDate) => {
    const dayAbbrev = getDayAbbrev(targetDate);

    const releaseMap = new Map();
    allReleases.filter((r) => r.date === targetDate).forEach((r) => releaseMap.set(`${r.scheduleId}_${r.date}`, r));

    const reassignAwayKeys = new Set(
      allReassignments.filter((r) => r.date === targetDate && r.oldRoomId).map((r) => `${r.scheduleId}_${r.date}`)
    );

    const scheduleOccurrences = allSchedules
      .filter((s) => s.roomName === room && s.day === dayAbbrev)
      .map((s) => {
        const key = `${s.scheduleId}_${targetDate}`;
        if (reassignAwayKeys.has(key)) return null;
        const releaseInfo = releaseMap.get(key);
        if (releaseInfo) {
          if (!releaseInfo.effectiveEndTime) return null;
          const endMin = timeToMinutes(releaseInfo.effectiveEndTime);
          const startMin = timeToMinutes(s.startTime);
          if (endMin <= startMin) return null;
          return { ...s, endTime: releaseInfo.effectiveEndTime, date: targetDate, isReleased: true, releasedAtTime: releaseInfo.effectiveEndTime };
        }
        return { ...s, date: targetDate };
      })
      .filter(Boolean);

    const eventOccurrences = allEvents.filter((e) => e.roomName === room && e.date === targetDate);
    const reservationOccurrences = allReservations.filter((r) => r.roomName === room && r.date === targetDate);

    const reassignInto = allReassignments
      .filter((r) => r.date === targetDate && r.roomName === room)
      .map((r) => ({ ...r, kind: "reassignment", sourceLabel: "Reassigned Class", facultyName: r.facultyName, subject: r.subject, roomName: r.roomName }));

    return [...scheduleOccurrences, ...eventOccurrences, ...reservationOccurrences, ...reassignInto]
      .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  };

  const trackRoom = () => {
    const currentDate = date || todayString();
    const combined = getOccurrencesForDate(currentDate);
    let current = null, next = null;
    const upcoming = [];

    if (isToday) {
      const now = getCurrentMinutes();
      combined.forEach((item, i) => {
        const start = timeToMinutes(item.startTime);
        const end = timeToMinutes(item.endTime);
        if (now >= start && now <= end) { current = item; next = combined[i + 1] || null; }
        if (start > now) upcoming.push(item);
      });
    } else {
      upcoming.push(...combined);
    }

    setCurrentSchedule(current);
    setNextSchedule(next);
    setUpcomingSchedules(upcoming);
  };

  const calculateProgress = (schedule) => {
    if (!schedule) return 0;
    const now = new Date();
    const current = now.getHours() * 60 + now.getMinutes();
    const start = timeToMinutes(schedule.startTime);
    const end = timeToMinutes(schedule.endTime);
    if (current <= start) return 0;
    if (current >= end) return 100;
    return ((current - start) / (end - start)) * 100;
  };

  const parseDateTime = (date, time) => {
    if (!date || !time) return new Date(0);
    const [clock, period] = time.split(" ");
    let [h, m] = clock.split(":").map(Number);
    if (period === "PM" && h !== 12) h += 12;
    if (period === "AM" && h === 12) h = 0;
    return new Date(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
  };

  const buildHistory = () => {
    const currentDate = date || todayString();
    const allOccurrences = getOccurrencesForDate(currentDate);
    const historyData = allOccurrences
      .filter((item) => item.kind === "schedule" || item.kind === "reassignment")
      .sort((a, b) => new Date(`${b.date}T${b.endTime}`) - new Date(`${a.date}T${a.endTime}`));

    const otherHistory = [
      ...allEvents.filter((e) => e.roomName === room && e.date === currentDate),
      ...allReservations.filter((r) => r.roomName === room && r.date === currentDate),
    ];

    const fullHistory = [...historyData, ...otherHistory]
      .sort((a, b) => new Date(`${b.date}T${b.endTime}`) - new Date(`${a.date}T${a.endTime}`));

    setHistory(fullHistory);

    const ongoing = fullHistory.find((item) => getStatus(item.date, item.startTime, item.endTime) === "ONGOING");
    if (ongoing) setLastUser(ongoing);
    else {
      const completed = fullHistory
        .filter((item) => getStatus(item.date, item.startTime, item.endTime) === "COMPLETED")
        .sort((a, b) => parseDateTime(b.date, b.endTime) - parseDateTime(a.date, a.endTime));
      setLastUser(completed[0] || null);
    }
  };

  const buildAnalytics = () => {
    const currentDate = date || todayString();
    const combined = getOccurrencesForDate(currentDate);
    let completed = 0, ongoing = 0, upcoming = 0;

    combined.forEach((item) => {
      const status = getStatus(currentDate, item.startTime, item.endTime);
      if (status === "COMPLETED") completed++;
      if (status === "ONGOING") ongoing++;
      if (status === "UPCOMING") upcoming++;
    });

    setAnalytics({ totalSchedules: combined.length, completed, ongoing, upcoming });
  };

  const handleExportReport = async ({ range, from, to, format }) => {
    let rows = history;

    if (range === "range" && from && to) {
      const start = new Date(from + "T00:00:00");
      const end = new Date(to + "T23:59:59");
      rows = history.filter((item) => {
        if (!item.date) return false;
        const d = new Date(item.date + "T00:00:00");
        return d >= start && d <= end;
      });
    }

    if (rows.length === 0) {
      showToast("error", "Nothing to Export", "No records in the selected range.");
      return;
    }

    setExporting(true);
    showToast("loading", "Generating...", "Please wait.");

    try {
      if (format === "csv") {
        const headers = ["Date", "Start", "End", "Subject", "Faculty", "Type", "Status"];
        const body = rows.map((r) => [
          r.date || "",
          format12Hour(r.startTime),
          format12Hour(r.endTime),
          r.subject || "",
          r.facultyName || "",
          r.sourceLabel || "",
          getStatus(r.date, r.startTime, r.endTime),
        ]);
        const csv = [headers, ...body]
          .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
          .join("\n");
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `SpaceSCICT_RoomUsage(${todayString()}).csv`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
        const pageWidth = pdf.internal.pageSize.getWidth();
        const marginX = 40;
        const logoSize = 50;
        const centerX = pageWidth / 2;

        if (SCHOOL_HEADER.universityLogoUrl) pdf.addImage(SCHOOL_HEADER.universityLogoUrl, "PNG", marginX, 22, logoSize, logoSize);
        if (SCHOOL_HEADER.collegeLogoUrl) pdf.addImage(SCHOOL_HEADER.collegeLogoUrl, "PNG", pageWidth - marginX - logoSize, 22, logoSize, logoSize);

        pdf.setFont("helvetica", "bold"); pdf.setFontSize(14); pdf.setTextColor(20, 27, 45);
        pdf.text(SCHOOL_HEADER.universityName, centerX, 36, { align: "center" });
        pdf.setFont("helvetica", "normal"); pdf.setFontSize(10); pdf.setTextColor(107, 114, 128);
        pdf.text(SCHOOL_HEADER.collegeName, centerX, 50, { align: "center" });
        pdf.text(SCHOOL_HEADER.systemName, centerX, 62, { align: "center" });

        pdf.setDrawColor(245, 124, 0); pdf.setLineWidth(1.5);
        pdf.line(marginX, 82, pageWidth - marginX, 82);

        pdf.setFont("helvetica", "bold"); pdf.setFontSize(16); pdf.setTextColor(245, 124, 0);
        pdf.text("Room Usage History Log", marginX, 104);
        pdf.setFont("helvetica", "normal"); pdf.setFontSize(10); pdf.setTextColor(107, 114, 128);
        pdf.text(`Room: ${room}`, marginX, 120);
        pdf.text(`Range: ${range === "range" ? `${from} to ${to}` : "All"}`, marginX, 134);
        pdf.text(`Generated: ${new Date().toLocaleString()}`, pageWidth - marginX, 120, { align: "right" });

        autoTable(pdf, {
          startY: 148,
          head: [["Date & Time", "Subject / Event", "Requested By", "Type", "Status"]],
          body: rows.map((r) => [
            `${r.date || "-"}\n${format12Hour(r.startTime)} - ${format12Hour(r.endTime)}${r.isReleased ? "\n(Released early)" : ""}`,
            r.subject,
            r.facultyName,
            r.sourceLabel,
            getStatus(r.date, r.startTime, r.endTime),
          ]),
          theme: "grid",
          styles: { font: "helvetica", fontSize: 9, cellPadding: 6, valign: "middle" },
          headStyles: { fillColor: [245, 124, 0], textColor: [255, 255, 255], fontStyle: "bold", fontSize: 9 },
          bodyStyles: { textColor: [26, 26, 26] },
          alternateRowStyles: { fillColor: [253, 246, 240] },
          margin: { left: marginX, right: marginX },
        });

        const pageCount = pdf.internal.getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
          pdf.setPage(i);
          pdf.setFont("helvetica", "normal"); pdf.setFontSize(8); pdf.setTextColor(150, 150, 150);
          pdf.text(`Page ${i} of ${pageCount}`, pageWidth - marginX, pdf.internal.pageSize.getHeight() - 20, { align: "right" });
          pdf.text(`${SCHOOL_HEADER.systemName} — Confidential`, marginX, pdf.internal.pageSize.getHeight() - 20);
        }

        pdf.save(`SpaceSCICT_RoomUsage(${todayString()}).pdf`);
      }

      showToast("success", "Exported", `${rows.length} record(s) exported.`);
      setShowExportModal(false);
    } catch (err) {
      console.error(err);
      showToast("error", "Export Failed", "Could not export. Please try again.");
    } finally {
      setExporting(false);
    }
  };

  const totalHistoryPages = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE));
  const paginatedHistory = history.slice((historyPage - 1) * HISTORY_PAGE_SIZE, historyPage * HISTORY_PAGE_SIZE);

  const renderHistoryPages = () => {
    const pages = [];
    const startPage = Math.max(1, historyPage - 1);
    const endPage = Math.min(totalHistoryPages, startPage + 2);
    for (let i = startPage; i <= endPage; i++) pages.push(i);
    return pages;
  };

  return (
    <>
      <div className="rut-page">
        <div className="rut-header">
          <h1 className="rut-title">Room Usage Tracking</h1>
          <p className="rut-subtitle">Investigate real-time occupancy and historical usage patterns for any campus facility.</p>
        </div>

        <div className="rut-filter-bar">
          <div className="rut-filter-row">
            {/* ROOM PICKER */}
            <div className="rut-filter-group">
              <span className="rut-filter-label">SELECT ROOM</span>
              <div className="rut-roompicker">
                <button
                  type="button"
                  className={`rut-room-trigger ${showRoomPicker ? "open" : ""}`}
                  onClick={() => { setRoomSearch(""); setShowRoomPicker((v) => !v); }}
                >
                  <i className="fa-solid fa-door-open"></i>
                  <span className="rut-room-trigger-text">{room || "Select a room"}</span>
                  {selectedRoomObj?.floor && <span className="rut-room-trigger-floor">{selectedRoomObj.floor} Floor</span>}
                  <i className={`fa-solid fa-chevron-down rut-room-caret ${showRoomPicker ? "open" : ""}`}></i>
                </button>

                {showRoomPicker && (
                  <>
                    <div className="rut-room-clickaway" onClick={() => setShowRoomPicker(false)}></div>
                    <div className="rut-room-popover">
                      <span className="rut-room-popover-arrow"></span>
                      <div className="rut-room-search-wrap">
                        <i className="fa-solid fa-magnifying-glass"></i>
                        <input
                          type="text" className="rut-room-search" placeholder="Search room, floor, building..."
                          value={roomSearch} onChange={(e) => setRoomSearch(e.target.value)} autoFocus
                        />
                        {roomSearch && (
                          <button type="button" className="rut-room-search-clear" onClick={() => setRoomSearch("")} aria-label="Clear search">
                            <i className="fa-solid fa-xmark"></i>
                          </button>
                        )}
                      </div>
                      <div className="rut-room-list">
                        {filteredRooms.length === 0 ? (
                          <div className="rut-room-empty">
                            <i className="fa-regular fa-face-frown"></i>
                            <span>No rooms match your search.</span>
                          </div>
                        ) : (
                          filteredRooms.map((r) => {
                            const name = r.roomName || r.name;
                            const isActive = name === room;
                            return (
                              <button
                                type="button" key={r.id}
                                className={`rut-room-option ${isActive ? "is-active" : ""}`}
                                onClick={() => { setRoom(name); setShowRoomPicker(false); setRoomSearch(""); }}
                              >
                                <div className="rut-room-option-icon"><i className="fa-solid fa-door-open"></i></div>
                                <div className="rut-room-option-body">
                                  <span className="rut-room-option-name">{name}</span>
                                  <span className="rut-room-option-meta">
                                    {r.floor && (<><i className="fa-solid fa-building"></i>{r.floor} Floor</>)}
                                    {r.capacity && (<><span className="rut-room-dot">•</span><i className="fa-solid fa-users"></i>{r.capacity} Seats</>)}
                                  </span>
                                </div>
                                {isActive && <i className="fa-solid fa-circle-check rut-room-option-check"></i>}
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* DATE PICKER */}
            <div className="rut-filter-group">
              <span className="rut-filter-label">SELECT DATE</span>
              <div className="rut-datepicker">
                <button
                  type="button"
                  className={`rut-date-trigger ${showDatePicker ? "open" : ""}`}
                  onClick={() => {
                    const base = date ? new Date(`${date}T00:00:00`) : new Date();
                    setCalendarCursor({ year: base.getFullYear(), month: base.getMonth() });
                    setShowDatePicker((v) => !v);
                  }}
                >
                  <i className="fa-regular fa-calendar"></i>
                  <span>{date ? formatDateLong(date) : "Select a date"}</span>
                  <i className={`fa-solid fa-chevron-down rut-date-caret ${showDatePicker ? "open" : ""}`}></i>
                </button>

                {showDatePicker && (
                  <>
                    <div className="rut-date-clickaway" onClick={() => setShowDatePicker(false)}></div>
                    <div className="rut-date-popover">
                      <span className="rut-date-popover-arrow"></span>
                      <div className="rut-date-quick-row">
                        <button type="button" className={date === toDateInputValue(new Date()) ? "active" : ""} onClick={() => { setDate(toDateInputValue(new Date())); setShowDatePicker(false); }}>Today</button>
                        <button type="button" className={date === addDaysLocal(toDateInputValue(new Date()), 1) ? "active" : ""} onClick={() => { setDate(addDaysLocal(toDateInputValue(new Date()), 1)); setShowDatePicker(false); }}>Tomorrow</button>
                      </div>
                      <div className="rut-cal-header">
                        <button type="button" className="rut-cal-nav" onClick={() => setCalendarCursor((c) => { const m = c.month - 1; return m < 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month: m }; })} aria-label="Previous month">
                          <i className="fa-solid fa-chevron-left"></i>
                        </button>
                        <span className="rut-cal-title">{MONTH_NAMES[calendarCursor.month]} {calendarCursor.year}</span>
                        <button type="button" className="rut-cal-nav" onClick={() => setCalendarCursor((c) => { const m = c.month + 1; return m > 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: m }; })} aria-label="Next month">
                          <i className="fa-solid fa-chevron-right"></i>
                        </button>
                      </div>
                      <div className="rut-cal-weekdays">{WEEKDAY_LABELS.map((w) => <span key={w}>{w}</span>)}</div>
                      <div className="rut-cal-grid">
                        {buildCalendarGrid(calendarCursor.year, calendarCursor.month).map((cell, i) => {
                          const cellStr = toDateInputValue(cell.date);
                          const isSelected = cellStr === date;
                          return (
                            <button
                              type="button" key={i}
                              className={["rut-cal-day", !cell.inMonth && "is-outside", isSelected && "is-selected"].filter(Boolean).join(" ")}
                              onClick={() => { setDate(cellStr); setShowDatePicker(false); }}
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

            <button className="rut-track-btn" onClick={() => loadRooms(false)} disabled={refreshing || loading} title="Reload all room data from server">
              <i className={`fa-solid ${refreshing || loading ? "fa-spinner fa-spin" : "fa-arrows-rotate"}`} />
              {refreshing || loading ? "Loading..." : "Refresh"}
            </button>
          </div>

          <div className="rut-analytics">
            <div className="rut-analytics-card"><h3>Total Schedule</h3><h1>{analytics.totalSchedules}</h1></div>
            <div className="rut-analytics-card"><h3>Completed</h3><h1>{analytics.completed}</h1></div>
            <div className="rut-analytics-card"><h3>Ongoing</h3><h1>{analytics.ongoing}</h1></div>
            <div className="rut-analytics-card"><h3>Upcoming</h3><h1>{analytics.upcoming}</h1></div>
          </div>
        </div>

        <div className="rut-content-card">
          <div className="rut-tabs">
            <button className={`rut-tab ${activeTab === "current" ? "active" : ""}`} onClick={() => setActiveTab("current")}>Current/Upcoming Usage</button>
            <button className={`rut-tab ${activeTab === "history" ? "active" : ""}`} onClick={() => setActiveTab("history")}>Last User</button>
          </div>

          {activeTab === "current" && (
            <div className="rut-current-layout">
              <div className="rut-live-card">
                <div className="rut-live-header">
                  <div className="rut-live-indicator">
                    {isToday && <span className="rut-live-dot"></span>}
                    <span className="rut-live-label">
                      {isToday ? `Current Status of ${room}` : `Schedule for ${date} : ${room}`}
                    </span>
                  </div>
                  <span className={`rut-status-badge ${currentSchedule ? "occupied" : "vacant"}`}>
                    {currentSchedule ? "OCCUPIED" : "VACANT"}
                  </span>
                </div>

                {currentSchedule ? (
                  <>
                    <span className="rut-type-badge">{currentSchedule.sourceLabel}</span>
                    <div className="rut-live-grid">
                      <div className="rut-live-item">
                        <div className="rut-live-item-header"><div className="rut-icon-circle"><i className="fa-solid fa-book" /></div><span className="rut-item-label">SUBJECT / PURPOSE</span></div>
                        <span className="rut-item-value large">{currentSchedule.subject}</span>
                      </div>
                      <div className="rut-live-item">
                        <div className="rut-live-item-header"><div className="rut-icon-circle"><i className="fa-solid fa-building" /></div><span className="rut-item-label">ORGANIZATION</span></div>
                        <span className="rut-item-value">{currentSchedule.organization || "N/A"}</span>
                      </div>
                      <div className="rut-live-item">
                        <div className="rut-live-item-header"><div className="rut-icon-circle"><i className="fa-solid fa-user" /></div><span className="rut-item-label">FACULTY / REQUESTED BY</span></div>
                        <span className="rut-item-value">{currentSchedule.facultyName}</span>
                      </div>
                      <div className="rut-live-item">
                        <div className="rut-live-item-header"><div className="rut-icon-circle"><i className="fa-solid fa-clock" /></div><span className="rut-item-label">TIME</span></div>
                        <span className="rut-item-value">{format12Hour(currentSchedule.startTime)} - {format12Hour(currentSchedule.endTime)}</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="rut-empty-live">
                    <i className="fa-regular fa-circle-check"></i>
                    <h2>{isToday ? "Room is currently available." : "No ongoing activity to show for this date."}</h2>
                  </div>
                )}
              </div>

              <div className="rut-right-col">
                <div className="rut-specs-card">
                  <div className="rut-specs-header"><i className="fa-solid fa-circle-info" /><span>Room Information</span></div>
                  {rooms.filter((r) => (r.roomName || r.name) === room).map((r) => (
                    <div key={r.id}>
                      <div className="rut-specs-row"><span className="rut-specs-key">Capacity</span><span className="rut-specs-val">{r.capacity || "-"}</span></div>
                      <div className="rut-specs-row"><span className="rut-specs-key">Type</span><span className="rut-specs-val">{r.roomType || "-"}</span></div>
                      <div className="rut-specs-row"><span className="rut-specs-key">Floor</span><span className="rut-specs-val">{r.floor || "-"}</span></div>
                    </div>
                  ))}
                </div>

                <div className="rut-next-card">
                  <span className="rut-next-label">{isToday ? "UPCOMING SCHEDULE/S" : `SCHEDULE FOR ${date}`}</span>
                  {upcomingSchedules.length === 0 ? (
                    <div className="rut-no-upcoming">No schedules found for this day.</div>
                  ) : (
                    upcomingSchedules.map((schedule) => (
                      <div key={`${schedule.kind}-${schedule.id}`} className="rut-upcoming-item">
                        <div className="rut-upcoming-subject">{schedule.subject}</div>
                        <div className="rut-upcoming-info">{format12Hour(schedule.startTime)} - {format12Hour(schedule.endTime)}</div>
                        <div className="rut-upcoming-info">{schedule.facultyName}</div>
                        <div className="rut-upcoming-info rut-upcoming-tag">{schedule.sourceLabel}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === "history" && (
            <div className="rut-live-card">
              <h2 className="rut-history-last-title">Last User of the Room</h2>
              <div className="rut-last-user">
                <strong className="rut-last-user-title">Last User</strong>
                {lastUser ? (
                  <div className="rut-last-user-details">
                    <span>{lastUser.facultyName}</span>
                    <span>{lastUser.subject}</span>
                    <span>{lastUser.date}</span>
                    <span>{format12Hour(lastUser.startTime)} - {format12Hour(lastUser.endTime)}</span>
                    <span className="rut-type-badge">{lastUser.sourceLabel}</span>
                  </div>
                ) : (
                  <p className="rut-last-user-empty">No previous usage.</p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="rut-history-section">
          <div className="rut-history-header">
            <h2 className="rut-history-title">Recent History Log</h2>
            <button className="rut-export-btn" onClick={() => setShowExportModal(true)} disabled={history.length === 0}>
              <i className="fa-solid fa-download" />
              Export
            </button>
          </div>

          <div className="rut-table-wrap">
            <table className="rut-table">
              <thead>
                <tr><th>DATE &amp; TIME</th><th>SUBJECT/EVENT</th><th>REQUESTED BY</th><th>TYPE</th><th>STATUS</th><th>ACTIONS</th></tr>
              </thead>
              <tbody>
                {history.length === 0 && (
                  <tr><td colSpan={6} className="rut-history-placeholder">No history yet for this room.</td></tr>
                )}
                {paginatedHistory.map((schedule) => (
                  <tr key={`${schedule.kind}-${schedule.id}`}>
                    <td>
                      <div className="rut-date-cell">
                        <span className="rut-date">{schedule.date}</span>
                        <span className="rut-time">{format12Hour(schedule.startTime)} - {format12Hour(schedule.endTime)}</span>
                        {schedule.isReleased && <span className="rut-released-tag" title={`Released at ${schedule.releasedAtTime}`}>Released early</span>}
                      </div>
                    </td>
                    <td className="rut-subject">{schedule.subject}</td>
                    <td>{schedule.facultyName}</td>
                    <td><span className="rut-type-badge">{schedule.sourceLabel}</span></td>
                    <td>
                      <span className={`rut-badge ${getStatus(schedule.date, schedule.startTime, schedule.endTime).toLowerCase()}`}>
                        {getStatus(schedule.date, schedule.startTime, schedule.endTime)}
                      </span>
                    </td>
                    <td>
                      <button className="rut-action-btn" onClick={() => setSelectedRecord(schedule)}>
                        <i className="fa-solid fa-eye" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rut-pagination-row">
            <span className="rut-pagination-info">
              Showing {history.length === 0 ? 0 : (historyPage - 1) * HISTORY_PAGE_SIZE + 1} to {Math.min(historyPage * HISTORY_PAGE_SIZE, history.length)} of {history.length} records
            </span>
            <div className="rut-pagination-buttons">
              <button className="rut-pagination-nav" disabled={historyPage === 1} onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}>
                <i className="fa-solid fa-chevron-left" />
              </button>
              {renderHistoryPages()[0] > 1 && (
                <>
                  <button className="rut-pagination-page" onClick={() => setHistoryPage(1)}>1</button>
                  {renderHistoryPages()[0] > 2 && <span className="rut-pagination-ellipsis">...</span>}
                </>
              )}
              {renderHistoryPages().map((page) => (
                <button key={page} className={`rut-pagination-page ${historyPage === page ? "is-active" : ""}`} onClick={() => setHistoryPage(page)}>
                  {page}
                </button>
              ))}
              {renderHistoryPages()[renderHistoryPages().length - 1] < totalHistoryPages && (
                <>
                  {renderHistoryPages()[renderHistoryPages().length - 1] < totalHistoryPages - 1 && (
                    <span className="rut-pagination-ellipsis">...</span>
                  )}
                  <button className="rut-pagination-page" onClick={() => setHistoryPage(totalHistoryPages)}>{totalHistoryPages}</button>
                </>
              )}
              <button className="rut-pagination-nav" disabled={historyPage >= totalHistoryPages} onClick={() => setHistoryPage((p) => Math.min(totalHistoryPages, p + 1))}>
                <i className="fa-solid fa-chevron-right" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {selectedRecord && (
        <div className="rut-modal-overlay" onClick={() => setSelectedRecord(null)}>
          <div className="rut-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="rut-modal-header">
              <span className="rut-type-badge">{selectedRecord.sourceLabel}</span>
              <button className="rut-modal-close" onClick={() => setSelectedRecord(null)}>
                <i className="fa-solid fa-xmark" />
              </button>
            </div>
            <h2 className="rut-modal-subject">{selectedRecord.subject}</h2>
            <div className="rut-modal-grid">
              <div className="rut-modal-field"><span className="rut-modal-label">REQUESTED BY</span><span className="rut-modal-value">{selectedRecord.facultyName}</span></div>
              <div className="rut-modal-field"><span className="rut-modal-label">SECTION</span><span className="rut-modal-value">{selectedRecord.section || "-"}</span></div>
              <div className="rut-modal-field"><span className="rut-modal-label">DATE</span><span className="rut-modal-value">{selectedRecord.date}</span></div>
              <div className="rut-modal-field"><span className="rut-modal-label">TIME</span><span className="rut-modal-value">{format12Hour(selectedRecord.startTime)} - {format12Hour(selectedRecord.endTime)}</span></div>
              {selectedRecord.isReleased && (
                <div className="rut-modal-field"><span className="rut-modal-label">RELEASED AT</span><span className="rut-modal-value">{selectedRecord.releasedAtTime}</span></div>
              )}
            </div>
          </div>
        </div>
      )}

      <ExportModal
        isOpen={showExportModal}
        onClose={() => setShowExportModal(false)}
        title="Export Room Usage"
        filenamePrefix="SpaceSCICT_RoomUsage"
        exporting={exporting}
        onExport={handleExportReport}
      />

      <Toast show={toast.show} type={toast.type} title={toast.title} message={toast.message} onClose={() => setToast((prev) => ({ ...prev, show: false }))} />
    </>
  );
}