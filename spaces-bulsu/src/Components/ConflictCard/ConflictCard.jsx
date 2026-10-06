import { useState } from "react";
import "./conflict-card.css";

// ─── Status metadata ──────────────────────────────────────────────
const STATUS_META = {
  active:     { label: "Active Conflict", className: "status-active",     icon: "fa-triangle-exclamation" },
  unresolved: { label: "Unresolved",      className: "status-unresolved", icon: "fa-clock-rotate-left" },
  resolved:   { label: "Resolved",        className: "status-resolved",   icon: "fa-circle-check" },
  returned:   { label: "Returned by Admin", className: "status-returned", icon: "fa-rotate-left" },
};

const toMinutes = (time) => {
  if (!time) return null;
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
};

const formatDuration = (startTime, endTime) => {
  const s = toMinutes(startTime), e = toMinutes(endTime);
  if (s == null || e == null || e <= s) return "";
  const mins = e - s;
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
};

const formatDate = (dateStr) => {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
};

function ConflictCard({
  conflict,
  showReassign = true,
  onReassignClick,
  returnedInfo = null,
}) {
  // ─── Collapse state (default: collapsed) ─────────────────────
  const [expanded, setExpanded] = useState(false);

  const formatTime = (time) => {
    if (!time) return "";
    const [hour, minute] = time.split(":");
    return new Date(0, 0, 0, hour, minute).toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", hour12: true,
    });
  };

  const isReturned = !!returnedInfo;

  const statusKey = isReturned
    ? "returned"
    : conflict.status === "resolved"
      ? "resolved"
      : conflict.status === "unresolved"
        ? "unresolved"
        : "active";

  const meta = STATUS_META[statusKey];
  const overlapDuration = formatDuration(conflict.conflictStartTime, conflict.conflictEndTime);
  const dateLabel = formatDate(conflict.date);

  const isResolved = conflict.status === "resolved";
  const isApproved = conflict.resolution === "approved";

  const toggleExpand = () => setExpanded((v) => !v);

  return (
    <div className={`conflict-card ${meta.className} ${expanded ? "is-expanded" : "is-collapsed"}`}>
      {/* ═══════════════════════════════════════════════════════════
          HEADER — always visible, clickable to toggle
          ═══════════════════════════════════════════════════════════ */}
      <button
        type="button"
        className="conflict-card-header-btn"
        onClick={toggleExpand}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse conflict details" : "Expand conflict details"}
      >
        <div className="conflict-card-header">
          <div className="conflict-card-icon">
            <i className={`fa-solid ${meta.icon}`}></i>
          </div>
          <div className="conflict-card-info">
            <span className="conflict-card-title">
              {conflict.roomName} — Schedule Conflict
            </span>
            <span className="conflict-card-subtitle">
              {conflict.floor ? `Floor ${conflict.floor}` : ""}
              {conflict.floor && dateLabel ? " • " : ""}
              {dateLabel}
            </span>
          </div>
        </div>

        <div className="conflict-card-header-actions">
          <span className="conflict-status-badge">
            <span className="conflict-status-dot" aria-hidden="true"></span>
            {meta.label}
          </span>
          <span className="conflict-card-chevron">
            <i className={`fa-solid fa-chevron-${expanded ? "up" : "down"}`}></i>
          </span>
        </div>
      </button>

      {/* ═══════════════════════════════════════════════════════════
          COLLAPSED SUMMARY — minimal info visible always
          ═══════════════════════════════════════════════════════════ */}
      {!expanded && (
        <div className="conflict-card-summary">
          <div className="conflict-summary-pair">
            <div className="conflict-summary-item">
              <span className="conflict-summary-label">
                <i className="fa-solid fa-chalkboard-user"></i> Class
              </span>
              <span className="conflict-summary-value">
                {conflict.courseTitle || "Untitled Course"}
              </span>
            </div>
            <span className="conflict-summary-vs">&</span>
            <div className="conflict-summary-item is-activity">
              <span className="conflict-summary-label">
                <i className="fa-solid fa-calendar-plus"></i> Activity
              </span>
              <span className="conflict-summary-value">
                {conflict.activityTitle || "Untitled Activity"}
              </span>
            </div>
          </div>

          <div className="conflict-summary-meta">
            <span className="conflict-summary-meta-item">
              <i className="fa-regular fa-clock"></i>
              {formatTime(conflict.conflictStartTime)} – {formatTime(conflict.conflictEndTime)}
            </span>
            {overlapDuration && (
              <span className="conflict-summary-meta-item is-overlap">
                <i className="fa-solid fa-circle-exclamation"></i>
                Overlaps {overlapDuration}
              </span>
            )}
          </div>

          {isReturned && (
            <div className="conflict-summary-flag">
              <i className="fa-solid fa-rotate-left"></i>
              Returned by Admin
              {returnedInfo.decidedByName ? ` — ${returnedInfo.decidedByName}` : ""}
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
          EXPANDED CONTENT — full details
          ═══════════════════════════════════════════════════════════ */}
      {expanded && (
        <div className="conflict-card-expanded">
          {/* Detail grid */}
          <div className="conflict-detail-grid">
            <div className="conflict-detail-block">
              <div className="conflict-detail-label">
                <i className="fa-solid fa-chalkboard-user"></i> Original Class
              </div>
              <div className="conflict-detail-main">
                {conflict.courseTitle || "Untitled Course"}
              </div>
              {conflict.section && <div className="conflict-detail-sub">{conflict.section}</div>}
              {conflict.faculty && (
                <div className="conflict-detail-meta">
                  <i className="fa-regular fa-user"></i> {conflict.faculty}
                </div>
              )}
              <div className="conflict-detail-meta">
                <i className="fa-regular fa-clock"></i>
                {conflict.day} • {formatTime(conflict.startTime)} - {formatTime(conflict.endTime)}
              </div>
            </div>

            <div className="conflict-detail-divider" aria-hidden="true">
              <i className="fa-solid fa-arrows-left-right"></i>
            </div>

            <div className="conflict-detail-block is-activity">
              <div className="conflict-detail-label">
                <i className="fa-solid fa-calendar-plus"></i> Conflicting Activity
              </div>
              <div className="conflict-detail-main">
                {conflict.activityTitle || "Untitled Activity"}
              </div>
              {conflict.activityReason && (
                <div className="conflict-detail-sub">{conflict.activityReason}</div>
              )}
              <div className="conflict-detail-meta">
                <i className="fa-regular fa-clock"></i>
                {formatTime(conflict.conflictStartTime)} - {formatTime(conflict.conflictEndTime)}
              </div>
            </div>
          </div>

          {/* Overlap chip */}
          {overlapDuration && (
            <div className="conflict-overlap-chip">
              <i className="fa-solid fa-circle-exclamation"></i> Overlaps for {overlapDuration}
            </div>
          )}

          {/* Admin returned note */}
          {isReturned && (
            <div className="conflict-returned-note">
              <i className="fa-solid fa-rotate-left"></i>
              <div className="conflict-returned-note-body">
                <strong>
                  Returned by Admin
                  {returnedInfo.decidedByName ? ` — ${returnedInfo.decidedByName}` : ""}
                </strong>
                {returnedInfo.adminNote && (
                  <span className="conflict-returned-reason">
                    Reason: {returnedInfo.adminNote}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Resolution box */}
          {isResolved && conflict.resolutionReason && (
            <div className="conflict-resolution-box">
              <span className={`resolution-badge ${isApproved ? "approved" : "denied"}`}>
                {isApproved ? "✅ Accepted" : "❌ Denied"}
              </span>
              <div className="resolution-reason">
                <span className="resolution-label">Reason:</span> {conflict.resolutionReason}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
          FOOTER — always visible (action buttons)
          ═══════════════════════════════════════════════════════════ */}
      {conflict.status === "active" ? (
        conflict.reassignPending ? (
          <div className="reassign-pending-badge">
            <i className="fa-solid fa-hourglass-half"></i> Reassignment Pending
          </div>
        ) : showReassign ? (
          <button
            className={`reassign-btn ${isReturned ? "is-returned" : ""}`}
            onClick={onReassignClick}
          >
            <i className={`fa-solid ${isReturned ? "fa-rotate-left" : "fa-right-left"}`}></i>
            {isReturned ? "Reassign Again" : "Reassign Room"}
          </button>
        ) : null
      ) : (
        <div className={`conflict-footer-note ${meta.className}`}>
          <i className={`fa-solid ${meta.icon}`}></i>
          {conflict.status === "resolved"
            ? "This conflict has been resolved."
            : "This conflict was left unresolved."}
        </div>
      )}
    </div>
  );
}

export default ConflictCard;