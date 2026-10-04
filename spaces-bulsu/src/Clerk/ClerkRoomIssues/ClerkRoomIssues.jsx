import { useState, useEffect, useMemo } from "react";
import "../../Components/IssueReportCard/issue-report-card.css";
import "./room-issues.css";
import IssueReportCard from "../../Components/IssueReportCard/IssueReportCard";
import SubmitIssueModal from "../../Components/SubmitIssueModal/SubmitIssueModal";
import Toast from "../../Popup/Toast/Toast";
import { auth, db } from "../../firebase";
import {
  collection, query, orderBy, onSnapshot, doc, updateDoc, addDoc,
  serverTimestamp, getDoc, getDocs,
} from "firebase/firestore";
import { logActivity } from "../../utils/logActivity";
import { isActiveOnDate } from "../../utils/scheduleActivePeriod";

const ITEMS_PER_PAGE = 6;

const SORT_OPTIONS = [
  { key: "newest",   label: "Newest First" },
  { key: "oldest",   label: "Oldest First" },
  { key: "severity", label: "Severity (High → Low)" },
];

const SEVERITY_ORDER = { Urgent: 4, High: 3, Medium: 2, Low: 1 };

// ═══════════════════════════════════════════════════════════════
// Helper: determine if a room is under maintenance
// ═══════════════════════════════════════════════════════════════
const isRoomMaintenance = (room) => {
  const status = String(room.roomStatus || "").toLowerCase().trim();
  const legacyStatus = String(room.status || "").toLowerCase().trim();
  return (
    room.maintenance === true ||
    status === "maintenance" ||
    legacyStatus === "under maintenance"
  );
};

// ═══════════════════════════════════════════════════════════════
// Helpers for matching faculty names to user accounts
// ═══════════════════════════════════════════════════════════════
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

