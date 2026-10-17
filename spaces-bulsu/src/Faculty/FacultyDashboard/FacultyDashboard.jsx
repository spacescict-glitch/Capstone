import React, { useEffect, useMemo, useState, useRef } from 'react';
import './faculty-dashboard.css';
import { useNavigate } from "react-router-dom";
import { auth, db } from "../../firebase";
import {
  collection,
  getDocs,
  doc,
  getDoc,
  updateDoc,
  arrayUnion,
  arrayRemove,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
} from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";

const DAY_LABELS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const DAY_TO_INDEX = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

const normalizeName = (name = "") =>
  name
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim();

const isApprovedReassignment = (status) =>
  ["approved", "accepted"].includes(String(status || "").toLowerCase());

const semesterRank = (sem = "") => {
  const s = sem.toLowerCase();
  if (s.includes("2nd")) return 2;
  if (s.includes("1st")) return 1;
  return 0;
};

const schoolYearStart = (sy = "") => {
  const match = sy.match(/\d{4}/);
  return match ? parseInt(match[0], 10) : 0;
};

const parseTimeParts = (time) => {
  const [h, m] = (time || "0:0").split(":").map(Number);
  return [Number.isNaN(h) ? 0 : h, Number.isNaN(m) ? 0 : m];
};

const toMinutes = (time) => {
  const [h, m] = parseTimeParts(time);
  return h * 60 + m;
};

const formatTime = (time) => {
  const [h, m] = parseTimeParts(time);
  const suffix = h >= 12 ? "PM" : "AM";
  const hh = h % 12 || 12;
  return `${String(hh).padStart(2, "0")}:${String(m).padStart(2, "0")} ${suffix}`;
};

const getNextOccurrenceDate = (dayAbbrev, startTime, now) => {
  const targetDow = DAY_TO_INDEX[dayAbbrev];
  if (targetDow === undefined) return null;

  const [h, m] = parseTimeParts(startTime);
  for (let i = 0; i < 14; i++) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + i);
    candidate.setHours(h, m, 0, 0);
    if (candidate.getDay() === targetDow && candidate >= now) {
      return candidate;
    }
  }
  return null;
};

const greetingForHour = (h) => {
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
};

const greetingIconForHour = (h) => {
  if (h < 12) return "fa-solid fa-sun";
  if (h < 18) return "fa-solid fa-cloud-sun";
  return "fa-solid fa-moon";
};

