import "./admin-reassignments.css";
import { useEffect, useState, useMemo } from "react";
import {
  collection, onSnapshot, doc, updateDoc, addDoc, getDoc, getDocs, serverTimestamp,
} from "firebase/firestore";
import { auth, db } from "../../firebase";
import Toast from "../../Popup/Toast/Toast";
import { logActivity } from "../../utils/logActivity";
import { findFacultyUserByName } from "../../utils/findFacultyUser";

const ITEMS_PER_PAGE = 6;

const TABS = [
  { key: "all", label: "All Requests" },
  { key: "pending_admin", label: "Needs Review" },
  { key: "pending_faculty", label: "With Faculty" },
  { key: "needs_reassign", label: "Returned to Clerk" },
  { key: "declined", label: "Declined" },
  { key: "accepted", label: "Confirmed" },
  { key: "cancelled", label: "Cancelled" },
];

const SORT_OPTIONS = [
  { key: "newest", label: "Newest First" },
  { key: "oldest", label: "Oldest First" },
  { key: "date_asc", label: "Schedule Date ↑" },
  { key: "date_desc", label: "Schedule Date ↓" },
];

const NO_ROOM_META = {
  none_available: { label: "No Room Available", short: "Unavailable", icon: "fa-door-closed" },
  none_suited:    { label: "No Suitable Room",  short: "Unsuited",    icon: "fa-circle-question" },
};

