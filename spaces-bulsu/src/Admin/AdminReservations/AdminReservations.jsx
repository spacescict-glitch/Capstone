import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import "./admin-reservations.css";
import ReservationCard from "../../Components/ReservationCard/ReservationCard";
import { collection, query, orderBy, onSnapshot } from "firebase/firestore";
import { db } from "../../firebase";

// ─── Tabs — "All" added as first tab ──────────────────────────────
const TABS = ["All", "Pending", "Approved", "Denied", "Cancelled"];
const PAGE_SIZE = 5;

// ─── Helpers ───────────────────────────────────────────────────────────
const normalizeStatus = (status) => status?.toLowerCase().trim() || "";
const normalizeRoom = (name) =>
  name?.toLowerCase().trim().replace(/\s+/g, "") || "";

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

// ─── Empty icon ──────────────────────────────────────────────────────
const EmptyIcon = () => (
  <svg
    width="56"
    height="56"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="3" y="5" width="18" height="16" rx="2" stroke="#CBD5E1" strokeWidth="1.5" />
    <path d="M3 9H21" stroke="#CBD5E1" strokeWidth="1.5" />
    <path d="M8 3V6" stroke="#CBD5E1" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M16 3V6" stroke="#CBD5E1" strokeWidth="1.5" strokeLinecap="round" />
    <path
      d="M8 13.5L10.5 16L15.5 11"
      stroke="#CBD5E1"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

function LoadingState() {
  return (
    <div className="dph-empty-state">
      <i
        className="fa-solid fa-spinner fa-spin"
        style={{ fontSize: "32px", color: "#f57c00" }}
      ></i>
      <h2>Loading Reservations</h2>
      <p>Please wait while we retrieve the reservation requests.</p>
    </div>
  );
}

function EmptyState({ label }) {
  return (
    <div className="dph-empty-state">
      <EmptyIcon />
      <p className="dph-empty-title">No {label} reservations</p>
      <p className="dph-empty-subtitle">
        Requests will show up here as soon as they come in.
      </p>
    </div>
  );
}

// ─── Helper: kung saan dadalhin pag-click ng card ──────────────────
const getBasePathForStatus = (status) => {
  const s = normalizeStatus(status);
  if (s === "approved") return "/admin/view-reservation-approved";
  if (s === "rejected") return "/admin/view-reservation-denied";
  if (s === "cancelled") return "/admin/view-reservation-cancelled";
  return "/admin/view-reservation";
};

function AdminReservations() {
  const [activeTab, setActiveTab] = useState("All");
  const navigate = useNavigate();
  const [reservations, setReservations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const [searchTerm, setSearchTerm] = useState("");
  const [filterRoom, setFilterRoom] = useState("");
  const [filterDate, setFilterDate] = useState("");
  const [sortOrder, setSortOrder] = useState("desc");

  // ── Room picker ──
  const [showRoomPicker, setShowRoomPicker] = useState(false);
  const [roomSearch, setRoomSearch] = useState("");

  // ── Date picker ──
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [calendarCursor, setCalendarCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  useEffect(() => {
    const q = query(
      collection(db, "reservationRequests"),
      orderBy("createdAt", "desc")
    );
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const list = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        setReservations(list);
        setLoading(false);
      },
      (error) => {
        console.error("Firestore error:", error);
        setLoading(false);
      }
    );
    return unsubscribe;
  }, []);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [activeTab]);

  // ─── Status mapping — "All" has null (no filter) ─────────────────
  const statusMap = {
    All: null,
    Pending: "pending",
    Approved: "approved",
    Denied: "rejected",
    Cancelled: "cancelled",
  };

  // ─── Filter by tab ────────────────────────────────────────────────
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

  // ─── Sort by date only (asc/desc) ─────────────────────────────────
  const sorted = [...filtered].sort((a, b) => {
    const aVal = a.date || "";
    const bVal = b.date || "";
    if (aVal < bVal) return sortOrder === "asc" ? -1 : 1;
    if (aVal > bVal) return sortOrder === "asc" ? 1 : -1;
    return 0;
  });

  const visibleReservations = sorted.slice(0, visibleCount);
  const hasMore = visibleCount < sorted.length;

  // ─── Counts — kasama "All" ────────────────────────────────────────
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
      if (!map.has(normalized)) map.set(normalized, original);
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
            numeric: true,
            sensitivity: "base",
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

  // ─── renderList — ReservationCard for ALL tabs ────────────────────
  const renderList = () => {
    if (loading) return <LoadingState />;
    if (sorted.length === 0)
      return <EmptyState label={activeTab.toLowerCase()} />;

    return visibleReservations.map((reservation) => {
      return (
        <ReservationCard
          key={reservation.id}
          reservation={reservation}
          basePath={getBasePathForStatus(reservation.status)}
          readOnly={true}
        />
      );
    });
  };

  const isEmpty = !loading && sorted.length === 0;

  return (
    <div className="dph-reservations">
      <div className="dph-reservations-header">
        <h1>Reservation Requests</h1>
        <p className="dph-reservations-subtitle">
          Review, approve, and track room reservation requests from your department.
        </p>
      </div>

      <div className="dph-filter-bar-outer">
        <div className="dph-filter-row">
          {/* 🔍 SEARCH — pinakamahaba */}
          <div className="dph-filter-group dph-search-group">
            <i className="fa-solid fa-magnifying-glass"></i>
            <input
              type="text"
              placeholder="Search by faculty..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="dph-filter-input"
            />
          </div>

          {/* ROOM PICKER */}
          <div className="dph-filter-group dph-picker-group">
            <div className="adr-roompicker">
              <button
                type="button"
                className={`adr-room-trigger ${showRoomPicker ? "open" : ""}`}
                onClick={() => {
                  setRoomSearch("");
                  setShowRoomPicker((v) => !v);
                }}
              >
                <i className="fa-solid fa-building"></i>
                <span className="adr-room-trigger-text">{selectedRoomLabel}</span>
                <i
                  className={`fa-solid fa-chevron-down adr-room-caret ${
                    showRoomPicker ? "open" : ""
                  }`}
                ></i>
              </button>

              {showRoomPicker && (
                <>
                  <div
                    className="adr-picker-clickaway"
                    onClick={() => setShowRoomPicker(false)}
                  ></div>
                  <div className="adr-room-popover">
                    <span className="adr-popover-arrow"></span>

                    <div className="adr-search-wrap">
                      <i className="fa-solid fa-magnifying-glass"></i>
                      <input
                        type="text"
                        className="adr-search"
                        placeholder="Search room..."
                        value={roomSearch}
                        onChange={(e) => setRoomSearch(e.target.value)}
                        autoFocus
                      />
                      {roomSearch && (
                        <button
                          type="button"
                          className="adr-search-clear"
                          onClick={() => setRoomSearch("")}
                        >
                          <i className="fa-solid fa-xmark"></i>
                        </button>
                      )}
                    </div>

                    <div className="adr-room-list">
                      <button
                        type="button"
                        className={`adr-room-option ${!filterRoom ? "is-active" : ""}`}
                        onClick={() => {
                          setFilterRoom("");
                          setShowRoomPicker(false);
                          setRoomSearch("");
                        }}
                      >
                        <div className="adr-room-option-icon">
                          <i className="fa-solid fa-layer-group"></i>
                        </div>
                        <span className="adr-room-option-name">All Rooms</span>
                        {!filterRoom && (
                          <i className="fa-solid fa-circle-check adr-room-option-check"></i>
                        )}
                      </button>

                      {filteredRoomOptions.length === 0 && roomSearch ? (
                        <div className="adr-picker-empty">
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
                              className={`adr-room-option ${isActive ? "is-active" : ""}`}
                              onClick={() => {
                                setFilterRoom(normalized);
                                setShowRoomPicker(false);
                                setRoomSearch("");
                              }}
                            >
                              <div className="adr-room-option-icon">
                                <i className="fa-solid fa-door-open"></i>
                              </div>
                              <span className="adr-room-option-name">{original}</span>
                              {isActive && (
                                <i className="fa-solid fa-circle-check adr-room-option-check"></i>
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
          </div>

          {/* DATE PICKER */}
          <div className="dph-filter-group dph-picker-group">
            <div className="adr-datepicker">
              <button
                type="button"
                className={`adr-date-trigger ${showDatePicker ? "open" : ""}`}
                onClick={() => {
                  const base = filterDate
                    ? new Date(`${filterDate}T00:00:00`)
                    : new Date();
                  setCalendarCursor({
                    year: base.getFullYear(),
                    month: base.getMonth(),
                  });
                  setShowDatePicker((v) => !v);
                }}
              >
                <i className="fa-regular fa-calendar"></i>
                <span>{filterDate ? formatDateLong(filterDate) : "All Dates"}</span>
                <i
                  className={`fa-solid fa-chevron-down adr-date-caret ${
                    showDatePicker ? "open" : ""
                  }`}
                ></i>
              </button>

              {showDatePicker && (
                <>
                  <div
                    className="adr-picker-clickaway"
                    onClick={() => setShowDatePicker(false)}
                  ></div>
                  <div className="adr-date-popover">
                    <span className="adr-popover-arrow"></span>

                    <div className="adr-date-quick-row">
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
                        className={
                          filterDate === toDateInputValue(new Date()) ? "active" : ""
                        }
                        onClick={() => {
                          setFilterDate(toDateInputValue(new Date()));
                          setShowDatePicker(false);
                        }}
                      >
                        Today
                      </button>
                    </div>

                    <div className="adr-cal-header">
                      <button
                        type="button"
                        className="adr-cal-nav"
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
                      <span className="adr-cal-title">
                        {MONTH_NAMES[calendarCursor.month]} {calendarCursor.year}
                      </span>
                      <button
                        type="button"
                        className="adr-cal-nav"
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

                    <div className="adr-cal-weekdays">
                      {WEEKDAY_LABELS.map((w) => (
                        <span key={w}>{w}</span>
                      ))}
                    </div>

                    <div className="adr-cal-grid">
                      {buildCalendarGrid(
                        calendarCursor.year,
                        calendarCursor.month
                      ).map((cell, i) => {
                        const cellStr = toDateInputValue(cell.date);
                        const isSelected = cellStr === filterDate;
                        return (
                          <button
                            type="button"
                            key={i}
                            className={[
                              "adr-cal-day",
                              !cell.inMonth && "is-outside",
                              isSelected && "is-selected",
                            ]
                              .filter(Boolean)
                              .join(" ")}
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

          {/* SORT BY DATE — single toggle (asc/desc) */}
          <button
            type="button"
            className={`dph-date-sort-btn ${sortOrder}`}
            onClick={() =>
              setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"))
            }
            title={
              sortOrder === "asc"
                ? "Currently showing oldest first — click for newest first"
                : "Currently showing newest first — click for oldest first"
            }
          >
            <i
              className={`fa-solid fa-arrow-${
                sortOrder === "asc" ? "up-long" : "down-long"
              }`}
            ></i>
            <span>
              {sortOrder === "asc" ? "Oldest First" : "Newest First"}
            </span>
          </button>

          <button className="dph-clear-filters-btn" onClick={clearFilters}>
            <i className="fa-solid fa-rotate-left"></i> Clear
          </button>
        </div>

        {(searchTerm || filterRoom || filterDate) && (
          <div className="dph-filter-summary">
            <span>Active filters:</span>
            {searchTerm && (
              <span className="dph-filter-tag">Faculty: {searchTerm}</span>
            )}
            {filterRoom && (
              <span className="dph-filter-tag">Room: {selectedRoomLabel}</span>
            )}
            {filterDate && (
              <span className="dph-filter-tag">Date: {filterDate}</span>
            )}
            <span className="dph-filter-result-count">
              {sorted.length} result{sorted.length !== 1 ? "s" : ""}
            </span>
          </div>
        )}
      </div>

      <div className="dph-white-box-reservations">
        <div className="dph-reservations-nav">
          {TABS.map((tab) => (
            <div
              key={tab}
              className={`dph-reservations-nav-item ${
                activeTab === tab ? "active" : ""
              }`}
              onClick={() => setActiveTab(tab)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setActiveTab(tab);
              }}
            >
              {tab}
              {!loading && (
                <span className="dph-reservations-nav-count">
                  {counts[tab]}
                </span>
              )}
            </div>
          ))}
        </div>
        <hr className="dph-reservations-nav-divider" />

        <div
          className={`dph-reservations-content ${
            loading || isEmpty ? "dph-reservations-content--empty" : ""
          }`}
        >
          {renderList()}
        </div>

        {!loading && hasMore && (
          <div className="dph-load-more-reservations">
            <button
              className="dph-load-more-btn-reservations"
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
            >
              Load More ({sorted.length - visibleCount} remaining)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default AdminReservations;