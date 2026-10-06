import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import "./clerk-reservations.css";
import ReservationCard from "../../Components/ReservationCard/ReservationCard";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  writeBatch,
} from "firebase/firestore";
import { db } from "../../firebase";
import Toast from "../../Popup/Toast/Toast";
import ExportModal from "../../Components/ExportModal/ExportModal";

// ─── PDF Libraries & Logos ──────────────────────────────────────────
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import universityLogo from "../../assets/BSU-Logo.png";
import collegeLogo from "../../assets/CICT-Logo.png";

// ─── School Header ──────────────────────────────────────────────────
const SCHOOL_HEADER = {
  universityLogoUrl: universityLogo,
  collegeLogoUrl: collegeLogo,
  universityName: "Bulacan State University",
  collegeName: "College of Information and Communications Technology",
  systemName: "SpaceS CICT",
};

// ─── Tabs — "All" added ────────────────────────────────────────────
const TABS = ["All", "Pending", "Approved", "Denied", "Cancelled"];
const PAGE_SIZE = 5;

// ─── Helpers ───────────────────────────────────────────────────────────
const normalizeStatus = (status) => status?.toLowerCase().trim() || "";
const normalizeRoom = (name) =>
  name?.toLowerCase().trim().replace(/\s+/g, "") || "";

const getToday = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const format12Hour = (time) => {
  if (!time) return "-";
  const [hour, minute] = time.split(":").map(Number);
  if (isNaN(hour) || isNaN(minute)) return time;
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return `${h}:${String(minute).padStart(2, "0")} ${suffix}`;
};

// ─── Date picker helpers ────────────────────────────────────────────
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

