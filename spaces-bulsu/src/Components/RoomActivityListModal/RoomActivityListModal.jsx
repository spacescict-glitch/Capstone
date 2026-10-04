import { useState, useEffect, useMemo } from "react";
import "./room-activity-list-modal.css";
import RoomActivityConflictCard from "../RoomActivityConflictCard/RoomActivityConflictCard";
import { collection, onSnapshot, query, orderBy } from "firebase/firestore";
import { db } from "../../firebase";

const ITEMS_PER_PAGE = 5;

// ── Archive rule: records older than 30 days are auto-hidden ──────
const ARCHIVE_AFTER_DAYS = 30;

const todayISO = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};

const addDaysLocal = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};

// A request is considered archived if it's explicitly flagged OR its
// activity date is older than the archive window.
const isArchivedRequest = (r) => {
  if (r.archived === true) return true;
  const cutoff = addDaysLocal(todayISO(), -ARCHIVE_AFTER_DAYS);
  const refDate = r.date || todayISO();
  return refDate < cutoff;
};

// ── Professional tab labels ─────────────────────────────────────
const TABS = [
  { key: "all",       label: "All Requests" },
  { key: "pending",   label: "Pending" },
  { key: "approved",  label: "Approved" },
];

const SORT_OPTIONS = [
  { key: "newest",    label: "Newest First" },
  { key: "oldest",    label: "Oldest First" },
  { key: "date_asc",  label: "Schedule Date ↑" },
  { key: "date_desc", label: "Schedule Date ↓" },
];

