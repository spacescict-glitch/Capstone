import { useState, useEffect, useMemo } from "react";
import "./cancelled-report-modal.css";
import { collection, getDocs, doc, getDoc } from "firebase/firestore";
import { db, auth } from "../../firebase";
import Toast from "../../Popup/Toast/Toast";
import { logActivity } from "../../utils/logActivity";

// ─── PDF ───────────────────────────────────────────────────────────
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import universityLogo from "../../assets/BSU-Logo.png";
import collegeLogo from "../../assets/CICT-Logo.png";

const SCHOOL_HEADER = {
  universityLogoUrl: universityLogo,
  collegeLogoUrl: collegeLogo,
  universityName: "Bulacan State University",
  collegeName: "College of Information and Communications Technology",
  systemName: "SpaceS CICT",
};

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

const SOURCE_META = {
  released:     { label: "Faculty Release",         short: "Released", color: "#16a34a", bg: "#dcfce7", icon: "fa-solid fa-door-open" },
  activity:     { label: "Room Activity Override",  short: "Activity", color: "#c2410c", bg: "#ffedd5", icon: "fa-solid fa-calendar-plus" },
  reassignment: { label: "Reassignment Cancelled",  short: "Reassign", color: "#b91c1c", bg: "#fee2e2", icon: "fa-solid fa-arrows-rotate" },
  "no-room":    { label: "No Room Available",       short: "No Room",  color: "#b45309", bg: "#fef3c7", icon: "fa-solid fa-door-closed" },
};

const ITEMS_PER_PAGE = 8;

// ─── Helpers ──────────────────────────────────────────────────────
const toDateStr = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const parseTimeParts = (t) => {
  if (!t) return [0, 0];
  const [h, m] = t.split(":").map(Number);
  return [Number.isNaN(h) ? 0 : h, Number.isNaN(m) ? 0 : m];
};