const fmt12 = (t) => {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const p = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, "0")} ${p}`;
};

const getTodayISO = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};

// ══════════════════════════════════════════════════════════════
// Inline Confirm Modal
// ══════════════════════════════════════════════════════════════
function ConfirmModal({
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  loadingText = "Processing…",
  variant = "primary",
  icon = "fa-solid fa-circle-question",
  loading = false,
  onCancel,
  onConfirm,
}) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !loading) onCancel?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loading, onCancel]);

  return (
    <div
      className="ri-cm-overlay"
      role="dialog"
      aria-modal="true"
      onClick={() => !loading && onCancel?.()}
    >
      <div
        className={`ri-cm-card ri-cm-${variant}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ri-cm-icon">
          <i className={icon} />
        </div>

        <h3 className="ri-cm-title">{title}</h3>
        {message && <p className="ri-cm-message">{message}</p>}

        <div className="ri-cm-actions">
          <button
            type="button"
            className="ri-cm-btn ri-cm-btn-cancel"
            onClick={onCancel}
            disabled={loading}
          >
            {cancelText}
          </button>

          <button
            type="button"
            className="ri-cm-btn ri-cm-btn-confirm"
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? (
              <>
                <span className="ri-cm-spinner" />
                <span>{loadingText}</span>
              </>
            ) : (
              <span>{confirmText}</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ClerkRoomIssues() {
  const [issues, setIssues]             = useState([]);
  const [loading, setLoading]           = useState(true);
  const [showModal, setShowModal]       = useState(false);
  const [activeTab, setActiveTab]       = useState("all");
  const [search, setSearch]             = useState("");
  const [roomFilter, setRoomFilter]     = useState("");
  const [sortOrder, setSortOrder]       = useState("newest");
  const [currentPage, setCurrentPage]   = useState(1);
  const [busy, setBusy]                 = useState(false);
  const [maintenanceRooms, setMaintenanceRooms] = useState({});
  const [confirmAction, setConfirmAction] = useState(null);

  // ── Room picker popover state ──────────────────────────────
  const [showRoomPicker, setShowRoomPicker] = useState(false);
  const [roomSearch, setRoomSearch] = useState("");

  const [toast, setToast] = useState({ show: false, type: "success", title: "", message: "" });
  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    setTimeout(() => setToast((p) => ({ ...p, show: false })), 3500);
  };

  // ── Load issues ────────────────────────────────────────────
  useEffect(() => {
    const q = query(collection(db, "roomIssues"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setIssues(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (err) => {
        console.error(err);
        setLoading(false);
      }
    );
    return () => unsub();
  }, []);

  // ── REAL-TIME: Load which rooms are under maintenance ─────
  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "rooms"),
      (snap) => {
        const map = {};
        snap.docs.forEach((d) => {
          const r = d.data();
          if (isRoomMaintenance(r)) {
            map[d.id] = true;
          }
        });
        setMaintenanceRooms(map);
      },
      (err) => console.warn("Rooms listener failed:", err)
    );
    return () => unsub();
  }, []);

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

  // ── Notify the original reporter ───────────────────────────
  const notifyReporter = async (issue, title, message) => {
    if (!issue?.reporterId) return;
    try {
      await addDoc(collection(db, "notifications"), {
        userId: issue.reporterId,
        ownerType: "faculty",
        title,
        message,
        type: "issue-update",
        issueId: issue.id,
        roomName: issue.roomName,
        unread: true,
        archived: false,
        badge: "UPDATE",
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn("Notify reporter failed:", err);
    }
  };

  // ══════════════════════════════════════════════════════════════
  // Notify ALL affected faculty (those with schedules in the room)
  // ══════════════════════════════════════════════════════════════
  const notifyAffectedFaculty = async ({
    roomId,
    roomName,
    eventType, // "maintenance" | "restored"
    reason = "",
    actorName = "",
  }) => {
    if (!roomId) return { notifiedCount: 0, totalSchedules: 0 };

    try {
      const scheduleSnap = await getDocs(
        collection(db, "rooms", roomId, "schedules")
      );
      const today = getTodayISO();

      const activeSchedules = scheduleSnap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((s) => {
          if (s.initialized) return false;
          try {
            if (!isActiveOnDate(s, today)) return false;
          } catch (e) {
            // ignore
          }
          return true;
        });

      if (activeSchedules.length === 0) {
        return { notifiedCount: 0, totalSchedules: 0 };
      }

      const usersSnap = await getDocs(collection(db, "users"));

      const facultySchedulesMap = new Map();

      for (const schedule of activeSchedules) {
        if (!schedule.faculty) continue;
        const facultyDoc = usersSnap.docs.find((docUser) => {
          const user = docUser.data();
          const fullname = normalizeName(
            `${user.firstName || ""} ${user.lastName || ""}`
          );
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

      let notifiedCount = 0;
      let totalSchedules = 0;

      for (const [facultyId, { schedules }] of facultySchedulesMap) {
        const scheduleLines = schedules
          .map((s) => {
            const subject = s.subject || s.courseTitle || "Class";
            const section = s.section ? ` (${s.section})` : "";
            return `• ${subject}${section} — ${s.day || ""} ${fmt12(s.startTime)}–${fmt12(s.endTime)}`;
          })
          .join("\n");

        const isMaintenance = eventType === "maintenance";

        const title = isMaintenance
          ? "Room Under Maintenance"
          : "Room Available Again";

        const message = isMaintenance
          ? `Room ${roomName} is now under maintenance. ` +
            `The following ${schedules.length === 1 ? "class" : "classes"} may be affected:\n` +
            `${scheduleLines}\n\n` +
            (reason ? `Reason: ${reason}\n\n` : "") +
            `Please coordinate with the Clerk for a possible room reassignment.`
          : `Good news! Room ${roomName} is now active and available again. ` +
            `Your following ${schedules.length === 1 ? "class is" : "classes are"} back on track:\n` +
            `${scheduleLines}\n\n` +
            `You may resume your classes in this room as originally scheduled.`;

        await addDoc(collection(db, "notifications"), {
          userId: facultyId,
          ownerType: "faculty",
          title,
          message,
          type: isMaintenance ? "room-maintenance" : "room-restored",
          roomId,
          roomName,
          ...(isMaintenance
            ? {
                maintenanceReason: reason,
                maintenanceSetBy: actorName,
                maintenanceStartDate: today,
              }
            : {
                restoredBy: actorName,
                restoredDate: today,
              }),
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
          badge: isMaintenance ? "URGENT" : "RESOLVED",
          createdAt: serverTimestamp(),
        });

        notifiedCount++;
        totalSchedules += schedules.length;
      }

      return { notifiedCount, totalSchedules };
    } catch (err) {
      console.warn("notifyAffectedFaculty failed:", err);
      return { notifiedCount: 0, totalSchedules: 0 };
    }
  };

  // ══════════════════════════════════════════════════════════
  // ACTION: Mark Under Maintenance
  // ══════════════════════════════════════════════════════════
  const markUnderMaintenance = (issue) => {
    setConfirmAction({
      title: "Mark Room Under Maintenance?",
      message: `This will flag ${issue.roomName} as Under Maintenance and notify all faculty with schedules in this room.`,
      confirmText: "Mark Under Maintenance",
      loadingText: "Flagging room…",
      variant: "warning",
      icon: "fa-solid fa-triangle-exclamation",
      onConfirm: async () => {
        setBusy(true);
        try {
          const u = await getCurrentUser();
          const today = getTodayISO();

          await updateDoc(doc(db, "rooms", issue.roomId), {
            status: "Under Maintenance",
            roomStatus: "maintenance",
            maintenance: true,
            maintenanceReason: issue.description || "",
            maintenanceReportId: issue.id,
            maintenanceCategory: issue.category || "",
            maintenanceSetBy: u.name,
            maintenanceSetAt: serverTimestamp(),
            maintenanceStartDate: today,
          });

          await updateDoc(doc(db, "roomIssues", issue.id), {
            status: "In Progress",
            inProgressBy: u.name,
            inProgressAt: serverTimestamp(),
          });

          await logActivity({
            user: u.name, role: u.role,
            action: "Marked room under maintenance",
            actionType: "edit",
            target: `${issue.roomName} • ${issue.category || ""}`,
            status: "Success",
          });

          await notifyReporter(
            issue,
            "Room Under Maintenance",
            `Your reported issue in ${issue.roomName} is now being addressed. The room has been flagged as Under Maintenance.`
          );

          const { notifiedCount, totalSchedules } = await notifyAffectedFaculty({
            roomId: issue.roomId,
            roomName: issue.roomName,
            eventType: "maintenance",
            reason: issue.description || "",
            actorName: u.name,
          });

          showToast(
            "success",
            "Room Flagged",
            `${issue.roomName} is now Under Maintenance. ${notifiedCount} faculty notified (${totalSchedules} schedule${totalSchedules === 1 ? "" : "s"} affected).`
          );
        } catch (err) {
          console.error(err);
          showToast("error", "Update Failed", err.message);
        } finally {
          setBusy(false);
          setConfirmAction(null);
        }
      },
    });
  };

  // ══════════════════════════════════════════════════════════
  // ACTION: Mark as Resolved
  // Now also restores the room to Available and notifies faculty.
  // ══════════════════════════════════════════════════════════
  const markResolved = (issue) => {
    const wasUnderMaintenance = !!maintenanceRooms[issue.roomId];

    setConfirmAction({
      title: "Mark as Resolved?",
      message: wasUnderMaintenance
        ? `Mark the ${issue.category} issue in ${issue.roomName} as Resolved? The room will be restored to Available and all affected faculty will be notified that their classes can resume.`
        : `Mark the ${issue.category} issue in ${issue.roomName} as Resolved? Affected faculty will be notified if applicable.`,
      confirmText: "Mark as Resolved",
      loadingText: "Resolving…",
      variant: "success",
      icon: "fa-solid fa-circle-check",
      onConfirm: async () => {
        setBusy(true);
        try {
          const u = await getCurrentUser();
          const today = getTodayISO();

          // 1. Resolve the issue
          await updateDoc(doc(db, "roomIssues", issue.id), {
            status: "Resolved",
            resolvedBy: u.name,
            resolvedAt: serverTimestamp(),
          });

          // 2. Restore room to Available (same as old restoreRoom)
          await updateDoc(doc(db, "rooms", issue.roomId), {
            status: "Available",
            roomStatus: "active",
            maintenance: false,
            maintenanceReason: "",
            maintenanceReportId: "",
            maintenanceRestoredBy: u.name,
            maintenanceRestoredAt: serverTimestamp(),
            maintenanceStartDate: null,
            maintenanceEndDate: null,
          });

          // 3. Log activity
          await logActivity({
            user: u.name, role: u.role,
            action: "Marked issue as Resolved",
            actionType: "edit",
            target: `${issue.roomName} • ${issue.category || ""}`,
            status: "Success",
          });

          // 4. Notify the original reporter
          await notifyReporter(
            issue,
            "Issue Resolved",
            `Your reported issue in ${issue.roomName} (${issue.category}) has been resolved. The room is now available. Thank you for reporting!`
          );

          // 5. Notify all affected faculty that the room is back
          const { notifiedCount, totalSchedules } = await notifyAffectedFaculty({
            roomId: issue.roomId,
            roomName: issue.roomName,
            eventType: "restored",
            actorName: u.name,
          });

          showToast(
            "success",
            "Issue Resolved",
            `${issue.roomName} is now Available. ${notifiedCount} faculty notified (${totalSchedules} schedule${totalSchedules === 1 ? "" : "s"} back on track).`
          );
        } catch (err) {
          console.error(err);
          showToast("error", "Failed", err.message);
        } finally {
          setBusy(false);
          setConfirmAction(null);
        }
      },
    });
  };

  // ── Counts ─────────────────────────────────────────────────
  const counts = useMemo(
    () => ({
      all: issues.length,
      pending: issues.filter((i) => i.status === "Pending").length,
      progress: issues.filter(
        (i) => i.status === "Acknowledged" || i.status === "In Progress"
      ).length,
      resolved: issues.filter((i) => i.status === "Resolved").length,
      urgent: issues.filter((i) => i.severity === "Urgent" && i.status !== "Resolved").length,
    }),
    [issues]
  );

  // ── Unique rooms ───────────────────────────────────────────
  const roomOptions = useMemo(() => {
    const set = new Set();
    issues.forEach((i) => {
      if (i.roomName) set.add(i.roomName);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [issues]);

  const filteredRoomOptions = useMemo(() => {
    const q = roomSearch.trim().toLowerCase();
    if (!q) return roomOptions;
    return roomOptions.filter((r) => r.toLowerCase().includes(q));
  }, [roomOptions, roomSearch]);

  // ── Filter + sort ──────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = [...issues];

    if (activeTab === "pending") list = list.filter((i) => i.status === "Pending");
    if (activeTab === "progress")
      list = list.filter((i) => i.status === "In Progress" || i.status === "Acknowledged");
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
      list.sort(
        (a, b) => (SEVERITY_ORDER[b.severity] || 0) - (SEVERITY_ORDER[a.severity] || 0)
      );
    }

    return list;
  }, [issues, activeTab, roomFilter, search, sortOrder]);

  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab, roomFilter, search, sortOrder]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const startIdx = (safePage - 1) * ITEMS_PER_PAGE;
  const paginated = filtered.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  const hasActiveFilters = search || roomFilter || sortOrder !== "newest";
  const clearAllFilters = () => {
    setSearch("");
    setRoomFilter("");
    setSortOrder("newest");
  };

  return (
    <>
      <div className="ri-page">
        <div className="ri-header">
          <div>
            <h1>Room Issues</h1>
            <p>
              Manage room issues forwarded by the Admin. You can only act on issues
              that have been acknowledged.
            </p>
          </div>
          <button className="ri-report-btn" onClick={() => setShowModal(true)}>
            <i className="fa-solid fa-plus" /> Report Issue
          </button>
        </div>

        {/* TABS */}
        <div className="ri-tabs ri-tabs-scroll">
          <button
            className={activeTab === "all" ? "active" : ""}
            onClick={() => setActiveTab("all")}
          >
            All <span className="ri-tab-count">{counts.all}</span>
          </button>
          <button
            className={activeTab === "pending" ? "active" : ""}
            onClick={() => setActiveTab("pending")}
          >
            Pending <span className="ri-tab-count">{counts.pending}</span>
          </button>
          <button
            className={activeTab === "progress" ? "active" : ""}
            onClick={() => setActiveTab("progress")}
          >
            In Progress <span className="ri-tab-count">{counts.progress}</span>
          </button>
          <button
            className={activeTab === "resolved" ? "active" : ""}
            onClick={() => setActiveTab("resolved")}
          >
            Resolved <span className="ri-tab-count">{counts.resolved}</span>
          </button>
          <button
            className={activeTab === "urgent" ? "active" : ""}
            onClick={() => setActiveTab("urgent")}
          >
            Urgent{" "}
            <span className="ri-tab-count ri-tab-count-urgent">{counts.urgent}</span>
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
              <button
                className="ri-search-clear"
                onClick={() => setSearch("")}
                aria-label="Clear"
              >
                <i className="fa-solid fa-xmark" />
              </button>
            )}
          </div>

          <div className="ri-filters">
            {/* ── ROOM PICKER ── */}
            <div className="ri-roompicker">
              <button
                type="button"
                className={`ri-room-trigger ${showRoomPicker ? "open" : ""}`}
                onClick={() => {
                  setRoomSearch("");
                  setShowRoomPicker((v) => !v);
                }}
              >
                <i className="fa-solid fa-door-open"></i>
                <span className="ri-room-trigger-text">
                  {roomFilter || "All Rooms"}
                </span>
                <i
                  className={`fa-solid fa-chevron-down ri-room-caret ${
                    showRoomPicker ? "open" : ""
                  }`}
                ></i>
              </button>

              {showRoomPicker && (
                <>
                  <div
                    className="ri-room-clickaway"
                    onClick={() => setShowRoomPicker(false)}
                  ></div>
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
                        <button
                          type="button"
                          className="ri-room-search-clear"
                          onClick={() => setRoomSearch("")}
                        >
                          <i className="fa-solid fa-xmark"></i>
                        </button>
                      )}
                    </div>

                    <div className="ri-room-list">
                      <button
                        type="button"
                        className={`ri-room-option ${
                          !roomFilter ? "is-active" : ""
                        }`}
                        onClick={() => {
                          setRoomFilter("");
                          setShowRoomPicker(false);
                          setRoomSearch("");
                        }}
                      >
                        <div className="ri-room-option-icon">
                          <i className="fa-solid fa-layer-group"></i>
                        </div>
                        <span className="ri-room-option-name">All Rooms</span>
                        {!roomFilter && (
                          <i className="fa-solid fa-circle-check ri-room-option-check"></i>
                        )}
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
                              type="button"
                              key={r}
                              className={`ri-room-option ${
                                isActive ? "is-active" : ""
                              }`}
                              onClick={() => {
                                setRoomFilter(r);
                                setShowRoomPicker(false);
                                setRoomSearch("");
                              }}
                            >
                              <div className="ri-room-option-icon">
                                <i className="fa-solid fa-door-open"></i>
                              </div>
                              <span className="ri-room-option-name">{r}</span>
                              {isActive && (
                                <i className="fa-solid fa-circle-check ri-room-option-check"></i>
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

            {/* ── SORT ── */}
            <div className="ri-select">
              <i className="fa-solid fa-arrow-down-short-wide" />
              <select
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
              >
                {SORT_OPTIONS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
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
            {filtered.length} result{filtered.length === 1 ? "" : "s"}
          </span>
        </div>

        {loading ? (
          <div className="ri-empty">
            <i className="fa-solid fa-circle-notch fa-spin" />
            <p>Loading issues...</p>
          </div>
        ) : paginated.length === 0 ? (
          <div className="ri-empty">
            <i className="fa-regular fa-face-smile" />
            <h3>Nothing here</h3>
            <p>No issues match the current filter.</p>
          </div>
        ) : (
          <div className="ri-list">
            {paginated.map((issue) => (
              <IssueReportCard
                key={issue.id}
                issue={issue}
                role="clerk"
                busy={busy}
                roomIsUnderMaintenance={!!maintenanceRooms[issue.roomId]}
                onMarkMaintenance={markUnderMaintenance}
                onMarkResolved={markResolved}
              />
            ))}
          </div>
        )}

        {/* PAGINATION */}
        {!loading && totalPages > 1 && (
          <div className="ri-pagination">
            <span className="ri-page-info">
              Showing {startIdx + 1}–{Math.min(startIdx + ITEMS_PER_PAGE, filtered.length)} of{" "}
              {filtered.length}
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
      </div>

      <SubmitIssueModal
        open={showModal}
        onClose={() => setShowModal(false)}
        onSubmitted={() => {}}
      />

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