import { useState, useEffect, useRef, useMemo } from "react";
import "./submit-issue-modal.css";
import { auth, db } from "../../firebase";
import { collection, addDoc, getDoc, getDocs, doc, serverTimestamp } from "firebase/firestore";
import Toast from "../../Popup/Toast/Toast";

const CLOUDINARY_CLOUD_NAME    = "dqn1s5ujs";
const CLOUDINARY_UPLOAD_PRESET = "SpaceSCICT";

// ── Upload limits ────────────────────────────────────────────
const MAX_PHOTOS        = 5;
const MAX_FILE_MB       = 5;    // per image
const MAX_TOTAL_MB      = 15;   // all images combined
const MAX_FILE_BYTES    = MAX_FILE_MB  * 1024 * 1024;
const MAX_TOTAL_BYTES   = MAX_TOTAL_MB * 1024 * 1024;

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const CATEGORIES = [
  { value: "Electrical",         icon: "fa-bolt",            label: "Electrical" },
  { value: "Plumbing / Leak",    icon: "fa-droplet",         label: "Plumbing / Leak" },
  { value: "Network / Internet", icon: "fa-wifi",            label: "Network / Internet" },
  { value: "Equipment",          icon: "fa-video",           label: "Equipment" },
  { value: "Air Conditioning",   icon: "fa-snowflake",       label: "Air Conditioning" },
  { value: "Furniture",          icon: "fa-chair",           label: "Furniture" },
  { value: "Cleanliness",        icon: "fa-broom",           label: "Cleanliness" },
  { value: "Security",           icon: "fa-shield-halved",   label: "Security" },
  { value: "Other",              icon: "fa-circle-question", label: "Other" },
];

const SEVERITIES = [
  { value: "Low",    label: "Low",    color: "#16a34a" },
  { value: "Medium", label: "Medium", color: "#eab308" },
  { value: "High",   label: "High",   color: "#f97316" },
  { value: "Urgent", label: "Urgent", color: "#dc2626" },
];

async function uploadToCloudinary(file) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  fd.append("folder", "spaces/room-issues");
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
    { method: "POST", body: fd }
  );
  if (!res.ok) throw new Error("Photo upload failed.");
  const data = await res.json();
  return data.secure_url;
}

