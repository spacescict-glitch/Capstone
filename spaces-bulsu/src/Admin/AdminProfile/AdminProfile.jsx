import { useState, useEffect, useRef } from "react";
import "./admin-profile.css";
import { logActivity } from "../../utils/logActivity";
import { auth, db } from "../../firebase";
import {
  doc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  onSnapshot,
} from "firebase/firestore";
import { sendPasswordResetEmail, onAuthStateChanged } from "firebase/auth";

const CLOUDINARY_CLOUD_NAME    = "dzu1qb8oz";
const CLOUDINARY_UPLOAD_PRESET = "SpacesCICT";

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

function getLogMillis(log) {
  const ts = log?.timestamp || log?.createdAt;
  if (!ts) return 0;
  if (ts.toMillis) return ts.toMillis();
  if (ts.toDate)   return ts.toDate().getTime();
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

export default function AdminProfile() {
  const [activeTab, setActiveTab]       = useState("details");
  const [editing, setEditing]           = useState(false);
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState(false);
  const [uploading, setUploading]       = useState(false);
  const [previewUrl, setPreviewUrl]     = useState(null);
  const [photoFile, setPhotoFile]       = useState(null);
  const fileInputRef                    = useRef(null);

  const [form, setForm] = useState({
    firstName: "",
    lastName:  "",
    email:     "",
    role:      "",
    photoUrl:  "",
  });

  const [originalData, setOriginalData] = useState(null);
  const [toast, setToast]               = useState(null);

  const [activityLogs, setActivityLogs]     = useState([]);
  const [activityLoading, setActivityLoading] = useState(true);

  const showToast = (type, message) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (!currentUser) {
        showToast("error", "No logged in user found.");
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
        showToast("error", err.message);
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

    const q = query(
      collection(db, "activityLogs"),
      where("user", "==", fullName)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const logs = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
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

  const handlePhotoChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { showToast("error", "Please select an image file."); return; }
    if (file.size > 5 * 1024 * 1024)    { showToast("error", "Image must be smaller than 5 MB."); return; }
    setPhotoFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  };

  const handleSave = async () => {
    const nameUnchanged =
      form.firstName === originalData.firstName &&
      form.lastName  === originalData.lastName;
    const photoUnchanged = form.photoUrl === originalData.photoUrl;
    if (nameUnchanged && photoUnchanged && !photoFile) { showToast("error", "Nothing to save."); return; }

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
        target: "Admin Profile",
        status: "Success",
      });

      const updatedData = { ...form, photoUrl };
      setForm(updatedData);
      setOriginalData(updatedData);
      setPhotoFile(null);
      setPreviewUrl(null);
      setEditing(false);
      showToast("success", "Profile updated successfully.");
    } catch (err) {
      console.error(err);
      setUploading(false);
      showToast("error", err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (originalData) setForm(originalData);
    setPhotoFile(null);
    if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }
    setEditing(false);
  };

  const handleResetPassword = async () => {
    try {
      await sendPasswordResetEmail(auth, form.email);
      showToast("success", "Password reset email sent. Check your inbox.");
    } catch (err) {
      console.error(err);
      showToast("error", err.message);
    }
  };

  const handleChange = (field) => (e) =>
    setForm(prev => ({ ...prev, [field]: e.target.value }));

  const displayPhoto = previewUrl || form.photoUrl;
  const initials = `${form.firstName.charAt(0)}${form.lastName.charAt(0)}`.toUpperCase();

  if (loading) {
    return (
      <div className="dhp-page">
        <div className="dhp-card">
          <h3>Loading profile...</h3>
        </div>
      </div>
    );
  }

  return (
    <div className="dhp-page">
      {/* TABS */}
      <div className="dhp-tabs">
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
        <div className="dhp-card">
          <div className="dhp-header">
            <h2>My Profile</h2>
            <p>View and manage your personal information and account details.</p>
          </div>

          {!editing && (
            <button className="dhp-edit-btn" onClick={() => setEditing(true)}>
              <i className="fa-solid fa-pen" />
            </button>
          )}

          {/* Avatar */}
          <div className="dhp-avatar-wrap">
            <div className="dhp-avatar">
              {displayPhoto ? (
                <img src={displayPhoto} alt="Profile" className="dhp-avatar-img" />
              ) : (
                <span className="dhp-avatar-initials">{initials || <i className="fa-solid fa-user" />}</span>
              )}
            </div>
            {editing && (
              <button
                className="dhp-avatar-camera"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                title="Change photo"
              >
                {uploading ? (
                  <i className="fa-solid fa-circle-notch fa-spin" />
                ) : (
                  <i className="fa-solid fa-camera" />
                )}
              </button>
            )}
          </div>

          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handlePhotoChange} />

          {editing && photoFile && !uploading && (
            <p className="dhp-photo-name"><i className="fa-solid fa-circle-check" /> {photoFile.name}</p>
          )}
          {editing && uploading && (
            <p className="dhp-upload-progress"><i className="fa-solid fa-circle-notch fa-spin" /> Uploading photo…</p>
          )}
          {editing && form.photoUrl && !uploading && (
            <button
              className="dhp-remove-photo-btn"
              type="button"
              onClick={() => {
                setPhotoFile(null);
                if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }
                setForm(prev => ({ ...prev, photoUrl: "" }));
              }}
            >
              <i className="fa-solid fa-trash" /> Remove Photo
            </button>
          )}
          {editing && !form.photoUrl && !photoFile && !uploading && (
            <button
              className="dhp-upload-btn"
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              <i className="fa-solid fa-arrow-up-from-bracket" /> Upload Picture
            </button>
          )}

          {/* Fields */}
          <div className="dhp-fields">
            <div className="dhp-field">
              <label>First Name</label>
              <input className="dhp-input" value={form.firstName} onChange={handleChange("firstName")} readOnly={!editing} />
            </div>
            <div className="dhp-field">
              <label>Last Name</label>
              <input className="dhp-input" value={form.lastName} onChange={handleChange("lastName")} readOnly={!editing} />
            </div>
            <div className="dhp-field">
              <label>Role</label>
              <input className="dhp-input" value={form.role} readOnly />
            </div>
          </div>
        </div>
      )}

      {activeTab === "activity" && (
        <div className="dhp-card dhp-card-activity">
          <div className="dhp-header">
            <h2>Activity Log</h2>
            <p>Everything you've done in SpaceS, most recent first.</p>
          </div>

          {activityLoading ? (
            <p className="dhp-activity-loading">Loading activity…</p>
          ) : activityLogs.length === 0 ? (
            <div className="dhp-activity-empty">
              <div className="dhp-activity-empty-icon">
                <i className="fa-solid fa-clock-rotate-left"></i>
              </div>
              <h4>No activity yet</h4>
              <p>Actions you take will show up here.</p>
            </div>
          ) : (
            <div className="dhp-activity-list">
              {activityLogs.map((log) => (
                <div key={log.id} className="dhp-activity-item">
                  <div className={`dhp-activity-icon ${log.status === "Failed" ? "is-failed" : ""}`}>
                    <i className={ACTIVITY_ICON[log.actionType] || ACTIVITY_ICON.default}></i>
                  </div>
                  <div className="dhp-activity-body">
                    <div className="dhp-activity-top">
                      <span className="dhp-activity-action">{log.action}</span>
                      {log.status && (
                        <span className={`dhp-activity-status ${log.status === "Failed" ? "is-failed" : "is-success"}`}>
                          {log.status}
                        </span>
                      )}
                    </div>
                    {log.target && <p className="dhp-activity-target">{log.target}</p>}
                    <span className="dhp-activity-time">{formatLogTime(log)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Footer for details tab only */}
      {activeTab === "details" && editing && (
        <div className="dhp-footer">
          <button className="dhp-cancel-btn" onClick={handleCancel}>Cancel</button>
          <button className="dhp-save-btn" onClick={handleSave} disabled={saving || uploading}>
            {uploading ? "Uploading…" : saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`dhp-toast ${toast.type}`}>
          <i className={`fa-solid ${toast.type === "success" ? "fa-circle-check" : "fa-circle-exclamation"}`} />
          {toast.message}
        </div>
      )}
    </div>
  );
}