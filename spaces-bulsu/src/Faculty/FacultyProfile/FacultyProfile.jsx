import { useState, useEffect, useRef } from "react";
import "./faculty-profile.css";
import { auth, db } from "../../firebase";
import { doc, getDoc, updateDoc, collection, query, where, onSnapshot } from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { logActivity } from "../../utils/logActivity";
import Toast from "../../Popup/Toast/Toast";

// ── Cloudinary config ─────────────────────────────────────────────────────────
const CLOUDINARY_CLOUD_NAME    = "dqn1s5ujs";
const CLOUDINARY_UPLOAD_PRESET = "SpaceSCICT";

async function uploadToCloudinary(file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  formData.append("folder", "spaces/profiles");

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
    { method: "POST", body: formData }
  );

  if (!res.ok) throw new Error("Image upload failed. Please try again.");
  const data = await res.json();
  return data.secure_url;
}

// Icon + accent color per actionType
const ACTIVITY_ICON = {
  edit:    "fa-solid fa-pen",
  create:  "fa-solid fa-plus",
  delete:  "fa-solid fa-trash",
  login:   "fa-solid fa-right-to-bracket",
  logout:  "fa-solid fa-right-from-bracket",
  reserve: "fa-solid fa-bookmark",
  cancel:  "fa-solid fa-ban",
  default: "fa-solid fa-circle-info",
};

// ✅ Accepts the whole log object (works with timestamp OR createdAt fallback)
function formatLogTime(log) {
  const ts = log?.timestamp || log?.createdAt;
  if (!ts) return "";
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  const now  = new Date();
  const diff = Math.floor((now - date) / 1000);
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString();
}