const fmt12 = (t) => {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const p = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, "0")} ${p}`;
};
const fmtDate = (d) => {
  if (!d) return "";
  const dt = d?.toDate ? d.toDate() : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });
};

function AdminReassignments() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("all");
  const [actionModal, setActionModal] = useState(null);
  const [noteText, setNoteText] = useState("");
  const [processing, setProcessing] = useState(false);

  const [searchTerm, setSearchTerm] = useState("");
  const [roomFilter, setRoomFilter] = useState("");
  const [sortOrder, setSortOrder] = useState("newest");
  const [currentPage, setCurrentPage] = useState(1);

  const [showRoomPicker, setShowRoomPicker] = useState(false);
  const [roomSearch, setRoomSearch] = useState("");

  const [toast, setToast] = useState({ show: false, type: "success", title: "", message: "" });
  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    if (type !== "loading")
      setTimeout(() => setToast((p) => ({ ...p, show: false })), 4000);
  };

  useEffect(() => {
    setLoading(true);
    const unsub = onSnapshot(
      collection(db, "roomReassignments"),
      (snap) => {
        setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (err) => {
        console.error(err);
        showToast("error", "Load Failed", "Could not load reassignments.");
        setLoading(false);
      }
    );
    return () => unsub();
  }, []);

  const counts = useMemo(
    () =>
      TABS.reduce((acc, t) => {
        acc[t.key] = t.key === "all"
          ? items.length
          : items.filter((i) => i.status === t.key).length;
        return acc;
      }, {}),
    [items]
  );

  const roomOptions = useMemo(() => {
    const set = new Set();
    items.forEach((i) => {
      if (i.oldRoomName) set.add(i.oldRoomName);
      if (i.newRoomName) set.add(i.newRoomName);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [items]);

  const filteredRoomOptions = useMemo(() => {
    const q = roomSearch.trim().toLowerCase();
    if (!q) return roomOptions;
    return roomOptions.filter((r) => r.toLowerCase().includes(q));
  }, [roomOptions, roomSearch]);

  const filtered = useMemo(() => {
    let list = activeTab === "all" ? items : items.filter((i) => i.status === activeTab);
    if (roomFilter)
      list = list.filter(
        (i) => i.oldRoomName === roomFilter || i.newRoomName === roomFilter
      );
    if (searchTerm.trim()) {
      const s = searchTerm.toLowerCase();
      list = list.filter(
        (i) =>
          (i.courseTitle || "").toLowerCase().includes(s) ||
          (i.eventTitle || "").toLowerCase().includes(s) ||
          (i.facultyName || "").toLowerCase().includes(s) ||
          (i.section || "").toLowerCase().includes(s) ||
          (i.oldRoomName || "").toLowerCase().includes(s) ||
          (i.newRoomName || "").toLowerCase().includes(s) ||
          (i.clerkReason || "").toLowerCase().includes(s)
      );
    }
    const sorted = [...list];
    if (sortOrder === "newest")
      sorted.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    else if (sortOrder === "oldest")
      sorted.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
    else if (sortOrder === "date_asc")
      sorted.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    else if (sortOrder === "date_desc")
      sorted.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    return sorted;
  }, [items, activeTab, searchTerm, roomFilter, sortOrder]);

  useEffect(() => { setCurrentPage(1); }, [activeTab, searchTerm, roomFilter, sortOrder]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const startIdx = (safePage - 1) * ITEMS_PER_PAGE;
  const paginated = filtered.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  const hasActiveFilters = searchTerm || roomFilter || sortOrder !== "newest";
  const clearAllFilters = () => {
    setSearchTerm("");
    setRoomFilter("");
    setSortOrder("newest");
  };

  const openAction = (item, type) => {
    setActionModal({ item, type });
    setNoteText("");
  };

  // ══════════════════════════════════════════════════════════════
  // DECIDE — Approve / Cancel / Reassign Again
  // ══════════════════════════════════════════════════════════════
  const decide = async () => {
    if (!actionModal) return;
    const { item, type } = actionModal;
    setProcessing(true);

    const isEvent = item.reassignType === "event";
    const isNoRoom = !!item.noRoomOption;
    const displayTitle = isEvent
      ? item.eventTitle || item.courseTitle || "Untitled Activity"
      : item.courseTitle || "Untitled Class";
    const entryLabel = isEvent ? "activity" : "class";
    const isDeclinedItem = item.status === "declined";
    const isNoRoomItem = isNoRoom;

    try {
      const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
      const me = userDoc.data();
      const myName = `${me.firstName} ${me.lastName}`;

      // ══════════════════════════════════════════════════════════
      // 1. APPROVE → send to faculty (N/A for no-room items)
      // ══════════════════════════════════════════════════════════
      if (type === "approve") {
        if (isNoRoom) {
          showToast("error", "Cannot Approve",
            "There is no new room to approve. Please choose Cancel or Reassign Again.");
          setProcessing(false);
          return;
        }

        // ── Resolve faculty id (fallback by name) ──
        // If facultyId is missing (name lookup failed during submission,
        // or the reassignment came back from a "needs_reassign" cycle),
        // try to re-resolve it now so the notification can be delivered.
        let resolvedFacultyId = item.facultyId || null;
        if (!resolvedFacultyId && item.facultyName) {
          try {
            const usersSnap = await getDocs(collection(db, "users"));
            const found = findFacultyUserByName(usersSnap, item.facultyName);
            if (found) resolvedFacultyId = found.id;
          } catch (err) {
            console.warn("[AdminReassignments] faculty lookup fallback failed:", err);
          }
        }

        await updateDoc(doc(db, "roomReassignments", item.id), {
          status: "pending_faculty",
          adminNote: noteText || "",
          approvedById: auth.currentUser.uid,
          approvedByName: myName,
          approvedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          // Persist resolved facultyId back so future steps find it too.
          ...(resolvedFacultyId && !item.facultyId ? { facultyId: resolvedFacultyId } : {}),
        });

        if (resolvedFacultyId) {
          await addDoc(collection(db, "notifications"), {
            userId: resolvedFacultyId,
            ownerType: "faculty",
            assignmentId: item.id,
            reassignmentId: item.id,
            title: `Room Reassignment — Please Respond`,
            message: `Your ${entryLabel} "${displayTitle}" has been moved from ${item.oldRoomName} to ${item.newRoomName} on ${item.date} (${fmt12(item.startTime)} – ${fmt12(item.endTime)}). Please review and respond.`,
            type: "room-reassignment",
            unread: true, archived: false, badge: "NEW",
            createdAt: serverTimestamp(),
          });
        } else {
          console.warn(
            `[AdminReassignments] No faculty user matched for reassignment ${item.id} (name: "${item.facultyName || ""}"). Notification skipped.`
          );
        }

        if (item.requestedById) {
          await addDoc(collection(db, "notifications"), {
            userId: item.requestedById,
            ownerType: "clerk",
            assignmentId: item.id,
            reassignmentId: item.id,
            title: "Reassignment Approved",
            message: `Your reassignment request (${item.oldRoomName} → ${item.newRoomName}) for "${displayTitle}" was approved. Waiting for faculty response.`,
            type: "room-reassignment-status",
            unread: true, archived: false, badge: "INFO",
            createdAt: serverTimestamp(),
          });
        }

        await logActivity({
          user: myName, role: me.role,
          action: "Approved room reassignment",
          actionType: "approve",
          target: `${displayTitle} • ${item.oldRoomName} → ${item.newRoomName}`,
          status: "SUCCESS",
        });

        showToast("success", "Approved", "Faculty has been notified.");
      }

      // ══════════════════════════════════════════════════════════
      // 2. CANCEL CLASS / ACTIVITY → resolve conflict
      // ══════════════════════════════════════════════════════════
      else if (type === "cancel_class") {
        if (item.eventId) {
          const evRef = doc(db, "events", item.eventId);
          const evSnap = await getDoc(evRef);
          const evData = evSnap.data() || {};

          await updateDoc(evRef, {
            conflictResolved: true,
            resolution: "cancelled_class",
            resolutionReason: noteText ||
              `${isEvent ? "Activity" : "Class"} cancelled by Admin${
                isDeclinedItem ? " (faculty declined reassignment)" :
                isNoRoomItem ? " (no suitable room found)" : ""
              }.`,
            updatedAt: serverTimestamp(),
          });

          if (item.scheduleId && evData.roomId) {
            const schedRef = doc(db, "rooms", evData.roomId, "schedules", item.scheduleId);
            const schedSnap = await getDoc(schedRef);
            if (schedSnap.exists()) {
              await updateDoc(schedRef, {
                cancelled: true,
                cancelledReason: `Cancelled by Admin${
                  isDeclinedItem ? " — faculty declined reassignment" :
                  isNoRoomItem ? " — no suitable room" : ""
                }`,
              });
            }
          }
        }

        await updateDoc(doc(db, "roomReassignments", item.id), {
          status: "cancelled",
          adminNote: noteText || "",
          decidedById: auth.currentUser.uid,
          decidedByName: myName,
          decidedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        if (item.requestedById) {
          await addDoc(collection(db, "notifications"), {
            userId: item.requestedById,
            ownerType: "clerk",
            assignmentId: item.id,
            reassignmentId: item.id,
            title: isEvent ? "Activity Cancelled" : "Class Cancelled",
            message: `The ${entryLabel} "${displayTitle}" on ${item.date} was cancelled by the Admin.${noteText ? ` Reason: ${noteText}` : ""} No further action needed.`,
            type: "room-reassignment-status",
            unread: true, archived: false, badge: "INFO",
            createdAt: serverTimestamp(),
          });
        }

        if (item.facultyId) {
          await addDoc(collection(db, "notifications"), {
            userId: item.facultyId,
            ownerType: "faculty",
            assignmentId: item.id,
            reassignmentId: item.id,
            title: isEvent ? "Activity Cancelled" : "Class Cancelled",
            message: isDeclinedItem
              ? `Your ${entryLabel} "${displayTitle}" on ${item.date} (${fmt12(item.startTime)} – ${fmt12(item.endTime)}) has been cancelled by the Admin after your reassignment was declined.${noteText ? ` Reason: ${noteText}` : ""}`
              : isNoRoomItem
              ? `Your ${entryLabel} "${displayTitle}" on ${item.date} (${fmt12(item.startTime)} – ${fmt12(item.endTime)}) has been cancelled by the Admin — no suitable room was available.${noteText ? ` Reason: ${noteText}` : ""}`
              : `Your ${entryLabel} "${displayTitle}" on ${item.date} (${fmt12(item.startTime)} – ${fmt12(item.endTime)}) has been cancelled by the Admin.${noteText ? ` Reason: ${noteText}` : ""}`,
            type: "room-reassignment-status",
            unread: true, archived: false, badge: "CANCELLED",
            createdAt: serverTimestamp(),
          });
        }

        await logActivity({
          user: myName, role: me.role,
          action: `Cancelled ${entryLabel} (via reassignment)`,
          actionType: "cancel",
          target: `${displayTitle} • ${item.oldRoomName}`,
          status: "SUCCESS",
        });

        showToast(
          "success",
          isEvent ? "Activity Cancelled" : "Class Cancelled",
          "Clerk and Faculty have been notified. Conflict resolved."
        );
      }

      // ══════════════════════════════════════════════════════════
      // 3. REASSIGN AGAIN → send back to clerk
      // ══════════════════════════════════════════════════════════
      else if (type === "reassign_again") {
        await updateDoc(doc(db, "roomReassignments", item.id), {
          status: "needs_reassign",
          adminNote: noteText || (isNoRoomItem
            ? "Please try again — check other floors or re-verify room availability."
            : "Please select another room."),
          decidedById: auth.currentUser.uid,
          decidedByName: myName,
          decidedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        if (item.requestedById) {
          await addDoc(collection(db, "notifications"), {
            userId: item.requestedById,
            ownerType: "clerk",
            assignmentId: item.id,
            reassignmentId: item.id,
            title: "Reassign Again",
            message: `Please reassign this ${entryLabel} to a different room.${noteText ? ` Reason: ${noteText}` : ""}`,
            type: "room-reassignment-status",
            unread: true, archived: false, badge: "ACTION",
            createdAt: serverTimestamp(),
          });
        }

        await logActivity({
          user: myName, role: me.role,
          action: "Requested reassignment again",
          actionType: "edit",
          target: `${displayTitle} • ${item.oldRoomName}`,
          status: "PENDING",
        });

        showToast("success", "Sent back to Clerk",
          "Clerk has been notified to reassign.");
      }

      setActionModal(null);
    } catch (err) {
      console.error(err);
      showToast("error", "Failed", "Could not complete the action.");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <>
      <div className="dhr-page">
        <div className="dhr-header">
          <div>
            <h1 className="dhr-title">Room Reassignments</h1>
            <p className="dhr-subtitle">
              Review reassignment requests from the Clerk. Approve, cancel the
              class, or send it back for a new room.
            </p>
          </div>
        </div>

        <div className="dhr-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`dhr-tab ${activeTab === t.key ? "active" : ""}`}
              onClick={() => setActiveTab(t.key)}
            >
              {t.label}
              <span className="dhr-tab-count">{counts[t.key] || 0}</span>
            </button>
          ))}
        </div>

        <div className="dhr-toolbar">
          <div className="dhr-search">
            <i className="fa-solid fa-magnifying-glass"></i>
            <input
              type="text"
              placeholder="Search course, faculty, section, or room…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {searchTerm && (
              <button className="dhr-search-clear" onClick={() => setSearchTerm("")} aria-label="Clear">
                <i className="fa-solid fa-xmark"></i>
              </button>
            )}
          </div>

          <div className="dhr-filters">
            <div className="dhr-roompicker">
              <button
                type="button"
                className={`dhr-room-trigger ${showRoomPicker ? "open" : ""}`}
                onClick={() => {
                  setRoomSearch("");
                  setShowRoomPicker((v) => !v);
                }}
              >
                <i className="fa-solid fa-door-open"></i>
                <span className="dhr-room-trigger-text">
                  {roomFilter || "All Rooms"}
                </span>
                <i className={`fa-solid fa-chevron-down dhr-room-caret ${showRoomPicker ? "open" : ""}`}></i>
              </button>

              {showRoomPicker && (
                <>
                  <div className="dhr-picker-clickaway" onClick={() => setShowRoomPicker(false)}></div>
                  <div className="dhr-room-popover">
                    <span className="dhr-popover-arrow"></span>
                    <div className="dhr-search-wrap">
                      <i className="fa-solid fa-magnifying-glass"></i>
                      <input
                        type="text"
                        className="dhr-search-input"
                        placeholder="Search room..."
                        value={roomSearch}
                        onChange={(e) => setRoomSearch(e.target.value)}
                        autoFocus
                      />
                      {roomSearch && (
                        <button
                          type="button"
                          className="dhr-search-clear-input"
                          onClick={() => setRoomSearch("")}
                        >
                          <i className="fa-solid fa-xmark"></i>
                        </button>
                      )}
                    </div>

                    <div className="dhr-room-list">
                      <button
                        type="button"
                        className={`dhr-room-option ${!roomFilter ? "is-active" : ""}`}
                        onClick={() => {
                          setRoomFilter("");
                          setShowRoomPicker(false);
                          setRoomSearch("");
                        }}
                      >
                        <div className="dhr-room-option-icon">
                          <i className="fa-solid fa-layer-group"></i>
                        </div>
                        <span className="dhr-room-option-name">All Rooms</span>
                        {!roomFilter && (
                          <i className="fa-solid fa-circle-check dhr-room-option-check"></i>
                        )}
                      </button>

                      {filteredRoomOptions.length === 0 && roomSearch ? (
                        <div className="dhr-picker-empty">
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
                              className={`dhr-room-option ${isActive ? "is-active" : ""}`}
                              onClick={() => {
                                setRoomFilter(r);
                                setShowRoomPicker(false);
                                setRoomSearch("");
                              }}
                            >
                              <div className="dhr-room-option-icon">
                                <i className="fa-solid fa-door-open"></i>
                              </div>
                              <span className="dhr-room-option-name">{r}</span>
                              {isActive && (
                                <i className="fa-solid fa-circle-check dhr-room-option-check"></i>
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

            <div className="dhr-select">
              <i className="fa-solid fa-arrow-down-short-wide"></i>
              <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value)}>
                {SORT_OPTIONS.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
              <i className="fa-solid fa-angle-down dhr-select-chev"></i>
            </div>

            {hasActiveFilters && (
              <button className="dhr-clear-all" onClick={clearAllFilters}>
                <i className="fa-solid fa-filter-circle-xmark"></i> Clear
              </button>
            )}
          </div>

          <span className="dhr-result-count">
            {filtered.length} result{filtered.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="dhr-body">
          {loading ? (
            <div className="dhr-empty">
              <i className="fa-solid fa-spinner fa-spin"></i>
              <p>Loading reassignments…</p>
            </div>
          ) : paginated.length === 0 ? (
            <div className="dhr-empty">
              <i className="fa-regular fa-folder-open"></i>
              <p>
                {searchTerm || roomFilter
                  ? "No matches for your filters."
                  : "No reassignment requests in this view."}
              </p>
            </div>
          ) : (
            paginated.map((item) => (
              <ReassignmentCard key={item.id} item={item} onAction={openAction} />
            ))
          )}
        </div>

        {!loading && totalPages > 1 && (
          <div className="dhr-pagination">
            <span className="dhr-page-info">
              Showing {startIdx + 1}–{Math.min(startIdx + ITEMS_PER_PAGE, filtered.length)} of {filtered.length}
            </span>
            <div className="dhr-page-controls">
              <button
                disabled={safePage === 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              >
                <i className="fa-solid fa-chevron-left"></i>
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
              >
                <i className="fa-solid fa-chevron-right"></i>
              </button>
            </div>
          </div>
        )}
      </div>

      {actionModal && (
        <div className="dhr-modal-overlay" onClick={() => !processing && setActionModal(null)}>
          <div className="dhr-modal" onClick={(e) => e.stopPropagation()}>
            <div className={`dhr-modal-icon is-${actionModal.type}`}>
              <i
                className={
                  actionModal.type === "approve"
                    ? "fa-solid fa-circle-check"
                    : actionModal.type === "cancel_class"
                    ? "fa-solid fa-ban"
                    : "fa-solid fa-rotate-left"
                }
              ></i>
            </div>

            <h3 className="dhr-modal-title">
              {actionModal.type === "approve"
                ? "Approve Reassignment?"
                : actionModal.type === "cancel_class"
                ? actionModal.item.reassignType === "event"
                  ? "Cancel the Activity?"
                  : "Cancel the Class?"
                : "Reassign Again?"}
            </h3>

            <p className="dhr-modal-text">
              {actionModal.type === "approve"
                ? "The affected faculty will be notified and can accept or decline."
                : actionModal.type === "cancel_class"
                ? actionModal.item.status === "declined"
                  ? "The faculty declined this reassignment. Cancelling will resolve the conflict and notify both the faculty and the clerk with the reason you provide."
                  : actionModal.item.noRoomOption
                  ? "The Clerk reported no suitable room. Cancelling will resolve the conflict and notify both faculty and the clerk."
                  : actionModal.item.reassignType === "event"
                  ? "The activity will be cancelled immediately. No further response is needed."
                  : "The class will be cancelled immediately. The faculty is aware and no further response is needed."
                : "This will be sent back to the Clerk to pick a different room."}
            </p>

            <div className="dhr-modal-summary">
              <div className="dhr-modal-summary-row">
                <i className={`fa-solid ${actionModal.item.reassignType === "event" ? "fa-calendar-plus" : "fa-chalkboard-user"}`}></i>
                <span>
                  {actionModal.item.reassignType === "event"
                    ? actionModal.item.eventTitle || "Untitled Activity"
                    : actionModal.item.courseTitle || "—"}
                  {actionModal.item.reassignType !== "event" && actionModal.item.section
                    ? ` · ${actionModal.item.section}`
                    : ""}
                </span>
              </div>

              <div className="dhr-modal-summary-row">
                <i className="fa-solid fa-door-open"></i>
                <span>
                  {actionModal.item.oldRoomName} →{" "}
                  {actionModal.item.noRoomOption ? (
                    <strong style={{ color: "#b45309" }}>
                      {NO_ROOM_META[actionModal.item.noRoomOption]?.label || "No Room"}
                    </strong>
                  ) : (
                    <strong>{actionModal.item.newRoomName || "—"}</strong>
                  )}
                </span>
              </div>

              <div className="dhr-modal-summary-row">
                <i className="fa-regular fa-calendar"></i>
                <span>{fmtDate(actionModal.item.date)}</span>
              </div>

              <div className="dhr-modal-summary-row">
                <i className="fa-regular fa-clock"></i>
                <span>
                  {fmt12(actionModal.item.startTime)} – {fmt12(actionModal.item.endTime)}
                </span>
              </div>

              {actionModal.item.noRoomOption && actionModal.item.clerkReason && (
                <div className="dhr-modal-summary-row" style={{ color: "#92400e" }}>
                  <i className="fa-solid fa-comment-dots" style={{ color: "#d97706" }}></i>
                  <span>Clerk reason: {actionModal.item.clerkReason}</span>
                </div>
              )}

              {actionModal.item.status === "declined" && actionModal.item.denialReason && (
                <div className="dhr-modal-summary-row" style={{ color: "#b91c1c" }}>
                  <i className="fa-solid fa-circle-xmark" style={{ color: "#dc2626" }}></i>
                  <span>Faculty decline reason: {actionModal.item.denialReason}</span>
                </div>
              )}
            </div>

            <textarea
              className="dhr-modal-note"
              placeholder={
                actionModal.type === "reassign_again"
                  ? "Optional note for the Clerk…"
                  : actionModal.type === "cancel_class"
                  ? "Reason for cancellation (will be shown to faculty & clerk)…"
                  : "Optional note (added to record)…"
              }
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              rows={3}
            />

            <div className="dhr-modal-actions">
              <button
                className="dhr-modal-cancel"
                onClick={() => setActionModal(null)}
                disabled={processing}
              >
                Cancel
              </button>
              <button
                className={`dhr-modal-confirm is-${actionModal.type}`}
                onClick={decide}
                disabled={processing}
              >
                {processing
                  ? "Processing…"
                  : actionModal.type === "approve"
                  ? "Approve"
                  : actionModal.type === "cancel_class"
                  ? actionModal.item.reassignType === "event"
                    ? "Cancel Activity"
                    : "Cancel Class"
                  : "Send Back"}
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
        onClose={() => setToast((p) => ({ ...p, show: false }))}
      />
    </>
  );
}

// ─── Card ────────────────────────────────────────────────────────
function ReassignmentCard({ item, onAction }) {
  const statusMap = {
    pending_admin:   { label: "Needs Review",       cls: "is-pending-admin" },
    pending:         { label: "Needs Review",       cls: "is-pending-admin" },
    pending_faculty: { label: "With Faculty",       cls: "is-pending-faculty" },
    needs_reassign:  { label: "Returned to Clerk",  cls: "is-needs-reassign" },
    accepted:        { label: "Confirmed",          cls: "is-accepted" },
    declined:        { label: "Declined",           cls: "is-declined" },
    cancelled:       { label: "Cancelled",          cls: "is-cancelled" },
  };
  const meta = statusMap[item.status] || statusMap.pending_admin;

  const isPending = item.status === "pending_admin" || item.status === "pending";
  const isDeclined = item.status === "declined";
  const isEvent = item.reassignType === "event";
  const isNoRoom = !!item.noRoomOption;
  const noRoomMeta = isNoRoom ? NO_ROOM_META[item.noRoomOption] : null;

  const displayTitle = isEvent
    ? item.eventTitle || item.courseTitle || "Untitled Activity"
    : item.courseTitle || "Untitled Class";

  const displaySubtitle = isEvent
    ? item.eventReason || ""
    : item.section || "";

  const acceptedDate = item.acceptedAt?.toDate?.() || item.acceptedAt || null;
  const declinedDate = item.declinedAt?.toDate?.() || item.declinedAt || null;

  return (
    <div className={`dhr-card ${meta.cls} ${isNoRoom ? "is-no-room" : ""}`}>
      <div className="dhr-card-top">
        <div className="dhr-card-title-block">
          <div className="dhr-card-title">
            <span className={`dhr-type-chip ${isEvent ? "is-event" : "is-class"}`}>
              <i className={`fa-solid ${isEvent ? "fa-calendar-plus" : "fa-chalkboard-user"}`}></i>
              {isEvent ? "Activity" : "Class"}
            </span>
            {displayTitle}
          </div>
          <div className="dhr-card-sub">
            {displaySubtitle && <span>{displaySubtitle}</span>}
            {item.facultyName && (
              <span>
                <i className="fa-regular fa-user"></i> {item.facultyName}
              </span>
            )}
          </div>
        </div>
        <span className={`dhr-status ${meta.cls}`}>{meta.label}</span>
      </div>

      <div className="dhr-card-grid">
        <div className="dhr-info">
          <span className="dhr-info-label">From</span>
          <span className="dhr-info-value">{item.oldRoomName || "—"}</span>
        </div>
        <div className="dhr-info">
          <span className="dhr-info-label">To</span>
          <span className="dhr-info-value" style={isNoRoom ? { color: "#b45309" } : undefined}>
            {isNoRoom
              ? (noRoomMeta?.label || "No Room")
              : (item.newRoomName || "—")}
          </span>
        </div>
        <div className="dhr-info">
          <span className="dhr-info-label">Date</span>
          <span className="dhr-info-value">{fmtDate(item.date)}</span>
        </div>
        <div className="dhr-info">
          <span className="dhr-info-label">Time</span>
          <span className="dhr-info-value">
            {fmt12(item.startTime)} – {fmt12(item.endTime)}
          </span>
        </div>
      </div>

      {isNoRoom && item.clerkReason && (
        <div
          className="dhr-note"
          style={{ background: "#fffbeb", color: "#92400e" }}
        >
          <i className={`fa-solid ${noRoomMeta?.icon || "fa-circle-info"}`}></i>
          <span>
            <strong>Clerk report — {noRoomMeta?.label}:</strong> {item.clerkReason}
          </span>
        </div>
      )}

      {item.adminNote && (
        <div className="dhr-note">
          <i className="fa-solid fa-comment-dots"></i> {item.adminNote}
        </div>
      )}

      {item.status === "pending_faculty" && (
        <div
          className="dhr-note"
          style={{ background: "#eff6ff", color: "#1e40af" }}
        >
          <i className="fa-solid fa-user-clock"></i>
          <span>
            Waiting for faculty response
            {item.facultyName ? ` (${item.facultyName})` : ""}…
          </span>
        </div>
      )}

      {item.status === "accepted" && (
        <div
          className="dhr-note"
          style={{ background: "#ecfdf5", color: "#065f46" }}
        >
          <i className="fa-solid fa-circle-check"></i>
          <span>
            <strong>Accepted by faculty</strong>
            {item.facultyName ? ` — ${item.facultyName}` : ""}
            {acceptedDate ? ` · ${fmtDate(acceptedDate)}` : ""}
            {` · ${isEvent ? "Activity" : "Class"} moved to ${item.newRoomName || "new room"}.`}
          </span>
        </div>
      )}

      {item.status === "declined" && (
        <div
          className="dhr-note"
          style={{ background: "#fef2f2", color: "#b91c1c" }}
        >
          <i className="fa-solid fa-circle-xmark"></i>
          <span>
            <strong>Declined by faculty</strong>
            {item.facultyName ? ` — ${item.facultyName}` : ""}
            {declinedDate ? ` · ${fmtDate(declinedDate)}` : ""}
            {item.denialReason ? ` · Reason: ${item.denialReason}` : ""}
          </span>
        </div>
      )}

      {isPending && (
        <div className="dhr-actions">
          {!isNoRoom && (
            <button
              className="dhr-btn dhr-btn-approve"
              onClick={() => onAction(item, "approve")}
            >
              <i className="fa-solid fa-circle-check"></i> Approve
            </button>
          )}
          <button
            className="dhr-btn dhr-btn-cancel"
            onClick={() => onAction(item, "cancel_class")}
          >
            <i className="fa-solid fa-ban"></i>{" "}
            {isEvent ? "Cancel Activity" : "Cancel Class"}
          </button>
          <button
            className="dhr-btn dhr-btn-reassign"
            onClick={() => onAction(item, "reassign_again")}
          >
            <i className="fa-solid fa-rotate-left"></i> Reassign Again
          </button>
        </div>
      )}

      {isDeclined && (
        <div className="dhr-actions">
          <button
            className="dhr-btn dhr-btn-cancel"
            onClick={() => onAction(item, "cancel_class")}
          >
            <i className="fa-solid fa-ban"></i>{" "}
            {isEvent ? "Cancel Activity" : "Cancel Class"}
          </button>
          <button
            className="dhr-btn dhr-btn-reassign"
            onClick={() => onAction(item, "reassign_again")}
          >
            <i className="fa-solid fa-rotate-left"></i> Reassign Again
          </button>
        </div>
      )}
    </div>
  );
}

export default AdminReassignments;