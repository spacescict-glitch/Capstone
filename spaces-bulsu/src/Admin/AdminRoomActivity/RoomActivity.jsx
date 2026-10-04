import { useState, useEffect, useMemo, useRef } from "react";
import "./room-activity.css";
import { db, auth } from "../../firebase";
import Toast from "../../Popup/Toast/Toast";
import {
  collection,
  getDocs,
  doc,
  getDoc,
  updateDoc,
  addDoc,
  serverTimestamp,
  onSnapshot,
} from "firebase/firestore";
import { logActivity } from "../../utils/logActivity";
import { findFacultyUserByName } from "../../utils/findFacultyUser";

const ITEMS_PER_PAGE = 5;

const TABS = [
  { key: "all",           label: "All Requests" },
  { key: "pending_admin", label: "Needs Review" },
  { key: "approved",      label: "Approved" },
];

const SORT_OPTIONS = [
  { key: "newest",    label: "Newest First" },
  { key: "oldest",    label: "Oldest First" },
  { key: "date_asc",  label: "Schedule Date ↑" },
  { key: "date_desc", label: "Schedule Date ↓" },
];

const fmt12 = (t) => {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const p = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, "0")} ${p}`;
};
const fmtDate = (d) => {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
};

// ═════════════════════════════════════════════════════════════════════
// RECENCY HELPERS — normalize any date-like value to milliseconds.
// Handles Firestore Timestamp, Date, number, ISO string, or missing.
// ═════════════════════════════════════════════════════════════════════
const toMillis = (v) => {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "object" && typeof v.seconds === "number") {
    return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
  }
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
};

// Best-effort "when was this request submitted" timestamp.
const recencyOf = (item) =>
  toMillis(item?.createdAt) ||
  toMillis(item?.updatedAt) ||
  (item?.date ? new Date(`${item.date}T00:00:00`).getTime() : 0);

// ═════════════════════════════════════════════════════════════════════
// CALENDAR HELPERS
// ═════════════════════════════════════════════════════════════════════
const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const WEEKDAY_LABELS = ["Su","Mo","Tu","We","Th","Fr","Sa"];

const toDateInputValue = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};
const formatDateLongLocal = (dateStr) => {
  if (!dateStr) return "";
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });
};
const buildCalendarGrid = (year, month) => {
  const first = new Date(year, month, 1);
  const startOffset = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < startOffset; i++) {
    cells.push({
      day: daysInPrev - startOffset + 1 + i,
      inMonth: false,
      date: new Date(year, month - 1, daysInPrev - startOffset + 1 + i),
    });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, inMonth: true, date: new Date(year, month, d) });
  }
  while (cells.length < 42) {
    const idx = cells.length - startOffset - daysInMonth + 1;
    cells.push({ day: idx, inMonth: false, date: new Date(year, month + 1, idx) });
  }
  return cells;
};

// ═════════════════════════════════════════════════════════════════════
// INLINE DATE PICKER
// ═════════════════════════════════════════════════════════════════════
function InlineDatePicker({ value, onChange, placeholder = "Select date", icon = "fa-regular fa-calendar" }) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => {
    const base = value ? new Date(`${value}T00:00:00`) : new Date();
    return { year: base.getFullYear(), month: base.getMonth() };
  });
  const wrapRef = useRef(null);

  useEffect(() => {
    const handle = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const todayStr = toDateInputValue(new Date());

  const toggle = () => {
    const base = value ? new Date(`${value}T00:00:00`) : new Date();
    setCursor({ year: base.getFullYear(), month: base.getMonth() });
    setOpen((v) => !v);
  };
  const pick = (v) => { onChange(v); setOpen(false); };

  return (
    <div className="ra-mp-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`ra-mp-trigger ${open ? "open" : ""}`}
        onClick={toggle}
      >
        <i className={icon}></i>
        <span className={`ra-mp-text ${!value ? "is-placeholder" : ""}`}>
          {value ? formatDateLongLocal(value) : placeholder}
        </span>
        <i className={`fa-solid fa-chevron-down ra-mp-caret ${open ? "open" : ""}`}></i>
      </button>

      {open && (
        <div className="ra-mp-popover ra-mp-date-popover">
          <span className="ra-mp-arrow"></span>

          <div className="ra-mp-quick">
            <button
              type="button"
              className={value === todayStr ? "active" : ""}
              onClick={() => pick(todayStr)}
            >
              Today
            </button>
            <button type="button" onClick={() => pick("")}>
              Clear
            </button>
          </div>

          <div className="ra-mp-cal-header">
            <button
              type="button"
              className="ra-mp-cal-nav"
              onClick={() =>
                setCursor((c) =>
                  c.month === 0
                    ? { year: c.year - 1, month: 11 }
                    : { year: c.year, month: c.month - 1 }
                )
              }
            >
              <i className="fa-solid fa-chevron-left"></i>
            </button>
            <span className="ra-mp-cal-title">
              {MONTH_NAMES[cursor.month]} {cursor.year}
            </span>
            <button
              type="button"
              className="ra-mp-cal-nav"
              onClick={() =>
                setCursor((c) =>
                  c.month === 11
                    ? { year: c.year + 1, month: 0 }
                    : { year: c.year, month: c.month + 1 }
                )
              }
            >
              <i className="fa-solid fa-chevron-right"></i>
            </button>
          </div>

          <div className="ra-mp-cal-weekdays">
            {WEEKDAY_LABELS.map((w) => <span key={w}>{w}</span>)}
          </div>

          <div className="ra-mp-cal-grid">
            {buildCalendarGrid(cursor.year, cursor.month).map((cell, i) => {
              const cellStr = toDateInputValue(cell.date);
              const isSelected = cellStr === value;
              return (
                <button
                  type="button"
                  key={i}
                  className={`ra-mp-cal-day ${!cell.inMonth ? "is-outside" : ""} ${isSelected ? "is-selected" : ""}`}
                  onClick={() => pick(cellStr)}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// INLINE ROOM PICKER
// ═════════════════════════════════════════════════════════════════════
function InlineRoomPicker({ value, valueId, onChange, rooms = [], placeholder = "Select room" }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapRef = useRef(null);

  useEffect(() => {
    const handle = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const sortedRooms = useMemo(
    () =>
      [...rooms].sort((a, b) =>
        (a.roomName || "").localeCompare(b.roomName || "", undefined, {
          numeric: true,
          sensitivity: "base",
        })
      ),
    [rooms]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sortedRooms;
    return sortedRooms.filter((r) => (r.roomName || "").toLowerCase().includes(q));
  }, [sortedRooms, search]);

  const toggle = () => { setSearch(""); setOpen((v) => !v); };

  return (
    <div className="ra-mp-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`ra-mp-trigger ${open ? "open" : ""}`}
        onClick={toggle}
      >
        <i className="fa-solid fa-door-open"></i>
        <span className={`ra-mp-text ${!value ? "is-placeholder" : ""}`}>
          {value || placeholder}
        </span>
        <i className={`fa-solid fa-chevron-down ra-mp-caret ${open ? "open" : ""}`}></i>
      </button>

      {open && (
        <div className="ra-mp-popover ra-mp-room-popover">
          <span className="ra-mp-arrow"></span>

          <div className="ra-mp-search-wrap">
            <i className="fa-solid fa-magnifying-glass"></i>
            <input
              type="text"
              className="ra-mp-search-input"
              placeholder="Search room..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            {search && (
              <button
                type="button"
                className="ra-mp-search-clear"
                onClick={() => setSearch("")}
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
            )}
          </div>

          <div className="ra-mp-room-list">
            {filtered.length === 0 ? (
              <div className="ra-mp-empty">
                <i className="fa-regular fa-face-frown"></i>
                <span>No rooms match.</span>
              </div>
            ) : (
              filtered.map((r) => {
                const rId = r.id || r.docId || r.roomId;
                const isActive = rId === valueId || r.roomName === value;
                return (
                  <button
                    type="button"
                    key={rId || r.roomName}
                    className={`ra-mp-room-option ${isActive ? "is-active" : ""}`}
                    onClick={() => {
                      onChange(r.roomName, rId);
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    <div className="ra-mp-room-icon">
                      <i className="fa-solid fa-door-open"></i>
                    </div>
                    <div className="ra-mp-room-body">
                      <span className="ra-mp-room-name">{r.roomName}</span>
                      {(r.floor || r.building) && (
                        <span className="ra-mp-room-meta">
                          {r.floor && <>Floor {r.floor}</>}
                          {r.floor && r.building && <span className="ra-mp-dot">•</span>}
                          {r.building && <>{r.building}</>}
                        </span>
                      )}
                    </div>
                    {isActive && (
                      <i className="fa-solid fa-circle-check ra-mp-room-check"></i>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// CONFLICT ROW
// ═════════════════════════════════════════════════════════════════════
function ConflictRow({ conflict }) {
  return (
    <div className="ra-conflict-row">
      <div className="ra-conflict-row-icon">
        <i className="fa-solid fa-triangle-exclamation"></i>
      </div>
      <div className="ra-conflict-row-body">
        <div className="ra-conflict-row-title">
          {conflict.subject || "Untitled class"}
        </div>
        <div className="ra-conflict-row-meta">
          {conflict.faculty && (
            <span>
              <i className="fa-regular fa-user"></i>
              {conflict.faculty}
            </span>
          )}
          {conflict.section && (
            <span>
              <i className="fa-solid fa-users"></i>
              {conflict.section}
            </span>
          )}
          {(conflict.startTime || conflict.endTime) && (
            <span>
              <i className="fa-regular fa-clock"></i>
              {fmt12(conflict.startTime)} – {fmt12(conflict.endTime)}
            </span>
          )}
          {conflict.roomName && (
            <span>
              <i className="fa-solid fa-door-open"></i>
              {conflict.roomName}
            </span>
          )}
          {conflict.date && (
            <span>
              <i className="fa-regular fa-calendar"></i>
              {conflict.date}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═════════════════════════════════════════════════════════════════════
function RoomActivity() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("all");

  const [searchTerm, setSearchTerm] = useState("");
  const [roomFilter, setRoomFilter] = useState("");
  const [sortOrder, setSortOrder] = useState("newest");
  const [currentPage, setCurrentPage] = useState(1);

  const [showRoomPicker, setShowRoomPicker] = useState(false);
  const [roomSearch, setRoomSearch] = useState("");
  const [roomsList, setRoomsList] = useState([]);

  const [reviewing, setReviewing] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState({});
  const [processing, setProcessing] = useState(false);

  const [toast, setToast] = useState({ show: false, type: "success", title: "", message: "" });
  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    if (type !== "loading") setTimeout(() => setToast((p) => ({ ...p, show: false })), 4000);
  };

  useEffect(() => {
    setLoading(true);
    const unsub = onSnapshot(
      collection(db, "roomActivityRequests"),
      (snap) => {
        setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (err) => {
        console.error(err);
        showToast("error", "Load Failed", "Could not load room activity requests.");
        setLoading(false);
      }
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "rooms"),
      (snap) => setRoomsList(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => console.warn("Rooms listener failed:", err)
    );
    return () => unsub();
  }, []);

  const counts = useMemo(() => ({
    pending_admin: items.filter((i) => i.status === "pending_admin").length,
    approved:      items.filter((i) => i.status === "approved").length,
    all:           items.length,
  }), [items]);

  const roomOptions = useMemo(() => {
    const set = new Set();
    items.forEach((i) => { if (i.roomName) set.add(i.roomName); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [items]);

  const filteredRoomOptions = useMemo(() => {
    const q = roomSearch.trim().toLowerCase();
    if (!q) return roomOptions;
    return roomOptions.filter((r) => r.toLowerCase().includes(q));
  }, [roomOptions, roomSearch]);

  const filtered = useMemo(() => {
    let list = activeTab === "all" ? items : items.filter((i) => i.status === activeTab);
    if (roomFilter) list = list.filter((i) => i.roomName === roomFilter);
    if (searchTerm.trim()) {
      const s = searchTerm.toLowerCase();
      list = list.filter((i) =>
        (i.title || "").toLowerCase().includes(s) ||
        (i.roomName || "").toLowerCase().includes(s) ||
        (i.requestedByName || "").toLowerCase().includes(s) ||
        (i.reason || "").toLowerCase().includes(s)
      );
    }
    const sorted = [...list];

    // ── NEWEST FIRST is the default & must always win ──
    if (sortOrder === "newest") {
      sorted.sort((a, b) => {
        const diff = recencyOf(b) - recencyOf(a);
        if (diff !== 0) return diff;
        // Stable tie-breaker: newest schedule date first, then id.
        const dateDiff = String(b.date || "").localeCompare(String(a.date || ""));
        if (dateDiff !== 0) return dateDiff;
        return String(b.id || "").localeCompare(String(a.id || ""));
      });
    } else if (sortOrder === "oldest") {
      sorted.sort((a, b) => {
        const diff = recencyOf(a) - recencyOf(b);
        if (diff !== 0) return diff;
        return String(a.date || "").localeCompare(String(b.date || ""));
      });
    } else if (sortOrder === "date_asc") {
      sorted.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    } else if (sortOrder === "date_desc") {
      sorted.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    }
    return sorted;
  }, [items, activeTab, searchTerm, roomFilter, sortOrder]);

  useEffect(() => { setCurrentPage(1); }, [activeTab, searchTerm, roomFilter, sortOrder]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const startIdx = (safePage - 1) * ITEMS_PER_PAGE;
  const paginated = filtered.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  const hasActiveFilters = searchTerm || roomFilter || sortOrder !== "newest";
  const clearAllFilters = () => { setSearchTerm(""); setRoomFilter(""); setSortOrder("newest"); };

  const startReview = (item) => {
    setReviewing({ item });
    setEditMode(false);
    setDraft({
      title: item.title || "",
      roomName: item.roomName || "",
      roomId: item.roomId || "",
      date: item.date || "",
      startTime: item.startTime || "",
      endTime: item.endTime || "",
      reason: item.reason || "",
    });
  };

  const handleApprove = async () => {
    if (!reviewing) return;
    const { item } = reviewing;
    setProcessing(true);
    try {
      const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
      const me = userDoc.data();
      const myName = `${me.firstName} ${me.lastName}`;

      await updateDoc(doc(db, "roomActivityRequests", item.id), {
        title: draft.title.trim(), roomName: draft.roomName, roomId: draft.roomId,
        date: draft.date, startTime: draft.startTime, endTime: draft.endTime,
        reason: draft.reason.trim(), status: "approved",
        approvedById: auth.currentUser.uid, approvedByName: myName,
        approvedAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });

      let eventId = item.eventId;
      if (!eventId) {
        const eventRef = await addDoc(collection(db, "events"), {
          roomId: draft.roomId, roomName: draft.roomName,
          title: draft.title.trim(), reason: draft.reason.trim(),
          date: draft.date, startTime: draft.startTime, endTime: draft.endTime,
          status: "active",
          createdById: item.requestedById, createdByName: item.requestedByName,
          approvedById: auth.currentUser.uid, createdAt: serverTimestamp(),
        });
        eventId = eventRef.id;
        await updateDoc(doc(db, "roomActivityRequests", item.id), { eventId });
      }

      const usersSnap = await getDocs(collection(db, "users"));
      let notified = 0;
      for (const conflict of item.conflicts || []) {
        let facultyDoc = null;
        if (conflict.facultyId) facultyDoc = usersSnap.docs.find((d) => d.id === conflict.facultyId) || null;
        if (!facultyDoc && conflict.faculty) facultyDoc = findFacultyUserByName(usersSnap, conflict.faculty);
        if (!facultyDoc) continue;

        await addDoc(collection(db, "notifications"), {
          userId: facultyDoc.id, ownerType: "faculty",
          activityId: eventId, title: "Room Activity Override",
          message: `${draft.title} will use ${draft.roomName} on ${draft.date} (${fmt12(draft.startTime)} - ${fmt12(draft.endTime)}). Your scheduled class may be affected.`,
          type: "room-activity", unread: true, archived: false, badge: "NEW",
          roomId: draft.roomId, roomName: draft.roomName,
          activityTitle: draft.title, activityReason: draft.reason,
          activityDate: draft.date, activityStart: draft.startTime, activityEnd: draft.endTime,
          affectedScheduleId: conflict.scheduleId, affectedSubject: conflict.subject,
          affectedFaculty: conflict.faculty, createdAt: serverTimestamp(),
        });
        notified++;
      }

      if (item.requestedById) {
        await addDoc(collection(db, "notifications"), {
          userId: item.requestedById, ownerType: "clerk",
          activityRequestId: item.id, title: "Room Activity Approved",
          message: `"${draft.title}" was approved for ${draft.roomName} on ${draft.date}. ${notified} faculty notified.`,
          type: "room-activity-status", unread: true, archived: false, badge: "INFO",
          createdAt: serverTimestamp(),
        });
      }

      await logActivity({
        user: myName, role: me.role,
        action: "Approved room activity request", actionType: "approve",
        target: `${draft.title} (${draft.roomName})`, status: "SUCCESS",
      });

      showToast("success", "Approved", `Activity approved. ${notified} faculty notified.`);
      setReviewing(null);
    } catch (err) {
      console.error(err);
      showToast("error", "Failed", "Could not approve request.");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <>
      <div className="ra-review-page">
        <div className="ra-review-header">
          <div>
            <h1 className="ra-review-title">Room Activity Requests</h1>
            <p className="ra-review-subtitle">
              Review requests submitted by the Clerk. Approve with optional edits before finalizing.
            </p>
          </div>
        </div>

        <div className="ra-review-tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`ra-review-tab ${activeTab === t.key ? "active" : ""}`}
              onClick={() => setActiveTab(t.key)}>
              {t.label}
              <span className="ra-review-tab-count">{counts[t.key] ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="ra-review-toolbar">
          <div className="ra-review-search">
            <i className="fa-solid fa-magnifying-glass"></i>
            <input type="text" placeholder="Search title, room, requester, or reason…"
              value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
            {searchTerm && (
              <button className="ra-review-search-clear" onClick={() => setSearchTerm("")} aria-label="Clear">
                <i className="fa-solid fa-xmark"></i>
              </button>
            )}
          </div>

          <div className="ra-review-filters">
            <div className="ra-review-roompicker">
              <button type="button"
                className={`ra-review-room-trigger ${showRoomPicker ? "open" : ""}`}
                onClick={() => { setRoomSearch(""); setShowRoomPicker((v) => !v); }}>
                <i className="fa-solid fa-door-open"></i>
                <span className="ra-review-room-trigger-text">{roomFilter || "All Rooms"}</span>
                <i className={`fa-solid fa-chevron-down ra-review-room-caret ${showRoomPicker ? "open" : ""}`}></i>
              </button>

              {showRoomPicker && (
                <>
                  <div className="ra-review-picker-clickaway" onClick={() => setShowRoomPicker(false)}></div>
                  <div className="ra-review-room-popover">
                    <span className="ra-review-popover-arrow"></span>

                    <div className="ra-review-room-search-wrap">
                      <i className="fa-solid fa-magnifying-glass"></i>
                      <input type="text" className="ra-review-room-search-input" placeholder="Search room..."
                        value={roomSearch} onChange={(e) => setRoomSearch(e.target.value)} autoFocus />
                      {roomSearch && (
                        <button type="button" className="ra-review-room-search-clear" onClick={() => setRoomSearch("")}>
                          <i className="fa-solid fa-xmark"></i>
                        </button>
                      )}
                    </div>

                    <div className="ra-review-room-list">
                      <button type="button"
                        className={`ra-review-room-option ${!roomFilter ? "is-active" : ""}`}
                        onClick={() => { setRoomFilter(""); setShowRoomPicker(false); setRoomSearch(""); }}>
                        <div className="ra-review-room-option-icon"><i className="fa-solid fa-layer-group"></i></div>
                        <span className="ra-review-room-option-name">All Rooms</span>
                        {!roomFilter && <i className="fa-solid fa-circle-check ra-review-room-option-check"></i>}
                      </button>

                      {filteredRoomOptions.length === 0 && roomSearch ? (
                        <div className="ra-review-picker-empty">
                          <i className="fa-regular fa-face-frown"></i>
                          <span>No rooms match.</span>
                        </div>
                      ) : (
                        filteredRoomOptions.map((r) => {
                          const isActive = r === roomFilter;
                          return (
                            <button type="button" key={r}
                              className={`ra-review-room-option ${isActive ? "is-active" : ""}`}
                              onClick={() => { setRoomFilter(r); setShowRoomPicker(false); setRoomSearch(""); }}>
                              <div className="ra-review-room-option-icon"><i className="fa-solid fa-door-open"></i></div>
                              <span className="ra-review-room-option-name">{r}</span>
                              {isActive && <i className="fa-solid fa-circle-check ra-review-room-option-check"></i>}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="ra-review-select">
              <i className="fa-solid fa-arrow-down-short-wide"></i>
              <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value)}>
                {SORT_OPTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
              <i className="fa-solid fa-angle-down ra-review-select-chev"></i>
            </div>

            {hasActiveFilters && (
              <button className="ra-review-clear-all" onClick={clearAllFilters}>
                <i className="fa-solid fa-filter-circle-xmark"></i> Clear
              </button>
            )}
          </div>

          <span className="ra-review-result-count">
            {filtered.length} result{filtered.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="ra-review-body">
          {loading ? (
            <div className="ra-review-empty">
              <i className="fa-solid fa-spinner fa-spin"></i><p>Loading requests…</p>
            </div>
          ) : paginated.length === 0 ? (
            <div className="ra-review-empty">
              <i className="fa-regular fa-folder-open"></i>
              <p>{searchTerm || roomFilter ? "No matches for your filters." : "No requests in this view."}</p>
            </div>
          ) : (
            paginated.map((item) => (
              <ReviewCard key={item.id} item={item} onReview={() => startReview(item)} />
            ))
          )}
        </div>

        {!loading && totalPages > 1 && (
          <div className="ra-review-pagination">
            <span className="ra-review-page-info">
              Showing {startIdx + 1}–{Math.min(startIdx + ITEMS_PER_PAGE, filtered.length)} of {filtered.length}
            </span>
            <div className="ra-review-page-controls">
              <button disabled={safePage === 1} onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}>
                <i className="fa-solid fa-chevron-left"></i>
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <button key={p} className={safePage === p ? "active" : ""} onClick={() => setCurrentPage(p)}>{p}</button>
              ))}
              <button disabled={safePage === totalPages} onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}>
                <i className="fa-solid fa-chevron-right"></i>
              </button>
            </div>
          </div>
        )}
      </div>

      {reviewing && (
        <div className="ra-modal-overlay">
          <div className="ra-modal ra-modal-wide">
            {/* ═════════════ SCROLLABLE BODY ═════════════ */}
            <div className="ra-modal-scroll">
              <div className="ra-modal-header">
                <div className="ra-modal-icon">
                  <i className="fa-solid fa-check"></i>
                </div>
                <h3 className="ra-modal-title">
                  {editMode ? "Edit & Approve" : "Approve Request"}
                </h3>
                <p className="ra-modal-text">
                  You can adjust details before approving. Only affected faculty will be notified.
                </p>
              </div>

              {/* Conflict details — compact scrollable list */}
              {(reviewing.item.conflicts?.length || 0) > 0 && (
                <div className="ra-conflict-panel">
                  <div className="ra-conflict-panel-header">
                    <i className="fa-solid fa-triangle-exclamation"></i>
                    <div>
                      <strong>
                        {reviewing.item.conflicts.length} conflicting{" "}
                        {reviewing.item.conflicts.length === 1 ? "schedule" : "schedules"}
                      </strong>
                      <p>These classes will be overridden. Affected faculty will be notified.</p>
                    </div>
                  </div>

                  <div className="ra-conflict-panel-list ra-conflict-panel-list--compact">
                    {reviewing.item.conflicts.map((conflict, i) => (
                      <ConflictRow key={conflict.scheduleId || i} conflict={conflict} />
                    ))}
                  </div>
                </div>
              )}

              <button className="ra-edit-toggle" onClick={() => setEditMode((v) => !v)}>
                <i className={`fa-solid ${editMode ? "fa-eye" : "fa-pen-to-square"}`}></i>
                {editMode ? "Preview only" : "Edit before approving"}
              </button>

              {editMode ? (
                <div className="ra-edit-grid">
                  <label>
                    Title
                    <input
                      value={draft.title}
                      onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    />
                  </label>

                  <label>
                    Room
                    <InlineRoomPicker
                      value={draft.roomName}
                      valueId={draft.roomId}
                      rooms={roomsList}
                      onChange={(roomName, roomId) =>
                        setDraft({ ...draft, roomName, roomId })
                      }
                      placeholder="Select room"
                    />
                  </label>

                  <label>
                    Date
                    <InlineDatePicker
                      value={draft.date}
                      onChange={(v) => setDraft({ ...draft, date: v })}
                      placeholder="Select date"
                    />
                  </label>

                  <div className="ra-row-2">
                    <label>
                      Start
                      <input
                        type="time"
                        value={draft.startTime}
                        onChange={(e) => setDraft({ ...draft, startTime: e.target.value })}
                      />
                    </label>
                    <label>
                      End
                      <input
                        type="time"
                        value={draft.endTime}
                        onChange={(e) => setDraft({ ...draft, endTime: e.target.value })}
                      />
                    </label>
                  </div>

                  <label>
                    Reason
                    <textarea
                      rows={3}
                      value={draft.reason}
                      onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                    />
                  </label>
                </div>
              ) : (
                <div className="ra-modal-summary">
                  <div className="ra-modal-summary-row"><i className="fa-solid fa-bookmark"></i><span>{draft.title || "Untitled"}</span></div>
                  <div className="ra-modal-summary-row"><i className="fa-solid fa-door-open"></i><span>{draft.roomName}</span></div>
                  <div className="ra-modal-summary-row"><i className="fa-regular fa-calendar"></i><span>{fmtDate(draft.date)}</span></div>
                  <div className="ra-modal-summary-row"><i className="fa-regular fa-clock"></i><span>{fmt12(draft.startTime)} – {fmt12(draft.endTime)}</span></div>
                </div>
              )}
            </div>

            {/* ═════════════ FIXED FOOTER ═════════════ */}
            <div className="ra-modal-actions">
              <button className="ra-modal-cancel" onClick={() => setReviewing(null)} disabled={processing}>
                Cancel
              </button>
              <button className="ra-modal-confirm" onClick={handleApprove} disabled={processing}>
                {processing ? "Approving…" : "Approve Request"}
              </button>
            </div>
          </div>
        </div>
      )}

      <Toast show={toast.show} type={toast.type} title={toast.title} message={toast.message}
        onClose={() => setToast((p) => ({ ...p, show: false }))} />
    </>
  );
}

function ReviewCard({ item, onReview }) {
  const statusMeta = {
    pending_admin:   { label: "Needs Review", cls: "is-pending" },
    pending_faculty: { label: "With Faculty", cls: "is-pending-faculty" },
    approved:        { label: "Approved",     cls: "is-approved" },
    denied:          { label: "Denied",       cls: "is-denied" },
    cancelled:       { label: "Cancelled",    cls: "is-cancelled" },
  }[item.status] || {
    label: String(item.status || "Unknown").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    cls: "",
  };

  const conflicts = item.conflicts || [];

  return (
    <div className={`ra-review-card ${statusMeta.cls}`}>
      <div className="ra-review-card-top">
        <div className="ra-review-card-title-block">
          <div className="ra-review-card-title">{item.title}</div>
          <div className="ra-review-card-sub">
            <span><i className="fa-solid fa-door-open"></i> {item.roomName}</span>
            <span><i className="fa-regular fa-calendar"></i> {fmtDate(item.date)}</span>
            <span><i className="fa-regular fa-clock"></i> {fmt12(item.startTime)} – {fmt12(item.endTime)}</span>
          </div>
        </div>
        <span className={`ra-review-status ${statusMeta.cls}`}>{statusMeta.label}</span>
      </div>

      <div className="ra-review-card-meta">
        <span className="ra-review-requester">
          <i className="fa-regular fa-user"></i> {item.requestedByName}
          <span className="ra-role-pill">{item.requestedByRole}</span>
        </span>
        {conflicts.length > 0 && (
          <span className="ra-review-conflict-chip">
            <i className="fa-solid fa-triangle-exclamation"></i> {conflicts.length} conflict{conflicts.length > 1 ? "s" : ""}
          </span>
        )}
      </div>

      {conflicts.length > 0 && (
        <div className="ra-review-conflict-preview">
          <div className="ra-review-conflict-preview-title">
            <i className="fa-solid fa-triangle-exclamation"></i>
            Conflicts with:
          </div>
          {conflicts.slice(0, 3).map((conflict, i) => (
            <div key={conflict.scheduleId || i} className="ra-review-conflict-line">
              <span className="ra-cp-subject">{conflict.subject || "Untitled"}</span>
              <span className="ra-cp-dot">•</span>
              <span className="ra-cp-faculty">{conflict.faculty || "Unknown"}</span>
              {(conflict.startTime || conflict.endTime) && (
                <>
                  <span className="ra-cp-dot">•</span>
                  <span className="ra-cp-time">
                    {fmt12(conflict.startTime)} – {fmt12(conflict.endTime)}
                  </span>
                </>
              )}
            </div>
          ))}
          {conflicts.length > 3 && (
            <div className="ra-review-conflict-more">
              +{conflicts.length - 3} more
            </div>
          )}
        </div>
      )}

      {item.reason && (
        <div className="ra-review-reason"><i className="fa-solid fa-note-sticky"></i><span>{item.reason}</span></div>
      )}

      {item.status === "pending_admin" && (
        <div className="ra-review-actions">
          <button className="ra-review-btn is-approve" onClick={onReview}>
            <i className="fa-solid fa-circle-check"></i> Review & Approve
          </button>
        </div>
      )}
    </div>
  );
}

export default RoomActivity;