import "./admin-view-reservation.css";
import { useNavigate, useLocation } from "react-router-dom";
import { useState, useRef, useEffect } from "react";
import { doc, getDoc, collection, getDocs, query, where, onSnapshot } from "firebase/firestore";
import { db, auth } from "../../firebase";
import Toast from "../../Popup/Toast/Toast";

// ─── Helpers ────────────────────────────────────────────────────
const parseTimeToMin = (t) => {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
};
const overlaps = (aS, aE, bS, bE) => aS < bE && aE > bS;
const format12Hour = (time) => {
  if (!time) return "—";
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return time;
  const suffix = h >= 12 ? "PM" : "AM";
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, "0")} ${suffix}`;
};

const findUserByName = async (name) => {
  if (!name) return null;
  const usersSnap = await getDocs(collection(db, "users"));
  const normalized = name.trim().toLowerCase();
  for (const userDoc of usersSnap.docs) {
    const data = userDoc.data();
    const fullName = `${data.firstName || ""} ${data.lastName || ""}`.trim().toLowerCase();
    if (fullName === normalized) return { id: userDoc.id, ...data };
  }
  return null;
};

// ─── Conflict check (same logic) ────────────────────────────────
const checkReservationConflicts = async (reservation, skipReservationId) => {
  if (!reservation) return [];
  const roomId = reservation.roomId;
  const roomName = reservation.roomName;
  if (!roomId && !roomName) return [];
  if (!reservation.date || !reservation.startTime || !reservation.endTime) return [];

  const reqStart = parseTimeToMin(reservation.startTime);
  const reqEnd = parseTimeToMin(reservation.endTime);
  if (reqStart == null || reqEnd == null) return [];

  const matchesRoom = (r) =>
    (roomId && r.roomId === roomId) || (roomName && r.roomName === roomName);

  const found = [];

  try {
    const [evSnap, reSnap, resSnap, schedSnap] = await Promise.all([
      getDocs(query(collection(db, "events"), where("date", "==", reservation.date))),
      getDocs(collection(db, "roomReassignments")),
      getDocs(query(collection(db, "reservationRequests"), where("date", "==", reservation.date))),
      roomId
        ? getDocs(collection(db, "rooms", roomId, "schedules"))
        : Promise.resolve({ docs: [] }),
    ]);

    evSnap.docs.forEach((d) => {
      const e = { id: d.id, ...d.data() };
      if (String(e.status || "").toLowerCase() === "cancelled") return;
      if (!matchesRoom(e)) return;
      if (skipReservationId && e.reservationId === skipReservationId) return;
      if (e.reservationId && e.reservationId === reservation.id) return;
      const s = parseTimeToMin(e.startTime);
      const en = parseTimeToMin(e.endTime);
      if (s == null || en == null) return;
      if (!overlaps(reqStart, reqEnd, s, en)) return;
      found.push({
        id: e.id, kind: "event", label: "Room Activity",
        title: e.title || e.purpose || "Room Activity",
        faculty: e.faculty || e.requestedByName || "Admin",
        startTime: e.startTime, endTime: e.endTime,
      });
    });

    reSnap.docs.forEach((d) => {
      const r = { id: d.id, ...d.data() };
      if (r.date !== reservation.date) return;
      const status = String(r.status || "").toLowerCase();
      if (status !== "accepted" && status !== "approved") return;
      const into = (roomId && r.newRoomId === roomId) || (roomName && r.newRoomName === roomName);
      if (!into) return;
      const s = parseTimeToMin(r.startTime);
      const en = parseTimeToMin(r.endTime);
      if (s == null || en == null) return;
      if (!overlaps(reqStart, reqEnd, s, en)) return;
      found.push({
        id: r.id, kind: "reassignment", label: "Reassigned Class",
        title: r.courseTitle || r.eventTitle || "Reassigned Class",
        faculty: r.facultyName || "-",
        startTime: r.startTime, endTime: r.endTime,
      });
    });

    resSnap.docs.forEach((d) => {
      const r = { id: d.id, ...d.data() };
      if (skipReservationId && r.id === skipReservationId) return;
      if (r.id === reservation.id) return;
      if (String(r.status || "").toLowerCase() !== "approved") return;
      if (!matchesRoom(r)) return;
      const s = parseTimeToMin(r.startTime);
      const en = parseTimeToMin(r.endTime);
      if (s == null || en == null) return;
      if (!overlaps(reqStart, reqEnd, s, en)) return;
      const isWalkIn = String(r.reservationType || "").toLowerCase() === "walk-in";
      found.push({
        id: r.id, kind: "reservation",
        label: isWalkIn ? "Walk-in Reservation" : "Faculty Reservation",
        title: r.customPurpose || r.courseTitle || r.purpose || "Reservation",
        faculty: r.requesterName || r.facultyName || "-",
        startTime: r.startTime, endTime: r.endTime,
      });
    });

    if (schedSnap.docs?.length) {
      const day = new Date(`${reservation.date}T00:00:00`)
        .toLocaleDateString("en-US", { weekday: "short" }).toUpperCase();
      schedSnap.docs.forEach((d) => {
        const s = { id: d.id, ...d.data() };
        if (s.cancelled || s.initialized) return;
        if (s.day !== day) return;
        const sT = parseTimeToMin(s.startTime);
        const eT = parseTimeToMin(s.endTime);
        if (sT == null || eT == null) return;
        if (!overlaps(reqStart, reqEnd, sT, eT)) return;
        found.push({
          id: s.id, kind: "schedule", label: "Class Schedule",
          title: s.subject || s.courseTitle || s.title || "Class",
          faculty: s.facultyName || s.faculty || "-",
          startTime: s.startTime, endTime: s.endTime,
        });
      });
    }
  } catch (err) {
    console.error("Conflict check failed:", err);
  }

  return found;
};

function AdminViewReservation() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const initialReservation = state?.reservation;

  const [reservation, setReservation] = useState(initialReservation);
  const [requesterPhoto, setRequesterPhoto] = useState(null);

  const [conflicts, setConflicts] = useState([]);
  const [checkingConflicts, setCheckingConflicts] = useState(true);

  const toastTimeoutRef = useRef(null);
  const [toast, setToast] = useState({
    show: false, type: "success", title: "", message: "",
  });

  const showToast = (type, title, message) => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = null;
    }
    setToast({ show: true, type, title, message });
    if (type !== "loading") {
      toastTimeoutRef.current = setTimeout(() => {
        setToast((prev) => ({ ...prev, show: false }));
        toastTimeoutRef.current = null;
      }, 4000);
    }
  };

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  // Live listener on reservation
  useEffect(() => {
    if (!initialReservation?.id) return;
    const unsub = onSnapshot(
      doc(db, "reservationRequests", initialReservation.id),
      (snap) => {
        if (snap.exists()) setReservation({ id: snap.id, ...snap.data() });
      },
      (err) => console.warn("Live reservation listener failed:", err)
    );
    return () => unsub();
  }, [initialReservation?.id]);

  // Fetch requester photo
  useEffect(() => {
    const fetchRequesterPhoto = async () => {
      if (!reservation) return;
      try {
        const inlinePhoto =
          reservation.userPhoto ||
          reservation.requesterPhoto ||
          reservation.facultyPhoto ||
          reservation.photoUrl;
        if (inlinePhoto) { setRequesterPhoto(inlinePhoto); return; }

        let userId = reservation.userId;
        if (!userId && (reservation.facultyName || reservation.requesterName)) {
          const user = await findUserByName(reservation.facultyName || reservation.requesterName);
          if (user) userId = user.id;
        }
        if (!userId) return;

        const userSnap = await getDoc(doc(db, "users", userId));
        if (!userSnap.exists()) return;

        const userData = userSnap.data();
        const photo =
          userData.photoUrl || userData.photoURL || userData.profilePhoto ||
          userData.photo || userData.profilePicture || userData.avatar ||
          userData.imageUrl || null;

        if (photo) setRequesterPhoto(photo);
      } catch (err) {
        console.error("Failed to fetch requester photo:", err);
      }
    };
    fetchRequesterPhoto();
  }, [reservation]);

  // Live conflict check
  useEffect(() => {
    let cancelled = false;
    const status = String(reservation?.status || "").toLowerCase();
    const decided =
      status === "rejected" || status === "denied" || status === "cancelled";

    if (decided || !reservation) {
      setConflicts([]);
      setCheckingConflicts(false);
      return;
    }

    const run = async () => {
      setCheckingConflicts(true);
      const found = await checkReservationConflicts(reservation, reservation.id);
      if (!cancelled) {
        setConflicts(found);
        setCheckingConflicts(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [reservation]);

  if (!reservation) {
    return (
      <div className="dh-view-reservation">
        <h2>Reservation not found.</h2>
        <button onClick={() => navigate("/admin/reservations")}>Back</button>
      </div>
    );
  }

  const getDuration = (start, end) => {
    if (!start || !end) return "N/A";
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    const diffMs = new Date().setHours(eh, em, 0) - new Date().setHours(sh, sm, 0);
    if (diffMs <= 0) return "N/A";
    const totalMinutes = Math.floor(diffMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours && minutes) return `${hours} hr ${minutes} min`;
    if (hours) return `${hours} hr`;
    return `${minutes} min`;
  };

  const createdDate = reservation.createdAt?.seconds
    ? new Date(reservation.createdAt.seconds * 1000)
    : new Date(reservation.createdAt);

  const updatedDate = reservation.updatedAt?.seconds
    ? new Date(reservation.updatedAt.seconds * 1000)
    : null;

  const duration = getDuration(reservation.startTime, reservation.endTime);

  const status = reservation.status?.toLowerCase().trim() || "pending";
  const isApproved = status === "approved";
  const isDenied = status === "rejected";
  const hasConflicts = conflicts.length > 0;

  return (
    <>
      <div className="dh-view-reservation">
        <i
          className="fa-solid fa-arrow-left dh-view-reservation-back"
          onClick={() => navigate(-1)}
        ></i>

        <div className="white-box-view-reservation">
          <div className="dh-reservation-header">
            <div className="dh-reservation-header-left">
              <div className="dh-reservation-profile">
                {requesterPhoto ? (
                  <img
                    src={requesterPhoto}
                    alt={reservation.facultyName || reservation.requesterName || "Requester"}
                    className="dh-reservation-profile-img"
                    onError={() => setRequesterPhoto(null)}
                  />
                ) : (
                  <i className="fa-solid fa-user"></i>
                )}
              </div>
              <span className="dh-reservation-faculty-name">
                {reservation.facultyName || reservation.requesterName || "Unknown"}
              </span>
            </div>

            <div className="dh-reservation-header-right">
              <div
                className={`dh-reservation-status-badge ${
                  isApproved ? "approved" : isDenied ? "denied" : "pending"
                }`}
              >
                <i className={`fa-solid ${isApproved ? "fa-check" : isDenied ? "fa-xmark" : "fa-clock"}`}></i>
                {reservation.status || "Pending"}
              </div>
            </div>
          </div>

          <div className="dh-reservation-info-boxes">
            <div className="dh-reservation-info-box">
              <h3 className="dh-info-box-title">Reservation Metadata</h3>
              <div className="dh-info-box-content">
                <p>
                  Requested On: {createdDate.toLocaleDateString()} | {createdDate.toLocaleTimeString()}
                </p>
                {updatedDate && (
                  <p>
                    <strong>Last Updated:</strong> {updatedDate.toLocaleDateString()} | {updatedDate.toLocaleTimeString()}
                    {reservation.updatedBy ? ` by ${reservation.updatedBy}` : ""}
                  </p>
                )}
                <p>Status: {reservation.status}</p>
                {reservation.denialReason && (
                  <p style={{ color: "#dc2626" }}>
                    <strong>Denial Reason:</strong> {reservation.denialReason}
                  </p>
                )}
              </div>
            </div>

            <div className="dh-reservation-info-box">
              <h3 className="dh-info-box-title">Reservation Details</h3>
              <div className="dh-info-box-content">
                <div className="dh-info-box-details">
                  <p>Room Name: {reservation.roomName}</p>
                  <p>Room Capacity: {reservation.roomCapacity}</p>
                  <p>Course Title: {reservation.courseTitle}</p>
                  <p>Date: {reservation.date}</p>
                  <p>Start Time: {reservation.startTime}</p>
                  <p>Total Duration: {duration}</p>
                  <p>End Time: {reservation.endTime}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="dh-reservation-info-boxes">
            <div className="dh-reservation-info-box">
              <h3 className="dh-info-box-title">Reservation Purpose</h3>
              <div className="dh-info-box-content">
                <p><strong>Audience Type:</strong> {reservation.audienceType}</p>

                {reservation.audienceType === "Class" && (
                  <>
                    <p><strong>Course:</strong> {reservation.attendees?.course}</p>
                    <p><strong>Year/Section/Group:</strong> {reservation.attendees?.yearSectionGroup}</p>
                  </>
                )}
                {reservation.audienceType === "Organization" && (
                  <p><strong>Organization:</strong> {reservation.attendees?.organization}</p>
                )}
                {reservation.audienceType === "Faculty" && (
                  <p><strong>Attendees:</strong> Faculty Members</p>
                )}
                {reservation.audienceType === "Others" && (
                  <p><strong>Attendees:</strong> {reservation.attendees?.otherAudience}</p>
                )}
                <p><strong>Purpose:</strong> {reservation.purpose}</p>
              </div>
            </div>

            <div className="dh-reservation-info-box conflict-check-box">
              <h3 className="dh-info-box-title">Conflict Check</h3>
              <div className="dh-info-box-content">
                {checkingConflicts ? (
                  <p style={{ color: "#6b7280" }}>
                    <i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }}></i>
                    Checking for conflicts…
                  </p>
                ) : !hasConflicts ? (
                  <p style={{ color: "#16a34a", fontWeight: 600 }}>
                    <i className="fa-solid fa-circle-check" style={{ marginRight: 6 }}></i>
                    No conflicts detected.
                  </p>
                ) : (
                  <>
                    <p style={{ color: "#b91c1c", fontWeight: 700, marginBottom: 8 }}>
                      <i className="fa-solid fa-triangle-exclamation" style={{ marginRight: 6 }}></i>
                      {conflicts.length} conflict{conflicts.length > 1 ? "s" : ""} detected
                    </p>
                    <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                      {conflicts.map((c) => (
                        <li
                          key={`${c.kind}-${c.id}`}
                          style={{
                            padding: "8px 10px",
                            background: "#fef2f2",
                            border: "1px solid #fecaca",
                            borderRadius: 8,
                          }}
                        >
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 5,
                              fontSize: 10.5,
                              fontWeight: 800,
                              letterSpacing: ".03em",
                              textTransform: "uppercase",
                              color: "#b91c1c",
                            }}
                          >
                            <i
                              className={
                                c.kind === "event" ? "fa-solid fa-calendar-star"
                                : c.kind === "reassignment" ? "fa-solid fa-right-left"
                                : c.kind === "reservation" ? "fa-solid fa-book-bookmark"
                                : "fa-solid fa-chalkboard-user"
                              }
                            ></i>
                            {c.label}
                          </span>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#16181d", marginTop: 3 }}>
                            {c.title}
                          </div>
                          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                            {format12Hour(c.startTime)} – {format12Hour(c.endTime)}
                            {c.faculty ? ` · ${c.faculty}` : ""}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <Toast
        show={toast.show}
        type={toast.type}
        title={toast.title}
        message={toast.message}
        onClose={() => setToast((prev) => ({ ...prev, show: false }))}
      />
    </>
  );
}

export default AdminViewReservation;