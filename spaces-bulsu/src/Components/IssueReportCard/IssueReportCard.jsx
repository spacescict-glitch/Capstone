import { useState, useEffect, useMemo } from "react";
import "./issue-report-card.css";

const STATUS_META = {
  Pending:       { label: "Pending",      cls: "pending",      icon: "fa-clock" },
  Acknowledged:  { label: "Acknowledged", cls: "acknowledged", icon: "fa-eye" },
  "In Progress": { label: "In Progress",  cls: "progress",     icon: "fa-tools" },
  Resolved:      { label: "Resolved",     cls: "resolved",     icon: "fa-circle-check" },
};

const normalizeStatus = (raw) => {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return "pending";
  if (v === "pending") return "pending";
  if (v === "acknowledged" || v === "ack") return "acknowledged";
  if (v === "in progress" || v === "in-progress" || v === "inprogress" || v === "progress")
    return "progress";
  if (v === "resolved") return "resolved";
  return "pending";
};

const STATUS_KEY_TO_META = {
  pending:      STATUS_META.Pending,
  acknowledged: STATUS_META.Acknowledged,
  progress:     STATUS_META["In Progress"],
  resolved:     STATUS_META.Resolved,
};

const STATUS_STEP_INDEX = { pending: 0, acknowledged: 1, progress: 2, resolved: 3 };
const STEPS = ["Reported", "Acknowledged", "In progress", "Resolved"];

const CATEGORY_ICON = {
  "Electrical":         "fa-bolt",
  "Plumbing / Leak":    "fa-droplet",
  "Network / Internet": "fa-wifi",
  "Equipment":          "fa-video",
  "Air Conditioning":   "fa-snowflake",
  "Furniture":          "fa-chair",
  "Cleanliness":        "fa-broom",
  "Security":           "fa-shield-halved",
  "Other":              "fa-circle-question",
};

const SEVERITY_COLOR = {
  Low: "#16a34a", Medium: "#eab308", High: "#f97316", Urgent: "#dc2626",
};

const MAX_VISIBLE_PHOTOS = 4;

const formatTime = (ts) => {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
};

