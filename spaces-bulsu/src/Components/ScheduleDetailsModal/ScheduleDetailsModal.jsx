import { useState } from "react";
import "./schedule-details-modal.css";

// ─── Helper (copy from parent) ──────────────────────────────────────
function fmt12Hour(time) {
  if (!time) return "";
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hh = h % 12 || 12;
  return `${String(hh).padStart(2, "0")}:${String(m).padStart(2, "0")} ${suffix}`;
}

function getStatusLabel(status) {
  const map = {
    COMPLETED: { label: "Completed", className: "completed" },
    ONGOING:   { label: "Ongoing",   className: "ongoing" },
    UPCOMING:  { label: "Upcoming",  className: "upcoming" },
    SCHEDULED: { label: "Scheduled", className: "scheduled" },
  };
  return map[status] || { label: "Scheduled", className: "scheduled" };
}

function ScheduleDetailsModal({ target, onClose }) {
  const [imgError, setImgError] = useState(false);

  if (!target) return null;

  const statusInfo = target.status
    ? getStatusLabel(target.status)
    : { label: "Scheduled", className: "scheduled" };

  const isEvent = target.kind === "event";
  const hasImage = target.image && !imgError;

  return (
    <div className="sdm-overlay" onClick={onClose}>
      <div className="sdm-panel" onClick={(e) => e.stopPropagation()}>

        <div className="sdm-header">
          <h2>Schedule Details</h2>
          <button className="sdm-close" onClick={onClose} aria-label="Close">
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div className="sdm-card">
          <div className="sdm-image-wrap">
            {hasImage ? (
              <img
                src={target.image}
                alt={target.roomName}
                onError={() => setImgError(true)}
              />
            ) : (
              <div className="sdm-image-fallback">
                <span>{target.roomName || "Room"}</span>
              </div>
            )}

            <div className="sdm-image-overlay">
              <h3>{target.roomName || "-"}</h3>
              <p>
                {target.title || target.subject || "-"}
                {target.section ? ` • ${target.section}` : ""}
              </p>
            </div>
          </div>

          {/* ─── Type ────────────────────────────────────────────── */}
          <div className="sdm-detail-row">
            <i className="fa-solid fa-tag"></i>
            <div>
              <span className="sdm-detail-label">TYPE</span>
              <strong className="sdm-detail-value">
                {target.kind === "schedule"
                  ? "Academic Class"
                  : target.kind === "reservation"
                  ? "Reservation"
                  : target.kind === "event"
                  ? "Room Activity"
                  : "Reassigned"}
              </strong>
            </div>
          </div>

          {/* ─── Faculty ──────────────────────────────────────────── */}
          <div className="sdm-detail-row">
            <i className="fa-solid fa-user"></i>
            <div>
              <span className="sdm-detail-label">
                {isEvent ? "ISSUED BY" : "FACULTY"}
              </span>
              <strong className="sdm-detail-value">
                {target.faculty || "-"}
              </strong>
            </div>
          </div>

          {/* ─── Room ─────────────────────────────────────────────── */}
          <div className="sdm-detail-row">
            <i className="fa-solid fa-door-open"></i>
            <div>
              <span className="sdm-detail-label">ROOM</span>
              <strong className="sdm-detail-value">{target.roomName || "-"}</strong>
            </div>
          </div>

          {/* ─── Subject / Section ────────────────────────────────── */}
          <div className="sdm-detail-row">
            <i className="fa-solid fa-bookmark"></i>
            <div>
              <span className="sdm-detail-label">
                {isEvent ? "ACTIVITY TITLE" : "SUBJECT / SECTION"}
              </span>
              <strong className="sdm-detail-value">
                {target.subject || target.title || "-"}
                {target.section && !isEvent ? ` • ${target.section}` : ""}
              </strong>
            </div>
          </div>

          {/* ─── Reason (only for room activities) ───────────────── */}
          {isEvent && (target.reason || target.activityReason) && (
            <div className="sdm-detail-row">
              <i className="fa-solid fa-circle-info"></i>
              <div>
                <span className="sdm-detail-label">REASON</span>
                <strong className="sdm-detail-value">
                  {target.reason || target.activityReason}
                </strong>
              </div>
            </div>
          )}

          {/* ─── Date ──────────────────────────────────────────────── */}
          <div className="sdm-detail-row">
            <i className="fa-regular fa-calendar"></i>
            <div>
              <span className="sdm-detail-label">DATE</span>
              <strong className="sdm-detail-value">{target.date || "-"}</strong>
            </div>
          </div>

          {/* ─── Time ──────────────────────────────────────────────── */}
          <div className="sdm-detail-row">
            <i className="fa-regular fa-clock"></i>
            <div>
              <span className="sdm-detail-label">SCHEDULED</span>
              <strong className="sdm-detail-value">
                {target.rawStartTime
                  ? `${fmt12Hour(target.rawStartTime)} — ${fmt12Hour(target.rawEndTime)}`
                  : "-"}
              </strong>
            </div>
          </div>

          {/* ─── Status ─────────────────────────────────────────────── */}
          <div className="sdm-detail-row">
            <i className="fa-solid fa-circle-info"></i>
            <div>
              <span className="sdm-detail-label">STATUS</span>
              <strong className={`sdm-detail-value sdm-status-${statusInfo.className}`}>
                {statusInfo.label}
              </strong>
            </div>
          </div>

          {/* ─── Original Room (only for reassignments) ────────────── */}
          {target.kind === "reassignment" && target.originalRoom && (
            <div className="sdm-detail-row">
              <i className="fa-solid fa-arrows-rotate"></i>
              <div>
                <span className="sdm-detail-label">ORIGINAL ROOM</span>
                <strong className="sdm-detail-value">{target.originalRoom}</strong>
              </div>
            </div>
          )}

          {/* ─── Affected Class (only for room activities that conflict) ─── */}
          {isEvent && target.conflictingSchedule && (
            <div className="sdm-detail-row">
              <i className="fa-solid fa-triangle-exclamation" style={{ color: "#dc2626" }}></i>
              <div>
                <span className="sdm-detail-label">AFFECTED CLASS</span>
                <strong className="sdm-detail-value" style={{ color: "#dc2626" }}>
                  {target.conflictingSchedule.subject || target.conflictingSchedule.title || "-"}
                  {target.conflictingSchedule.section ? ` • ${target.conflictingSchedule.section}` : ""}
                </strong>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ScheduleDetailsModal;