export default function SubmitIssueModal({ open, onClose, onSubmitted, presetRoomId = "" }) {
  const [rooms, setRooms]               = useState([]);
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [submitting, setSubmitting]     = useState(false);
  const [uploading, setUploading]       = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ done: 0, total: 0 });

  const [form, setForm] = useState({
    roomId: presetRoomId || "", category: "", severity: "Medium", description: "",
  });
  const [photoFiles, setPhotoFiles]     = useState([]);
  const [previewUrls, setPreviewUrls]   = useState([]);
  const fileInputRef = useRef(null);

  // ── Room picker popover state ────────────────────────────
  const [showRoomPicker, setShowRoomPicker] = useState(false);
  const [roomSearch, setRoomSearch] = useState("");

  // ── Preview modal state ──────────────────────────────────
  const [showPreview, setShowPreview] = useState(false);

  const [toast, setToast] = useState({ show: false, type: "success", title: "", message: "" });
  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    setTimeout(() => setToast(p => ({ ...p, show: false })), 3500);
  };

  useEffect(() => {
    if (!open) return;
    const load = async () => {
      setLoadingRooms(true);
      try {
        const snap = await getDocs(collection(db, "rooms"));
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        list.sort((a, b) => (a.roomName || "").localeCompare(b.roomName || ""));
        setRooms(list);
      } catch (err) { console.error(err); }
      finally { setLoadingRooms(false); }
    };
    load();
  }, [open]);

  useEffect(() => {
    if (!open) {
      setForm({ roomId: presetRoomId || "", category: "", severity: "Medium", description: "" });
      previewUrls.forEach(u => URL.revokeObjectURL(u));
      setPhotoFiles([]);
      setPreviewUrls([]);
      setUploadProgress({ done: 0, total: 0 });
      setShowRoomPicker(false);
      setRoomSearch("");
      setShowPreview(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, presetRoomId]);

  const selectedRoom = useMemo(
    () => rooms.find(r => r.id === form.roomId) || null,
    [rooms, form.roomId]
  );

  const filteredRooms = useMemo(() => {
    const q = roomSearch.trim().toLowerCase();
    if (!q) return rooms;
    return rooms.filter(r => {
      const name = (r.roomName || "").toLowerCase();
      const floor = String(r.floor || "").toLowerCase();
      const building = String(r.building || r.bldg || "").toLowerCase();
      return name.includes(q) || floor.includes(q) || building.includes(q);
    });
  }, [rooms, roomSearch]);

  const selectedCategoryMeta = useMemo(
    () => CATEGORIES.find(c => c.value === form.category) || null,
    [form.category]
  );

  const selectedSeverityMeta = useMemo(
    () => SEVERITIES.find(s => s.value === form.severity) || SEVERITIES[1],
    [form.severity]
  );

  // ── Total size of all attached images ────────────────────
  const totalBytes = useMemo(
    () => photoFiles.reduce((sum, f) => sum + f.size, 0),
    [photoFiles]
  );
  const totalPercent = Math.min(100, (totalBytes / MAX_TOTAL_BYTES) * 100);
  const meterState =
    totalPercent >= 90 ? "danger" : totalPercent >= 70 ? "warn" : "ok";

  const handlePhotosChange = (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;

    const remaining = MAX_PHOTOS - photoFiles.length;
    if (remaining <= 0) {
      showToast("error", "Photo Limit", `You can only upload up to ${MAX_PHOTOS} photos.`);
      return;
    }

    const accepted = [];
    const problems = [];
    let runningTotal = totalBytes;

    for (const file of files) {
      if (accepted.length >= remaining) {
        problems.push(`Only ${MAX_PHOTOS} photos are allowed.`);
        break;
      }
      if (!file.type.startsWith("image/")) {
        problems.push(`${file.name} is not an image.`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        problems.push(`${file.name} is ${formatBytes(file.size)} (max ${MAX_FILE_MB} MB each).`);
        continue;
      }
      if (runningTotal + file.size > MAX_TOTAL_BYTES) {
        problems.push(
          `${file.name} would exceed the ${MAX_TOTAL_MB} MB total limit.`
        );
        continue;
      }
      runningTotal += file.size;
      accepted.push(file);
    }

    if (problems.length > 0) {
      showToast(
        "error",
        accepted.length > 0 ? "Some photos were skipped" : "Photo not added",
        problems.join(" ")
      );
    }

    if (accepted.length === 0) return;

    setPhotoFiles(prev => [...prev, ...accepted]);
    setPreviewUrls(prev => [...prev, ...accepted.map(f => URL.createObjectURL(f))]);
  };

  const removePhotoAt = (index) => {
    setPhotoFiles(prev => prev.filter((_, i) => i !== index));
    setPreviewUrls(prev => {
      const url = prev[index];
      if (url) URL.revokeObjectURL(url);
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleSubmitClick = () => {
    if (!form.roomId) return showToast("error", "Select Room", "Please select the room.");
    if (!form.category) return showToast("error", "Select Category", "Please choose a category.");
    if (!form.description.trim() || form.description.trim().length < 5)
      return showToast("error", "Description Required", "Please describe the issue (min 5 characters).");
    if (totalBytes > MAX_TOTAL_BYTES)
      return showToast("error", "Photos Too Large", `Total photo size must be ${MAX_TOTAL_MB} MB or less.`);

    setShowPreview(true);
  };

  const handleConfirmSubmit = async () => {
    setSubmitting(true);
    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Not authenticated.");

      const userSnap = await getDoc(doc(db, "users", user.uid));
      const ud = userSnap.exists() ? userSnap.data() : {};
      const reporterName = `${ud.firstName || ""} ${ud.lastName || ""}`.trim() || user.email;
      const reporterRole = ud.role || "";

      const photoUrls = [];
      if (photoFiles.length > 0) {
        setUploading(true);
        setUploadProgress({ done: 0, total: photoFiles.length });
        for (let i = 0; i < photoFiles.length; i++) {
          try {
            const url = await uploadToCloudinary(photoFiles[i]);
            photoUrls.push(url);
            setUploadProgress({ done: i + 1, total: photoFiles.length });
          } catch (err) {
            console.error("Upload failed for", photoFiles[i]?.name, err);
          }
        }
        setUploading(false);
      }

      await addDoc(collection(db, "roomIssues"), {
        roomId:         form.roomId,
        roomName:       selectedRoom?.roomName || "",
        floor:          selectedRoom?.floor || "",
        category:       form.category,
        severity:       form.severity,
        description:    form.description.trim(),
        photoUrls,
        photoUrl: photoUrls[0] || "",
        reporterId:     user.uid,
        reporterName,
        reporterRole,
        status:         "Pending",
        clerkNotes:     "",
        acknowledgedBy: "",
        acknowledgedAt: null,
        resolvedBy:     "",
        resolvedAt:     null,
        createdAt:      serverTimestamp(),
      });

      showToast(
        "success",
        "Issue Reported ✓",
        "Your report was sent to the Admin. Please wait for their acknowledgment. Thank you for reporting!"
      );
      onSubmitted?.();
      setShowPreview(false);
      setTimeout(() => onClose?.(), 800);
    } catch (err) {
      console.error(err);
      showToast("error", "Submission Failed", err.message);
      setUploading(false);
    } finally {
      setSubmitting(false);
      setUploadProgress({ done: 0, total: 0 });
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="sim-overlay" onClick={() => !submitting && onClose?.()}>
        <div className="sim-modal" onClick={e => e.stopPropagation()}>
          <div className="sim-header">
            <div className="sim-header-icon"><i className="fa-solid fa-triangle-exclamation" /></div>
            <div className="sim-header-text">
              <h3>Report Room Issue</h3>
              <p>Help us keep CICT classrooms in top condition.</p>
            </div>
            <button className="sim-close" onClick={onClose} disabled={submitting}>
              <i className="fa-solid fa-xmark" />
            </button>
          </div>

          <div className="sim-body">
            {/* ═════════ ROOM PICKER ═════════ */}
            <div className="sim-field">
              <label>Room <span className="sim-required">*</span></label>

              <div className="sim-roompicker">
                <button
                  type="button"
                  className={`sim-room-trigger ${showRoomPicker ? "open" : ""}`}
                  onClick={() => {
                    if (loadingRooms || presetRoomId) return;
                    setRoomSearch("");
                    setShowRoomPicker((v) => !v);
                  }}
                  disabled={loadingRooms || !!presetRoomId}
                >
                  <i className="fa-solid fa-door-open"></i>
                  <span className="sim-room-trigger-text">
                    {loadingRooms
                      ? "Loading rooms..."
                      : selectedRoom
                      ? selectedRoom.roomName
                      : "Select a room"}
                  </span>
                  {selectedRoom?.floor && (
                    <span className="sim-room-trigger-floor">
                      {selectedRoom.floor}
                    </span>
                  )}
                  <i
                    className={`fa-solid fa-chevron-down sim-room-caret ${
                      showRoomPicker ? "open" : ""
                    }`}
                  ></i>
                </button>

                {showRoomPicker && (
                  <>
                    <div
                      className="sim-room-clickaway"
                      onClick={() => setShowRoomPicker(false)}
                    ></div>
                    <div className="sim-room-popover">
                      <span className="sim-room-popover-arrow"></span>

                      <div className="sim-room-search-wrap">
                        <i className="fa-solid fa-magnifying-glass"></i>
                        <input
                          type="text"
                          className="sim-room-search"
                          placeholder="Search room, floor, building..."
                          value={roomSearch}
                          onChange={(e) => setRoomSearch(e.target.value)}
                          autoFocus
                        />
                        {roomSearch && (
                          <button
                            type="button"
                            className="sim-room-search-clear"
                            onClick={() => setRoomSearch("")}
                          >
                            <i className="fa-solid fa-xmark"></i>
                          </button>
                        )}
                      </div>

                      <div className="sim-room-list">
                        {filteredRooms.length === 0 ? (
                          <div className="sim-room-empty">
                            <i className="fa-regular fa-face-frown"></i>
                            <span>No rooms match your search.</span>
                          </div>
                        ) : (
                          filteredRooms.map((r) => {
                            const isActive = r.id === form.roomId;
                            return (
                              <button
                                type="button"
                                key={r.id}
                                className={`sim-room-option ${
                                  isActive ? "is-active" : ""
                                }`}
                                onClick={() => {
                                  setForm((f) => ({ ...f, roomId: r.id }));
                                  setShowRoomPicker(false);
                                  setRoomSearch("");
                                }}
                              >
                                <div className="sim-room-option-icon">
                                  <i className="fa-solid fa-door-open"></i>
                                </div>
                                <div className="sim-room-option-body">
                                  <span className="sim-room-option-name">
                                    {r.roomName}
                                  </span>
                                  <span className="sim-room-option-meta">
                                    {r.floor && (
                                      <>
                                        <i className="fa-solid fa-building"></i>
                                        {r.floor}
                                      </>
                                    )}
                                    {r.capacity && (
                                      <>
                                        <span className="sim-room-dot">•</span>
                                        <i className="fa-solid fa-users"></i>
                                        {r.capacity} Seats
                                      </>
                                    )}
                                  </span>
                                </div>
                                {isActive && (
                                  <i className="fa-solid fa-circle-check sim-room-option-check"></i>
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

            {/* Category grid */}
            <div className="sim-field">
              <label>Issue Category <span className="sim-required">*</span></label>
              <div className="sim-cat-grid">
                {CATEGORIES.map(c => (
                  <button
                    key={c.value}
                    type="button"
                    className={`sim-cat ${form.category === c.value ? "active" : ""}`}
                    onClick={() => setForm(f => ({ ...f, category: c.value }))}
                  >
                    <i className={`fa-solid ${c.icon}`} />
                    <span>{c.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Severity */}
            <div className="sim-field">
              <label>Severity</label>
              <div className="sim-sev-row">
                {SEVERITIES.map(s => (
                  <button
                    key={s.value}
                    type="button"
                    className={`sim-sev ${form.severity === s.value ? "active" : ""}`}
                    style={{ "--sev-color": s.color }}
                    onClick={() => setForm(f => ({ ...f, severity: s.value }))}
                  >
                    <span className="sim-sev-dot" />
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Description */}
            <div className="sim-field">
              <label>Description <span className="sim-required">*</span></label>
              <textarea
                className="sim-textarea"
                rows={4}
                maxLength={500}
                placeholder="Describe the issue briefly — what happened, where exactly, and how severe."
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              />
              <span className="sim-counter">{form.description.length}/500</span>
            </div>

            {/* Photos — limits are visible up front */}
            <div className="sim-field">
              <label>
                Photos <span className="sim-optional">
                  (optional · {photoFiles.length}/{MAX_PHOTOS})
                </span>
              </label>

              <p className="sim-photo-rules">
                <i className="fa-solid fa-circle-info" />
                <span>
                  Up to <strong>{MAX_PHOTOS} photos</strong>, <strong>{MAX_FILE_MB} MB</strong> each,
                  and <strong>{MAX_TOTAL_MB} MB</strong> in total. Clear photos help the
                  Admin and Clerk act faster.
                </span>
              </p>

              {previewUrls.length > 0 && (
                <>
                  <div className="sim-photo-grid">
                    {previewUrls.map((url, i) => (
                      <div key={url} className="sim-photo-cell">
                        <img src={url} alt={`Preview ${i + 1}`} />
                        <span className="sim-photo-size">
                          {formatBytes(photoFiles[i]?.size || 0)}
                        </span>
                        <button
                          type="button"
                          className="sim-photo-remove-icon"
                          onClick={() => removePhotoAt(i)}
                          aria-label={`Remove photo ${i + 1}`}
                          disabled={uploading}
                        >
                          <i className="fa-solid fa-xmark" />
                        </button>
                      </div>
                    ))}
                  </div>

                  <div className={`sim-size-meter ${meterState}`}>
                    <div className="sim-size-meter-top">
                      <span>Total size</span>
                      <span>
                        <strong>{formatBytes(totalBytes)}</strong> / {MAX_TOTAL_MB} MB
                      </span>
                    </div>
                    <div className="sim-size-meter-bar">
                      <div
                        className="sim-size-meter-fill"
                        style={{ width: `${totalPercent}%` }}
                      />
                    </div>
                  </div>
                </>
              )}

              {photoFiles.length < MAX_PHOTOS && !uploading && (
                <button
                  type="button"
                  className="sim-photo-btn"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <i className="fa-solid fa-camera" />
                  {previewUrls.length === 0 ? "Attach Photos" : "Add More Photos"}
                </button>
              )}

              {uploading && (
                <div className="sim-upload-progress">
                  <i className="fa-solid fa-circle-notch fa-spin" />
                  Uploading photo {uploadProgress.done} of {uploadProgress.total}…
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={handlePhotosChange}
              />
            </div>
          </div>

          <div className="sim-footer">
            <button className="sim-btn cancel" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              className="sim-btn submit"
              onClick={handleSubmitClick}
              disabled={submitting || uploading}
            >
              {submitting || uploading
                ? <><i className="fa-solid fa-circle-notch fa-spin" /> Submitting...</>
                : <><i className="fa-solid fa-paper-plane" /> Submit Report</>
              }
            </button>
          </div>
        </div>
      </div>

      {/* ═══════════ PREVIEW MODAL ═══════════ */}
      {showPreview && (
        <div
          className="sim-preview-overlay"
          onClick={() => !submitting && setShowPreview(false)}
        >
          <div
            className="sim-preview-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sim-preview-header">
              <div className="sim-preview-icon">
                <i className="fa-solid fa-clipboard-check"></i>
              </div>
              <h3>Review Your Report</h3>
              <p className="sim-preview-subtitle">
                Please check the details below before submitting.
              </p>
            </div>

            <div className="sim-preview-body">
              <div className="sim-preview-row">
                <span className="sim-preview-label">Room</span>
                <span className="sim-preview-value">
                  {selectedRoom?.roomName || "—"}
                </span>
              </div>

              <div className="sim-preview-row">
                <span className="sim-preview-label">Floor</span>
                <span className="sim-preview-value">
                  {selectedRoom?.floor || "—"}
                </span>
              </div>

              <div className="sim-preview-row">
                <span className="sim-preview-label">Category</span>
                <span className="sim-preview-value">
                  {selectedCategoryMeta ? (
                    <>
                      <i
                        className={`fa-solid ${selectedCategoryMeta.icon}`}
                        style={{ marginRight: 6, color: "#f57c00" }}
                      />
                      {selectedCategoryMeta.label}
                    </>
                  ) : (
                    "—"
                  )}
                </span>
              </div>

              <div className="sim-preview-row">
                <span className="sim-preview-label">Severity</span>
                <span
                  className="sim-preview-sev"
                  style={{ "--sev-color": selectedSeverityMeta.color }}
                >
                  <span className="sim-preview-sev-dot" />
                  {selectedSeverityMeta.label}
                </span>
              </div>

              <div className="sim-preview-row sim-preview-row--stacked">
                <span className="sim-preview-label">Description</span>
                <span className="sim-preview-value sim-preview-description">
                  {form.description || "—"}
                </span>
              </div>

              {previewUrls.length > 0 && (
                <div className="sim-preview-row sim-preview-row--stacked">
                  <span className="sim-preview-label">
                    Photos ({previewUrls.length}) · {formatBytes(totalBytes)}
                  </span>
                  <div className="sim-preview-photo-grid">
                    {previewUrls.map((url, i) => (
                      <div key={url} className="sim-preview-photo-cell">
                        <img src={url} alt={`Preview ${i + 1}`} />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="sim-preview-note">
                <i className="fa-solid fa-circle-info"></i>
                <span>
                  After submitting, please wait for the <strong>Admin to acknowledge</strong>{" "}
                  your report before it can be resolved. You'll be notified once it's
                  reviewed.
                </span>
              </div>

              <div className="sim-preview-thanks">
                <i className="fa-solid fa-heart"></i>
                <span>Thank you for helping us keep our rooms in good condition!</span>
              </div>
            </div>

            <div className="sim-preview-actions">
              <button
                className="sim-preview-back-btn"
                onClick={() => setShowPreview(false)}
                disabled={submitting}
              >
                <i className="fa-solid fa-pen-to-square"></i>
                Edit Report
              </button>
              <button
                className={`sim-preview-confirm-btn ${submitting ? "disabled" : ""}`}
                onClick={handleConfirmSubmit}
                disabled={submitting || uploading}
              >
                {submitting || uploading ? (
                  <>
                    <i className="fa-solid fa-spinner fa-spin"></i> Submitting...
                  </>
                ) : (
                  <>
                    <i className="fa-solid fa-circle-check"></i> Confirm & Submit
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      <Toast
        show={toast.show} type={toast.type} title={toast.title} message={toast.message}
        onClose={() => setToast(p => ({ ...p, show: false }))}
      />
    </>
  );
}