// ✅ Helper: get millis from either timestamp or createdAt
function getLogMillis(log) {
  const ts = log?.timestamp || log?.createdAt;
  if (!ts) return 0;
  if (ts.toMillis) return ts.toMillis();
  if (ts.toDate)   return ts.toDate().getTime();
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

export default function FacultyProfile() {
  const [activeTab, setActiveTab]   = useState("details");
  const [editing, setEditing]       = useState(false);
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [uploading, setUploading]   = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [photoFile, setPhotoFile]   = useState(null);
  const fileInputRef                = useRef(null);

  const [form, setForm] = useState({
    firstName: "",
    lastName:  "",
    email:     "",
    role:      "",
    photoUrl:  "",
  });

  const [originalData, setOriginalData] = useState(null);

  const [activityLogs, setActivityLogs]     = useState([]);
  const [activityLoading, setActivityLoading] = useState(true);

  const [toast, setToast] = useState({
    show: false, type: "success", title: "", message: "",
  });

  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    setTimeout(() => setToast(prev => ({ ...prev, show: false })), 3000);
  };

  // ── Load profile ────────────────────────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (!currentUser) {
        showToast("error", "Authentication Error", "No logged in user found.");
        setLoading(false);
        return;
      }

      try {
        const snap = await getDoc(doc(db, "users", currentUser.uid));
        if (!snap.exists()) throw new Error("User profile not found.");

        const data = snap.data();
        const profile = {
          firstName: data.firstName || "",
          lastName:  data.lastName  || "",
          email:     data.email     || "",
          role:      data.role      || "",
          photoUrl:  data.photoUrl  || "",
        };

        setForm(profile);
        setOriginalData(profile);
      } catch (err) {
        console.error(err);
        showToast("error", "Profile Error", err.message);
      } finally {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  // ── Load activity log ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!form.firstName && !form.lastName) return;

    const fullName = `${form.firstName} ${form.lastName}`
      .replace(/\s+/g, " ")
      .trim();
    if (!fullName) return;

    setActivityLoading(true);

    // ✅ FIX:
    // - Removed orderBy("timestamp") para hindi mag-drop ng docs
    //   na walang `timestamp` field (mga gumagamit ng `createdAt`).
    // - Removed orderBy din para hindi na kailangan ng composite index.
    // - Client-side sorting na lang below.
    const q = query(
      collection(db, "activityLogs"),
      where("user", "==", fullName)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const logs = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

        // Sort client-side (newest first) — supports timestamp OR createdAt
        logs.sort((a, b) => getLogMillis(b) - getLogMillis(a));

        setActivityLogs(logs.slice(0, 50));
        setActivityLoading(false);
      },
      (err) => {
        console.error("Activity log query failed:", err);
        setActivityLoading(false);
      }
    );

    return () => unsubscribe();
  }, [form.firstName, form.lastName]);

  // ── Photo selection ─────────────────────────────────────────────────────────
  const handlePhotoChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      showToast("error", "Invalid File", "Please select an image file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToast("error", "File Too Large", "Image must be smaller than 5 MB.");
      return;
    }

    setPhotoFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  };

  // ── Save ────────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    const nameUnchanged =
      form.firstName === originalData.firstName &&
      form.lastName  === originalData.lastName;
    const photoUnchanged = form.photoUrl === originalData.photoUrl;

    if (nameUnchanged && photoUnchanged && !photoFile) {
      showToast("error", "No Changes", "Nothing to save.");
      return;
    }

    setSaving(true);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error("User session expired.");

      let photoUrl = form.photoUrl;

      if (photoFile) {
        setUploading(true);
        photoUrl = await uploadToCloudinary(photoFile);
        setUploading(false);
      }

      await updateDoc(doc(db, "users", currentUser.uid), {
        firstName: form.firstName.trim(),
        lastName:  form.lastName.trim(),
        photoUrl,
      });

      await logActivity({
        user: `${form.firstName.trim()} ${form.lastName.trim()}`,
        role: form.role,
        action: "Updated profile",
        actionType: "edit",
        target: "Faculty Profile",
        status: "Success",
      });

      const updatedData = { ...form, photoUrl };
      setForm(updatedData);
      setOriginalData(updatedData);
      setPhotoFile(null);
      setPreviewUrl(null);
      setEditing(false);

      showToast("success", "Profile Updated", "Your profile has been updated successfully.");
    } catch (err) {
      console.error(err);
      setUploading(false);
      showToast("error", "Update Failed", err.message);
    } finally {
      setSaving(false);
    }
  };

  // ── Cancel ──────────────────────────────────────────────────────────────────
  const handleCancel = () => {
    if (originalData) setForm(originalData);
    setPhotoFile(null);

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }

    setEditing(false);
  };

  const handleChange = (field) => (e) =>
    setForm(prev => ({ ...prev, [field]: e.target.value }));

  const displayPhoto = previewUrl || form.photoUrl;
  const initials = `${form.firstName.charAt(0)}${form.lastName.charAt(0)}`.toUpperCase();

  if (loading) {
    return (
      <div className="up-page">
        <div className="up-card">
          <h3>Loading profile...</h3>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="up-page">

        {/* TABS */}
        <div className="up-tabs">
          <button
            className={activeTab === "details" ? "active" : ""}
            onClick={() => setActiveTab("details")}
          >
            <i className="fa-regular fa-id-card"></i> Details
          </button>
          <button
            className={activeTab === "activity" ? "active" : ""}
            onClick={() => setActiveTab("activity")}
          >
            <i className="fa-solid fa-clock-rotate-left"></i> Activity Log
          </button>
        </div>

        {activeTab === "details" && (
          <div className="up-card">

            <div className="up-header">
              <h2>Faculty Profile</h2>
              <p>Update your profile information and picture here.</p>
            </div>

            {!editing && (
              <button className="up-edit-btn" onClick={() => setEditing(true)}>
                <i className="fa-solid fa-pen" />
              </button>
            )}

            {/* ── Avatar ── */}
            <div className="up-avatar-wrap">
              <div className="up-avatar">
                {displayPhoto ? (
                  <img src={displayPhoto} alt="Profile" className="up-avatar-img" />
                ) : (
                  initials
                    ? <span className="up-avatar-initials">{initials}</span>
                    : <i className="fa-solid fa-user" />
                )}
              </div>

              {editing && (
                <button
                  className="up-avatar-camera"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  title="Change photo"
                >
                  {uploading
                    ? <i className="fa-solid fa-circle-notch fa-spin" />
                    : <i className="fa-solid fa-camera" />
                  }
                </button>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={handlePhotoChange}
            />

            {editing && photoFile && !uploading && (
              <p className="up-photo-name">
                <i className="fa-solid fa-circle-check" /> {photoFile.name}
              </p>
            )}

            {editing && uploading && (
              <p className="up-upload-progress">
                <i className="fa-solid fa-circle-notch fa-spin" /> Uploading photo…
              </p>
            )}

            {editing && form.photoUrl && !uploading && (
              <button
                className="up-remove-photo-btn"
                type="button"
                onClick={() => {
                  setPhotoFile(null);
                  if (previewUrl) {
                    URL.revokeObjectURL(previewUrl);
                    setPreviewUrl(null);
                  }
                  setForm(prev => ({ ...prev, photoUrl: "" }));
                }}
              >
                <i className="fa-solid fa-trash" /> Remove Photo
              </button>
            )}

            {editing && !form.photoUrl && !photoFile && !uploading && (
              <button
                className="up-upload-btn"
                type="button"
                onClick={() => fileInputRef.current?.click()}
              >
                <i className="fa-solid fa-arrow-up-from-bracket" /> Upload Picture
              </button>
            )}

            {/* ── Fields ── */}
            <div className="up-fields">
              <div className="up-field">
                <label>First Name</label>
                <input
                  className="up-input"
                  value={form.firstName}
                  onChange={handleChange("firstName")}
                  readOnly={!editing}
                />
              </div>

              <div className="up-field">
                <label>Last Name</label>
                <input
                  className="up-input"
                  value={form.lastName}
                  onChange={handleChange("lastName")}
                  readOnly={!editing}
                />
              </div>

              <div className="up-field">
                <label>Role</label>
                <input className="up-input" value={form.role} readOnly />
              </div>
            </div>

            {editing && (
              <div className="up-footer">
                <button className="up-cancel-btn" onClick={handleCancel}>
                  Cancel
                </button>
                <button
                  className="up-save-btn"
                  onClick={handleSave}
                  disabled={saving || uploading}
                >
                  {uploading ? "Uploading…" : saving ? "Saving…" : "Save"}
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === "activity" && (
          <div className="up-card up-card-activity">

            <div className="up-header">
              <h2>Activity Log</h2>
              <p>Everything you've done in SpaceS, most recent first.</p>
            </div>

            {activityLoading ? (
              <p className="up-activity-loading">Loading activity…</p>
            ) : activityLogs.length === 0 ? (
              <div className="up-activity-empty">
                <div className="up-activity-empty-icon">
                  <i className="fa-solid fa-clock-rotate-left"></i>
                </div>
                <h4>No activity yet</h4>
                <p>Actions you take will show up here.</p>
              </div>
            ) : (
              <div className="up-activity-list">
                {activityLogs.map((log) => (
                  <div key={log.id} className="up-activity-item">
                    <div className={`up-activity-icon ${log.status === "Failed" ? "is-failed" : ""}`}>
                      <i className={ACTIVITY_ICON[log.actionType] || ACTIVITY_ICON.default}></i>
                    </div>
                    <div className="up-activity-body">
                      <div className="up-activity-top">
                        <span className="up-activity-action">{log.action}</span>
                        {log.status && (
                          <span className={`up-activity-status ${log.status === "Failed" ? "is-failed" : "is-success"}`}>
                            {log.status}
                          </span>
                        )}
                      </div>
                      {log.target && <p className="up-activity-target">{log.target}</p>}
                      <span className="up-activity-time">{formatLogTime(log)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </div>

      <Toast
        show={toast.show}
        type={toast.type}
        title={toast.title}
        message={toast.message}
        onClose={() => setToast(prev => ({ ...prev, show: false }))}
      />
    </>
  );
}