export default function IssueReportCard({
  issue,
  role = "faculty",
  onAcknowledge,
  onMarkMaintenance,
  onMarkResolved,
  roomIsUnderMaintenance = false,
  busy = false,
  acknowledging = false,
}) {
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const [showDetails, setShowDetails] = useState(false);

  const statusKey = normalizeStatus(issue.status);
  const status = STATUS_KEY_TO_META[statusKey];
  const stepIndex = STATUS_STEP_INDEX[statusKey];

  const isPending      = statusKey === "pending";
  const isAcknowledged = statusKey === "acknowledged";
  const isInProgress   = statusKey === "progress";
  const isResolved     = statusKey === "resolved";

  const isClerk   = role === "clerk";
  const isAdmin   = role === "admin";
  const isFaculty = role === "faculty";

  const canAcknowledge = isAdmin && isPending;
  const clerkCanAct    = isClerk && (isAcknowledged || isInProgress) && !isResolved;

  const canMarkMaintenance = clerkCanAct && !roomIsUnderMaintenance;
  const canResolve         = clerkCanAct;

  const photos = Array.isArray(issue.photoUrls) && issue.photoUrls.length > 0
    ? issue.photoUrls
    : (issue.photoUrl ? [issue.photoUrl] : []);

  const visiblePhotos = photos.slice(0, MAX_VISIBLE_PHOTOS);
  const extraCount = Math.max(0, photos.length - MAX_VISIBLE_PHOTOS);
  const photoCount = photos.length;
  const hasPhotos = photoCount > 0;

  const sevColor = SEVERITY_COLOR[issue.severity] || "#9ca3af";

  const openLightbox = (index) => setLightboxIndex(index);
  const closeLightbox = () => setLightboxIndex(null);
  const nextPhoto = () => setLightboxIndex(i => (i + 1) % photos.length);
  const prevPhoto = () => setLightboxIndex(i => (i - 1 + photos.length) % photos.length);

  useEffect(() => {
    if (lightboxIndex === null) return;
    const onKey = (e) => {
      if (e.key === "Escape") closeLightbox();
      if (e.key === "ArrowRight") nextPhoto();
      if (e.key === "ArrowLeft") prevPhoto();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightboxIndex, photos.length]);

  useEffect(() => {
    if (!showDetails) return;
    const onKey = (e) => { if (e.key === "Escape") setShowDetails(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showDetails]);

  // ── Activity timeline (built once, used by card + modal) ───
  const events = useMemo(() => {
    const list = [
      {
        key: "created",
        icon: "fa-flag",
        color: "#6b7280",
        label: "Reported",
        who: issue.reporterName || "Anonymous",
        time: issue.createdAt,
      },
    ];
    if (issue.acknowledgedBy) {
      list.push({
        key: "ack", icon: "fa-eye", color: "#2563eb",
        label: "Acknowledged", who: issue.acknowledgedBy, time: issue.acknowledgedAt,
      });
    }
    if (issue.inProgressBy) {
      list.push({
        key: "prog", icon: "fa-tools", color: "#f97316",
        label: "Set under maintenance", who: issue.inProgressBy, time: issue.inProgressAt,
      });
    }
    if (issue.resolvedBy) {
      list.push({
        key: "res", icon: "fa-circle-check", color: "#16a34a",
        label: "Resolved", who: issue.resolvedBy, time: issue.resolvedAt,
      });
    }
    return list;
  }, [issue]);

  const description = issue.description || "";
  const hasNotes = !!issue.clerkNotes;

  return (
    <>
      <div className={`irc ${status.cls}`}>
        {/* ── HEADER: icon · room + severity · status ───────── */}
        <div className="irc-top">
          <div className="irc-icon-wrap">
            <i className={`fa-solid ${CATEGORY_ICON[issue.category] || "fa-circle-question"}`} />
          </div>

          <div className="irc-headline">
            <div className="irc-title-row">
              <h4 className="irc-room" title={issue.roomName}>{issue.roomName}</h4>
              <span className="irc-sev" style={{ "--sev": sevColor }}>
                <span className="irc-sev-dot" />
                {issue.severity || "Low"}
              </span>
            </div>
            <div className="irc-category">
              {issue.category}
              {issue.floor && <span className="irc-category-floor"> · {issue.floor}</span>}
              {roomIsUnderMaintenance && !isResolved && (
                <span className="irc-category-maint"> · Under maintenance</span>
              )}
            </div>
          </div>

          <span className={`irc-status ${status.cls}`}>
            <i className={`fa-solid ${status.icon}`} /> {status.label}
          </span>
        </div>

        {/* ── PHOTO ROW (fixed height, always rendered) ─────── */}
        {hasPhotos ? (
          <div className="irc-photos">
            {visiblePhotos.map((url, i) => {
              const isLast = i === visiblePhotos.length - 1;
              return (
                <button
                  type="button"
                  key={i}
                  className="irc-photo-cell"
                  onClick={() => openLightbox(i)}
                  aria-label={`View photo ${i + 1}`}
                >
                  <img src={url} alt={`Issue ${i + 1}`} loading="lazy" />
                  {isLast && extraCount > 0 && (
                    <span className="irc-photo-more">+{extraCount}</span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="irc-photos irc-photos--empty">
            <i className="fa-regular fa-image" /> No photo attached
          </div>
        )}

        {/* ── DESCRIPTION (always 2 lines tall) ─────────────── */}
        <p className="irc-description">{description || "—"}</p>

        {/* ── FOOTER ROW: who/when · details (always present) ── */}
        <div className="irc-foot">
          <span className="irc-meta" title={`${issue.reporterName || "Anonymous"} · ${formatTime(issue.createdAt)}`}>
            {issue.reporterName || "Anonymous"}
            {issue.createdAt ? ` · ${formatTime(issue.createdAt)}` : ""}
          </span>
          <button
            type="button"
            className="irc-view-details"
            onClick={() => setShowDetails(true)}
          >
            Details
            {(hasNotes || photoCount > 0) && (
              <span className="irc-view-details-icons">
                {photoCount > 0 && <i className="fa-regular fa-image" title={`${photoCount} photo(s)`} />}
                {hasNotes && <i className="fa-regular fa-note-sticky" title="Has clerk notes" />}
              </span>
            )}
            <i className="fa-solid fa-chevron-right irc-view-details-arrow" />
          </button>
        </div>

        {/* ── ACTION SLOT (fixed height) ────────────────────── */}
        <div className="irc-actions">
          {isFaculty && (
            <span className="irc-hint">
              {isResolved
                ? "Issue resolved — thank you for reporting."
                : isPending
                ? "Waiting for the Admin to acknowledge your report."
                : isAcknowledged
                ? "Acknowledged and forwarded to the Clerk."
                : "The Clerk is currently handling your report."}
            </span>
          )}

          {isAdmin && (
            canAcknowledge ? (
              <button
                className="irc-btn primary"
                onClick={() => onAcknowledge?.(issue)}
                disabled={busy || acknowledging}
              >
                {acknowledging ? (
                  <><span className="irc-btn-spinner" /> Acknowledging…</>
                ) : (
                  <><i className="fa-solid fa-eye" /> Acknowledge issue</>
                )}
              </button>
            ) : (
              <span className="irc-hint">
                {isResolved
                  ? "This issue has been resolved."
                  : isInProgress
                  ? "The Clerk is currently addressing this issue."
                  : "Acknowledged — forwarded to the Clerk."}
              </span>
            )
          )}

          {isClerk && (
            clerkCanAct ? (
              <>
                {canMarkMaintenance && (
                  <button
                    className="irc-btn danger"
                    onClick={() => onMarkMaintenance?.(issue)}
                    disabled={busy}
                  >
                    <i className="fa-solid fa-wrench" /> Maintenance
                  </button>
                )}
                {canResolve && (
                  <button
                    className="irc-btn success"
                    onClick={() => onMarkResolved?.(issue)}
                    disabled={busy}
                    title={
                      roomIsUnderMaintenance
                        ? "Resolving will also restore this room to Available"
                        : "Mark this issue as resolved"
                    }
                  >
                    <i className="fa-solid fa-circle-check" /> Resolve
                  </button>
                )}
              </>
            ) : (
              <span className="irc-hint">
                {isResolved
                  ? "This issue has been resolved."
                  : "Waiting for the Admin to acknowledge this issue first."}
              </span>
            )
          )}
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════
          FULL DETAILS MODAL
         ═══════════════════════════════════════════════════════ */}
      {showDetails && (
        <div
          className="irc-details-overlay"
          onClick={() => setShowDetails(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className={`irc-details-modal ${status.cls}`}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="irc-details-close"
              onClick={() => setShowDetails(false)}
              aria-label="Close details"
            >
              <i className="fa-solid fa-xmark" />
            </button>

            {/* Header: icon · room + severity · status (top right) */}
            <div className="irc-details-header">
              <div className={`irc-details-icon ${status.cls}`}>
                <i className={`fa-solid ${CATEGORY_ICON[issue.category] || "fa-circle-question"}`} />
              </div>

              <div className="irc-details-header-text">
                <div className="irc-details-title-row">
                  <h3>{issue.roomName || "Room"}</h3>
                  <span className="irc-sev" style={{ "--sev": sevColor }}>
                    <span className="irc-sev-dot" />
                    {issue.severity || "Low"}
                  </span>
                </div>
                <p>
                  {issue.category}
                  {issue.floor ? ` · ${issue.floor}` : ""}
                </p>
              </div>

              <span className={`irc-status ${status.cls} irc-details-status`}>
                <i className={`fa-solid ${status.icon}`} /> {status.label}
              </span>
            </div>

            <div className="irc-details-body">
              {/* Progress */}
              <div className="irc-track" aria-label={`Progress: ${status.label}`}>
                {STEPS.map((label, i) => (
                  <div
                    key={label}
                    className={`irc-track-step ${i < stepIndex ? "done" : ""} ${i === stepIndex ? "current" : ""}`}
                  >
                    <span className="irc-track-dot">
                      {i < stepIndex && <i className="fa-solid fa-check" />}
                    </span>
                    <span className="irc-track-label">{label}</span>
                  </div>
                ))}
              </div>

              {/* Overview */}
              <div className="irc-details-section">
                <span className="irc-details-label">Overview</span>
                <dl className="irc-overview">
                  <div><dt>Room</dt><dd>{issue.roomName || "—"}</dd></div>
                  <div><dt>Floor</dt><dd>{issue.floor || "—"}</dd></div>
                  <div><dt>Category</dt><dd>{issue.category || "—"}</dd></div>
                  <div>
                    <dt>Severity</dt>
                    <dd>
                      <span className="irc-sev" style={{ "--sev": sevColor }}>
                        <span className="irc-sev-dot" />
                        {issue.severity || "Low"}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>Reported by</dt>
                    <dd>
                      {issue.reporterName || "Anonymous"}
                      {issue.reporterRole && (
                        <span className="irc-overview-sub"> · {issue.reporterRole}</span>
                      )}
                    </dd>
                  </div>
                  <div><dt>Reported on</dt><dd>{formatTime(issue.createdAt) || "—"}</dd></div>
                  <div>
                    <dt>Room status</dt>
                    <dd className={roomIsUnderMaintenance && !isResolved ? "irc-overview-warn" : ""}>
                      {roomIsUnderMaintenance && !isResolved ? "Under maintenance" : "Available"}
                    </dd>
                  </div>
                  <div><dt>Photos</dt><dd>{photoCount > 0 ? photoCount : "None"}</dd></div>
                </dl>
              </div>

              {/* Description */}
              <div className="irc-details-section">
                <span className="irc-details-label">Description</span>
                <p className="irc-details-text">{description || "—"}</p>
              </div>

              {/* Photos */}
              {hasPhotos && (
                <div className="irc-details-section">
                  <span className="irc-details-label">Photos ({photoCount})</span>
                  <div className="irc-details-photos">
                    {photos.map((url, i) => (
                      <button
                        type="button"
                        key={i}
                        className="irc-details-photo"
                        onClick={() => openLightbox(i)}
                        aria-label={`View photo ${i + 1}`}
                      >
                        <img src={url} alt={`Issue ${i + 1}`} loading="lazy" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Activity timeline */}
              <div className="irc-details-section">
                <span className="irc-details-label">Activity</span>
                <ol className="irc-timeline">
                  {events.map((ev, i) => (
                    <li
                      key={ev.key}
                      className={`irc-timeline-item ${i === events.length - 1 ? "last" : ""}`}
                      style={{ "--ev": ev.color }}
                    >
                      <span className="irc-timeline-dot">
                        <i className={`fa-solid ${ev.icon}`} />
                      </span>
                      <div className="irc-timeline-body">
                        <span className="irc-timeline-title">
                          {ev.label} <span className="irc-timeline-by">by {ev.who}</span>
                        </span>
                        {ev.time && (
                          <span className="irc-timeline-time">{formatTime(ev.time)}</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>

              {/* Clerk Notes */}
              {issue.clerkNotes && (
                <div className="irc-details-section">
                  <span className="irc-details-label">Clerk notes</span>
                  <div className="irc-details-notes">
                    <i className="fa-solid fa-note-sticky" />
                    <span>{issue.clerkNotes}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── LIGHTBOX ─────────────────────────────────────── */}
      {lightboxIndex !== null && photos.length > 0 && (
        <div className="irc-lightbox" onClick={closeLightbox}>
          <button
            className="irc-lightbox-close"
            onClick={closeLightbox}
            aria-label="Close"
          >
            <i className="fa-solid fa-xmark" />
          </button>

          {photos.length > 1 && (
            <>
              <button
                className="irc-lightbox-nav prev"
                onClick={(e) => { e.stopPropagation(); prevPhoto(); }}
                aria-label="Previous photo"
              >
                <i className="fa-solid fa-chevron-left" />
              </button>
              <button
                className="irc-lightbox-nav next"
                onClick={(e) => { e.stopPropagation(); nextPhoto(); }}
                aria-label="Next photo"
              >
                <i className="fa-solid fa-chevron-right" />
              </button>
            </>
          )}

          <img
            src={photos[lightboxIndex]}
            alt={`Issue photo ${lightboxIndex + 1}`}
            onClick={(e) => e.stopPropagation()}
          />

          {photos.length > 1 && (
            <div className="irc-lightbox-counter">
              {lightboxIndex + 1} / {photos.length}
            </div>
          )}
        </div>
      )}
    </>
  );
}