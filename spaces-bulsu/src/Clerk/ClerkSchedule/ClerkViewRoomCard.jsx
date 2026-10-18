import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";

import "./clerk-view-room-card.css";
import { normalizeScheduleItem } from "../../utils/normalizeScheduleItem";
import { isActiveOnDate } from "../../utils/scheduleActivePeriod";

import ScheduleCard from "../../Components/ScheduleCard/ScheduleCard";
import ClassDetailsCard from "../../Components/ClassDetailsCard/ClassDetailsCard";

import {
  collection,
  getDocs,
} from "firebase/firestore";

import { db } from "../../firebase";

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

const HOUR_HEIGHT = 60;
const CALENDAR_START_MINUTES = 7 * 60;
const CARD_GAP = 2;

const toDateStr = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

// ─── COLOR HELPERS ──────────────────────────────────────────────
const getFacultyColor = (faculty) => {
  if (!faculty) return "#E0E0E0";
  let hash = 0;
  for (let i = 0; i < faculty.length; i++) {
    hash = faculty.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 80%)`;
};

const getCategoryColor = (source) => {
  switch (source) {
    case "event":
      return "#4DD0E1";
    case "reservation":
      return "#FFB74D";
    case "reassignment":
      return "#81C784";
    case "walkin":
      return "#FFD54F";
    default:
      return "#E0E0E0";
  }
};
// ────────────────────────────────────────────────────────────────

// ✅ Accepts BOTH "approved" and "accepted" reassignment statuses.
const isApprovedReassignment = (status) =>
  ["approved", "accepted"].includes(String(status || "").toLowerCase());

function ClerkViewRoomCard() {
  const [currentWeek, setCurrentWeek] = useState(new Date());
  const navigate = useNavigate();
  const location = useLocation();
  const room = location.state?.room;

  const [schedules, setSchedules] = useState([]);
  const [events, setEvents] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [releasedMap, setReleasedMap] = useState(new Map());
  const [reassignedAwayKeys, setReassignedAwayKeys] = useState(new Set());
  const [reassignedInto, setReassignedInto] = useState([]);
  const [selectedSchedule, setSelectedSchedule] = useState(null);

  useEffect(() => {
    loadSchedules();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSchedules = async () => {
    if (!room?.id) return;

    const snapshot = await getDocs(
      collection(db, "rooms", room.id, "schedules")
    );

    const list = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    setSchedules(list.filter((item) => !item.initialized));

    const eventSnap = await getDocs(collection(db, "events"));
    const eventList = eventSnap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((event) => event.roomId === room.id);
    setEvents(eventList);

    const reservationSnap = await getDocs(
      collection(db, "reservationRequests")
    );
    const reservationList = reservationSnap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter(
        (reservation) =>
          reservation.roomId === room.id &&
          String(reservation.status).toLowerCase() === "approved"
      );
    setReservations(reservationList);

    // ── Releases as Map (keyed by scheduleId_date) ──
    const releaseSnap = await getDocs(collection(db, "roomReleases"));
    const map = new Map();
    releaseSnap.docs
      .map((d) => d.data())
      .filter((r) => r.roomId === room.id)
      .forEach((r) => map.set(`${r.scheduleId}_${r.date}`, r));
    setReleasedMap(map);

    const reassignSnap = await getDocs(collection(db, "roomReassignments"));
const roomReassignments = reassignSnap.docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .filter(
    (r) =>
      // ✅ Accepts "approved" AND "accepted"
      isApprovedReassignment(r.status) &&
      // ✅ Exclude event reassignments — class stays put, only the activity moves
      r.reassignType !== "event" &&
      (r.oldRoomId === room.id || r.newRoomId === room.id)
  );
    setReassignedAwayKeys(
      new Set(
        roomReassignments
          .filter((r) => r.oldRoomId === room.id)
          .map((r) => `${r.scheduleId}_${r.date}`)
      )
    );
    setReassignedInto(
      roomReassignments.filter((r) => r.newRoomId === room.id)
    );
  };

  const getSchedulesByDay = (day) => {
    return schedules.filter(
      (schedule) => schedule.day?.trim().toUpperCase() === day
    );
  };

  const convertToMinutes = (time) => {
    if (!time) return 0;
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
    const raw = ((endMinutes - startMinutes) / 60) * HOUR_HEIGHT;
    return Math.max(raw - CARD_GAP, 18);
  };

  const getStartOfWeek = (date) => {
    const d = new Date(date);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  const startOfWeek = getStartOfWeek(currentWeek);

  const weekDates = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(startOfWeek);
    date.setDate(startOfWeek.getDate() + i);
    return date;
  });

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

  const isToday = (date) => {
    const today = new Date();
    return (
      today.getDate() === date.getDate() &&
      today.getMonth() === date.getMonth() &&
      today.getFullYear() === date.getFullYear()
    );
  };

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

  return (
    <>
      <div className="clerk-view-room">
        <i
          className="fa-solid fa-arrow-left clerk-back-arrow"
          style={{ cursor: "pointer" }}
          onClick={() => {
            if (window.history.length > 1) {
              navigate(-1);
            } else {
              navigate("/clerk/schedule-view-academic-schedule");
            }
          }}
        ></i>

        <div className="clerk-white-box-view-room">
          <div className="clerk-box-header">
            <div className="clerk-week-navigation">
              <i
                className="fa-solid fa-chevron-left"
                style={{ cursor: "pointer" }}
                onClick={() => {
                  const prev = new Date(currentWeek);
                  prev.setDate(prev.getDate() - 7);
                  setCurrentWeek(prev);
                }}
              ></i>
              <span>{formatWeekRange()}</span>
              <i
                className="fa-solid fa-chevron-right"
                style={{ cursor: "pointer" }}
                onClick={() => {
                  const next = new Date(currentWeek);
                  next.setDate(next.getDate() + 7);
                  setCurrentWeek(next);
                }}
              ></i>
            </div>
            <span className="clerk-room-name">{room?.roomName}</span>
          </div>

          <div className="clerk-scroll-x">
            <div className="clerk-days-container">
              <div className="clerk-time-column" aria-hidden="true"></div>
              {weekDates.map((date, index) => (
                <div
                  className={`clerk-day ${isToday(date) ? "today" : ""}`}
                  key={index}
                >
                  <span className="clerk-day-name">{DAYS[index]}</span>
                  <span className="clerk-day-date">{date.getDate()}</span>
                </div>
              ))}
            </div>

            <hr className="clerk-days-divider" />

            <div className="clerk-schedule-container">
              <div className="clerk-time-column">
                <div className="clerk-time-slot">07 AM</div>
                <div className="clerk-time-slot">08 AM</div>
                <div className="clerk-time-slot">09 AM</div>
                <div className="clerk-time-slot">10 AM</div>
                <div className="clerk-time-slot">11 AM</div>
                <div className="clerk-time-slot">12 PM</div>
                <div className="clerk-time-slot">01 PM</div>
                <div className="clerk-time-slot">02 PM</div>
                <div className="clerk-time-slot">03 PM</div>
                <div className="clerk-time-slot">04 PM</div>
                <div className="clerk-time-slot">05 PM</div>
                <div className="clerk-time-slot">06 PM</div>
                <div className="clerk-time-slot">07 PM</div>
                <div className="clerk-time-slot">08 PM</div>
              </div>

              <div className="clerk-calendar-grid">
                {schedules.length === 0 &&
                events.length === 0 &&
                reservations.length === 0 &&
                reassignedInto.length === 0 ? (
                  <div className="clerk-no-schedule">
                    <i className="fa-regular fa-calendar-xmark"></i>
                    <h3>No schedules available</h3>
                    <p>There are no schedules or room activities.</p>
                  </div>
                ) : (
                  DAYS.map((day, index) => {
                    const dateEvents = getItemsForDate(weekDates[index]);
                    const occurrenceDateStr = toDateStr(weekDates[index]);

                    return (
                      <div className="clerk-calendar-day" key={day}>
                        {getSchedulesByDay(day)
                          .map((schedule) => {
                            if (!isActiveOnDate(schedule, occurrenceDateStr)) {
                              return null;
                            }
                            if (
                              reassignedAwayKeys.has(
                                `${schedule.id}_${occurrenceDateStr}`
                              )
                            ) {
                              return null;
                            }

                            const releaseInfo = releasedMap.get(
                              `${schedule.id}_${occurrenceDateStr}`
                            );
                            let effectiveSchedule = schedule;

                            if (releaseInfo) {
                              if (!releaseInfo.effectiveEndTime) return null;

                              const endMin = convertToMinutes(
                                releaseInfo.effectiveEndTime
                              );
                              const startMin = convertToMinutes(
                                schedule.startTime
                              );
                              if (endMin <= startMin) return null;

                              effectiveSchedule = {
                                ...schedule,
                                endTime: releaseInfo.effectiveEndTime,
                                isReleased: true,
                                releasedAtTime: releaseInfo.effectiveEndTime,
                              };
                            }

                            const sStart = convertToMinutes(
                              effectiveSchedule.startTime
                            );
                            const sEnd = convertToMinutes(
                              effectiveSchedule.endTime
                            );

                            const conflict = dateEvents.some((event) => {
                              const eStart = convertToMinutes(
                                event.startTime
                              );
                              const eEnd = convertToMinutes(event.endTime);
                              return sStart < eEnd && sEnd > eStart;
                            });
                            if (conflict) return null;

                            return effectiveSchedule;
                          })
                          .filter(Boolean)
                          .map((schedule) => (
                            <ScheduleCard
                              key={schedule.id}
                              schedule={schedule}
                              top={getTopPosition(schedule.startTime)}
                              height={getCardHeight(
                                schedule.startTime,
                                schedule.endTime
                              )}
                              onClick={() =>
                                setSelectedSchedule(
                                  normalizeScheduleItem(schedule, "schedule")
                                )
                              }
                              facultyColor={getFacultyColor(schedule.faculty)}
                            />
                          ))}

                        {dateEvents.map((event) => {
                          let category = event._source;
                          let facultyName;

                          if (category === "event") {
                            facultyName = "ROOM ACTIVITY";
                          } else if (category === "reservation") {
                            facultyName =
                              event.requesterName ||
                              event.facultyName ||
                              "Walk-in";
                            if (!event.requesterName && !event.facultyName) {
                              category = "walkin";
                            }
                          } else if (category === "reassignment") {
                            facultyName =
                              event.facultyName ||
                              event.courseTitle ||
                              "Moved Class";
                          } else {
                            category = "walkin";
                            facultyName = "Walk-in";
                          }

                          const color = getCategoryColor(category);

                          return (
                            <ScheduleCard
                              key={event.id}
                              schedule={{
                                ...event,
                                subject:
                                  event.title ||
                                  event.purpose ||
                                  event.courseTitle ||
                                  (event._source === "reassignment"
                                    ? `${event.courseTitle || "Class"} (Moved)`
                                    : "Walk-in Reservation"),
                                faculty: facultyName,
                              }}
                              top={getTopPosition(event.startTime)}
                              height={getCardHeight(
                                event.startTime,
                                event.endTime
                              )}
                              onClick={() =>
                                setSelectedSchedule(
                                  normalizeScheduleItem(event, event._source)
                                )
                              }
                              facultyColor={color}
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

          <div className="clerk-class-details-container">
            <ClassDetailsCard
              schedule={selectedSchedule}
              roomName={room?.roomName}
              onClose={() => setSelectedSchedule(null)}
            />
          </div>
        </div>
      </div>
    </>
  );
}

export default ClerkViewRoomCard;