export default function RoomActivityListModal({ open, onClose }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [roomFilter, setRoomFilter] = useState("");
  const [sortOrder, setSortOrder] = useState("newest");
  const [currentPage, setCurrentPage] = useState(1);
  // ✅ Toggle to reveal archived / expired records
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const unsub = onSnapshot(
      query(collection(db, "roomActivityRequests"), orderBy("createdAt", "desc")),
      (snap) => {
        setRequests(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      () => setLoading(false)
    );
    return () => unsub();
  }, [open]);

  // Close on ESC
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Reset to page 1 when the modal opens or the archive toggle flips
  useEffect(() => {
    if (!open) {
      setShowArchived(false);
    }
  }, [open]);

  // ── Visible set: exclude archived / expired unless toggled on ─
  const visibleRequests = useMemo(() => {
    if (showArchived) return requests;
    return requests.filter((r) => !isArchivedRequest(r));
  }, [requests, showArchived]);

  const archivedCount = useMemo(
    () => requests.filter((r) => isArchivedRequest(r)).length,
    [requests]
  );

  const counts = useMemo(() => ({
    all: visibleRequests.length,
    pending: visibleRequests.filter((r) =>
      ["pending_admin", "pending_reassign", "pending_faculty"].includes(r.status)
    ).length,
    approved: visibleRequests.filter((r) => r.status === "approved").length,
  }), [visibleRequests]);

  // Unique rooms for the filter dropdown (based on visible set)
  const roomOptions = useMemo(() => {
    const set = new Set();
    visibleRequests.forEach((r) => { if (r.roomName) set.add(r.roomName); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [visibleRequests]);

  // ── Filter + Search + Sort ─────────────────────────────────
  const filtered = useMemo(() => {
    let list = visibleRequests;

    // Tab filter
    if (activeTab === "pending") {
      list = list.filter((r) =>
        ["pending_admin", "pending_reassign", "pending_faculty"].includes(r.status)
      );
    } else if (activeTab === "approved") {
      list = list.filter((r) => r.status === "approved");
    }

    // Room filter
    if (roomFilter) list = list.filter((r) => r.roomName === roomFilter);

    // Search
    if (searchTerm.trim()) {
      const s = searchTerm.toLowerCase();
      list = list.filter((r) =>
        (r.title || "").toLowerCase().includes(s) ||
        (r.roomName || "").toLowerCase().includes(s) ||
        (r.requestedByName || "").toLowerCase().includes(s) ||
        (r.reason || "").toLowerCase().includes(s)
      );
    }

    // Sort
    const sorted = [...list];
    if (sortOrder === "newest") {
      sorted.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    } else if (sortOrder === "oldest") {
      sorted.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
    } else if (sortOrder === "date_asc") {
      sorted.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    } else if (sortOrder === "date_desc") {
      sorted.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    }
    return sorted;
  }, [visibleRequests, activeTab, searchTerm, roomFilter, sortOrder]);

  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab, searchTerm, roomFilter, sortOrder, showArchived]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const start = (safePage - 1) * ITEMS_PER_PAGE;
  const paginated = filtered.slice(start, start + ITEMS_PER_PAGE);

  const hasActiveFilters =
    searchTerm || roomFilter || sortOrder !== "newest" || showArchived;

  const clearAllFilters = () => {
    setSearchTerm("");
    setRoomFilter("");
    setSortOrder("newest");
    setShowArchived(false);
  };

  if (!open) return null;

  return (
    <div className="ralm-overlay" onClick={onClose}>
      <div className="ralm-panel" onClick={(e) => e.stopPropagation()}>

        {/* ── HEADER ────────────────────────────────────────── */}
        <div className="ralm-header">
          <div>
            <h2>Room Activity Requests</h2>
            <p>Track every request you've submitted and its current status.</p>
          </div>
          <button className="ralm-close" onClick={onClose} aria-label="Close">
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>

        {/* ── TABS ROW (full width, scrollable) ──────────────── */}
        <div className="ralm-tabs-row">
          <div className="ralm-tabs">
            {TABS.map((t) => (
              <button key={t.key}
                className={activeTab === t.key ? "active" : ""}
                onClick={() => setActiveTab(t.key)}>
                {t.label}
                <span className="ralm-count">{counts[t.key] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>

        {/* ── SEARCH + FILTERS ROW ───────────────────────────── */}
        <div className="ralm-filters-row">
          <div className="ralm-search">
            <i className="fa-solid fa-magnifying-glass"></i>
            <input
              type="text"
              placeholder="Search title, room, requester, or reason…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {searchTerm && (
              <button className="ralm-search-clear"
                onClick={() => setSearchTerm("")} aria-label="Clear">
                <i className="fa-solid fa-xmark"></i>
              </button>
            )}
          </div>

          <div className="ralm-select-wrap">
            <i className="fa-solid fa-door-open"></i>
            <select value={roomFilter} onChange={(e) => setRoomFilter(e.target.value)}>
              <option value="">All Rooms</option>
              {roomOptions.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            <i className="fa-solid fa-angle-down ralm-select-chev"></i>
          </div>

          <div className="ralm-select-wrap">
            <i className="fa-solid fa-arrow-down-short-wide"></i>
            <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value)}>
              {SORT_OPTIONS.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
            <i className="fa-solid fa-angle-down ralm-select-chev"></i>
          </div>

          {hasActiveFilters && (
            <button className="ralm-clear-all" onClick={clearAllFilters}>
              <i className="fa-solid fa-filter-circle-xmark"></i> Clear
            </button>
          )}
        </div>

        {/* ── RESULT COUNT + ARCHIVE TOGGLE ──────────────────── */}
        <div className="ralm-result-strip">
          <span className="ralm-result-count">
            {filtered.length} result{filtered.length === 1 ? "" : "s"}
            {activeTab !== "all" && (
              <span className="ralm-result-filter"> in {TABS.find((t) => t.key === activeTab)?.label}</span>
            )}
          </span>

          {archivedCount > 0 && (
            <button
              type="button"
              className={`ralm-archive-toggle ${showArchived ? "is-on" : ""}`}
              onClick={() => setShowArchived((v) => !v)}
              title={
                showArchived
                  ? "Hide archived requests"
                  : "Show archived requests (older than 30 days)"
              }
            >
              <i className={`fa-solid ${showArchived ? "fa-eye-slash" : "fa-box-archive"}`}></i>
              {showArchived ? "Hide Archived" : `Show Archived (${archivedCount})`}
            </button>
          )}
        </div>

        {/* ── BODY ──────────────────────────────────────────── */}
        <div className="ralm-body">
          {loading ? (
            <div className="ralm-empty">
              <i className="fa-solid fa-circle-notch fa-spin"></i>
              <p>Loading requests…</p>
            </div>
          ) : paginated.length === 0 ? (
            <div className="ralm-empty">
              <i className="fa-regular fa-folder-open"></i>
              <h4>No requests found</h4>
              <p>
                {searchTerm || roomFilter
                  ? "Try another tab or clear the filters."
                  : "Try another tab."}
              </p>
            </div>
          ) : (
            <div className="ralm-list">
              {paginated.map((r) => (
                <RoomActivityConflictCard key={r.id} request={r} compact />
              ))}
            </div>
          )}
        </div>

        {/* ── PAGINATION ────────────────────────────────────── */}
        {!loading && totalPages > 1 && (
          <div className="ralm-pagination">
            <span className="ralm-page-info">
              Showing {start + 1}–{Math.min(start + ITEMS_PER_PAGE, filtered.length)} of {filtered.length}
            </span>
            <div className="ralm-page-controls">
              <button disabled={safePage === 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                aria-label="Previous">
                <i className="fa-solid fa-chevron-left"></i>
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <button key={p}
                  className={safePage === p ? "active" : ""}
                  onClick={() => setCurrentPage(p)}>
                  {p}
                </button>
              ))}
              <button disabled={safePage === totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                aria-label="Next">
                <i className="fa-solid fa-chevron-right"></i>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}