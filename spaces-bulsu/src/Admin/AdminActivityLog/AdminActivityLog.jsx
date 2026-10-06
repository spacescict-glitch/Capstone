import React, { useState, useEffect, useMemo, useRef } from 'react';
import './admin-activity-log.css';
import { useNavigate } from "react-router-dom";
import {
  collection,
  onSnapshot,
  query,
  orderBy,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import Toast from "../../Popup/Toast/Toast";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import universityLogo from "../../assets/BSU-Logo.png";
import collegeLogo from "../../assets/CICT-Logo.png";

const tabs = ['All Activities', 'System Changes', 'Security Logs'];
const ITEMS_PER_PAGE = 10;

const SCHOOL_HEADER = {
  universityLogoUrl: universityLogo,
  collegeLogoUrl: collegeLogo,
  universityName: "Bulacan State University",
  collegeName: "College of Information and Communications Technology",
  systemName: "SpaceS CICT",
};

// ═════════════════════════════════════════════════════════════════════
// CUSTOM FILTER SELECT — pretty dropdown with icons
// ═════════════════════════════════════════════════════════════════════
function FilterSelect({
  value,
  onChange,
  options = [],
  icon = "fa-solid fa-filter",
  label,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    const handle = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    document.addEventListener("touchstart", handle);
    return () => {
      document.removeEventListener("mousedown", handle);
      document.removeEventListener("touchstart", handle);
    };
  }, []);

  const selected = options.find((o) => o.value === value) || options[0];

  return (
    <div className="fs-wrap" ref={wrapRef}>
      {label && <label className="fs-label">{label}</label>}
      <button
        type="button"
        className={`fs-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="fs-trigger-icon">
          <i className={selected?.icon || icon}></i>
        </span>
        <span className="fs-trigger-text">{selected?.label || value}</span>
        <i className={`fa-solid fa-chevron-down fs-caret ${open ? "open" : ""}`}></i>
      </button>

      {open && (
        <>
          <div className="fs-clickaway" onClick={() => setOpen(false)} />
          <div className="fs-popover" role="listbox">
            <span className="fs-arrow" />
            <div className="fs-list">
              {options.map((o) => {
                const isActive = o.value === value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    className={`fs-option ${isActive ? "is-active" : ""}`}
                    onClick={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                  >
                    <span className="fs-option-icon">
                      <i className={o.icon || icon}></i>
                    </span>
                    <span className="fs-option-label">{o.label}</span>
                    {isActive && (
                      <i className="fa-solid fa-circle-check fs-option-check" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// CUSTOM DATE PICKER — pretty calendar popover
// ═════════════════════════════════════════════════════════════════════
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

const formatPrettyDate = (isoStr) => {
  if (!isoStr) return "—";
  const d = new Date(isoStr + "T00:00:00");
  if (Number.isNaN(d.getTime())) return isoStr;
  return d.toLocaleDateString("en-US", {
    month: "short",
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

function DatePickerInput({
  value,
  onChange,
  placeholder = "Select a date",
  min,
  max,
  label,
  disabled,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const [cursor, setCursor] = useState(() => {
    const base = value ? new Date(value + "T00:00:00") : new Date();
    return { year: base.getFullYear(), month: base.getMonth() };
  });

  useEffect(() => {
    const handle = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    document.addEventListener("touchstart", handle);
    return () => {
      document.removeEventListener("mousedown", handle);
      document.removeEventListener("touchstart", handle);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const base = value ? new Date(value + "T00:00:00") : new Date();
    setCursor({ year: base.getFullYear(), month: base.getMonth() });
  }, [open, value]);

  const minDate = min ? new Date(min + "T00:00:00") : null;
  const maxDate = max ? new Date(max + "T00:00:00") : null;

  const handleDayClick = (cell) => {
    if (disabled) return;
    const cellStr = toDateInputValue(cell.date);
    if (minDate && cell.date < minDate) return;
    if (maxDate && cell.date > maxDate) return;
    onChange(cellStr);
    setOpen(false);
  };

  const goPrevMonth = () =>
    setCursor((c) => {
      const m = c.month - 1;
      return m < 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month: m };
    });

  const goNextMonth = () =>
    setCursor((c) => {
      const m = c.month + 1;
      return m > 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: m };
    });

  const goToday = () => {
    const t = new Date();
    setCursor({ year: t.getFullYear(), month: t.getMonth() });
    if (minDate && t < minDate) return;
    if (maxDate && t > maxDate) return;
    onChange(toDateInputValue(t));
    setOpen(false);
  };

  const clearValue = () => {
    if (disabled) return;
    onChange("");
  };

  return (
    <div className="dp-wrap" ref={wrapRef}>
      {label && <label className="dp-label">{label}</label>}

      <button
        type="button"
        className={`dp-trigger ${open ? "open" : ""} ${!value ? "is-placeholder" : ""}`}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
      >
        <i className="fa-regular fa-calendar dp-trigger-icon" />
        <span className="dp-trigger-text">
          {value ? formatPrettyDate(value) : placeholder}
        </span>
        {value && !disabled ? (
          <span
            className="dp-clear"
            onClick={(e) => {
              e.stopPropagation();
              clearValue();
            }}
            role="button"
            aria-label="Clear date"
          >
            <i className="fa-solid fa-xmark" />
          </span>
        ) : (
          <i className={`fa-solid fa-chevron-down dp-caret ${open ? "open" : ""}`} />
        )}
      </button>

      {open && (
        <>
          <div className="dp-clickaway" onClick={() => setOpen(false)} />
          <div className="dp-popover">
            <span className="dp-arrow" />

            <div className="dp-cal-header">
              <button
                type="button"
                className="dp-cal-nav"
                onClick={goPrevMonth}
                aria-label="Previous month"
              >
                <i className="fa-solid fa-chevron-left" />
              </button>
              <span className="dp-cal-title">
                {MONTH_NAMES[cursor.month]} {cursor.year}
              </span>
              <button
                type="button"
                className="dp-cal-nav"
                onClick={goNextMonth}
                aria-label="Next month"
              >
                <i className="fa-solid fa-chevron-right" />
              </button>
            </div>

            <div className="dp-cal-weekdays">
              {WEEKDAY_LABELS.map((w) => (
                <span key={w}>{w}</span>
              ))}
            </div>

            <div className="dp-cal-grid">
              {buildCalendarGrid(cursor.year, cursor.month).map((cell, i) => {
                const cellStr = toDateInputValue(cell.date);
                const isSelected = cellStr === value;
                const isToday = cellStr === toDateInputValue(new Date());
                const isDisabled =
                  (minDate && cell.date < minDate) ||
                  (maxDate && cell.date > maxDate);

                return (
                  <button
                    type="button"
                    key={i}
                    disabled={isDisabled}
                    className={[
                      "dp-cal-day",
                      !cell.inMonth && "is-outside",
                      isSelected && "is-selected",
                      isToday && !isSelected && "is-today",
                      isDisabled && "is-disabled",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => handleDayClick(cell)}
                  >
                    {cell.day}
                  </button>
                );
              })}
            </div>

            <div className="dp-cal-footer">
              <button
                type="button"
                className="dp-cal-footer-btn"
                onClick={goToday}
              >
                Today
              </button>
              <button
                type="button"
                className="dp-cal-footer-btn muted"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// ICONS & HELPERS
// ═════════════════════════════════════════════════════════════════════
const actionIcon = (type) => {
  switch (type) {
    case 'success':  return <i className="fa-solid fa-circle-check action-icon green"></i>;
    case 'edit':     return <i className="fa-solid fa-pen action-icon blue"></i>;
    case 'denied':   return <i className="fa-solid fa-circle-xmark action-icon red"></i>;
    case 'failed':   return <i className="fa-solid fa-circle-xmark action-icon red"></i>;
    case 'warning':  return <i className="fa-solid fa-triangle-exclamation action-icon orange"></i>;
    default:         return <i className="fa-solid fa-bolt action-icon orange"></i>;
  }
};

const reasonLabel = (reason) => {
  switch (reason) {
    case "role_mismatch":      return "Wrong Role Attempt";
    case "wrong_password":     return "Wrong Password";
    case "invalid_credentials":return "Invalid Credentials";
    case "user_not_found":     return "Unknown Email";
    default:                   return "Failed Login";
  }
};

const getTodayISO = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

// ─── Filter option definitions ───
const DATE_RANGE_OPTIONS = [
  { value: "Last 7 Days",  label: "Last 7 Days",  icon: "fa-regular fa-calendar" },
  { value: "Last 30 Days", label: "Last 30 Days", icon: "fa-regular fa-calendar-days" },
  { value: "Last 90 Days", label: "Last 90 Days", icon: "fa-regular fa-calendar-check" },
];

const ROLE_OPTIONS = [
  { value: "All Roles",       label: "All Roles",       icon: "fa-solid fa-users" },
  { value: "Admin",           label: "Admin",           icon: "fa-solid fa-user-shield" },
  { value: "Faculty",         label: "Faculty",         icon: "fa-solid fa-chalkboard-user" },
  { value: "Clerk",           label: "Clerk",           icon: "fa-solid fa-user-tie" },
  { value: "Local Registrar", label: "Local Registrar", icon: "fa-solid fa-user-graduate" },
];

const ACTION_OPTIONS = [
  { value: "All Actions", label: "All Actions", icon: "fa-solid fa-filter" },
  { value: "Success",     label: "Success",     icon: "fa-solid fa-circle-check" },
  { value: "Failed",      label: "Failed",      icon: "fa-solid fa-circle-xmark" },
  { value: "Warning",     label: "Warning",     icon: "fa-solid fa-triangle-exclamation" },
];

export default function AdminActivityLog() {
  const [activeTab, setActiveTab] = useState('All Activities');
  const [dateRange, setDateRange] = useState('Last 7 Days');
  const [userRole, setUserRole] = useState('All Roles');
  const [actionType, setActionType] = useState('All Actions');
  const [currentPage, setCurrentPage] = useState(1);
  const navigate = useNavigate();
  const [logs, setLogs] = useState([]);
  const [securityLogs, setSecurityLogs] = useState([]);
  const [todayCount, setTodayCount] = useState(0);
  const [alertCount, setAlertCount] = useState(0);
  const [blockedCount, setBlockedCount] = useState(0);

  const [showExportModal, setShowExportModal] = useState(false);
  const [exportRange, setExportRange] = useState("all");
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");
  const [exportFormat, setExportFormat] = useState("csv");
  const [exporting, setExporting] = useState(false);

  const [toast, setToast] = useState({
    show: false,
    message: "",
    type: "loading",
  });

  const showToast = (message, type = "success") => {
    setToast({ show: true, message, type });
    if (type !== "loading") {
      setTimeout(() => {
        setToast({ show: false, message: "", type: "loading" });
      }, 2500);
    }
  };

  useEffect(() => {
    const q = query(collection(db, "activityLogs"), orderBy("timestamp", "desc"));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      setLogs(data);

      const today = new Date().toDateString();
      const todayLogs = data.filter((log) =>
        log.timestamp?.toDate?.().toDateString() === today
      );
      setTodayCount(todayLogs.length);

      const alerts = data.filter(
        (log) => log.actionType === "failed" || log.actionType === "denied" || log.actionType === "warning"
      );
      setAlertCount(alerts.length);
    });

    return () => unsubscribe();
  }, []);

    // ─── Fetch securityLogs (para sa Security Logs tab) ───────────────
    useEffect(() => {
      const q = query(collection(db, "securityLogs"), orderBy("timestamp", "desc"));
      const unsubscribe = onSnapshot(q, (snapshot) => {
        const data = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        setSecurityLogs(data);
      });
      return () => unsubscribe();
    }, []);

    useEffect(() => {
      const q = query(
        collection(db, "users"),
        where("status", "==", "Blocked")
      );
      const unsubscribe = onSnapshot(
        q,
        (snapshot) => setBlockedCount(snapshot.size),
        (err) => console.error("Blocked users listener:", err)
      );
      return () => unsubscribe();
    }, []);
    
  const normalizedSecurityLogs = useMemo(() => {
    return securityLogs.map((s) => ({
      id: `sec_${s.id}`,
      _kind: "security",
      user: s.email || "Unknown",
      role: s.attemptedRole || "Unknown",
      action: reasonLabel(s.reason) + (s.blocked ? " (Blocked)" : ""),
      actionType: s.blocked ? "failed" : "warning",
      target: s.email || "—",
      status: s.blocked ? "BLOCKED" : "WARNING",
      timestamp: s.timestamp,
      attemptNumber: s.attemptNumber,
      userAgent: s.userAgent,
      reason: s.reason,
    }));
  }, [securityLogs]);

  const sourceLogs = useMemo(() => {
    if (activeTab === "Security Logs") {
      const activitySecurity = logs.filter(
        (log) =>
          log.actionType === "failed" ||
          log.actionType === "denied" ||
          log.actionType === "warning"
      );
      const combined = [...activitySecurity, ...normalizedSecurityLogs];
      return combined.sort((a, b) => {
        const aT = a.timestamp?.toDate?.()?.getTime?.() || 0;
        const bT = b.timestamp?.toDate?.()?.getTime?.() || 0;
        return bT - aT;
      });
    }
    return logs;
  }, [activeTab, logs, normalizedSecurityLogs]);

  const filteredLogs = useMemo(() => {
    let result = [...sourceLogs];

    if (activeTab === "System Changes") {
      result = result.filter(
        (log) => log.actionType === "edit" || log.actionType === "success"
      );
    }

    const now = new Date();
    let cutoffDate = null;
    if (dateRange === "Last 7 Days") {
      cutoffDate = new Date(now);
      cutoffDate.setDate(now.getDate() - 7);
    } else if (dateRange === "Last 30 Days") {
      cutoffDate = new Date(now);
      cutoffDate.setDate(now.getDate() - 30);
    } else if (dateRange === "Last 90 Days") {
      cutoffDate = new Date(now);
      cutoffDate.setDate(now.getDate() - 90);
    }
    if (cutoffDate) {
      result = result.filter((log) => {
        const logDate = log.timestamp?.toDate?.();
        return logDate && logDate >= cutoffDate;
      });
    }

    if (userRole !== "All Roles") {
      const roleLower = userRole.toLowerCase();
      result = result.filter(
        (log) => (log.role || "").toLowerCase() === roleLower
      );
    }

    if (actionType !== "All Actions") {
      const actionLower = actionType.toLowerCase();
      let targetType = "";
      if (actionLower === "success") targetType = "success";
      else if (actionLower === "failed") targetType = "failed";
      else if (actionLower === "warning") targetType = "warning";
      else targetType = actionLower;

      result = result.filter(
        (log) => (log.actionType || "").toLowerCase() === targetType
      );
    }

    return result;
  }, [sourceLogs, activeTab, dateRange, userRole, actionType]);

  const totalItems = filteredLogs.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * ITEMS_PER_PAGE;
  const paginatedLogs = filteredLogs.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  useEffect(() => { setCurrentPage(1); }, [activeTab, dateRange, userRole, actionType]);
  useEffect(() => { if (currentPage > totalPages) setCurrentPage(totalPages); }, [totalPages]);

  const renderPageNumbers = () => {
    const pages = [];
    const start = Math.max(1, safePage - 1);
    const end = Math.min(totalPages, start + 2);
    for (let i = start; i <= end; i++) pages.push(i);
    return pages;
  };
  const pageNumbers = renderPageNumbers();

  const openExportModal = () => {
    setExportRange("all");
    setExportFrom("");
    setExportTo("");
    setExportFormat("csv");
    setShowExportModal(true);
  };

  const closeExportModal = () => {
    if (exporting) return;
    setShowExportModal(false);
  };

  const exportDateError = useMemo(() => {
    if (exportRange !== "range") return "";
    if (!exportFrom || !exportTo) return "";
    if (new Date(exportTo) < new Date(exportFrom)) {
      return "The 'To' date cannot be earlier than the 'From' date.";
    }
    return "";
  }, [exportRange, exportFrom, exportTo]);

  const isExportValid = useMemo(() => {
    if (exportRange === "all") return true;
    if (!exportFrom || !exportTo) return false;
    if (exportDateError) return false;
    return true;
  }, [exportRange, exportFrom, exportTo, exportDateError]);

  const getExportLogs = () => {
    if (exportRange === "all") return filteredLogs;

    const from = exportFrom ? new Date(exportFrom + "T00:00:00") : null;
    const to = exportTo ? new Date(exportTo + "T23:59:59") : null;

    return filteredLogs.filter((log) => {
      const logDate = log.timestamp?.toDate?.();
      if (!logDate) return false;
      if (from && logDate < from) return false;
      if (to && logDate > to) return false;
      return true;
    });
  };

  const buildExportFilename = () =>
    `SpaceSCICT_ActivityLogs(${getTodayISO()})`;

  const exportCSV = async (logsToExport) => {
    const headers = ["User", "Role", "Action", "Target", "Date", "Status"];
    const rows = logsToExport.map((log) => {
      const date = log.timestamp?.toDate?.().toLocaleDateString?.() || "";
      return [
        log.user || "",
        log.role || "",
        log.action || "",
        log.target || "",
        date,
        log.status || "",
      ];
    });
    const csv = [headers, ...rows]
      .map((r) => r.map((v) => `"${v}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${buildExportFilename()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportPDF = (logsToExport) => {
    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const marginX = 40;
    const logoSize = 50;
    const centerX = pageWidth / 2;

    if (SCHOOL_HEADER.universityLogoUrl) {
      pdf.addImage(SCHOOL_HEADER.universityLogoUrl, "PNG", marginX, 22, logoSize, logoSize);
    }
    if (SCHOOL_HEADER.collegeLogoUrl) {
      pdf.addImage(SCHOOL_HEADER.collegeLogoUrl, "PNG", pageWidth - marginX - logoSize, 22, logoSize, logoSize);
    }

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(14);
    pdf.setTextColor(20, 27, 45);
    pdf.text(SCHOOL_HEADER.universityName, centerX, 36, { align: "center" });

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.setTextColor(107, 114, 128);
    pdf.text(SCHOOL_HEADER.collegeName, centerX, 50, { align: "center" });
    pdf.text(SCHOOL_HEADER.systemName, centerX, 62, { align: "center" });

    pdf.setDrawColor(245, 124, 0);
    pdf.setLineWidth(1.5);
    pdf.line(marginX, 82, pageWidth - marginX, 82);

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    pdf.setTextColor(245, 124, 0);
    pdf.text(`Activity Log — ${activeTab}`, marginX, 104);

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.setTextColor(107, 114, 128);

    const rangeText =
      exportRange === "range" ? `${exportFrom} to ${exportTo}` : "All logs";
    pdf.text(
      `Range: ${rangeText} | Filters: ${dateRange} | ${userRole} | ${actionType}`,
      marginX,
      120
    );
    pdf.text(
      `Generated: ${new Date().toLocaleString()}`,
      pageWidth - marginX,
      120,
      { align: "right" }
    );

    const rows = logsToExport.map((log) => {
      const date = log.timestamp?.toDate?.().toLocaleDateString?.() || "N/A";
      const time = log.timestamp?.toDate?.().toLocaleTimeString?.([], {
        hour: "2-digit", minute: "2-digit",
      }) || "";
      return [
        log.user || "-",
        log.role || "-",
        log.action || "-",
        log.target || "-",
        `${date} ${time}`,
        log.status || "-",
      ];
    });

    autoTable(pdf, {
      startY: 134,
      head: [["User", "Role", "Action", "Target", "Date & Time", "Status"]],
      body: rows,
      theme: "grid",
      styles: { font: "helvetica", fontSize: 8, cellPadding: 5, valign: "middle" },
      headStyles: { fillColor: [245, 124, 0], textColor: [255, 255, 255], fontStyle: "bold", fontSize: 8 },
      bodyStyles: { textColor: [26, 26, 26] },
      alternateRowStyles: { fillColor: [253, 246, 240] },
      margin: { left: marginX, right: marginX },
    });

    const pageCount = pdf.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      pdf.setPage(i);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8);
      pdf.setTextColor(150, 150, 150);
      pdf.text(`Page ${i} of ${pageCount}`, pageWidth - marginX, pdf.internal.pageSize.getHeight() - 20, { align: "right" });
      pdf.text(`${SCHOOL_HEADER.systemName} — Confidential`, marginX, pdf.internal.pageSize.getHeight() - 20);
    }

    pdf.save(`${buildExportFilename()}.pdf`);
  };

  const handleExport = async () => {
    if (!isExportValid || exporting) return;

    const logsToExport = getExportLogs();
    if (logsToExport.length === 0) {
      showToast("No logs to export for the selected range.", "error");
      return;
    }

    setExporting(true);
    showToast("Preparing export...", "loading");

    try {
      await new Promise((res) => setTimeout(res, 500));
      if (exportFormat === "csv") {
        await exportCSV(logsToExport);
      } else {
        exportPDF(logsToExport);
      }
      showToast(
        `Exported ${logsToExport.length} logs as ${exportFormat.toUpperCase()}.`,
        "success"
      );
      setExporting(false);
      setShowExportModal(false);
    } catch (err) {
      console.error(err);
      showToast("Export failed. Please try again.", "error");
      setExporting(false);
    }
  };

  return (
    <div className="activity-log">
      <div className="log-page-header">
        <div className="log-title-row">
          <button
            className="dh-al-back-btn"
            onClick={() => navigate("/admin")}
            aria-label="Back to dashboard"
          >
            <i className="fa-solid fa-arrow-left"></i>
            <span>Back</span>
          </button>
          <div className="log-title-text">
            <h1>Activity Log</h1>
            <p className="log-subtitle">
              Secure, read-only audit trail of all actions performed within the SpaceS CICT environment.
            </p>
          </div>
        </div>

        <div className="log-actions">
          <button className="action-btn filled" onClick={openExportModal}>
            <i className="fa-solid fa-download"></i>
            Export Logs
          </button>
        </div>
      </div>

      {/* STAT CARDS */}
      <div className="log-stats">
        <div className="log-stat-card">
          <div className="log-stat-icon blue">
            <i className="fa-solid fa-eye"></i>
          </div>
          <div>
            <p className="log-stat-label">TOTAL ACTIONS TODAY</p>
            <h2 className="log-stat-value">{todayCount}</h2>
            <span className="log-stat-change green">Updates automatically</span>
          </div>
        </div>

        <div className="log-stat-card">
          <div className="log-stat-icon orange">
            <i className="fa-solid fa-shield-halved"></i>
          </div>
          <div>
            <p className="log-stat-label">WARNINGS FLAGGED</p>
            <h2 className="log-stat-value">{alertCount}</h2>
            <span className="log-stat-change gray">Informational warnings only</span>
          </div>
        </div>

        <div className="log-stat-card">
          <div className="log-stat-icon" style={{ background: "#fff0f0", color: "#dc2626" }}>
            <i className="fa-solid fa-ban"></i>
          </div>
          <div>
            <p className="log-stat-label">BLOCKED ACCOUNTS</p>
            <h2 className="log-stat-value" style={{ color: "#dc2626" }}>{blockedCount}</h2>
            <span className="log-stat-change gray">Blocked accounts as of {new Date().toLocaleDateString()}</span>
          </div>
        </div>
      </div>

      <div className="log-content-box">
        {/* TABS */}
        <div className="log-tabs">
          {tabs.map((tab) => (
            <button
              key={tab}
              className={`log-tab ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* FILTERS — custom dropdowns */}
        <div className="log-filters">
          <FilterSelect
            label="DATE RANGE"
            value={dateRange}
            onChange={setDateRange}
            options={DATE_RANGE_OPTIONS}
          />

          <FilterSelect
            label="USER ROLE"
            value={userRole}
            onChange={setUserRole}
            options={ROLE_OPTIONS}
          />

          <FilterSelect
            label="ACTION TYPE"
            value={actionType}
            onChange={setActionType}
            options={ACTION_OPTIONS}
          />
        </div>

        {/* TABLE */}
        <div className="log-table-wrap">
          <table className="log-table">
            <thead>
              <tr>
                <th>USER</th>
                <th>ACTION</th>
                <th>SUBJECT</th>
                <th>DATE & TIME</th>
                <th>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {paginatedLogs.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", padding: "40px", color: "#9ca3af" }}>
                    No activity logs found.
                  </td>
                </tr>
              )}

              {paginatedLogs.map((log) => {
                const date = log.timestamp?.toDate?.().toLocaleDateString?.() || "N/A";
                const time = log.timestamp?.toDate?.().toLocaleTimeString?.([], {
                  hour: "2-digit", minute: "2-digit",
                }) || "";

                return (
                  <tr key={log.id}>
                    <td>
                      <div className="user-cell">
                        <div className="user-avatar">
                          {(log.user || "")
                            .split(/[\s@]+/)
                            .filter(Boolean)
                            .slice(0, 2)
                            .map((n) => n[0])
                            .join("")
                            .toUpperCase()}
                        </div>
                        <div>
                          <p className="user-name">{log.user}</p>
                          <p className="user-role">{log.role}</p>
                        </div>
                      </div>
                    </td>

                    <td>
                      <div className="action-cell">
                        {actionIcon(log.actionType)}
                        <span>{log.action}</span>
                        {log._kind === "security" && log.attemptNumber && (
                          <span className="attempt-pill">#{log.attemptNumber}</span>
                        )}
                      </div>
                    </td>

                    <td className="target-cell">
                      {log.target}
                      {log._kind === "security" && log.userAgent && (
                        <span className="ua-hint" title={log.userAgent}>
                          <i className="fa-solid fa-circle-info"></i>
                        </span>
                      )}
                    </td>

                    <td className="date-cell">
                      <p>{date}</p>
                      <p className="time">{time}</p>
                    </td>

                    <td>
                      <span className={`status-badge ${log.status?.toLowerCase?.()}`}>
                        {log.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* PAGINATION */}
        <div className="log-pagination">
          <span className="pagination-info">
            Showing {totalItems === 0 ? 0 : startIndex + 1} to{" "}
            {Math.min(startIndex + ITEMS_PER_PAGE, totalItems)} of {totalItems} activities
          </span>

          <div className="pagination-controls">
            <button
              className="page-btn"
              disabled={safePage === 1}
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>

            {pageNumbers[0] > 1 && (
              <>
                <button className="page-btn" onClick={() => setCurrentPage(1)}>1</button>
                {pageNumbers[0] > 2 && <span className="page-ellipsis">...</span>}
              </>
            )}

            {pageNumbers.map((p) => (
              <button
                key={p}
                className={`page-btn ${safePage === p ? 'active' : ''}`}
                onClick={() => setCurrentPage(p)}
              >
                {p}
              </button>
            ))}

            {pageNumbers[pageNumbers.length - 1] < totalPages && (
              <>
                {pageNumbers[pageNumbers.length - 1] < totalPages - 1 && (
                  <span className="page-ellipsis">...</span>
                )}
                <button className="page-btn" onClick={() => setCurrentPage(totalPages)}>
                  {totalPages}
                </button>
              </>
            )}

            <button
              className="page-btn"
              disabled={safePage === totalPages}
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </button>
          </div>
        </div>

        <Toast
          show={toast.show}
          type={toast.type}
          message={toast.message}
          onClose={() => setToast({ show: false, type: "", message: "" })}
        />
      </div>

      {/* ═══════════ EXPORT MODAL ═══════════ */}
      {showExportModal && (
        <div className="export-modal-overlay" onClick={closeExportModal}>
          <div className="export-modal" onClick={(e) => e.stopPropagation()}>
            <div className="export-modal-header">
              <div className="export-modal-title">
                <i className="fa-solid fa-download"></i>
                <h3>Export Activity Logs</h3>
              </div>
              <button
                type="button"
                className="export-modal-close"
                onClick={closeExportModal}
                disabled={exporting}
                aria-label="Close"
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>

            <div className="export-modal-body">
              <div className="export-section">
                <label className="export-section-label">DATE RANGE</label>
                <div className="export-range-options">
                  <button
                    type="button"
                    className={`export-range-btn ${exportRange === "all" ? "active" : ""}`}
                    onClick={() => setExportRange("all")}
                    disabled={exporting}
                  >
                    <i className="fa-solid fa-infinity"></i>
                    <span>All Logs</span>
                  </button>
                  <button
                    type="button"
                    className={`export-range-btn ${exportRange === "range" ? "active" : ""}`}
                    onClick={() => setExportRange("range")}
                    disabled={exporting}
                  >
                    <i className="fa-regular fa-calendar"></i>
                    <span>Custom Range</span>
                  </button>
                </div>
              </div>

              {exportRange === "range" && (
                <div className="export-section">
                  <div className="export-date-row">
                    <DatePickerInput
                      label="FROM"
                      value={exportFrom}
                      onChange={setExportFrom}
                      placeholder="Pick start date"
                      max={exportTo || undefined}
                      disabled={exporting}
                    />
                    <DatePickerInput
                      label="TO"
                      value={exportTo}
                      onChange={setExportTo}
                      placeholder="Pick end date"
                      min={exportFrom || undefined}
                      disabled={exporting}
                    />
                  </div>

                  {exportDateError && (
                    <p className="export-error">
                      <i className="fa-solid fa-circle-exclamation"></i>
                      {exportDateError}
                    </p>
                  )}

                  {!exportDateError && exportFrom && exportTo && (
                    <p className="export-range-summary">
                      <i className="fa-solid fa-circle-check"></i>
                      Exporting logs from{" "}
                      <strong>{formatPrettyDate(exportFrom)}</strong> to{" "}
                      <strong>{formatPrettyDate(exportTo)}</strong>
                    </p>
                  )}
                </div>
              )}

              <div className="export-section">
                <label className="export-section-label">FORMAT</label>
                <div className="export-format-options">
                  <button
                    type="button"
                    className={`export-format-btn ${exportFormat === "csv" ? "active" : ""}`}
                    onClick={() => setExportFormat("csv")}
                    disabled={exporting}
                  >
                    <i className="fa-solid fa-file-csv"></i>
                    <div className="export-format-text">
                      <span className="export-format-name">CSV</span>
                      <span className="export-format-desc">Spreadsheet format</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    className={`export-format-btn ${exportFormat === "pdf" ? "active" : ""}`}
                    onClick={() => setExportFormat("pdf")}
                    disabled={exporting}
                  >
                    <i className="fa-solid fa-file-pdf"></i>
                    <div className="export-format-text">
                      <span className="export-format-name">PDF</span>
                      <span className="export-format-desc">Formatted document</span>
                    </div>
                  </button>
                </div>
              </div>

              <div className="export-file-preview">
                <i className="fa-solid fa-file-arrow-down"></i>
                <span>
                  File:{" "}
                  <strong>
                    SpaceSCICT_ActivityLogs({getTodayISO()}).{exportFormat}
                  </strong>
                </span>
              </div>
            </div>

            <div className="export-modal-footer">
              <button
                type="button"
                className="export-btn cancel"
                onClick={closeExportModal}
                disabled={exporting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="export-btn confirm"
                onClick={handleExport}
                disabled={!isExportValid || exporting}
              >
                {exporting ? (
                  <>
                    <i className="fa-solid fa-circle-notch fa-spin"></i>
                    Exporting...
                  </>
                ) : (
                  <>
                    <i className="fa-solid fa-download"></i>
                    Export {exportFormat.toUpperCase()}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}