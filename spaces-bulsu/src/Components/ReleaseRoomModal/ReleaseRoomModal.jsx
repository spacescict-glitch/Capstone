import "./release-room-modal.css";
import { useState } from "react";

// ─── Helper ──────────────────────────────────────────────────────────
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

function getKindLabel(kind) {
  const map = {
    schedule:     "Academic Class",
    reservation:  "Reservation",
    event:        "Room Activity",
    reassignment: "Reassigned",
  };
  return map[kind] || "Class";
}

// ✅ Dynamic title per kind
function getModalTitle(kind) {
  switch (kind) {
    case "reassignment":
      return "Mark Reassigned Room Available";
    case "reservation":
      return "Mark Reserved Room Available";
    case "schedule":
    default:
      return "Mark Room Available";
  }
}

// ✅ Dynamic subtitle per kind
function getModalSubtitle(kind) {
  switch (kind) {
    case "reassignment":
      return "Confirm that you are marking this reassigned room as available.";
    case "reservation":
      return "Confirm that you are marking this reserved room as available.";
    case "schedule":
    default:
      return "Confirm that you are marking this room as available.";
  }
}

export default function ReleaseRoomModal({ target, onClose, onConfirm, submitting }) {
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");

  if (!target) return null;

  const statusInfo = target.status
    ? getStatusLabel(target.status)
    : { label: "Scheduled", className: "scheduled" };
  const kindLabel = getKindLabel(target.kind);
  const modalTitle = getModalTitle(target.kind);
  const modalSubtitle = getModalSubtitle(target.kind);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!reason.trim()) return;
    onConfirm({ reason: reason.trim(), details: details.trim() });
  };

  return (
    <div className="rr-overlay" onClick={onClose}>
      <div className="rr-panel" onClick={(e) => e.stopPropagation()}>
        <div className="rr-header">
          <div>
            <h2>{modalTitle}</h2>
            <p className="rr-header-sub">{modalSubtitle}</p>
          </div>
          <button className="rr-close" onClick={onClose} aria-label="Close">
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div className="rr-card">
          <div className="rr-image-wrap">
            <img
              src={
                target.image ||
                "https://images.unsplash.com/photo-1509062522246-3755977927d7?q=80&w=1200&auto=format&fit=crop"
              }
              alt={target.roomName}
            />
            <div className="rr-image-overlay">
              <h3>{target.roomName || "-"}</h3>
              <p>
                {target.title || target.subject || "-"}
                {target.section ? ` • ${target.section}` : ""}
              </p>
            </div>
          </div>

          <div className="rr-detail-row">
            <i className="fa-solid fa-tag"></i>
            <div>
              <span className="rr-detail-label">TYPE</span>
              <strong className="rr-detail-value">{kindLabel}</strong>
            </div>
          </div>

          <div className="rr-detail-row">
            <i className="fa-solid fa-user"></i>
            <div>
              <span className="rr-detail-label">FACULTY</span>
              <strong className="rr-detail-value">{target.faculty || "-"}</strong>
            </div>
          </div>

          <div className="rr-detail-row">
            <i className="fa-solid fa-door-open"></i>
            <div>
              <span className="rr-detail-label">ROOM</span>
              <strong className="rr-detail-value">{target.roomName || "-"}</strong>
            </div>
          </div>

          <div className="rr-detail-row">
            <i className="fa-solid fa-bookmark"></i>
            <div>
              <span className="rr-detail-label">SUBJECT / SECTION</span>
              <strong className="rr-detail-value">
                {target.subject || target.title || "-"}
                {target.section ? ` • ${target.section}` : ""}
              </strong>
            </div>
          </div>

          <div className="rr-detail-row">
            <i className="fa-regular fa-calendar"></i>
            <div>
              <span className="rr-detail-label">DATE</span>
              <strong className="rr-detail-value">{target.date || "-"}</strong>
            </div>
          </div>

          <div className="rr-detail-row">
            <i className="fa-regular fa-clock"></i>
            <div>
              <span className="rr-detail-label">SCHEDULED</span>
              <strong className="rr-detail-value">
                {target.rawStartTime
                  ? `${fmt12Hour(target.rawStartTime)} — ${fmt12Hour(target.rawEndTime)}`
                  : "-"}
              </strong>
            </div>
          </div>

          <div className="rr-detail-row">
            <i className="fa-solid fa-circle-info"></i>
            <div>
              <span className="rr-detail-label">STATUS</span>
              <strong className={`rr-detail-value rr-status-${statusInfo.className}`}>
                {statusInfo.label}
              </strong>
            </div>
          </div>

          {target.kind === "reassignment" && target.originalRoom && (
            <div className="rr-detail-row">
              <i className="fa-solid fa-arrows-rotate"></i>
              <div>
                <span className="rr-detail-label">ORIGINAL ROOM</span>
                <strong className="rr-detail-value">{target.originalRoom}</strong>
              </div>
            </div>
          )}

          {target.status === "ONGOING" && (
            <div className="rr-ongoing-note">
              <i className="fa-solid fa-circle-info"></i>
              <span>
                This class is currently <strong>ongoing</strong>. Only the
                remaining time will be released — the elapsed portion will
                still be recorded.
              </span>
            </div>
          )}

          <div className="rr-form-group">
            <label htmlFor="reason">
              Reason <span>*</span>
            </label>
            <select
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
              required
            >
              <option value="">Select a reason</option>
              <option value="Class Cancelled">Class Cancelled</option>
              <option value="Class will be held online">
                Class will be held online
              </option>
              <option value="Faculty Unavailable">Faculty Unavailable</option>
              <option value="Alternative Activity">Alternative Activity</option>
              <option value="Other">Other</option>
            </select>
          </div>

          <div className="rr-form-group">
            <label htmlFor="details">Additional Notes</label>
            <textarea
              id="details"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Add additional details…"
              rows={3}
              disabled={submitting}
            />
          </div>
        </div>

        <button
          className="rr-release-btn"
          onClick={handleSubmit}
          disabled={submitting || !reason}
        >
          {submitting ? (
            <>
              <i className="fa-solid fa-spinner fa-spin"></i> Marking…
            </>
          ) : (
            <>
              <i className="fa-solid fa-door-open"></i> Mark Room Available
            </>
          )}
        </button>
      </div>
    </div>
  );
}