const fmt12 = (t) => {
  if (!t) return "—";
  const [h, m] = parseTimeParts(t);
  const suffix = h >= 12 ? "PM" : "AM";
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, "0")} ${suffix}`;
};

const fmtDateShort = (dateStr) => {
  if (!dateStr) return "—";
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
};

const fmtDateLong = (dateStr) => {
  if (!dateStr) return "—";
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });
};

const getWeekRange = (offset = 0) => {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff + offset * 7);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { start: monday, end: sunday };
};

const getMonthRange = (offset = 0) => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

const getTimestampMs = (ts) => {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (ts.seconds) return ts.seconds * 1000;
  if (ts.toDate) return ts.toDate().getTime();
  return 0;
};

// ══════════════════════════════════════════════════════════════════
// MODAL
// ══════════════════════════════════════════════════════════════════
export default function CancelledReportModal({ isOpen, onClose }) {
  const [loading, setLoading] = useState(false);
  const [rawRecords, setRawRecords] = useState([]);
  const [exporting, setExporting] = useState(false);

  // Period
  const [period, setPeriod] = useState("weekly");
  const [weekOffset, setWeekOffset] = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  const [semFrom, setSemFrom] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 5);
    return toDateStr(d);
  });
  const [semTo, setSemTo] = useState(() => toDateStr(new Date()));

  // Filters
  const [searchTerm, setSearchTerm] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [onlineFilter, setOnlineFilter] = useState("all");
  const [facultyFilter, setFacultyFilter] = useState("");
  const [currentPage, setCurrentPage] = useState(1);

  const [toast, setToast] = useState({
    show: false, type: "success", title: "", message: "",
  });
  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    if (type !== "loading") {
      setTimeout(() => setToast((p) => ({ ...p, show: false })), 5000);
    }
  };

  // ─── Date range ─────────────────────────────────────────────
  const dateRange = useMemo(() => {
    if (period === "weekly") {
      const { start, end } = getWeekRange(weekOffset);
      return {
        start: toDateStr(start),
        end: toDateStr(end),
        label: `${fmtDateShort(toDateStr(start))} – ${fmtDateShort(toDateStr(end))}`,
      };
    }
    if (period === "monthly") {
      const { start, end } = getMonthRange(monthOffset);
      return {
        start: toDateStr(start),
        end: toDateStr(end),
        label: `${MONTH_NAMES[start.getMonth()]} ${start.getFullYear()}`,
      };
    }
    return {
      start: semFrom,
      end: semTo,
      label: `${fmtDateShort(semFrom)} – ${fmtDateShort(semTo)}`,
    };
  }, [period, weekOffset, monthOffset, semFrom, semTo]);

  // ─── Load data on every open (no gate) ─────────────────────
  useEffect(() => {
    if (!isOpen) return;
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Reset filters when closing
  useEffect(() => {
    if (!isOpen) {
      setCurrentPage(1);
      setSearchTerm("");
      setSourceFilter("all");
      setOnlineFilter("all");
      setFacultyFilter("");
    }
  }, [isOpen]);

  const loadAll = async () => {
    setLoading(true);
    setRawRecords([]);

    const allRecords = [];
    const stats = { releases: 0, activity: 0, reassign: 0 };
    const errors = [];

    // ══════════════════════════════════════════════════════════
    // OPTIONAL — users + facultySchedules (for online detection)
    // Best-effort only; must NOT block the report.
    // ══════════════════════════════════════════════════════════
    const usersById = new Map();
    const onlineByFaculty = new Map();

    try {
      const usersSnap = await getDocs(collection(db, "users"));
      usersSnap.docs.forEach((d) => usersById.set(d.id, d.data()));
      console.log("[CancelledReport] Loaded users:", usersById.size);
    } catch (err) {
      console.warn("[CancelledReport] users load failed:", err.code, err.message);
    }

    try {
      const fsSnap = await getDocs(collection(db, "facultySchedules"));
      fsSnap.docs.forEach((d) => {
        const o = d.data();
        if (!o.userId) return;
        if (!onlineByFaculty.has(o.userId)) onlineByFaculty.set(o.userId, []);
        onlineByFaculty.get(o.userId).push({ id: d.id, ...o });
      });
      console.log("[CancelledReport] Loaded facultySchedules:", fsSnap.size);
    } catch (err) {
      console.warn("[CancelledReport] facultySchedules load failed:", err.code, err.message);
    }

    // ══════════════════════════════════════════════════════════
    // SOURCE 1 — Faculty Releases
    // ══════════════════════════════════════════════════════════
    try {
      const snap = await getDocs(collection(db, "roomReleases"));
      stats.releases = snap.size;
      console.log("[CancelledReport] roomReleases count:", snap.size);

      snap.docs.forEach((d) => {
        const r = d.data();
        if (!r.date) {
          console.warn("[CancelledReport] Skip release without date:", d.id);
          return;
        }

        const facultyId = r.releasedBy || "";
        const facultyDoc = facultyId ? usersById.get(facultyId) : null;
        const facultyName =
          r.releasedByName ||
          r.faculty ||
          r.teacher ||
          (facultyDoc
            ? `${facultyDoc.firstName || ""} ${facultyDoc.lastName || ""}`.trim()
            : "");

        allRecords.push({
          id: `release-${d.id}`,
          sourceType: "released",
          date: r.date,
          subject: r.subject || "",
          section: r.section || "",
          faculty: facultyName || "Unknown",
          facultyId,
          roomName: r.roomName || "",
          startTime: r.startTime || "",
          endTime: r.endTime || "",
          effectiveEndTime: r.effectiveEndTime || null,
          reason: r.reason || "",
          activityTitle: "",
          cancelledAt: getTimestampMs(r.releasedAt),
          recordedByName: r.releasedByName || "",
        });
      });
    } catch (err) {
      console.error("[CancelledReport] ❌ roomReleases failed:", err.code, err.message);
      errors.push(`Releases (${err.code || "error"})`);
    }

    // ══════════════════════════════════════════════════════════
    // SOURCE 2 — Room Activity Overrides
    // ══════════════════════════════════════════════════════════
    try {
      const snap = await getDocs(collection(db, "roomActivityRequests"));
      stats.activity = snap.size;
      console.log("[CancelledReport] roomActivityRequests count:", snap.size);

      snap.docs.forEach((d) => {
        const a = d.data();
        if (String(a.status || "").toLowerCase() !== "approved") return;
        if (!Array.isArray(a.conflicts) || a.conflicts.length === 0) return;
        if (!a.date) return;

        a.conflicts.forEach((c, idx) => {
          if (c.kind && c.kind !== "schedule" && c.kind !== "reassignment") return;

          const facultyId = c.facultyId || "";
          const facultyDoc = facultyId ? usersById.get(facultyId) : null;
          const facultyName =
            c.faculty ||
            (facultyDoc
              ? `${facultyDoc.firstName || ""} ${facultyDoc.lastName || ""}`.trim()
              : "");

          allRecords.push({
            id: `activity-${d.id}-${idx}`,
            sourceType: "activity",
            date: a.date,
            subject: c.subject || "",
            section: c.section || "",
            faculty: facultyName || "Unknown",
            facultyId,
            roomName: a.roomName || "",
            startTime: c.startTime || "",
            endTime: c.endTime || "",
            effectiveEndTime: null,
            reason: a.reason || "",
            activityTitle: a.title || "",
            cancelledAt: getTimestampMs(a.approvedAt),
            recordedByName: a.approvedByName || "",
          });
        });
      });
    } catch (err) {
      console.error("[CancelledReport] ❌ roomActivityRequests failed:", err.code, err.message);
      errors.push(`Activity (${err.code || "error"})`);
    }

    // ══════════════════════════════════════════════════════════
    // SOURCE 3 — Cancelled Reassignments
    // ══════════════════════════════════════════════════════════
    try {
      const snap = await getDocs(collection(db, "roomReassignments"));
      stats.reassign = snap.size;
      console.log("[CancelledReport] roomReassignments count:", snap.size);

      snap.docs.forEach((d) => {
        const r = d.data();
        const status = String(r.status || "").toLowerCase();
        if (status !== "cancelled") return;
        if (r.reassignType === "event") return;
        if (!r.date) return;

        const isNoRoom = !!r.noRoomOption;
        const facultyId = r.facultyId || "";
        const facultyDoc = facultyId ? usersById.get(facultyId) : null;
        const facultyName =
          r.facultyName ||
          (facultyDoc
            ? `${facultyDoc.firstName || ""} ${facultyDoc.lastName || ""}`.trim()
            : "");

        const reasonParts = [];
        if (r.clerkReason) reasonParts.push(r.clerkReason);
        if (r.denialReason) reasonParts.push(`Faculty: ${r.denialReason}`);
        if (r.adminNote) reasonParts.push(r.adminNote);

        allRecords.push({
          id: `reassign-${d.id}`,
          sourceType: isNoRoom ? "no-room" : "reassignment",
          date: r.date,
          subject: r.courseTitle || r.subject || "",
          section: r.section || "",
          faculty: facultyName || "Unknown",
          facultyId,
          roomName: r.oldRoomName || r.oldRoomId || "",
          startTime: r.startTime || "",
          endTime: r.endTime || "",
          effectiveEndTime: null,
          reason:
            reasonParts.join(" • ") ||
            (isNoRoom ? "No suitable room found" : "Cancelled by Admin"),
          activityTitle: "",
          cancelledAt: getTimestampMs(r.decidedAt) || getTimestampMs(r.updatedAt),
          recordedByName: r.decidedByName || "",
        });
      });
    } catch (err) {
      console.error("[CancelledReport] ❌ roomReassignments failed:", err.code, err.message);
      errors.push(`Reassignments (${err.code || "error"})`);
    }

    // ══════════════════════════════════════════════════════════
    // ONLINE REPLACEMENT detection (best-effort)
    // ══════════════════════════════════════════════════════════
    allRecords.forEach((r) => {
      r.replacedByOnline = false;
      r.onlineClassInfo = null;
      if (!r.facultyId || !r.date || !r.startTime || !r.endTime) return;

      const dayOfWeek = new Date(`${r.date}T00:00:00`)
        .toLocaleDateString("en-US", { weekday: "short" })
        .toUpperCase();

      const candidates = onlineByFaculty.get(r.facultyId) || [];
      const match = candidates.find((o) => {
        if (String(o.day || "").toUpperCase() !== dayOfWeek) return false;
        const [oSH, oSM] = parseTimeParts(o.startTime);
        const [oEH, oEM] = parseTimeParts(o.endTime);
        const [rSH, rSM] = parseTimeParts(r.startTime);
        const [rEH, rEM] = parseTimeParts(r.endTime);
        return (
          oSH * 60 + oSM < rEH * 60 + rEM &&
          oEH * 60 + oEM > rSH * 60 + rSM
        );
      });

      if (match) {
        r.replacedByOnline = true;
        r.onlineClassInfo = {
          subject: match.subject || "",
          section: match.section || "",
          startTime: match.startTime || "",
          endTime: match.endTime || "",
        };
      }
    });

    // ── Sort newest first ──
    allRecords.sort((a, b) => {
      if (a.date < b.date) return 1;
      if (a.date > b.date) return -1;
      return b.cancelledAt - a.cancelledAt;
    });

    console.log(
      `[CancelledReport] ✅ Loaded ${allRecords.length} cancellation records`,
      { stats, errors }
    );

    setRawRecords(allRecords);
    setLoading(false);

    // ── Feedback toast ──
    if (allRecords.length === 0) {
      const detail =
        `Queried: ${stats.releases} releases, ${stats.activity} activity requests, ${stats.reassign} reassignments.` +
        (errors.length ? ` Errors: ${errors.join("; ")}.` : "");

      if (errors.length > 0) {
        showToast(
          "error",
          "Load Issues",
          `${detail} Check browser console (F12) for details.`
        );
      } else {
        showToast(
          "error",
          "No Records Found",
          `${detail} Adjust the period or filters.`
        );
      }
    } else {
      const detail =
        `${stats.releases} release${stats.releases === 1 ? "" : "s"}, ` +
        `${stats.activity} activity, ` +
        `${stats.reassign} reassignment${stats.reassign === 1 ? "" : "s"}` +
        (errors.length ? ` · Partial: ${errors.join("; ")}` : "");

      showToast("success", "Loaded", `${allRecords.length} records · ${detail}`);
    }
  };

  // ─── Filtered by period ──────────────────────────────────────
  const inRange = useMemo(
    () => rawRecords.filter((r) => r.date >= dateRange.start && r.date <= dateRange.end),
    [rawRecords, dateRange]
  );

  // ─── Applied filters ─────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = [...inRange];

    if (sourceFilter !== "all") {
      list = list.filter((r) => r.sourceType === sourceFilter);
    }

    if (onlineFilter === "replaced") {
      list = list.filter((r) => r.replacedByOnline);
    } else if (onlineFilter === "not-replaced") {
      list = list.filter((r) => !r.replacedByOnline);
    }

    if (facultyFilter) {
      list = list.filter(
        (r) => r.facultyId === facultyFilter || r.faculty === facultyFilter
      );
    }

    if (searchTerm.trim()) {
      const s = searchTerm.toLowerCase();
      list = list.filter(
        (r) =>
          (r.subject || "").toLowerCase().includes(s) ||
          (r.section || "").toLowerCase().includes(s) ||
          (r.faculty || "").toLowerCase().includes(s) ||
          (r.roomName || "").toLowerCase().includes(s) ||
          (r.reason || "").toLowerCase().includes(s)
      );
    }

    return list;
  }, [inRange, sourceFilter, onlineFilter, facultyFilter, searchTerm]);

  // ─── Stats ───────────────────────────────────────────────────
  const stats = useMemo(() => {
    const total = inRange.length;
    const released = inRange.filter((r) => r.sourceType === "released").length;
    const activity = inRange.filter((r) => r.sourceType === "activity").length;
    const reassigned = inRange.filter((r) => r.sourceType === "reassignment").length;
    const noRoom = inRange.filter((r) => r.sourceType === "no-room").length;
    const replacedOnline = inRange.filter((r) => r.replacedByOnline).length;
    const uniqueFaculty = new Set(
      inRange.filter((r) => r.facultyId).map((r) => r.facultyId)
    ).size;
    const onlineRate = total > 0 ? Math.round((replacedOnline / total) * 100) : 0;
    return { total, released, activity, reassigned, noRoom, replacedOnline, uniqueFaculty, onlineRate };
  }, [inRange]);

  // ─── Faculty options ─────────────────────────────────────────
  const facultyOptions = useMemo(() => {
    const map = new Map();
    rawRecords.forEach((r) => {
      if (r.facultyId && !map.has(r.facultyId)) map.set(r.facultyId, r.faculty);
      else if (!r.facultyId && r.faculty && r.faculty !== "Unknown") {
        if (!map.has(r.faculty)) map.set(r.faculty, r.faculty);
      }
    });
    return Array.from(map.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rawRecords]);

  // ─── Pagination ──────────────────────────────────────────────
  useEffect(() => {
    setCurrentPage(1);
  }, [period, weekOffset, monthOffset, semFrom, semTo, sourceFilter, onlineFilter, facultyFilter, searchTerm]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const startIdx = (safePage - 1) * ITEMS_PER_PAGE;
  const paginated = filtered.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  const hasActiveFilters =
    sourceFilter !== "all" ||
    onlineFilter !== "all" ||
    facultyFilter ||
    searchTerm.trim();

  const clearFilters = () => {
    setSourceFilter("all");
    setOnlineFilter("all");
    setFacultyFilter("");
    setSearchTerm("");
  };

  // ═══════════════════════════════════════════════════════════════
  // EXPORT — CSV
  // ═══════════════════════════════════════════════════════════════
  const exportCSV = async () => {
    if (filtered.length === 0) {
      showToast("error", "Nothing to Export", "No cancellations in this period.");
      return;
    }
    setExporting(true);
    try {
      const headers = [
        "Date","Subject","Section","Faculty","Room","Start","End",
        "Source","Reason","Replaced by Online?","Online Subject","Recorded By",
      ];
      const rows = filtered.map((r) => [
        r.date,
        r.subject || "",
        r.section || "",
        r.faculty || "",
        r.roomName || "",
        fmt12(r.startTime),
        fmt12(r.endTime),
        SOURCE_META[r.sourceType]?.label || r.sourceType,
        r.reason || "",
        r.replacedByOnline ? "Yes" : "No",
        r.onlineClassInfo?.subject || "",
        r.recordedByName || "",
      ]);
      const csv = [headers, ...rows]
        .map((row) =>
          row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")
        )
        .join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `SpaceSCICT_CancelledClasses_${dateRange.start}_to_${dateRange.end}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("success", "Exported", `${filtered.length} record(s) exported.`);
    } catch (err) {
      console.error("CSV export failed:", err);
      showToast("error", "Export Failed", "Could not generate CSV.");
    } finally {
      setExporting(false);
    }
  };

  // ═══════════════════════════════════════════════════════════════
  // EXPORT — PDF
  // ═══════════════════════════════════════════════════════════════
  const exportPDF = async () => {
    if (filtered.length === 0) {
      showToast("error", "Nothing to Export", "No cancellations in this period.");
      return;
    }
    setExporting(true);
    try {
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
      pdf.text("Cancelled Classes Report", marginX, 98);

      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      pdf.setTextColor(107, 114, 128);
      pdf.text(
        `Period: ${dateRange.label}  ·  Total: ${stats.total} cancellation${stats.total === 1 ? "" : "s"}`,
        marginX, 114
      );
      pdf.text(
        `Online Replacements: ${stats.replacedOnline} (${stats.onlineRate}%)  ·  Faculty Affected: ${stats.uniqueFaculty}`,
        marginX, 126
      );
      pdf.text(
        `Generated: ${new Date().toLocaleString()}`,
        pageWidth - marginX, 114, { align: "right" }
      );

      autoTable(pdf, {
        startY: 144,
        head: [["Date","Subject","Section","Faculty","Room","Time","Source","Reason","Online?"]],
        body: filtered.map((r) => [
          r.date,
          r.subject || "—",
          r.section || "—",
          r.faculty || "—",
          r.roomName || "—",
          `${fmt12(r.startTime)} – ${fmt12(r.endTime)}`,
          SOURCE_META[r.sourceType]?.short || r.sourceType,
          r.reason || "—",
          r.replacedByOnline ? "✓ Yes" : "✗ No",
        ]),
        theme: "grid",
        styles: { font: "helvetica", fontSize: 7.5, cellPadding: 5, valign: "middle", overflow: "linebreak" },
        headStyles: { fillColor: [245, 124, 0], textColor: [255, 255, 255], fontStyle: "bold", fontSize: 8 },
        bodyStyles: { textColor: [26, 26, 26] },
        alternateRowStyles: { fillColor: [253, 246, 240] },
        columnStyles: {
          0: { cellWidth: 60 },
          1: { cellWidth: 110 },
          2: { cellWidth: 55 },
          3: { cellWidth: 100 },
          4: { cellWidth: 70 },
          5: { cellWidth: 90 },
          6: { cellWidth: 55 },
          7: { cellWidth: "auto" },
          8: { cellWidth: 55, halign: "center" },
        },
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

      pdf.save(`SpaceSCICT_CancelledClasses_${dateRange.start}_to_${dateRange.end}.pdf`);

      try {
        const firebaseUser = auth.currentUser;
        const userDoc = await getDoc(doc(db, "users", firebaseUser.uid));
        const me = userDoc.exists() ? userDoc.data() : {};
        await logActivity({
          user: `${me.firstName || ""} ${me.lastName || ""}`.trim() || "Admin",
          role: me.role || "Admin",
          action: "Exported Cancelled Classes Report",
          actionType: "export",
          target: `Cancelled Classes · ${dateRange.label}`,
          status: "SUCCESS",
          details: { period, records: filtered.length, format: "PDF" },
        });
      } catch (err) {
        console.warn("Log failed:", err);
      }

      showToast("success", "PDF Downloaded", `${filtered.length} record(s) exported.`);
    } catch (err) {
      console.error("PDF export failed:", err);
      showToast("error", "Export Failed", "Could not generate PDF.");
    } finally {
      setExporting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="crm-overlay" onClick={onClose}>
        <div className="crm-modal" onClick={(e) => e.stopPropagation()}>
          {/* HEADER */}
          <div className="crm-header">
            <div className="crm-header-text">
              <h2 className="crm-title">
                <i className="fa-solid fa-file-circle-xmark"></i>
                Cancelled Classes Report
              </h2>
              <p className="crm-subtitle">
                Aggregated from faculty releases, room activity overrides, cancelled reassignments, and no-room situations.
              </p>
            </div>
            <div className="crm-header-actions">
              <button
                className="crm-refresh-btn"
                onClick={loadAll}
                disabled={loading}
                title="Reload data"
              >
                <i className={`fa-solid fa-rotate-right ${loading ? "fa-spin" : ""}`}></i>
                <span>Refresh</span>
              </button>
              <button className="crm-close-btn" onClick={onClose} aria-label="Close">
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>
          </div>

          {/* PERIOD BAR */}
          <div className="crm-period-bar">
            <div className="crm-period-tabs">
              <button
                className={`crm-period-tab ${period === "weekly" ? "active" : ""}`}
                onClick={() => setPeriod("weekly")}
              >
                <i className="fa-regular fa-calendar-week"></i> Weekly
              </button>
              <button
                className={`crm-period-tab ${period === "monthly" ? "active" : ""}`}
                onClick={() => setPeriod("monthly")}
              >
                <i className="fa-regular fa-calendar"></i> Monthly
              </button>
              <button
                className={`crm-period-tab ${period === "semestral" ? "active" : ""}`}
                onClick={() => setPeriod("semestral")}
              >
                <i className="fa-solid fa-calendar-days"></i> Semestral
              </button>
            </div>

            <div className="crm-period-nav">
              {period === "weekly" && (
                <>
                  <button className="crm-nav-btn" onClick={() => setWeekOffset((o) => o - 1)}>
                    <i className="fa-solid fa-chevron-left"></i>
                  </button>
                  <span className="crm-period-label">{dateRange.label}</span>
                  <button
                    className="crm-nav-btn"
                    onClick={() => setWeekOffset((o) => o + 1)}
                    disabled={weekOffset >= 0}
                  >
                    <i className="fa-solid fa-chevron-right"></i>
                  </button>
                </>
              )}
              {period === "monthly" && (
                <>
                  <button className="crm-nav-btn" onClick={() => setMonthOffset((o) => o - 1)}>
                    <i className="fa-solid fa-chevron-left"></i>
                  </button>
                  <span className="crm-period-label">{dateRange.label}</span>
                  <button
                    className="crm-nav-btn"
                    onClick={() => setMonthOffset((o) => o + 1)}
                    disabled={monthOffset >= 0}
                  >
                    <i className="fa-solid fa-chevron-right"></i>
                  </button>
                </>
              )}
              {period === "semestral" && (
                <div className="crm-date-range">
                  <label>
                    <span>From</span>
                    <input type="date" value={semFrom} max={semTo} onChange={(e) => setSemFrom(e.target.value)} />
                  </label>
                  <label>
                    <span>To</span>
                    <input type="date" value={semTo} min={semFrom} onChange={(e) => setSemTo(e.target.value)} />
                  </label>
                </div>
              )}
            </div>
          </div>

          {/* SCROLLABLE BODY */}
          <div className="crm-body">
            {/* STATS */}
            <div className="crm-stats">
              <div className="crm-stat-card is-total">
                <div className="crm-stat-icon"><i className="fa-solid fa-ban"></i></div>
                <div>
                  <div className="crm-stat-value">{stats.total}</div>
                  <div className="crm-stat-label">Total</div>
                </div>
              </div>
              <div className="crm-stat-card is-released">
                <div className="crm-stat-icon"><i className="fa-solid fa-door-open"></i></div>
                <div>
                  <div className="crm-stat-value">{stats.released}</div>
                  <div className="crm-stat-label">Released</div>
                </div>
              </div>
              <div className="crm-stat-card is-activity">
                <div className="crm-stat-icon"><i className="fa-solid fa-calendar-plus"></i></div>
                <div>
                  <div className="crm-stat-value">{stats.activity}</div>
                  <div className="crm-stat-label">Activity</div>
                </div>
              </div>
              <div className="crm-stat-card is-reassign">
                <div className="crm-stat-icon"><i className="fa-solid fa-door-closed"></i></div>
                <div>
                  <div className="crm-stat-value">{stats.reassigned + stats.noRoom}</div>
                  <div className="crm-stat-label">No Room</div>
                </div>
              </div>
              <div className="crm-stat-card is-online">
                <div className="crm-stat-icon"><i className="fa-solid fa-laptop"></i></div>
                <div>
                  <div className="crm-stat-value">
                    {stats.replacedOnline}
                    <span className="crm-stat-rate">{stats.onlineRate}%</span>
                  </div>
                  <div className="crm-stat-label">Online</div>
                </div>
              </div>
            </div>

            {/* FILTERS */}
            <div className="crm-filters">
              <div className="crm-search">
                <i className="fa-solid fa-magnifying-glass"></i>
                <input
                  type="text"
                  placeholder="Search subject, faculty, room, reason…"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                {searchTerm && (
                  <button className="crm-search-clear" onClick={() => setSearchTerm("")}>
                    <i className="fa-solid fa-xmark"></i>
                  </button>
                )}
              </div>
              <div className="crm-select">
                <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
                  <option value="all">All Sources</option>
                  <option value="released">Faculty Release</option>
                  <option value="activity">Room Activity</option>
                  <option value="reassignment">Reassignment</option>
                  <option value="no-room">No Room</option>
                </select>
                <i className="fa-solid fa-angle-down crm-select-chev"></i>
              </div>
              <div className="crm-select">
                <select value={onlineFilter} onChange={(e) => setOnlineFilter(e.target.value)}>
                  <option value="all">All (Online/Not)</option>
                  <option value="replaced">Replaced by Online</option>
                  <option value="not-replaced">Not Replaced</option>
                </select>
                <i className="fa-solid fa-angle-down crm-select-chev"></i>
              </div>
              <div className="crm-select">
                <select value={facultyFilter} onChange={(e) => setFacultyFilter(e.target.value)}>
                  <option value="">All Faculty</option>
                  {facultyOptions.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
                <i className="fa-solid fa-angle-down crm-select-chev"></i>
              </div>
              {hasActiveFilters && (
                <button className="crm-clear-btn" onClick={clearFilters}>
                  <i className="fa-solid fa-filter-circle-xmark"></i>
                </button>
              )}
              <span className="crm-result-count">
                {filtered.length} result{filtered.length === 1 ? "" : "s"}
              </span>
            </div>

            {/* TABLE */}
            {loading ? (
              <div className="crm-empty">
                <i className="fa-solid fa-spinner fa-spin"></i>
                <p>Loading cancellation data…</p>
              </div>
            ) : filtered.length === 0 ? (
              <div className="crm-empty">
                <i className="fa-regular fa-circle-check"></i>
                <h3>No cancelled classes</h3>
                <p>
                  {hasActiveFilters
                    ? "No records match your current filters."
                    : "No cancellations recorded for this period."}
                </p>
              </div>
            ) : (
              <div className="crm-table-wrap">
                <table className="crm-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Class</th>
                      <th>Faculty</th>
                      <th>Room / Time</th>
                      <th>Source</th>
                      <th>Reason</th>
                      <th>Online</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginated.map((r) => {
                      const meta = SOURCE_META[r.sourceType] || {};
                      return (
                        <tr key={r.id}>
                          <td>
                            <div className="crm-date-cell">
                              <i className="fa-regular fa-calendar"></i>
                              <span>{fmtDateLong(r.date)}</span>
                            </div>
                          </td>
                          <td>
                            <div className="crm-class-cell">
                              <span className="crm-subject">{r.subject || "—"}</span>
                              {r.section && <span className="crm-section">{r.section}</span>}
                            </div>
                          </td>
                          <td><span className="crm-faculty">{r.faculty || "—"}</span></td>
                          <td>
                            <div className="crm-room-time">
                              <span className="crm-room">
                                <i className="fa-solid fa-door-open"></i>
                                {r.roomName || "—"}
                              </span>
                              <span className="crm-time">
                                {fmt12(r.startTime)} – {fmt12(r.endTime)}
                              </span>
                            </div>
                          </td>
                          <td>
                            <span className="crm-source-badge" style={{ background: meta.bg, color: meta.color }}>
                              <i className={meta.icon}></i>
                              {meta.short}
                            </span>
                          </td>
                          <td>
                            <span className="crm-reason" title={r.reason}>{r.reason || "—"}</span>
                          </td>
                          <td>
                            {r.replacedByOnline ? (
                              <span className="crm-online-yes"><i className="fa-solid fa-circle-check"></i> Yes</span>
                            ) : (
                              <span className="crm-online-no"><i className="fa-solid fa-circle-xmark"></i> No</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* PAGINATION */}
            {!loading && totalPages > 1 && (
              <div className="crm-pagination">
                <span className="crm-page-info">
                  Showing {startIdx + 1}–{Math.min(startIdx + ITEMS_PER_PAGE, filtered.length)} of {filtered.length}
                </span>
                <div className="crm-page-controls">
                  <button disabled={safePage === 1} onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}>
                    <i className="fa-solid fa-chevron-left"></i>
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                    <button key={p} className={safePage === p ? "active" : ""} onClick={() => setCurrentPage(p)}>
                      {p}
                    </button>
                  ))}
                  <button disabled={safePage === totalPages} onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}>
                    <i className="fa-solid fa-chevron-right"></i>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* FOOTER */}
          <div className="crm-footer">
            <div className="crm-footer-info">
              <i className="fa-solid fa-circle-info"></i>
              <span>Exports reflect the current filters.</span>
            </div>
            <div className="crm-footer-actions">
              <button className="crm-btn crm-btn-cancel" onClick={onClose}>
                Close
              </button>
              <button className="crm-btn crm-btn-csv" onClick={exportCSV} disabled={exporting || filtered.length === 0}>
                <i className="fa-solid fa-file-csv"></i> CSV
              </button>
              <button className="crm-btn crm-btn-pdf" onClick={exportPDF} disabled={exporting || filtered.length === 0}>
                {exporting ? (
                  <><i className="fa-solid fa-circle-notch fa-spin"></i> Generating…</>
                ) : (
                  <><i className="fa-solid fa-file-pdf"></i> Export PDF</>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      <Toast
        show={toast.show}
        type={toast.type}
        title={toast.title}
        message={toast.message}
        onClose={() => setToast((p) => ({ ...p, show: false }))}
      />
    </>
  );
}