const formatCountdown = (target, now) => {
  const diffMs = target - now;
  if (diffMs <= 0) return "Starting now";

  const totalMin = Math.round(diffMs / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;

  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
};

const toDateStr = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const timesOverlap = (s1, e1, s2, e2) => {
  const a1 = toMinutes(s1);
  const b1 = toMinutes(e1);
  const a2 = toMinutes(s2);
  const b2 = toMinutes(e2);
  return a1 < b2 && b1 > a2;
};

const getInitials = (name = "") => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

const timeAgo = (timestamp, now) => {
  if (!timestamp?.toDate) return "";
  const date = timestamp.toDate();
  const diffMin = Math.max(0, Math.round((now - date) / 60000));
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

// ✅ Text-only preview — never renders images/attachments
const announcementPreview = (a) => {
  if (a.content && a.content.trim()) return a.content.trim();
  const imgCount = (a.imageUrls || (a.imageUrl ? [a.imageUrl] : [])).length;
  const fileCount = (a.files || (a.fileUrl ? [1] : [])).length;
  if (imgCount && fileCount) {
    return `📷 Sent ${imgCount} image${imgCount > 1 ? "s" : ""} and ${fileCount} attachment${fileCount > 1 ? "s" : ""}`;
  }
  if (imgCount) return `📷 Sent ${imgCount} image${imgCount > 1 ? "s" : ""}`;
  if (fileCount) return `📎 Sent ${fileCount} attachment${fileCount > 1 ? "s" : ""}`;
  return "New announcement";
};

const getKindMeta = (item) => {
  if (item.isOnline) {
    return { key: "online", label: "Online", icon: "fa-solid fa-wifi" };
  }
  if (item.kind === "reservation") {
    return { key: "reservation", label: "Reservation", icon: "fa-solid fa-bookmark" };
  }
  if (item.kind === "reassignment") {
    return { key: "reassignment", label: "Moved", icon: "fa-solid fa-right-left" };
  }
  if (item.kind === "event") {
    return { key: "event", label: "Room Activity", icon: "fa-solid fa-calendar-plus" };
  }
  return { key: "schedule", label: "Class", icon: "fa-solid fa-chalkboard-user" };
};

// ═════════════════════════════════════════════════════════════════
// ✅ NEW: Stable release-key builder (same as FacultySchedule.jsx)
// ═════════════════════════════════════════════════════════════════
const makeReleaseKey = (kind, id, date) => {
  if (kind === "reassignment") return `reassign_${id}_${date}`;
  if (kind === "reservation") return `resv_${id}_${date}`;
  return `${id}_${date}`; // schedule
};

export default function FacultyDashboard({ onLogout }) {
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [activeTerm, setActiveTerm] = useState(null);
  const [latestSchedules, setLatestSchedules] = useState([]);
  const [facultyName, setFacultyName] = useState("");
  const [myUid, setMyUid] = useState(null);
  const [myRoomIds, setMyRoomIds] = useState([]);

  const [onlineSchedules, setOnlineSchedules] = useState([]);
  // ✅ CHANGED: Set<string> → Map<string, releaseDoc>
  const [releasedMap, setReleasedMap] = useState(new Map());
  const [reassignedAwayKeys, setReassignedAwayKeys] = useState(new Set());
  const [reassignedInto, setReassignedInto] = useState([]);
  const [approvedReservations, setApprovedReservations] = useState([]);
  const [myRoomEvents, setMyRoomEvents] = useState([]);

  const [adminAnnouncements, setAdminAnnouncements] = useState([]);
  const [announcementLoading, setAnnouncementLoading] = useState(true);
  const [likeBusyId, setLikeBusyId] = useState(null);

  const [bannerIndex, setBannerIndex] = useState(0);
  const [, forceTick] = useState(0);

  const unsubsRef = useRef([]);
  const baseLoadedRef = useRef(false);

  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let isCancelled = false;

    const cleanup = () => {
      unsubsRef.current.forEach((u) => {
        try { u(); } catch (e) { /* ignore */ }
      });
      unsubsRef.current = [];
    };

    const setup = async (user) => {
      if (isCancelled || !user) return;

      cleanup();
      setLoading(true);
      setMyUid(user.uid);

      try {
        const userSnap = await getDoc(doc(db, "users", user.uid));
        if (!userSnap.exists()) {
          setLoading(false);
          return;
        }

        const me = userSnap.data();
        setFacultyName(me.firstName || "");

        const myName = normalizeName(
          `${me.lastName}, ${me.firstName}${me.middleInitial ? ` ${me.middleInitial}` : ""}`
        );

        const roomsSnap = await getDocs(collection(db, "rooms"));
        const matchedSchedules = [];

        for (const roomDoc of roomsSnap.docs) {
          const room = { id: roomDoc.id, ...roomDoc.data() };
          const scheduleSnap = await getDocs(
            collection(db, "rooms", roomDoc.id, "schedules")
          );

          scheduleSnap.docs.forEach((d) => {
            const s = d.data();
            if (s.initialized) return;
            if (!s.faculty) return;
            if (normalizeName(s.faculty) === myName) {
              matchedSchedules.push({
                id: d.id,
                ...s,
                roomId: room.id,
                roomName: room.roomName,
              });
            }
          });
        }

        if (isCancelled) return;

        let roomIds = [];

        if (matchedSchedules.length > 0) {
          const rank = (s) => [
            schoolYearStart(s.schoolYear),
            semesterRank(s.semester),
          ];

          const latest = matchedSchedules.reduce((best, cur) => {
            const [by, bs] = rank(best);
            const [cy, cs] = rank(cur);
            if (cy > by || (cy === by && cs > bs)) return cur;
            return best;
          }, matchedSchedules[0]);

          const filtered = matchedSchedules.filter(
            (s) =>
              (s.schoolYear || "") === (latest.schoolYear || "") &&
              (s.semester || "") === (latest.semester || "")
          );

          setLatestSchedules(filtered);
          setActiveTerm({
            semester: latest.semester,
            schoolYear: latest.schoolYear,
          });
          roomIds = [...new Set(filtered.map((s) => s.roomId))];
        } else {
          setLatestSchedules([]);
          setActiveTerm(null);
        }

        setMyRoomIds(roomIds);
        baseLoadedRef.current = true;
        setLoading(false);

        const unsubOnline = onSnapshot(
          query(
            collection(db, "facultySchedules"),
            where("userId", "==", user.uid)
          ),
          (snap) => {
            setOnlineSchedules(
              snap.docs.map((d) => ({ id: d.id, ...d.data(), isOnline: true }))
            );
          },
          (err) => {
            console.warn("Online schedules listener:", err);
            setOnlineSchedules([]);
          }
        );
        unsubsRef.current.push(unsubOnline);

        // ✅ CHANGED: kind-aware release map (matches FacultySchedule)
        const unsubReleases = onSnapshot(
          query(
            collection(db, "roomReleases"),
            where("releasedBy", "==", user.uid)
          ),
          (snap) => {
            const map = new Map();
            snap.docs.forEach((d) => {
              const r = d.data();
              let key;
              if (r.releaseType === "reassignment" && r.reassignmentId) {
                key = `reassign_${r.reassignmentId}_${r.date}`;
              } else if (r.releaseType === "reservation" && r.reservationId) {
                key = `resv_${r.reservationId}_${r.date}`;
              } else if (r.scheduleId) {
                key = `${r.scheduleId}_${r.date}`;
              } else {
                return; // unknown release kind — skip
              }
              map.set(key, r);
            });
            setReleasedMap(map);
          },
          (err) => {
            console.warn("Releases listener:", err);
            setReleasedMap(new Map());
          }
        );
        unsubsRef.current.push(unsubReleases);

        const unsubReassign = onSnapshot(
          query(
            collection(db, "roomReassignments"),
            where("facultyId", "==", user.uid)
          ),
          (snap) => {
            const all = snap.docs
              .map((d) => ({ id: d.id, ...d.data() }))
              .filter((r) => isApprovedReassignment(r.status));

            const away = new Set(
              all
                .filter((r) => r.oldRoomId)
                .map((r) => `${r.scheduleId}_${r.date}`)
            );
            setReassignedAwayKeys(away);
            setReassignedInto(all);
          },
          (err) => console.warn("Reassignments listener:", err)
        );
        unsubsRef.current.push(unsubReassign);

        const unsubReservations = onSnapshot(
          collection(db, "reservationRequests"),
          (snap) => {
            const mine = snap.docs
              .map((d) => ({ id: d.id, ...d.data() }))
              .filter((r) => {
                const isOwnerById =
                  r.userId === user.uid || r.createdBy === user.uid;
                const isOwnerByName =
                  normalizeName(r.requesterName || r.facultyName || "") ===
                  myName;
                const isApproved =
                  String(r.status || "").toLowerCase() === "approved";
                return (isOwnerById || isOwnerByName) && isApproved;
              });
            setApprovedReservations(mine);
          },
          (err) => console.warn("Reservations listener:", err)
        );
        unsubsRef.current.push(unsubReservations);

        const unsubEvents = onSnapshot(
          collection(db, "events"),
          (snap) => {
            const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            const mine = all.filter(
              (e) =>
                roomIds.includes(e.roomId) && e.status !== "Cancelled"
            );
            setMyRoomEvents(mine);
          },
          (err) => console.warn("Events listener:", err)
        );
        unsubsRef.current.push(unsubEvents);
      } catch (err) {
        console.error("Setup error:", err);
        setLoading(false);
      }
    };

    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (user) setup(user);
    });

    return () => {
      isCancelled = true;
      unsubAuth();
      cleanup();
    };
  }, []);

  useEffect(() => {
    setAnnouncementLoading(true);

    const annQuery = query(
      collection(db, "broadcastChannels"),
      orderBy("createdAt", "desc"),
      limit(15)
    );

    const unsubscribe = onSnapshot(
      annQuery,
      (snap) => {
        const adminOnly = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((a) => a.senderRole === "Admin")
          .filter(
            (a) => a.recipient === "All Staffs" || a.recipient === "Faculty"
          )
          .slice(0, 3);

        setAdminAnnouncements(adminOnly);
        setAnnouncementLoading(false);
      },
      (err) => {
        console.warn("Announcement listener error:", err);
        setAdminAnnouncements([]);
        setAnnouncementLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  const toggleAnnouncementLike = async (announcementId) => {
    const firebaseUser = auth.currentUser;
    if (!firebaseUser || likeBusyId) return;

    const target = adminAnnouncements.find((a) => a.id === announcementId);
    if (!target) return;

    const currentLikes = target.reactions?.like || [];
    const hasLiked = currentLikes.includes(firebaseUser.uid);

    setLikeBusyId(announcementId);
    setAdminAnnouncements((prev) =>
      prev.map((a) => {
        if (a.id !== announcementId) return a;
        const likes = a.reactions?.like || [];
        const nextLikes = hasLiked
          ? likes.filter((uid) => uid !== firebaseUser.uid)
          : [...likes, firebaseUser.uid];
        return { ...a, reactions: { ...a.reactions, like: nextLikes } };
      })
    );

    try {
      await updateDoc(doc(db, "broadcastChannels", announcementId), {
        "reactions.like": hasLiked
          ? arrayRemove(firebaseUser.uid)
          : arrayUnion(firebaseUser.uid),
      });
    } catch (err) {
      console.error("Failed to toggle like:", err);
      setAdminAnnouncements((prev) =>
        prev.map((a) => (a.id === announcementId ? target : a))
      );
    } finally {
      setLikeBusyId(null);
    }
  };

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const todayAbbrev = DAY_LABELS[now.getDay()];
  const todayStr = toDateStr(now);

  // ═════════════════════════════════════════════════════════════════
  // ✅ UPDATED allItems — kind-aware release filtering & trimming
  // ═════════════════════════════════════════════════════════════════
  const allItems = useMemo(() => {
    const items = [];

    const isOverridden = (schedule, dateStr) => {
      return myRoomEvents.some((ev) => {
        if (ev.roomId !== schedule.roomId) return false;
        if (ev.date !== dateStr) return false;
        return timesOverlap(
          schedule.startTime,
          schedule.endTime,
          ev.startTime,
          ev.endTime
        );
      });
    };

    // ─── Helper: apply release info → returns {hide, endTime, isReleased, releasedAtTime}
    const applyRelease = (releaseInfo, originalStart, originalEnd) => {
      // No release record → show as-is
      if (!releaseInfo) {
        return {
          hide: false,
          endTime: originalEnd,
          isReleased: false,
          releasedAtTime: null,
        };
      }

      // Fully released (no effectiveEndTime) → hide entirely
      if (!releaseInfo.effectiveEndTime) {
        return { hide: true };
      }

      // Mid-class release → trim to effectiveEndTime
      const effMin = toMinutes(releaseInfo.effectiveEndTime);
      const startMin = toMinutes(originalStart);

      // Edge case: release happened before/at start → treat as fully released
      if (effMin <= startMin) {
        return { hide: true };
      }

      return {
        hide: false,
        endTime: releaseInfo.effectiveEndTime,
        isReleased: true,
        releasedAtTime: releaseInfo.effectiveEndTime,
      };
    };

    // ─── 1) SCHEDULES ───
    latestSchedules.forEach((s) => {
      const occurrenceDate = getNextOccurrenceDate(s.day, s.startTime, now);
      if (!occurrenceDate) return;
      const dateStr = toDateStr(occurrenceDate);
      const reassignKey = `${s.id}_${dateStr}`;

      // Reassigned to another room → hide from original slot
      if (reassignedAwayKeys.has(reassignKey)) return;

      // Overridden by a room activity → hide
      if (isOverridden(s, dateStr)) return;

      // ✅ Release handling (full → hide, partial → trim)
      const releaseInfo = releasedMap.get(
        makeReleaseKey("schedule", s.id, dateStr)
      );
      const release = applyRelease(releaseInfo, s.startTime, s.endTime);
      if (release.hide) return;

      items.push({
        id: s.id,
        kind: "schedule",
        subject: s.subject,
        roomName: s.roomName,
        section: s.section,
        startTime: s.startTime,
        endTime: release.endTime,
        day: s.day,
        date: dateStr,
        occurrence: occurrenceDate,
        isToday: dateStr === todayStr,
        isRecurring: true,
        faculty: s.faculty,
        isOnline: false,
        isReleased: release.isReleased,
        releasedAtTime: release.releasedAtTime,
      });
    });

    // ─── 2) ONLINE SCHEDULES ─── (not released — matches schedule page)
    onlineSchedules.forEach((s) => {
      const occurrenceDate = getNextOccurrenceDate(s.day, s.startTime, now);
      if (!occurrenceDate) return;
      const dateStr = toDateStr(occurrenceDate);

      items.push({
        id: s.id,
        kind: "online",
        subject: s.subject,
        roomName: "Online",
        section: s.section,
        startTime: s.startTime,
        endTime: s.endTime,
        day: s.day,
        date: dateStr,
        occurrence: occurrenceDate,
        isToday: dateStr === todayStr,
        isRecurring: true,
        faculty: s.facultyName || "Faculty",
        isOnline: true,
        isReleased: false,
        releasedAtTime: null,
      });
    });

    // ─── 3) REASSIGNMENTS ─── ✅ now release-aware
    reassignedInto.forEach((r) => {
      const occurrence = new Date(`${r.date}T${r.startTime}:00`);
      if (occurrence < now) return;

      const releaseInfo = releasedMap.get(
        makeReleaseKey("reassignment", r.id, r.date)
      );
      const release = applyRelease(releaseInfo, r.startTime, r.endTime);
      if (release.hide) return;

      items.push({
        id: r.id,
        kind: "reassignment",
        subject: `${r.courseTitle || "Class"}`,
        roomName: r.newRoomName,
        startTime: r.startTime,
        endTime: release.endTime,
        date: r.date,
        occurrence,
        isToday: r.date === todayStr,
        isRecurring: false,
        faculty: r.facultyName || "Faculty",
        originalRoom: r.oldRoomName,
        isOnline: false,
        isReleased: release.isReleased,
        releasedAtTime: release.releasedAtTime,
      });
    });

    // ─── 4) RESERVATIONS ─── ✅ now release-aware
    approvedReservations.forEach((r) => {
      const occurrence = new Date(`${r.date}T${r.startTime}:00`);
      if (occurrence < now) return;

      const releaseInfo = releasedMap.get(
        makeReleaseKey("reservation", r.id, r.date)
      );
      const release = applyRelease(releaseInfo, r.startTime, r.endTime);
      if (release.hide) return;

      items.push({
        id: r.id,
        kind: "reservation",
        subject: r.courseTitle || r.purpose || "Reservation",
        roomName: r.roomName,
        startTime: r.startTime,
        endTime: release.endTime,
        date: r.date,
        occurrence,
        isToday: r.date === todayStr,
        isRecurring: false,
        faculty: r.facultyName || "Faculty",
        isOnline: false,
        isReleased: release.isReleased,
        releasedAtTime: release.releasedAtTime,
      });
    });

    items.sort((a, b) => a.occurrence - b.occurrence);
    return items;
  }, [
    latestSchedules,
    onlineSchedules,
    releasedMap,        // ✅ was releasedKeys
    reassignedAwayKeys,
    reassignedInto,
    approvedReservations,
    myRoomEvents,
    now,
    todayStr,
  ]);

  const todaysItems = useMemo(() => {
    return allItems
      .filter((item) => item.isToday)
      .map((item) => {
        const [startH, startM] = parseTimeParts(item.startTime);
        const [endH, endM] = parseTimeParts(item.endTime);
        const startMin = startH * 60 + startM;
        const endMin = endH * 60 + endM;
        const status =
          currentMinutes >= startMin && currentMinutes < endMin
            ? "ONGOING"
            : currentMinutes < startMin
            ? "UPCOMING"
            : "COMPLETED";
        return { ...item, status, startMin, endMin };
      })
      .sort((a, b) => a.startMin - b.startMin);
  }, [allItems, currentMinutes]);

  const upcomingItems = useMemo(() => {
    return allItems.filter((item) => item.occurrence > now).slice(0, 5);
  }, [allItems, now]);

  useEffect(() => {
    if (bannerIndex >= todaysItems.length) {
      setBannerIndex(0);
    }
  }, [todaysItems, bannerIndex]);

  const activeBanner = todaysItems[bannerIndex] || null;
  const activeBannerMeta = activeBanner ? getKindMeta(activeBanner) : null;

  const ongoingProgress =
    activeBanner?.status === "ONGOING"
      ? Math.min(
          100,
          Math.max(
            0,
            ((currentMinutes - activeBanner.startMin) /
              (activeBanner.endMin - activeBanner.startMin)) *
              100
          )
        )
      : null;

  const roomsThisWeek = useMemo(
    () => new Set(allItems.map((item) => item.roomName)).size,
    [allItems]
  );

  const nextClass = upcomingItems[0] || null;
  const latestAnnouncement = adminAnnouncements[0] || null;
  const currentUid = auth.currentUser?.uid;
  const latestLikes = latestAnnouncement?.reactions?.like || [];
  const hasLikedLatest = latestLikes.includes(currentUid);

  return (
    <div className="dashboard-shell">
      <div className="container">
        <main className="dashboard-main">
          {/* ─── HEADER ──────────────────────────────────────────── */}
          <div className="dash-header">
            <div className="dash-greeting">
              <div className="dash-greeting-icon">
                <i className={greetingIconForHour(now.getHours())}></i>
              </div>
              <div>
                <h1 className="dash-title">
                  {greetingForHour(now.getHours())}{facultyName ? `, ${facultyName}` : ""}!
                </h1>
                <p className="dash-eyebrow">
                  {now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                  {activeTerm && (
                    <>
                      {" "}
                      <span className="dash-term-dot">•</span>{" "}
                      {activeTerm.semester || ""} Semester, {activeTerm.schoolYear || ""}
                    </>
                  )}
                </p>
              </div>
            </div>

            <button className="reserve-btn" onClick={() => navigate("/faculty/submit-reservation")}>
              <i className="fa-solid fa-plus"></i>
              Reserve Room
            </button>
          </div>

          {/* ─── ANNOUNCEMENT (PERMANENT — text preview only) ────── */}
          {announcementLoading ? (
            <div className="announce-card is-skeleton">
              <div className="announce-skeleton-avatar"></div>
              <div className="announce-skeleton-lines">
                <div className="announce-skeleton-line w-40"></div>
                <div className="announce-skeleton-line w-90"></div>
                <div className="announce-skeleton-line w-60"></div>
              </div>
            </div>
          ) : latestAnnouncement ? (
            <div className="announce-card">
              <div className="announce-card-glow" aria-hidden="true" />

              <div className="announce-top">
                <div className="announce-avatar-wrap">
                  <div className="announce-avatar">
                    {getInitials(latestAnnouncement.senderName)}
                  </div>
                  <span className="announce-avatar-badge">
                    <i className="fa-solid fa-bullhorn"></i>
                  </span>
                </div>

                <div className="announce-meta">
                  <div className="announce-meta-row">
                    <strong>{latestAnnouncement.senderName || "Admin"}</strong>
                    <span className="announce-role-chip">Admin</span>
                    <span className="announce-live-dot" title="Live updates enabled"></span>
                  </div>
                  <span className="announce-subtext">
                    {timeAgo(latestAnnouncement.createdAt, now)}
                    <span className="announce-subtext-dot">•</span>
                    College of Information and Communications Technology
                  </span>
                </div>

                {adminAnnouncements.length > 1 && (
                  <span className="announce-more-pill">
                    +{adminAnnouncements.length - 1}
                  </span>
                )}
              </div>

              <p className="announce-text">
                {announcementPreview(latestAnnouncement)}
              </p>

              <div className="announce-actions">
                <button
                  className={`announce-like-btn ${hasLikedLatest ? "is-liked" : ""}`}
                  onClick={() => toggleAnnouncementLike(latestAnnouncement.id)}
                  disabled={likeBusyId === latestAnnouncement.id}
                >
                  <i className={hasLikedLatest ? "fa-solid fa-heart" : "fa-regular fa-heart"}></i>
                  {latestLikes.length > 0 ? latestLikes.length : "Like"}
                </button>

                <button
                  className="announce-view-btn"
                  onClick={() => navigate("/faculty/broadcast-channel")}
                >
                  View announcement
                  <i className="fa-solid fa-arrow-right"></i>
                </button>
              </div>
            </div>
          ) : null}

          {/* ─── STATS ROW ───────────────────────────────────────── */}
          {loading ? (
            <div className="dash-stats-row">
              <div className="stat-skeleton"></div>
              <div className="stat-skeleton"></div>
              <div className="stat-skeleton"></div>
              <div className="stat-skeleton"></div>
            </div>
          ) : allItems.length > 0 ? (
            <div className="dash-stats-row">
              <div className="dash-stat-chip">
                <i className="fa-solid fa-calendar-day"></i>
                <div>
                  <strong>{todaysItems.length}</strong>
                  <span>Class{todaysItems.length === 1 ? "" : "es"} Today</span>
                </div>
              </div>

              <div className="dash-stat-chip">
                <i className="fa-solid fa-layer-group"></i>
                <div>
                  <strong>{latestSchedules.length + onlineSchedules.length}</strong>
                  <span>Meetings / Week</span>
                </div>
              </div>

              <div className="dash-stat-chip">
                <i className="fa-solid fa-door-open"></i>
                <div>
                  <strong>{roomsThisWeek}</strong>
                  <span>Room{roomsThisWeek === 1 ? "" : "s"} Used</span>
                </div>
              </div>

              {nextClass && (
                <div className="dash-stat-chip is-accent">
                  <i className="fa-solid fa-hourglass-half"></i>
                  <div>
                    <strong>{formatCountdown(nextClass.occurrence, now)}</strong>
                    <span>Next: {nextClass.subject}</span>
                  </div>
                </div>
              )}
            </div>
          ) : null}

          {/* ─── MAIN GRID ───────────────────────────────────────── */}
          <div className="dash-grid">
            {/* LEFT: Today's Schedule */}
            <section className="today-card">
              <div className="card-header">
                <div>
                  <h2>Today's Schedule</h2>
                  <span className="card-subtitle">
                    {todayAbbrev} · {now.toLocaleDateString("en-US", { month: "long", day: "numeric" })}
                  </span>
                </div>

                <button
                  className="see-all-btn"
                  onClick={() => navigate("/faculty/schedule")}
                >
                  See All
                  <i className="fa-solid fa-arrow-right"></i>
                </button>
              </div>

              {loading ? (
                <div className="schedule-skeleton">
                  <div className="skeleton-banner"></div>
                  <div className="skeleton-row"></div>
                  <div className="skeleton-row short"></div>
                </div>
              ) : !activeBanner ? (
                <div className="schedule-empty">
                  <i className="fa-regular fa-calendar-check"></i>
                  <p>No classes scheduled for today.</p>
                  <span className="schedule-empty-hint">
                    Enjoy the free day, or check your upcoming classes.
                  </span>
                </div>
              ) : (
                <>
                  <div className="schedule-slider">
                    <button
                      className="slide-btn left"
                      disabled={todaysItems.length < 2}
                      onClick={() =>
                        setBannerIndex(
                          (i) => (i - 1 + todaysItems.length) % todaysItems.length
                        )
                      }
                      aria-label="Previous class"
                    >
                      <i className="fa-solid fa-chevron-left"></i>
                    </button>

                    <div className={`schedule-banner is-${activeBannerMeta.key}`}>
                      <span
                        className={`ongoing-badge ${
                          activeBanner.status === "ONGOING"
                            ? "status-ongoing"
                            : activeBanner.status === "UPCOMING"
                            ? "status-upcoming"
                            : "status-completed"
                        }`}
                      >
                        <span className="ongoing-dot"></span>
                        {activeBanner.status}
                      </span>

                      <span className="schedule-time">
                        <i className="fa-regular fa-clock"></i>
                        {formatTime(activeBanner.startTime)} - {formatTime(activeBanner.endTime)}
                      </span>

                      <div className="banner-art">
                        <i className={activeBannerMeta.icon}></i>
                      </div>

                      <div className="banner-overlay">
                        <span className={`banner-kind-tag tag-${activeBannerMeta.key}`}>
                          <i className={activeBannerMeta.icon}></i>
                          {activeBannerMeta.label}
                        </span>

                        <h1>{activeBanner.roomName}</h1>
                        <p>
                          {activeBanner.subject}
                          {activeBanner.section ? ` • ${activeBanner.section}` : ""}
                        </p>

                        {/* ✅ NEW: partial-release indicator */}
                        {activeBanner.isReleased && (
                          <span className="banner-countdown banner-released-pill">
                            <i className="fa-solid fa-lock-open"></i>
                            Released at {formatTime(activeBanner.releasedAtTime)}
                          </span>
                        )}

                        {!activeBanner.isReleased && activeBanner.status === "UPCOMING" && (
                          <span className="banner-countdown">
                            <i className="fa-regular fa-clock"></i>
                            Starts {formatCountdown(
                              new Date(
                                now.getFullYear(),
                                now.getMonth(),
                                now.getDate(),
                                ...parseTimeParts(activeBanner.startTime),
                                0
                              ),
                              now
                            )}
                          </span>
                        )}

                        {!activeBanner.isReleased && ongoingProgress !== null && (
                          <div className="banner-progress-track">
                            <div
                              className="banner-progress-fill"
                              style={{ width: `${ongoingProgress}%` }}
                            />
                          </div>
                        )}
                      </div>
                    </div>

                    <button
                      className="slide-btn right"
                      disabled={todaysItems.length < 2}
                      onClick={() =>
                        setBannerIndex((i) => (i + 1) % todaysItems.length)
                      }
                      aria-label="Next class"
                    >
                      <i className="fa-solid fa-chevron-right"></i>
                    </button>
                  </div>

                  {todaysItems.length > 1 && (
                    <div className="schedule-dots">
                      {todaysItems.map((_, i) => (
                        <button
                          key={i}
                          className={`schedule-dot ${i === bannerIndex ? "active" : ""}`}
                          onClick={() => setBannerIndex(i)}
                          aria-label={`Go to class ${i + 1}`}
                        />
                      ))}
                    </div>
                  )}

                  {/* Today's class strip */}
                  <div className="today-strip-wrap">
                    <span className="today-strip-label">
                      <i className="fa-solid fa-list-ul"></i>
                      All classes today
                    </span>
                    <div className="today-strip">
                      {todaysItems.map((item, i) => (
                        <button
                          key={`${item.id}-${i}`}
                          className={`today-pill ${i === bannerIndex ? "active" : ""}`}
                          onClick={() => setBannerIndex(i)}
                        >
                          <span
                            className={`today-pill-status status-${item.status.toLowerCase()}`}
                          />
                          <span className="today-pill-time">
                            {formatTime(item.startTime)}
                          </span>
                          <span className="today-pill-subject">{item.subject}</span>
                          {/* ✅ NEW: tiny release indicator on pill */}
                          {item.isReleased && (
                            <i
                              className="fa-solid fa-lock-open today-pill-released"
                              title={`Released at ${formatTime(item.releasedAtTime)}`}
                            ></i>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </section>

            {/* RIGHT: Sidebar */}
            <aside className="dash-sidebar">
              <div className="sidebar-card">
                <div className="sidebar-header">
                  <div>
                    <h3>Upcoming</h3>
                    <span className="sidebar-subtitle">
                      Your next {upcomingItems.length || 0} class
                      {upcomingItems.length === 1 ? "" : "es"}
                    </span>
                  </div>
                  <button
                    className="sidebar-link"
                    onClick={() => navigate("/faculty/schedule")}
                  >
                    All
                    <i className="fa-solid fa-chevron-right"></i>
                  </button>
                </div>

                {loading ? (
                  <div className="sidebar-skeletons">
                    <div className="skeleton-card"></div>
                    <div className="skeleton-card"></div>
                    <div className="skeleton-card"></div>
                  </div>
                ) : upcomingItems.length === 0 ? (
                  <div className="upcoming-empty">
                    <i className="fa-regular fa-calendar"></i>
                    No upcoming classes found.
                  </div>
                ) : (
                  <div className="upcoming-compact-list">
                    {upcomingItems.map((item) => {
                      const meta = getKindMeta(item);
                      return (
                        <div
                          className={`upcoming-mini is-${meta.key}`}
                          key={item.id}
                        >
                          <div className="mini-date">
                            <span>{DAY_LABELS[item.occurrence.getDay()]}</span>
                            <strong>{item.occurrence.getDate()}</strong>
                          </div>

                          <div className="mini-body">
                            <div className="mini-heading">
                              <h4>{item.subject}</h4>
                              {item.isToday && (
                                <span className="today-chip-mini">Today</span>
                              )}
                              {item.isReleased && (
                                <span className="today-chip-mini mini-released-chip">
                                  Released
                                </span>
                              )}
                            </div>

                            <div className="mini-meta">
                              <span>
                                <i className="fa-regular fa-clock"></i>
                                {formatTime(item.startTime)}
                              </span>
                              <span>
                                <i className="fa-solid fa-location-dot"></i>
                                {item.roomName}
                              </span>
                            </div>

                            <span className={`kind-pill pill-${meta.key}`}>
                              <i className={meta.icon}></i>
                              {meta.label}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </aside>
          </div>
        </main>
      </div>
    </div>
  );
}