const formatDateLong = (dateStr) => {
  if (!dateStr) return "-";
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
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

// ─── Base path resolver — depende sa status ─────────────────────
const getBasePathForStatus = (status) => {
  const s = normalizeStatus(status);
  if (s === "approved") return "/clerk/view-reservation-approved";
  if (s === "rejected") return "/clerk/view-reservation-denied";
  if (s === "cancelled") return "/clerk/view-reservation-cancelled";
  return "/clerk/view-online-reservation"; // pending default
};

// ─── Empty icon (SVG) ──────────────────────────────────────────────────
const EmptyIcon = () => (
  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="5" width="18" height="16" rx="2" stroke="#CBD5E1" strokeWidth="1.5" />
    <path d="M3 9H21" stroke="#CBD5E1" strokeWidth="1.5" />
    <path d="M8 3V6" stroke="#CBD5E1" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M16 3V6" stroke="#CBD5E1" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M8 13.5L10.5 16L15.5 11" stroke="#CBD5E1" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function SkeletonCard() {
  return (
    <div className="clerk-skeleton-card">
      <div className="clerk-skeleton-line clerk-skeleton-title" />
      <div className="clerk-skeleton-line clerk-skeleton-subtitle" />
      <div className="clerk-skeleton-row">
        <div className="clerk-skeleton-pill" />
        <div className="clerk-skeleton-pill" />
      </div>
    </div>
  );
}

function EmptyState({ label }) {
  return (
    <div className="clerk-empty-state">
      <EmptyIcon />
      <p className="clerk-empty-title">No {label} reservations</p>
      <p className="clerk-empty-subtitle">
        Requests will show up here as soon as they come in.
      </p>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────
function ClerkReservations() {
  const [activeTab, setActiveTab] = useState("All");
  const navigate = useNavigate();
  const [reservations, setReservations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // ─── Filter/sort state ─────────────────────────────────────────────
  const [searchTerm, setSearchTerm] = useState("");
  const [filterRoom, setFilterRoom] = useState("");
  const [filterDate, setFilterDate] = useState("");
  const [sortOrder, setSortOrder] = useState("desc");

  // ─── Room picker popover ────────────────────────────────────────────
  const [showRoomPicker, setShowRoomPicker] = useState(false);
  const [roomSearch, setRoomSearch] = useState("");

  // ─── Date picker popover ────────────────────────────────────────────
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [calendarCursor, setCalendarCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  // ─── Export state ──────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);

  const [toast, setToast] = useState({
    show: false,
    type: "",
    title: "",
    message: "",
  });

  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    if (type !== "loading") {
      setTimeout(() => setToast((prev) => ({ ...prev, show: false })), 3000);
    }
  };

  // ─── Auto-cancel past-dated pending ────────────────────────────────
  const autoCancelPastReservations = async () => {
    const now = new Date();
    const pendingPast = reservations.filter((r) => {
      if (normalizeStatus(r.status) !== "pending") return false;
      if (!r.date || !r.endTime) return false;
      const [year, month, day] = r.date.split("-").map(Number);
      const [hour, minute] = r.endTime.split(":").map(Number);
      const reservationEnd = new Date(year, month - 1, day, hour, minute);
      return reservationEnd < now;
    });

    if (pendingPast.length === 0) return;

    try {
      const batch = writeBatch(db);
      pendingPast.forEach((r) => {
        const ref = doc(db, "reservationRequests", r.id);
        batch.update(ref, {
          status: "Cancelled",
          cancellationReason:
            "The reservation end time has passed without approval or denial.",
          cancelledAt: new Date(),
        });
      });
      await batch.commit();
    } catch (err) {
      console.error("Auto-cancel failed:", err);
    }
  };

  useEffect(() => {
    const q = query(collection(db, "reservationRequests"), orderBy("createdAt", "desc"));
    const unsubscribe = onSnapshot(
      q,
      async (snapshot) => {
        const list = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        setReservations(list);
        setLoading(false);
        if (!loading) {
          await autoCancelPastReservations();
        }
      },
      (error) => {
        console.error(error);
        setLoading(false);
      }
    );
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!loading && reservations.length > 0) {
      autoCancelPastReservations();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservations]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [activeTab]);

  // ─── Status mapping ─────────────────────────────────────────────
  const statusMap = {
    All: null,
    Pending: "pending",
    Approved: "approved",
    Denied: "rejected",
    Cancelled: "cancelled",
  };

  const tabFiltered =
    statusMap[activeTab] === null
      ? reservations
      : reservations.filter(
          (r) => normalizeStatus(r.status) === statusMap[activeTab]
        );

  const trimmedSearch = searchTerm.trim().toLowerCase();

  const filtered = tabFiltered.filter((r) => {
    const name = (r.facultyName || r.requesterName || "").toLowerCase();
    if (trimmedSearch && !name.includes(trimmedSearch)) return false;

    const roomNameNormalized = normalizeRoom(r.roomName);
    const filterRoomNormalized = normalizeRoom(filterRoom);
    if (filterRoom && roomNameNormalized !== filterRoomNormalized) return false;

    if (filterDate && r.date !== filterDate) return false;

    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const aVal = a.date || "";
    const bVal = b.date || "";
    if (aVal < bVal) return sortOrder === "asc" ? -1 : 1;
    if (aVal > bVal) return sortOrder === "asc" ? 1 : -1;
    return 0;
  });

  const visibleReservations = sorted.slice(0, visibleCount);
  const hasMore = visibleCount < sorted.length;

  const counts = {
    All: reservations.length,
    Pending: reservations.filter((r) => normalizeStatus(r.status) === "pending").length,
    Approved: reservations.filter((r) => normalizeStatus(r.status) === "approved").length,
    Denied: reservations.filter((r) => normalizeStatus(r.status) === "rejected").length,
    Cancelled: reservations.filter((r) => normalizeStatus(r.status) === "cancelled").length,
  };

  const roomMap = useMemo(() => {
    const map = new Map();
    reservations.forEach((r) => {
      const original = (r.roomName || "").trim();
      if (!original) return;
      const normalized = normalizeRoom(original);
      if (!map.has(normalized)) {
        map.set(normalized, original);
      }
    });
    return map;
  }, [reservations]);

  const roomOptions = useMemo(
    () =>
      Array.from(roomMap.entries())
        .map(([normalized, original]) => ({
          normalized,
          original,
        }))
        .sort((a, b) =>
          a.original.localeCompare(b.original, undefined, {
            sensitivity: "base",
            numeric: true,
          })
        ),
    [roomMap]
  );

  const filteredRoomOptions = useMemo(() => {
    const q = roomSearch.trim().toLowerCase();
    if (!q) return roomOptions;
    return roomOptions.filter((o) => o.original.toLowerCase().includes(q));
  }, [roomOptions, roomSearch]);

  const selectedRoomLabel = useMemo(() => {
    if (!filterRoom) return "All Rooms";
    const found = roomOptions.find((o) => o.normalized === filterRoom);
    return found ? found.original : filterRoom;
  }, [filterRoom, roomOptions]);

  const clearFilters = () => {
    setSearchTerm("");
    setFilterRoom("");
    setFilterDate("");
    setSortOrder("desc");
  };

  // ─── EXPORT HANDLER (via shared ExportModal) ───────────────────────
  const handleExportReport = async ({ range, from, to, format }) => {
    let rows = sorted;

    if (range === "range" && from && to) {
      const start = new Date(from + "T00:00:00");
      const end = new Date(to + "T23:59:59");
      rows = sorted.filter((r) => {
        if (!r.date) return false;
        const d = new Date(r.date + "T00:00:00");
        return d >= start && d <= end;
      });
    }

    if (rows.length === 0) {
      showToast("error", "Nothing to Export", "No reservations in the selected range.");
      return;
    }

    setExporting(true);
    showToast("loading", "Generating...", "Please wait.");

    try {
      if (format === "csv") {
        const headers = [
          "Faculty/Requester", "Room", "Date", "Start Time", "End Time",
          "Purpose", "Status", "Organization", "Section",
        ];
        const body = rows.map((r) => [
          r.facultyName || r.requesterName || "-",
          r.roomName || "-",
          r.date || "-",
          r.startTime ? format12Hour(r.startTime) : "-",
          r.endTime ? format12Hour(r.endTime) : "-",
          r.customPurpose || r.purpose || r.courseTitle || "-",
          r.status || "-",
          r.organizationName || r.attendees?.organization || "-",
          r.yearSectionGroup || r.attendees?.yearSectionGroup || "-",
        ]);
        const csvContent = [headers, ...body]
          .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
          .join("\n");
        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `SpaceSCICT_Reservations(${getToday()}).csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      } else {
        const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
        const pageWidth = pdf.internal.pageSize.getWidth();
        const marginX = 40;
        const logoSize = 40;
        const centerX = pageWidth / 2;

        if (SCHOOL_HEADER.universityLogoUrl) {
          pdf.addImage(SCHOOL_HEADER.universityLogoUrl, "PNG", marginX, 20, logoSize, logoSize);
        }
        if (SCHOOL_HEADER.collegeLogoUrl) {
          pdf.addImage(SCHOOL_HEADER.collegeLogoUrl, "PNG", pageWidth - marginX - logoSize, 20, logoSize, logoSize);
        }

        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(13);
        pdf.setTextColor(20, 27, 45);
        pdf.text(SCHOOL_HEADER.universityName, centerX, 34, { align: "center" });

        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(9);
        pdf.setTextColor(107, 114, 128);
        pdf.text(SCHOOL_HEADER.collegeName, centerX, 48, { align: "center" });
        pdf.text(SCHOOL_HEADER.systemName, centerX, 58, { align: "center" });

        pdf.setDrawColor(245, 124, 0);
        pdf.setLineWidth(1.5);
        pdf.line(marginX, 74, pageWidth - marginX, 74);

        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(16);
        pdf.setTextColor(245, 124, 0);
        pdf.text(`Reservation Report — ${activeTab}`, marginX, 98);

        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(9);
        pdf.setTextColor(107, 114, 128);

        let filterSummary = "";
        if (searchTerm) filterSummary += `Faculty: ${searchTerm} | `;
        if (filterRoom) filterSummary += `Room: ${selectedRoomLabel} | `;
        if (filterDate) filterSummary += `Date: ${filterDate} | `;
        if (range === "range") filterSummary += `Range: ${from} to ${to} | `;
        if (!filterSummary) filterSummary = "All reservations";

        pdf.text(`Filters: ${filterSummary}`, marginX, 112);
        pdf.text(
          `Generated: ${new Date().toLocaleString()}`,
          pageWidth - marginX, 112, { align: "right" }
        );

        const tableRows = rows.map((r) => [
          r.facultyName || r.requesterName || "-",
          r.roomName || "-",
          r.date || "-",
          r.startTime ? format12Hour(r.startTime) : "-",
          r.endTime ? format12Hour(r.endTime) : "-",
          r.customPurpose || r.purpose || r.courseTitle || "-",
          r.status || "-",
          r.organizationName || r.attendees?.organization || "-",
          r.yearSectionGroup || r.attendees?.yearSectionGroup || "-",
        ]);

        autoTable(pdf, {
          startY: 130,
          head: [["Faculty", "Room", "Date", "Start", "End", "Purpose", "Status", "Organization", "Section"]],
          body: tableRows,
          theme: "grid",
          styles: { font: "helvetica", fontSize: 7, cellPadding: 4, valign: "middle" },
          headStyles: { fillColor: [245, 124, 0], textColor: [255, 255, 255], fontStyle: "bold", fontSize: 7 },
          bodyStyles: { textColor: [26, 26, 26] },
          alternateRowStyles: { fillColor: [253, 246, 240] },
          margin: { left: marginX, right: marginX },
        });

        const pageCount = pdf.internal.getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
          pdf.setPage(i);
          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(7);
          pdf.setTextColor(150, 150, 150);
          pdf.text(`Page ${i} of ${pageCount}`, pageWidth - marginX, pdf.internal.pageSize.getHeight() - 16, { align: "right" });
          pdf.text(`${SCHOOL_HEADER.systemName} — Confidential`, marginX, pdf.internal.pageSize.getHeight() - 16);
        }

        pdf.save(`SpaceSCICT_Reservations(${getToday()}).pdf`);
      }

      showToast("success", "Exported", `${rows.length} reservation(s) exported.`);
      setShowExportModal(false);
    } catch (err) {
      console.error("Export failed:", err);
      showToast("error", "Export Failed", "Could not export. Please try again.");
    } finally {
      setExporting(false);
    }
  };

  // ─── renderList — ReservationCard for ALL tabs ────────────────────
  const renderList = () => {
    if (loading) {
      return Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />);
    }
    if (sorted.length === 0) {
      return <EmptyState label={activeTab.toLowerCase()} />;
    }

    return visibleReservations.map((reservation) => {
      const isPending = normalizeStatus(reservation.status) === "pending";

      return (
        <ReservationCard
          key={reservation.id}
          reservation={reservation}
          basePath={getBasePathForStatus(reservation.status)}
          readOnly={!isPending}
        />
      );
    });
  };

  const isEmpty = !loading && sorted.length === 0;

  return (
    <div className="clerk-reservations">
      <div className="clerk-reservations-header">
        <div className="clerk-reservations-header-top">
          <div>
            <h1>Reservation Requests</h1>
            <p className="clerk-reservations-subtitle">
              Review, approve, and track room reservation requests from your department.
            </p>
          </div>

          <button
            className="clerk-export-btn"
            onClick={() => setShowExportModal(true)}
            disabled={loading || sorted.length === 0}
          >
            <i className="fa-solid fa-download"></i> Export Report
          </button>
        </div>
      </div>

      {/* ── Filter Bar ── */}
      <div className="clerk-filter-bar-outer">
        <div className="clerk-filter-row">
          {/* SEARCH */}
          <div className="clerk-filter-group clerk-search-group">
            <i className="fa-solid fa-magnifying-glass"></i>
            <input
              type="text"
              placeholder="Search by faculty..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="clerk-filter-input"
            />
          </div>

          {/* ROOM PICKER */}
          <div className="clerk-filter-group cr-picker-group">
            <div className="cr-roompicker">
              <button
                type="button"
                className={`cr-room-trigger ${showRoomPicker ? "open" : ""}`}
                onClick={() => {
                  setRoomSearch("");
                  setShowRoomPicker((v) => !v);
                }}
              >
                <i className="fa-solid fa-building"></i>
                <span className="cr-room-trigger-text">{selectedRoomLabel}</span>
                <i className={`fa-solid fa-chevron-down cr-room-caret ${showRoomPicker ? "open" : ""}`}></i>
              </button>

              {showRoomPicker && (
                <>
                  <div className="cr-picker-clickaway" onClick={() => setShowRoomPicker(false)}></div>
                  <div className="cr-room-popover">
                    <span className="cr-popover-arrow"></span>

                    <div className="cr-search-wrap">
                      <i className="fa-solid fa-magnifying-glass"></i>
                      <input
                        type="text"
                        className="cr-search"
                        placeholder="Search room..."
                        value={roomSearch}
                        onChange={(e) => setRoomSearch(e.target.value)}
                        autoFocus
                      />
                      {roomSearch && (
                        <button type="button" className="cr-search-clear" onClick={() => setRoomSearch("")}>
                          <i className="fa-solid fa-xmark"></i>
                        </button>
                      )}
                    </div>

                    <div className="cr-room-list">
                      <button
                        type="button"
                        className={`cr-room-option ${!filterRoom ? "is-active" : ""}`}
                        onClick={() => {
                          setFilterRoom("");
                          setShowRoomPicker(false);
                          setRoomSearch("");
                        }}
                      >
                        <div className="cr-room-option-icon">
                          <i className="fa-solid fa-layer-group"></i>
                        </div>
                        <span className="cr-room-option-name">All Rooms</span>
                        {!filterRoom && <i className="fa-solid fa-circle-check cr-room-option-check"></i>}
                      </button>

                      {filteredRoomOptions.length === 0 && roomSearch ? (
                        <div className="cr-picker-empty">
                          <i className="fa-regular fa-face-frown"></i>
                          <span>No rooms match.</span>
                        </div>
                      ) : (
                        filteredRoomOptions.map(({ normalized, original }) => {
                          const isActive = normalized === filterRoom;
                          return (
                            <button
                              type="button"
                              key={normalized}
                              className={`cr-room-option ${isActive ? "is-active" : ""}`}
                              onClick={() => {
                                setFilterRoom(normalized);
                                setShowRoomPicker(false);
                                setRoomSearch("");
                              }}
                            >
                              <div className="cr-room-option-icon">
                                <i className="fa-solid fa-door-open"></i>
                              </div>
                              <span className="cr-room-option-name">{original}</span>
                              {isActive && <i className="fa-solid fa-circle-check cr-room-option-check"></i>}
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
          <div className="clerk-filter-group cr-picker-group">
            <div className="cr-datepicker">
              <button
                type="button"
                className={`cr-date-trigger ${showDatePicker ? "open" : ""}`}
                onClick={() => {
                  const base = filterDate ? new Date(`${filterDate}T00:00:00`) : new Date();
                  setCalendarCursor({
                    year: base.getFullYear(),
                    month: base.getMonth(),
                  });
                  setShowDatePicker((v) => !v);
                }}
              >
                <i className="fa-regular fa-calendar"></i>
                <span>{filterDate ? formatDateLong(filterDate) : "All Dates"}</span>
                <i className={`fa-solid fa-chevron-down cr-date-caret ${showDatePicker ? "open" : ""}`}></i>
              </button>

              {showDatePicker && (
                <>
                  <div className="cr-picker-clickaway" onClick={() => setShowDatePicker(false)}></div>
                  <div className="cr-date-popover">
                    <span className="cr-popover-arrow"></span>

                    <div className="cr-date-quick-row">
                      <button
                        type="button"
                        className={!filterDate ? "active" : ""}
                        onClick={() => {
                          setFilterDate("");
                          setShowDatePicker(false);
                        }}
                      >
                        All Dates
                      </button>
                      <button
                        type="button"
                        className={filterDate === toDateInputValue(new Date()) ? "active" : ""}
                        onClick={() => {
                          setFilterDate(toDateInputValue(new Date()));
                          setShowDatePicker(false);
                        }}
                      >
                        Today
                      </button>
                    </div>

                    <div className="cr-cal-header">
                      <button
                        type="button"
                        className="cr-cal-nav"
                        onClick={() =>
                          setCalendarCursor((c) => {
                            const m = c.month - 1;
                            return m < 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month: m };
                          })
                        }
                      >
                        <i className="fa-solid fa-chevron-left"></i>
                      </button>
                      <span className="cr-cal-title">
                        {MONTH_NAMES[calendarCursor.month]} {calendarCursor.year}
                      </span>
                      <button
                        type="button"
                        className="cr-cal-nav"
                        onClick={() =>
                          setCalendarCursor((c) => {
                            const m = c.month + 1;
                            return m > 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: m };
                          })
                        }
                      >
                        <i className="fa-solid fa-chevron-right"></i>
                      </button>
                    </div>

                    <div className="cr-cal-weekdays">
                      {WEEKDAY_LABELS.map((w) => <span key={w}>{w}</span>)}
                    </div>

                    <div className="cr-cal-grid">
                      {buildCalendarGrid(calendarCursor.year, calendarCursor.month).map((cell, i) => {
                        const cellStr = toDateInputValue(cell.date);
                        const isSelected = cellStr === filterDate;
                        return (
                          <button
                            type="button"
                            key={i}
                            className={["cr-cal-day", !cell.inMonth && "is-outside", isSelected && "is-selected"].filter(Boolean).join(" ")}
                            onClick={() => {
                              setFilterDate(cellStr);
                              setShowDatePicker(false);
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

          {/* SORT BY DATE */}
          <button
            type="button"
            className={`clerk-date-sort-btn ${sortOrder}`}
            onClick={() => setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"))}
            title={
              sortOrder === "asc"
                ? "Currently showing oldest first — click for newest first"
                : "Currently showing newest first — click for oldest first"
            }
          >
            <i className={`fa-solid fa-arrow-${sortOrder === "asc" ? "up-long" : "down-long"}`}></i>
            <span>{sortOrder === "asc" ? "Oldest First" : "Newest First"}</span>
          </button>

          <button className="clerk-clear-filters-btn" onClick={clearFilters}>
            <i className="fa-solid fa-rotate-left"></i> Clear
          </button>
        </div>

        {(searchTerm || filterRoom || filterDate) && (
          <div className="clerk-filter-summary">
            <span>Active filters:</span>
            {searchTerm && <span className="clerk-filter-tag">Faculty: {searchTerm}</span>}
            {filterRoom && <span className="clerk-filter-tag">Room: {selectedRoomLabel}</span>}
            {filterDate && <span className="clerk-filter-tag">Date: {filterDate}</span>}
            <span className="clerk-filter-result-count">
              {sorted.length} result{sorted.length !== 1 ? "s" : ""}
            </span>
          </div>
        )}
      </div>

      <div className="clerk-white-box-reservations">
        <div className="clerk-reservations-nav">
          {TABS.map((tab) => (
            <div
              key={tab}
              className={`clerk-reservations-nav-item ${activeTab === tab ? "active" : ""}`}
              onClick={() => setActiveTab(tab)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setActiveTab(tab);
              }}
            >
              {tab}
              {!loading && <span className="clerk-reservations-nav-count">{counts[tab]}</span>}
            </div>
          ))}
        </div>
        <hr className="clerk-reservations-nav-divider" />

        <div className={`clerk-reservations-content ${isEmpty ? "clerk-reservations-content--empty" : ""}`}>
          {renderList()}
        </div>

        {!loading && hasMore && (
          <div className="clerk-load-more-reservations">
            <button
              className="clerk-load-more-btn-reservations"
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
            >
              Load More ({sorted.length - visibleCount} remaining)
            </button>
          </div>
        )}
      </div>

      <ExportModal
        isOpen={showExportModal}
        onClose={() => setShowExportModal(false)}
        title="Export Reservation Report"
        filenamePrefix="SpaceSCICT_Reservations"
        exporting={exporting}
        onExport={handleExportReport}
      />

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

export default ClerkReservations;