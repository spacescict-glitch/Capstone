import { useState, useEffect, useMemo } from "react";
import { useParams, useSearchParams, useNavigate } from "react-router-dom";

import "./public-room-schedule.css";

import ScheduleCard from "../../Components/ScheduleCard/ScheduleCard";
import ClassDetailsCard from "../../Components/ClassDetailsCard/ClassDetailsCard";
import { isActiveOnDate } from "../../utils/scheduleActivePeriod";
import { getCurrentTerm, getTermLabel, isValidTerm } from "../../utils/academicTerm";

import {
  doc,
  getDoc,
  collection,
  getDocs,
} from "firebase/firestore";

import { db } from "../../firebase";

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

// Must match the CSS .time-slot height (60px) and .calendar-grid height (840px = 14 × 60)
const HOUR_HEIGHT = 60;

// Calendar grid starts at 7:00 AM (first label = "07 AM")
const CALENDAR_START_MINUTES = 7 * 60;

// ─── date helpers ───────────────────────────────────────────────────
const toDateStr = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const stripTime = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const getStartOfWeek = (date) => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

// ─── Expired screen ────────────────────────────────────────────────
function ExpiredScreen({ urlTerm, currentTerm }) {
  const navigate = useNavigate();
  const urlTermLabel = urlTerm ? getTermLabel(urlTerm) : null;
  const currentTermLabel = getTermLabel(currentTerm);

  return (
    <div className="public-room-expired">
      <div className="public-room-expired-card">
        <div className="public-room-expired-icon">
          <i className="fa-solid fa-qrcode"></i>
        </div>

        <h1>QR Code Expired</h1>
        <p className="public-room-expired-sub">
          This QR code is no longer valid. It was issued for a previous academic
          term and cannot be used anymore.
        </p>

        <div className="public-room-expired-info">
          <div className="public-room-expired-row">
            <span>QR was issued for</span>
            <strong>{urlTermLabel || "Unknown term"}</strong>
          </div>
          <div className="public-room-expired-row">
            <span>Current active term</span>
            <strong>{currentTermLabel}</strong>
          </div>
        </div>

        <div className="public-room-expired-hint">
          <i className="fa-solid fa-lightbulb"></i>
          <span>
            Please contact the <strong>CICT Local Registrar</strong> to request
            an updated QR code for this room.
          </span>
        </div>

        <button
          type="button"
          className="public-room-expired-back"
          onClick={() => navigate("/login")}
        >
          <i className="fa-solid fa-right-to-bracket"></i> Go to Login
        </button>
      </div>
    </div>
  );
}

