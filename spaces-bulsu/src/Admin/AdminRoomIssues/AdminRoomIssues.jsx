import { useState, useEffect, useMemo } from "react";
import "../../Components/IssueReportCard/issue-report-card.css";
import "./room-issues.css";
import IssueReportCard from "../../Components/IssueReportCard/IssueReportCard";
import Toast from "../../Popup/Toast/Toast";
import { auth, db } from "../../firebase";
import {
  collection, query, orderBy, onSnapshot, getDocs,
  doc, updateDoc, serverTimestamp, getDoc, addDoc,
} from "firebase/firestore";
import { logActivity } from "../../utils/logActivity";

const ITEMS_PER_PAGE = 6;
const SUMMARY_PER_PAGE = 9;

const SORT_OPTIONS = [
  { key: "newest",   label: "Newest First" },
  { key: "oldest",   label: "Oldest First" },
  { key: "severity", label: "Severity (High → Low)" },
];

const SEVERITY_ORDER = { Urgent: 4, High: 3, Medium: 2, Low: 1 };

function ConfirmModal({
  title, message, confirmText = "Confirm", cancelText = "Cancel",
  loadingText = "Processing…", variant = "primary",
  icon = "fa-solid fa-circle-question", loading = false, onCancel, onConfirm,
}) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !loading) onCancel?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loading, onCancel]);

  return (
    <div className="ri-cm-overlay" role="dialog" aria-modal="true"
      onClick={() => !loading && onCancel?.()}>
      <div className={`ri-cm-card ri-cm-${variant}`} onClick={(e) => e.stopPropagation()}>
        <div className="ri-cm-icon"><i className={icon} /></div>
        <h3 className="ri-cm-title">{title}</h3>
        {message && <p className="ri-cm-message">{message}</p>}
        <div className="ri-cm-actions">
          <button type="button" className="ri-cm-btn ri-cm-btn-cancel"
            onClick={onCancel} disabled={loading}>{cancelText}</button>
          <button type="button" className="ri-cm-btn ri-cm-btn-confirm"
            onClick={onConfirm} disabled={loading}>
            {loading ? (<><span className="ri-cm-spinner" /><span>{loadingText}</span></>) : <span>{confirmText}</span>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ROOM SUMMARY CARD
// ══════════════════════════════════════════════════════════════
function RoomSummaryCard({ summary, onSelect }) {
  const {
    roomName, total, pending, acknowledged, resolved,
    urgent, high, medium, low, categories,
  } = summary;

  const topCategories = Object.entries(categories)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const openCount = total - resolved;

  return (
    <div
      className={`ri-summary-card ${urgent > 0 ? "has-urgent" : ""}`}
      onClick={() => onSelect(summary)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect(summary); }}
    >
      <div className="ri-summary-head">
        <div className="ri-summary-icon">
          <i className="fa-solid fa-door-open" />
        </div>
        <div className="ri-summary-title">
          <h3 title={roomName}>{roomName}</h3>
          <span className="ri-summary-sub">
            {total} report{total !== 1 ? "s" : ""}
            {openCount > 0 && ` · ${openCount} open`}
          </span>
        </div>
        {urgent > 0 && (
          <span className="ri-summary-urgent-badge">
            <i className="fa-solid fa-triangle-exclamation" /> {urgent}
          </span>
        )}
      </div>

      <div className="ri-summary-stats">
        <div className="ri-summary-stat is-pending">
          <span className="ri-summary-stat-num">{pending}</span>
          <span className="ri-summary-stat-label">Pending</span>
        </div>
        <div className="ri-summary-stat is-ack">
          <span className="ri-summary-stat-num">{acknowledged}</span>
          <span className="ri-summary-stat-label">Ack</span>
        </div>
        <div className="ri-summary-stat is-resolved">
          <span className="ri-summary-stat-num">{resolved}</span>
          <span className="ri-summary-stat-label">Resolved</span>
        </div>
      </div>

      <div className="ri-summary-sev">
        {urgent > 0 && <span className="ri-summary-sev-pill is-urgent">Urgent {urgent}</span>}
        {high > 0   && <span className="ri-summary-sev-pill is-high">High {high}</span>}
        {medium > 0 && <span className="ri-summary-sev-pill is-medium">Med {medium}</span>}
        {low > 0    && <span className="ri-summary-sev-pill is-low">Low {low}</span>}
      </div>

      {topCategories.length > 0 && (
        <div className="ri-summary-cats">
          {topCategories.map(([cat, count]) => (
            <span key={cat} className="ri-summary-cat-chip">
              {cat} <strong>{count}</strong>
            </span>
          ))}
        </div>
      )}

      <div className="ri-summary-footer">
        <span>View issues</span>
        <i className="fa-solid fa-arrow-right" />
      </div>
    </div>
  );
}

export default function AdminRoomIssues() {
  const [issues, setIssues]             = useState([]);
  const [loading, setLoading]           = useState(true);
  const [activeTab, setActiveTab]       = useState("all");
  const [search, setSearch]             = useState("");
  const [roomFilter, setRoomFilter]     = useState("");
  const [sortOrder, setSortOrder]       = useState("newest");
  const [currentPage, setCurrentPage]   = useState(1);
  const [maintenanceRooms, setMaintenanceRooms] = useState({});
  const [busy, setBusy]                 = useState(false);
  const [acknowledgingId, setAcknowledgingId] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);
  const [viewMode, setViewMode]         = useState("list"); // "list" | "summary"

  const [showRoomPicker, setShowRoomPicker] = useState(false);
  const [roomSearch, setRoomSearch] = useState("");

  const [toast, setToast] = useState({ show: false, type: "success", title: "", message: "" });
  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    setTimeout(() => setToast((p) => ({ ...p, show: false })), 3500);
  };

  useEffect(() => {
    const q = query(collection(db, "roomIssues"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setIssues(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (err) => { console.error(err); setLoading(false); }
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    const load = async () => {
      const snap = await getDocs(collection(db, "rooms"));
      const map = {};
      snap.docs.forEach((d) => {
        const r = d.data();
        if (r.maintenance || r.status === "Under Maintenance" || r.roomStatus === "maintenance") {
          map[d.id] = true;
        }
      });
      setMaintenanceRooms(map);
    };
    load();
  }, [issues]);

  const getCurrentUser = async () => {
    const user = auth.currentUser;
    if (!user) return { uid: "", name: "", role: "" };
    const snap = await getDoc(doc(db, "users", user.uid));
    const d = snap.exists() ? snap.data() : {};
    return {
      uid: user.uid,
      name: `${d.firstName || ""} ${d.lastName || ""}`.trim() || user.email,
      role: d.role || "",
    };
  };

  const notifyAllClerks = async (title, message, issue) => {
    try {
      const usersSnap = await getDocs(collection(db, "users"));
      const jobs = [];
      usersSnap.forEach((d) => {
        const role = (d.data().role || "").toLowerCase().trim();
        if (role === "clerk") {
          jobs.push(addDoc(collection(db, "notifications"), {
            userId: d.id, ownerType: "clerk",
            issueId: issue.id, roomId: issue.roomId, roomName: issue.roomName,
            title, message, type: "issue-update",
            unread: true, archived: false, badge: "NEW",
            createdAt: serverTimestamp(),
          }));
        }
      });
      if (jobs.length) await Promise.all(jobs);
    } catch (err) { console.warn("notifyAllClerks failed:", err); }
  };

  const notifyReporter = async (issue, title, message, badge = "INFO") => {
    if (!issue?.reporterId) return;
    try {
      await addDoc(collection(db, "notifications"), {
        userId: issue.reporterId, ownerType: "faculty",
        title, message, type: "issue-update",
        issueId: issue.id, roomName: issue.roomName,
        unread: true, archived: false, badge,
        createdAt: serverTimestamp(),
      });
    } catch (err) { console.warn("notifyReporter failed:", err); }
  };

  const acknowledge = (issue) => {
    if (busy) return;
    setConfirmAction({
      title: "Acknowledge Issue?",
      message: `Acknowledge the ${issue.severity || ""} ${issue.category || "room"} issue in ${issue.roomName}? This will forward it to the Clerk and notify all clerks.`,
      confirmText: "Acknowledge",
      loadingText: "Acknowledging…",
      variant: "primary",
      icon: "fa-solid fa-circle-check",
      onConfirm: async () => {
        setAcknowledgingId(issue.id);
        setBusy(true);
        try {
          const u = await getCurrentUser();
          await updateDoc(doc(db, "roomIssues", issue.id), {
            status: "Acknowledged",
            acknowledgedBy: u.name,
            acknowledgedAt: serverTimestamp(),
          });
          await logActivity({
            user: u.name, role: u.role,
            action: "Acknowledged room issue", actionType: "edit",
            target: `${issue.roomName} • ${issue.category || ""}`, status: "Success",
          });
          await notifyReporter(
            issue, "Issue Acknowledged",
            `Your reported issue in ${issue.roomName} (${issue.category || "issue"}) has been acknowledged and forwarded to the Clerk for action.`,
            "INFO"
          );
          await notifyAllClerks(
            "New Acknowledged Issue",
            `${u.name} acknowledged a ${issue.severity || ""} ${issue.category || "room"} issue in ${issue.roomName}. Please review and take action.`,
            issue
          );
          showToast("success", "Acknowledged", `${issue.roomName} issue forwarded to Clerk. Reporter notified.`);
        } catch (err) {
          console.error(err);
          showToast("error", "Failed", err.message || "Could not acknowledge issue.");
        } finally {
          setBusy(false); setAcknowledgingId(null); setConfirmAction(null);
        }
      },
    });
  };

  const counts = useMemo(
    () => ({
      all: issues.length,
      pending: issues.filter((i) => i.status === "Pending").length,
      acknowledged: issues.filter((i) => i.status === "Acknowledged").length,
      resolved: issues.filter((i) => i.status === "Resolved").length,
      urgent: issues.filter((i) => i.severity === "Urgent" && i.status !== "Resolved").length,
    }),
    [issues]
  );

  const roomOptions = useMemo(() => {
    const set = new Set();
    issues.forEach((i) => { if (i.roomName) set.add(i.roomName); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [issues]);

  const filteredRoomOptions = useMemo(() => {
    const q = roomSearch.trim().toLowerCase();
    if (!q) return roomOptions;
    return roomOptions.filter((r) => r.toLowerCase().includes(q));
  }, [roomOptions, roomSearch]);

  // ═══════════════════════════════════════════════════════════
  // ROOM SUMMARIES
  // ═══════════════════════════════════════════════════════════
  const roomSummaries = useMemo(() => {
    // Only apply the search box (not tab/roomFilter) so summaries always
    // show every room — clicking a card sets the filter.
    let list = issues;
    if (search.trim()) {
      const s = search.toLowerCase();
      list = list.filter(
        (i) =>
          (i.roomName || "").toLowerCase().includes(s) ||
          (i.reporterName || "").toLowerCase().includes(s) ||
          (i.category || "").toLowerCase().includes(s) ||
          (i.description || "").toLowerCase().includes(s)
      );
    }

    const map = new Map();
    list.forEach((i) => {
      const key = i.roomName || "Unknown";
      if (!map.has(key)) {
        map.set(key, {
          roomName: key, roomId: i.roomId,
          total: 0, pending: 0, acknowledged: 0, resolved: 0,
          urgent: 0, high: 0, medium: 0, low: 0, categories: {},
        });
      }
      const s = map.get(key);
      s.total++;
      if (i.status === "Pending") s.pending++;
      else if (i.status === "Acknowledged") s.acknowledged++;
      else if (i.status === "Resolved") s.resolved++;

      if (i.severity === "Urgent") s.urgent++;
      else if (i.severity === "High") s.high++;
      else if (i.severity === "Medium") s.medium++;
      else if (i.severity === "Low") s.low++;

      const cats = Array.isArray(i.categories)
        ? i.categories
        : (i.category ? [i.category] : []);
      cats.forEach((c) => { s.categories[c] = (s.categories[c] || 0) + 1; });
    });

    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [issues, search]);

  const filtered = useMemo(() => {
    let list = [...issues];
    if (activeTab === "pending") list = list.filter((i) => i.status === "Pending");
    if (activeTab === "acknowledged") list = list.filter((i) => i.status === "Acknowledged");
    if (activeTab === "resolved") list = list.filter((i) => i.status === "Resolved");
    if (activeTab === "urgent")
      list = list.filter((i) => i.severity === "Urgent" && i.status !== "Resolved");

    if (roomFilter) list = list.filter((i) => i.roomName === roomFilter);
    if (search.trim()) {
      const s = search.toLowerCase();
      list = list.filter(
        (i) =>
          (i.roomName || "").toLowerCase().includes(s) ||
          (i.reporterName || "").toLowerCase().includes(s) ||
          (i.category || "").toLowerCase().includes(s) ||
          (i.description || "").toLowerCase().includes(s)
      );
    }
    if (sortOrder === "newest") {
      list.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    } else if (sortOrder === "oldest") {
      list.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
    } else if (sortOrder === "severity") {
      list.sort((a, b) => (SEVERITY_ORDER[b.severity] || 0) - (SEVERITY_ORDER[a.severity] || 0));
    }
    return list;
  }, [issues, activeTab, roomFilter, search, sortOrder]);

  useEffect(() => { setCurrentPage(1); }, [activeTab, roomFilter, search, sortOrder, viewMode]);

  // ── List pagination ──
  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const startIdx = (safePage - 1) * ITEMS_PER_PAGE;
  const paginated = filtered.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  // ── Summary pagination ──
  const totalSummaryPages = Math.max(1, Math.ceil(roomSummaries.length / SUMMARY_PER_PAGE));
  const safeSummaryPage = Math.min(currentPage, totalSummaryPages);
  const summaryStart = (safeSummaryPage - 1) * SUMMARY_PER_PAGE;
  const paginatedSummaries = roomSummaries.slice(summaryStart, summaryStart + SUMMARY_PER_PAGE);

  const hasActiveFilters = search || roomFilter || sortOrder !== "newest";
  const clearAllFilters = () => {
    setSearch(""); setRoomFilter(""); setSortOrder("newest");
  };

  const handleSummarySelect = (summary) => {
    setRoomFilter(summary.roomName);
    setViewMode("list");
  };

  return (
    <>
      <div className="ri-page">
        <div className="ri-header">
          <div>
            <h1>Room Issue Monitoring</h1>
            <p>Acknowledge issues reported by faculty and staff. Acknowledged issues are forwarded to the Clerk for action.</p>
          </div>

          {/* VIEW TOGGLE */}
          <div className="ri-view-toggle" role="tablist" aria-label="View mode">
            <button
              role="tab"
              className={viewMode === "list" ? "active" : ""}
              onClick={() => setViewMode("list")}
              aria-selected={viewMode === "list"}
            >
              <i className="fa-solid fa-list" /> Issues
            </button>
            <button
              role="tab"
              className={viewMode === "summary" ? "active" : ""}
              onClick={() => setViewMode("summary")}
              aria-selected={viewMode === "summary"}
            >
              <i className="fa-solid fa-table-cells-large" /> By Room
            </button>
          </div>
        </div>

        {/* TABS */}
        <div className="ri-tabs ri-tabs-scroll">
          <button className={activeTab === "all" ? "active" : ""} onClick={() => setActiveTab("all")}>
            All <span className="ri-tab-count">{counts.all}</span>
          </button>
          <button className={activeTab === "pending" ? "active" : ""} onClick={() => setActiveTab("pending")}>
            Pending <span className="ri-tab-count">{counts.pending}</span>
          </button>
          <button className={activeTab === "acknowledged" ? "active" : ""} onClick={() => setActiveTab("acknowledged")}>
            Acknowledged <span className="ri-tab-count">{counts.acknowledged}</span>
          </button>
          <button className={activeTab === "resolved" ? "active" : ""} onClick={() => setActiveTab("resolved")}>
            Resolved <span className="ri-tab-count">{counts.resolved}</span>
          </button>
          <button className={activeTab === "urgent" ? "active" : ""} onClick={() => setActiveTab("urgent")}>
            Urgent <span className="ri-tab-count ri-tab-count-urgent">{counts.urgent}</span>
          </button>
        </div>

        {/* TOOLBAR */}
        <div className="ri-toolbar">
          <div className="ri-search">
            <i className="fa-solid fa-magnifying-glass" />
            <input
              type="text"
              placeholder="Search room, reporter, category..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button className="ri-search-clear" onClick={() => setSearch("")} aria-label="Clear">
                <i className="fa-solid fa-xmark" />
              </button>
            )}
          </div>

          <div className="ri-filters">
            <div className="ri-roompicker">
              <button
                type="button"
                className={`ri-room-trigger ${showRoomPicker ? "open" : ""}`}
                onClick={() => { setRoomSearch(""); setShowRoomPicker((v) => !v); }}
              >
                <i className="fa-solid fa-door-open"></i>
                <span className="ri-room-trigger-text">{roomFilter || "All Rooms"}</span>
                <i className={`fa-solid fa-chevron-down ri-room-caret ${showRoomPicker ? "open" : ""}`}></i>
              </button>

              {showRoomPicker && (
                <>
                  <div className="ri-room-clickaway" onClick={() => setShowRoomPicker(false)}></div>
                  <div className="ri-room-popover">
                    <span className="ri-room-popover-arrow"></span>
                    <div className="ri-room-search-wrap">
                      <i className="fa-solid fa-magnifying-glass"></i>
                      <input
                        type="text"
                        className="ri-room-search"
                        placeholder="Search room..."
                        value={roomSearch}
                        onChange={(e) => setRoomSearch(e.target.value)}
                        autoFocus
                      />
                      {roomSearch && (
                        <button type="button" className="ri-room-search-clear" onClick={() => setRoomSearch("")}>
                          <i className="fa-solid fa-xmark"></i>
                        </button>
                      )}
                    </div>
                    <div className="ri-room-list">
                      <button
                        type="button"
                        className={`ri-room-option ${!roomFilter ? "is-active" : ""}`}
                        onClick={() => {
                          setRoomFilter(""); setShowRoomPicker(false); setRoomSearch("");
                        }}
                      >
                        <div className="ri-room-option-icon"><i className="fa-solid fa-layer-group"></i></div>
                        <span className="ri-room-option-name">All Rooms</span>
                        {!roomFilter && <i className="fa-solid fa-circle-check ri-room-option-check"></i>}
                      </button>
                      {filteredRoomOptions.length === 0 && roomSearch ? (
                        <div className="ri-room-empty">
                          <i className="fa-regular fa-face-frown"></i>
                          <span>No rooms match.</span>
                        </div>
                      ) : (
                        filteredRoomOptions.map((r) => {
                          const isActive = r === roomFilter;
                          return (
                            <button
                              type="button" key={r}
                              className={`ri-room-option ${isActive ? "is-active" : ""}`}
                              onClick={() => {
                                setRoomFilter(r); setShowRoomPicker(false); setRoomSearch("");
                              }}
                            >
                              <div className="ri-room-option-icon"><i className="fa-solid fa-door-open"></i></div>
                              <span className="ri-room-option-name">{r}</span>
                              {isActive && <i className="fa-solid fa-circle-check ri-room-option-check"></i>}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="ri-select">
              <i className="fa-solid fa-arrow-down-short-wide" />
              <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value)}>
                {SORT_OPTIONS.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
              <i className="fa-solid fa-angle-down ri-select-chev" />
            </div>

            {hasActiveFilters && (
              <button className="ri-clear-all" onClick={clearAllFilters}>
                <i className="fa-solid fa-filter-circle-xmark" /> Clear
              </button>
            )}
          </div>

          <span className="ri-result-count">
            {viewMode === "summary"
              ? `${roomSummaries.length} room${roomSummaries.length === 1 ? "" : "s"}`
              : `${filtered.length} result${filtered.length === 1 ? "" : "s"}`}
          </span>
        </div>

        {/* ═══════════════════════════════════════════════════════
            VIEW: SUMMARY
            ═══════════════════════════════════════════════════════ */}
        {viewMode === "summary" ? (
          <>
            {/* Overall overview strip */}
            <div className="ri-summary-overview">
              <div className="ri-summary-overview-item">
                <span className="ri-summary-overview-num">{roomSummaries.length}</span>
                <span className="ri-summary-overview-label">Rooms w/ Issues</span>
              </div>
              <div className="ri-summary-overview-item">
                <span className="ri-summary-overview-num">{counts.all}</span>
                <span className="ri-summary-overview-label">Total Issues</span>
              </div>
              <div className="ri-summary-overview-item is-pending">
                <span className="ri-summary-overview-num">{counts.pending}</span>
                <span className="ri-summary-overview-label">Pending</span>
              </div>
              <div className="ri-summary-overview-item is-ack">
                <span className="ri-summary-overview-num">{counts.acknowledged}</span>
                <span className="ri-summary-overview-label">Acknowledged</span>
              </div>
              <div className="ri-summary-overview-item is-resolved">
                <span className="ri-summary-overview-num">{counts.resolved}</span>
                <span className="ri-summary-overview-label">Resolved</span>
              </div>
              <div className="ri-summary-overview-item is-urgent">
                <span className="ri-summary-overview-num">{counts.urgent}</span>
                <span className="ri-summary-overview-label">Urgent</span>
              </div>
            </div>

            {loading ? (
              <div className="ri-empty">
                <i className="fa-solid fa-circle-notch fa-spin" />
                <p>Loading rooms...</p>
              </div>
            ) : roomSummaries.length === 0 ? (
              <div className="ri-summary-empty">
                <i className="fa-regular fa-folder-open" />
                <h3>No room reports yet</h3>
                <p>Once faculty or staff submit room issues, they'll appear here.</p>
              </div>
            ) : (
              <div className="ri-summary-grid">
                {paginatedSummaries.map((s) => (
                  <RoomSummaryCard key={s.roomName} summary={s} onSelect={handleSummarySelect} />
                ))}
              </div>
            )}

            {!loading && totalSummaryPages > 1 && (
              <div className="ri-pagination">
                <span className="ri-page-info">
                  Showing {summaryStart + 1}–{Math.min(summaryStart + SUMMARY_PER_PAGE, roomSummaries.length)} of {roomSummaries.length} rooms
                </span>
                <div className="ri-page-controls">
                  <button
                    disabled={safeSummaryPage === 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    aria-label="Previous"
                  >
                    <i className="fa-solid fa-chevron-left" />
                  </button>
                  {Array.from({ length: totalSummaryPages }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      className={safeSummaryPage === p ? "active" : ""}
                      onClick={() => setCurrentPage(p)}
                    >
                      {p}
                    </button>
                  ))}
                  <button
                    disabled={safeSummaryPage === totalSummaryPages}
                    onClick={() => setCurrentPage((p) => Math.min(totalSummaryPages, p + 1))}
                    aria-label="Next"
                  >
                    <i className="fa-solid fa-chevron-right" />
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          /* ═════════════════════════════════════════════════════
             VIEW: LIST (unchanged)
             ═════════════════════════════════════════════════════ */
          <>
            {loading ? (
              <div className="ri-empty">
                <i className="fa-solid fa-circle-notch fa-spin" />
                <p>Loading issues...</p>
              </div>
            ) : paginated.length === 0 ? (
              <div className="ri-empty">
                <i className="fa-regular fa-clipboard" />
                <h3>No issues found</h3>
                <p>Nothing matches the current filter.</p>
              </div>
            ) : (
              <div className="ri-list">
                {paginated.map((issue) => (
                  <IssueReportCard
                    key={issue.id}
                    issue={issue}
                    role="admin"
                    busy={busy}
                    acknowledging={acknowledgingId === issue.id}
                    roomIsUnderMaintenance={!!maintenanceRooms[issue.roomId]}
                    onAcknowledge={acknowledge}
                  />
                ))}
              </div>
            )}

            {!loading && totalPages > 1 && (
              <div className="ri-pagination">
                <span className="ri-page-info">
                  Showing {startIdx + 1}–{Math.min(startIdx + ITEMS_PER_PAGE, filtered.length)} of {filtered.length}
                </span>
                <div className="ri-page-controls">
                  <button
                    disabled={safePage === 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    aria-label="Previous"
                  >
                    <i className="fa-solid fa-chevron-left" />
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      className={safePage === p ? "active" : ""}
                      onClick={() => setCurrentPage(p)}
                    >
                      {p}
                    </button>
                  ))}
                  <button
                    disabled={safePage === totalPages}
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    aria-label="Next"
                  >
                    <i className="fa-solid fa-chevron-right" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {confirmAction && (
        <ConfirmModal
          title={confirmAction.title}
          message={confirmAction.message}
          confirmText={confirmAction.confirmText}
          loadingText={confirmAction.loadingText}
          variant={confirmAction.variant}
          icon={confirmAction.icon}
          loading={busy}
          onCancel={() => !busy && setConfirmAction(null)}
          onConfirm={confirmAction.onConfirm}
        />
      )}

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