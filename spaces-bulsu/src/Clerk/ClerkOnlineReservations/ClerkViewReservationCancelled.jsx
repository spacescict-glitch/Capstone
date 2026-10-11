import { useNavigate, useLocation } from "react-router-dom";
import "./clerk-view-reservation-cancelled.css"; // you can reuse the approved CSS

function ClerkViewReservationCancelled() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const reservation = state?.reservation;

  if (!reservation) {
    return (
      <div className="clerk-cancelled-reservation-room">
        <h2>Reservation not found.</h2>
        <button onClick={() => navigate("/clerk/online-reservations")}>Back</button>
      </div>
    );
  }

  // ─── Duration helper ──────────────────────────────────────────────
  const getDuration = (start, end) => {
    if (!start || !end) return "N/A";
    const [startHour, startMin] = start.split(":").map(Number);
    const [endHour, endMin] = end.split(":").map(Number);
    const diffMs = new Date().setHours(endHour, endMin, 0) - new Date().setHours(startHour, startMin, 0);
    if (diffMs <= 0) return "N/A";
    const totalMinutes = Math.floor(diffMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours && minutes) return `${hours} hr ${minutes} min`;
    if (hours) return `${hours} hr`;
    return `${minutes} min`;
  };

  const duration = getDuration(reservation.startTime, reservation.endTime);

  const createdDate =
    reservation.createdAt?.seconds
      ? new Date(reservation.createdAt.seconds * 1000)
      : new Date(reservation.createdAt);

  const equipmentList = reservation.requiredEquipment
    ?.map((eq) => {
      const labels = {
        projector: "Projector",
        tvDisplay: "TV Display",
        ac: "AC",
        computer: "Computer",
        smartBoard: "Smart Board",
      };
      return labels[eq] || eq;
    })
    .join(", ") || "None";

  return (
    <div className="clerk-cancelled-reservation-room">

      <div className="clerk-white-box-cancelled">
        <h2 className="clerk-cancelled-title">Cancelled Reservation Details</h2>

        <div className="clerk-cancelled-info-grid">
          {/* ─── Faculty / Requester ────────────────────────────── */}
          <div className="clerk-cancelled-info-box">
            <h3 className="clerk-cancelled-info-box-title">
              <i className="fa-solid fa-user"></i> Requester
            </h3>
            <div className="clerk-cancelled-info-box-content">
              <p>
                <strong>Name:</strong> {reservation.facultyName || reservation.requesterName || "Unknown"}
              </p>
              {reservation.audienceType === "Organization" && (
                <p>
                  <strong>Organization:</strong> {reservation.attendees?.organization || "N/A"}
                </p>
              )}
            </div>
          </div>

          {/* ─── Course & Purpose ────────────────────────────────── */}
          <div className="clerk-cancelled-info-box">
            <h3 className="clerk-cancelled-info-box-title">
              <i className="fa-solid fa-book"></i> Course & Purpose
            </h3>
            <div className="clerk-cancelled-info-box-content">
              <p>
                <strong>Course Title:</strong> {reservation.courseTitle || "N/A"}
              </p>
              <p>
                <strong>Purpose:</strong> {reservation.purpose || "N/A"}
              </p>
              {reservation.purpose === "Other Activity" && reservation.attendees?.customPurpose && (
                <p>
                  <strong>Specified Activity:</strong> {reservation.attendees.customPurpose}
                </p>
              )}
            </div>
          </div>

          {/* ─── Room & Schedule ─────────────────────────────────── */}
          <div className="clerk-cancelled-info-box">
            <h3 className="clerk-cancelled-info-box-title">
              <i className="fa-solid fa-calendar-days"></i> Room & Schedule
            </h3>
            <div className="clerk-cancelled-info-box-content">
              <p>
                <strong>Room:</strong> {reservation.roomName || "N/A"}
              </p>
              <p>
                <strong>Date:</strong> {reservation.date || "N/A"}
              </p>
              <p>
                <strong>Time:</strong> {reservation.startTime || "N/A"} – {reservation.endTime || "N/A"}
              </p>
              <p>
                <strong>Duration:</strong> {duration}
              </p>
            </div>
          </div>

          {/* ─── Audience ─────────────────────────────────────────── */}
          <div className="clerk-cancelled-info-box">
            <h3 className="clerk-cancelled-info-box-title">
              <i className="fa-solid fa-users"></i> Audience
            </h3>
            <div className="clerk-cancelled-info-box-content">
              <p>
                <strong>Type:</strong> {reservation.audienceType || "N/A"}
              </p>

              {reservation.audienceType === "Class" && (
                <>
                  <p>
                    <strong>Course:</strong> {reservation.attendees?.course || "N/A"}
                  </p>
                  <p>
                    <strong>Year/Section/Group:</strong> {reservation.attendees?.yearSectionGroup || "N/A"}
                  </p>
                </>
              )}

              {reservation.audienceType === "Organization" && (
                <p>
                  <strong>Organization Name:</strong> {reservation.attendees?.organization || "N/A"}
                </p>
              )}

              {reservation.audienceType === "Faculty" && (
                <p>
                  <strong>Attendees:</strong> Faculty Members
                </p>
              )}

              {reservation.audienceType === "Others" && (
                <p>
                  <strong>Attendees:</strong> {reservation.attendees?.otherAudience || "N/A"}
                </p>
              )}
            </div>
          </div>

          {/* ─── Equipment & Capacity ────────────────────────────── */}
          <div className="clerk-cancelled-info-box">
            <h3 className="clerk-cancelled-info-box-title">
              <i className="fa-solid fa-toolbox"></i> Equipment & Capacity
            </h3>
            <div className="clerk-cancelled-info-box-content">
              <p>
                <strong>Required Equipment:</strong> {equipmentList}
              </p>
              {reservation.studentRange && (
                <p>
                  <strong>Estimated Attendees:</strong> {reservation.studentRange}
                </p>
              )}
            </div>
          </div>

          {/* ─── Metadata ──────────────────────────────────────────── */}
          <div className="clerk-cancelled-info-box">
            <h3 className="clerk-cancelled-info-box-title">
              <i className="fa-solid fa-circle-info"></i> Metadata
            </h3>
            <div className="clerk-cancelled-info-box-content">
              <p>
                <strong>Status:</strong>{" "}
                <span className="clerk-cancelled-status-badge cancelled">Cancelled</span>
              </p>
              <p>
                <strong>Requested On:</strong> {createdDate.toLocaleDateString()} | {createdDate.toLocaleTimeString()}
              </p>
              {reservation.roomCapacity && (
                <p>
                  <strong>Room Capacity:</strong> {reservation.roomCapacity}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="clerk-cancelled-footer">
        <button
          className="clerk-cancelled-back-btn"
          onClick={() => navigate("/clerk/online-reservations")}
        >
          Back
        </button>
        {/* No Edit button for cancelled reservations */}
      </div>
    </div>
  );
}

export default ClerkViewReservationCancelled;