function PublicRoomSchedule() {
  const { roomId } = useParams();
  const [searchParams] = useSearchParams();
  const urlTerm = searchParams.get("term");
  const currentTerm = useMemo(() => getCurrentTerm(), []);

  // ─── Term gate: block if missing / mismatched ───────────────────
  const termValid = isValidTerm(urlTerm);

  const [room, setRoom] = useState(null);
  const [currentWeek, setCurrentWeek] = useState(new Date());

  const [schedules, setSchedules] = useState([]);
  const [events, setEvents] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [releases, setReleases] = useState([]);
  const [reassignments, setReassignments] = useState([]);

  const [selectedSchedule, setSelectedSchedule] = useState(null);
  const [status, setStatus] = useState("Available");

  // ─── time helpers ─────────────────────────────────────────────
  const convertToMinutes = (time) => {
    if (!time) return 0;

    if (time.includes("AM") || time.includes("PM")) {
      const [clock, period] = time.trim().split(" ");
      let [hour, minute] = clock.split(":").map(Number);
      if (period === "PM" && hour !== 12) hour += 12;
      if (period === "AM" && hour === 12) hour = 0;
      return hour * 60 + minute;
    }

    const [hour, minute] = time.split(":").map(Number);
    return hour * 60 + minute;
  };

  const getTopPosition = (startTime) => {
    const startMinutes = convertToMinutes(startTime);
    return ((startMinutes - CALENDAR_START_MINUTES) / 60) * HOUR_HEIGHT;
  };

  const getCardHeight = (startTime, endTime) => {
    const startMinutes = convertToMinutes(startTime);
    const endMinutes = convertToMinutes(endTime);
    return ((endMinutes - startMinutes) / 60) * HOUR_HEIGHT;
  };

  // ─── week helpers ─────────────────────────────────────────────
  const startOfWeek = getStartOfWeek(currentWeek);
  const weekDates = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(startOfWeek);
    date.setDate(startOfWeek.getDate() + i);
    return date;
  });

  const todayStart = useMemo(() => stripTime(new Date()), []);
  const currentWeekStart = useMemo(() => getStartOfWeek(todayStart), [todayStart]);
  const viewingWeekStart = useMemo(() => getStartOfWeek(currentWeek), [currentWeek]);

  const canGoPrev = viewingWeekStart.getTime() > currentWeekStart.getTime();
  const isAtCurrentWeek =
    viewingWeekStart.getTime() === currentWeekStart.getTime();

  const isToday = (date) => {
    const t = new Date();
    return (
      t.getDate() === date.getDate() &&
      t.getMonth() === date.getMonth() &&
      t.getFullYear() === date.getFullYear()
    );
  };

  const isPastDay = (date) => stripTime(date).getTime() < todayStart.getTime();

  const formatWeekRange = () => {
    const start = weekDates[0];
    const end = weekDates[6];
    const startMonth = start.toLocaleString("default", { month: "long" });
    const endMonth = end.toLocaleString("default", { month: "long" });

    if (start.getMonth() === end.getMonth()) {
      return `${startMonth} ${start.getDate()} - ${end.getDate()}, ${end.getFullYear()}`;
    }
    return `${startMonth} ${start.getDate()} - ${endMonth} ${end.getDate()}, ${end.getFullYear()}`;
  };

  // ─── effects ──────────────────────────────────────────────────
  useEffect(() => {
    if (!termValid) return; // term invalid → don't load anything
    loadRoom();
    const interval = setInterval(() => loadRoom(), 60000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, termValid]);

  const getCurrentDay = () => {
    const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    return days[new Date().getDay()];
  };

  // ─── data loading ─────────────────────────────────────────────
  const loadRoom = async () => {
    if (!roomId) return;

    // ── ROOM ──
    const roomSnap = await getDoc(doc(db, "rooms", roomId));
    if (!roomSnap.exists()) return;
    const roomData = { id: roomSnap.id, ...roomSnap.data() };
    setRoom(roomData);

    // ── REGULAR SCHEDULES ──
    const scheduleSnap = await getDocs(
      collection(db, "rooms", roomId, "schedules")
    );
    const scheduleList = scheduleSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((s) => !s.initialized);
    setSchedules(scheduleList);

    // ── EVENTS (only today & future) ──
    const eventSnap = await getDocs(collection(db, "events"));
    const todayStr = toDateStr(todayStart);
    const eventList = eventSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((e) => e.roomId === roomId && (!e.date || e.date >= todayStr));
    setEvents(eventList);

    // ── RESERVATIONS (approved only, today & future) ──
    const reservationSnap = await getDocs(
      collection(db, "reservationRequests")
    );
    const reservationList = reservationSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter(
        (r) =>
          r.roomId === roomId &&
          String(r.status).toLowerCase() === "approved" &&
          (!r.date || r.date >= todayStr)
      );
    setReservations(reservationList);

    // ── RELEASES (early endings) ──
    const releaseSnap = await getDocs(collection(db, "roomReleases"));
    const releaseList = releaseSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((r) => r.roomId === roomId);
    setReleases(releaseList);

    // ── REASSIGNMENTS (approved only) ──
    const reassignSnap = await getDocs(
      collection(db, "roomReassignments")
    );
    const reassignList = reassignSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter(
        (r) =>
          String(r.status || "").toLowerCase() === "approved" &&
          (r.oldRoomId === roomId || r.newRoomId === roomId)
      );
    setReassignments(reassignList);

    // ── STATUS (Available / Occupied) — only relevant for today ──
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const todayDay = getCurrentDay();
    const todayDate = toDateStr(now);

    const releasedKeys = new Set(
      releaseList.map((r) => `${r.scheduleId}_${r.date}`)
    );
    const reassignedAwayKeys = new Set(
      reassignList
        .filter((r) => r.oldRoomId === roomId)
        .map((r) => `${r.scheduleId}_${r.date}`)
    );
    const reassignedIntoToday = reassignList.filter(
      (r) => r.newRoomId === roomId && r.date === todayDate
    );

    let occupied = false;

    // regular schedules active today
    scheduleList.forEach((schedule) => {
      if (schedule.day?.toUpperCase() !== todayDay) return;
      if (!isActiveOnDate(schedule, todayDate)) return;

      const key = `${schedule.id}_${todayDate}`;
      if (releasedKeys.has(key)) return;
      if (reassignedAwayKeys.has(key)) return;

      const start = convertToMinutes(schedule.startTime);
      const end = convertToMinutes(schedule.endTime);

      if (currentMinutes >= start && currentMinutes < end) {
        occupied = true;
      }
    });

    // events today
    if (!occupied) {
      eventList.forEach((event) => {
        if (event.date !== todayDate) return;
        const start = convertToMinutes(event.startTime);
        const end = convertToMinutes(event.endTime);
        if (currentMinutes >= start && currentMinutes < end) {
          occupied = true;
        }
      });
    }

    // reservations today
    if (!occupied) {
      reservationList.forEach((reservation) => {
        if (reservation.date !== todayDate) return;
        const start = convertToMinutes(reservation.startTime);
        const end = convertToMinutes(reservation.endTime);
        if (currentMinutes >= start && currentMinutes < end) {
          occupied = true;
        }
      });
    }

    // reassigned into this room today
    if (!occupied) {
      reassignedIntoToday.forEach((item) => {
        const start = convertToMinutes(item.startTime);
        const end = convertToMinutes(item.endTime);
        if (currentMinutes >= start && currentMinutes < end) {
          occupied = true;
        }
      });
    }

    setStatus(occupied ? "Occupied" : "Available");
  };

  // ─── derived helpers ──────────────────────────────────────────
  const releasedMap = (() => {
    const map = new Map();
    releases.forEach((r) => map.set(`${r.scheduleId}_${r.date}`, r));
    return map;
  })();

  const reassignedAwayKeys = new Set(
    reassignments
      .filter((r) => r.oldRoomId === roomId)
      .map((r) => `${r.scheduleId}_${r.date}`)
  );

  const reassignedInto = reassignments.filter(
    (r) => r.newRoomId === roomId
  );

  // ── For a given (day, date), return the filtered + effective schedules
  const getSchedulesForDate = (day, dateStr) => {
    return schedules
      .filter((s) => s.day?.trim().toUpperCase() === day)
      .map((schedule) => {
        if (!isActiveOnDate(schedule, dateStr)) return null;

        const key = `${schedule.id}_${dateStr}`;
        if (reassignedAwayKeys.has(key)) return null;

        const releaseInfo = releasedMap.get(key);
        if (releaseInfo) {
          if (!releaseInfo.effectiveEndTime) return null;

          const endMin = convertToMinutes(releaseInfo.effectiveEndTime);
          const startMin = convertToMinutes(schedule.startTime);
          if (endMin <= startMin) return null;

          return {
            ...schedule,
            endTime: releaseInfo.effectiveEndTime,
            isReleased: true,
          };
        }

        return schedule;
      })
      .filter(Boolean);
  };

  // ── Events + reservations + reassigned-in items on a specific date
  const getItemsForDate = (date) => {
    const dateString = toDateStr(date);
    return [
      ...events
        .filter((e) => e.date === dateString)
        .map((e) => ({ ...e, _source: "event" })),
      ...reservations
        .filter((r) => r.date === dateString)
        .map((r) => ({ ...r, _source: "reservation" })),
      ...reassignedInto
        .filter((r) => r.date === dateString)
        .map((r) => ({ ...r, _source: "reassignment" })),
    ];
  };

  // ─── TERM GATE ────────────────────────────────────────────────
  if (!termValid) {
    return <ExpiredScreen urlTerm={urlTerm} currentTerm={currentTerm} />;
  }

  // ─── render ───────────────────────────────────────────────────
  return (
    <div className="public-room-page">
      <div className="public-room-header">
        <div className="public-room-title-wrap">
          <h1>{room?.roomName || "Room"}</h1>
          <span className="public-room-term-chip">
            <i className="fa-solid fa-calendar-check"></i>
            {getTermLabel(currentTerm)}
          </span>
        </div>

        <span
          className={
            status === "Occupied"
              ? "room-status occupied"
              : "room-status available"
          }
        >
          {status}
        </span>
      </div>

      <div className="white-box-view-room">
        <div className="box-header">
          <div className="week-navigation">
            <button
              type="button"
              className={`public-room-nav-btn ${!canGoPrev ? "is-disabled" : ""}`}
              onClick={() => {
                if (!canGoPrev) return;
                const prev = new Date(currentWeek);
                prev.setDate(prev.getDate() - 7);
                setCurrentWeek(prev);
              }}
              disabled={!canGoPrev}
              aria-label="Previous week"
            >
              <i className="fa-solid fa-chevron-left"></i>
            </button>

            <span className="public-room-week-label">{formatWeekRange()}</span>

            <button
              type="button"
              className="public-room-nav-btn"
              onClick={() => {
                const next = new Date(currentWeek);
                next.setDate(next.getDate() + 7);
                setCurrentWeek(next);
              }}
              aria-label="Next week"
            >
              <i className="fa-solid fa-chevron-right"></i>
            </button>

            {!isAtCurrentWeek && (
              <button
                type="button"
                className="public-room-today-btn"
                onClick={() => setCurrentWeek(new Date())}
                aria-label="Jump to current week"
              >
                <i className="fa-solid fa-calendar-day"></i> Today
              </button>
            )}
          </div>
        </div>

        <div className="calendar-scroll-x">
          <div className="calendar-inner">
            <div className="days-container">
              <div className="time-column" aria-hidden="true"></div>

              {weekDates.map((date, index) => {
                const past = isPastDay(date);
                return (
                  <div
                    key={index}
                    className={`day ${isToday(date) ? "today" : ""} ${
                      past ? "past-day" : ""
                    }`}
                  >
                    <span className="day-name">{DAYS[index]}</span>
                    <span className="day-date">{date.getDate()}</span>
                  </div>
                );
              })}
            </div>

            <hr className="days-divider" />

            <div className="schedule-container">
              <div className="time-column">
                <div className="time-slot">07 AM</div>
                <div className="time-slot">08 AM</div>
                <div className="time-slot">09 AM</div>
                <div className="time-slot">10 AM</div>
                <div className="time-slot">11 AM</div>
                <div className="time-slot">12 PM</div>
                <div className="time-slot">01 PM</div>
                <div className="time-slot">02 PM</div>
                <div className="time-slot">03 PM</div>
                <div className="time-slot">04 PM</div>
                <div className="time-slot">05 PM</div>
                <div className="time-slot">06 PM</div>
                <div className="time-slot">07 PM</div>
                <div className="time-slot">08 PM</div>
              </div>

              <div className="calendar-grid">
                {schedules.length === 0 &&
                events.length === 0 &&
                reservations.length === 0 &&
                reassignedInto.length === 0 ? (
                  <div className="no-schedule">
                    <i className="fa-regular fa-calendar-xmark"></i>
                    <h3>No schedules available</h3>
                    <p>There are no upcoming schedules for this room.</p>
                  </div>
                ) : (
                  DAYS.map((day, index) => {
                    const dateObj = weekDates[index];
                    const dateStr = toDateStr(dateObj);
                    const past = isPastDay(dateObj);

                    // Hide cards on past days (today and future only)
                    const dayItems = past ? [] : getItemsForDate(dateObj);
                    const daySchedules = past
                      ? []
                      : getSchedulesForDate(day, dateStr);

                    return (
                      <div
                        className={`calendar-day ${past ? "past-day" : ""}`}
                        key={day}
                      >
                        {/* Regular schedules (active + not reassigned away) */}
                        {daySchedules
                          .filter((schedule) => {
                            const sStart = convertToMinutes(schedule.startTime);
                            const sEnd = convertToMinutes(schedule.endTime);

                            return !dayItems.some((item) => {
                              const eStart = convertToMinutes(item.startTime);
                              const eEnd = convertToMinutes(item.endTime);
                              return sStart < eEnd && sEnd > eStart;
                            });
                          })
                          .map((schedule) => (
                            <ScheduleCard
                              key={schedule.id}
                              schedule={schedule}
                              top={getTopPosition(schedule.startTime)}
                              height={getCardHeight(
                                schedule.startTime,
                                schedule.endTime
                              )}
                              onClick={() => setSelectedSchedule(schedule)}
                            />
                          ))}

                        {/* Events / Reservations / Reassignments-in */}
                        {dayItems.map((item) => {
                          const isReassignment = item._source === "reassignment";
                          const isEvent = item._source === "event";

                          const displaySchedule = {
                            ...item,
                            subject: isReassignment
                              ? item.courseTitle ||
                                item.subject ||
                                "Moved Class"
                              : item.title || item.purpose || "Reservation",
                            faculty: isEvent
                              ? "ROOM ACTIVITY"
                              : isReassignment
                              ? item.facultyName ||
                                item.faculty ||
                                "Moved Class"
                              : item.requesterName ||
                                item.facultyName ||
                                "Reservation",
                          };

                          return (
                            <ScheduleCard
                              key={item.id}
                              schedule={displaySchedule}
                              top={getTopPosition(item.startTime)}
                              height={getCardHeight(
                                item.startTime,
                                item.endTime
                              )}
                              onClick={() => setSelectedSchedule(item)}
                            />
                          );
                        })}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="class-details-container">
          <ClassDetailsCard
            schedule={selectedSchedule}
            roomName={room?.roomName}
            onClose={() => setSelectedSchedule(null)}
          />
        </div>
      </div>
    </div>
  );
}

export default PublicRoomSchedule;