import { useState, useRef, useEffect } from 'react';
import './room-management-add-room.css';
import { useNavigate } from "react-router-dom";
import { db, auth } from "../../../firebase";
import {
  collection, query, where, getDocs, getDoc,
  doc, addDoc, setDoc, serverTimestamp,
} from "firebase/firestore";
import { logActivity } from "../../../utils/logActivity";
import Toast from "../../../Popup/Toast/Toast";

/* ─── Cloudinary config (same as SubmitIssueModal) ─── */
const CLOUDINARY_CLOUD_NAME    = "dqn1s5ujs";
const CLOUDINARY_UPLOAD_PRESET = "SpaceSCICT";

async function uploadToCloudinary(file) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  fd.append("folder", "spaces/rooms");
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
    { method: "POST", body: fd }
  );
  if (!res.ok) throw new Error("Photo upload failed.");
  const data = await res.json();
  return data.secure_url;
}

const ROOM_TYPES = ['Computer Lab', 'Lecture Room', 'Conference Room', 'Laboratory'];

const EQUIPMENT_OPTIONS = [
  { id: 'projector',  label: 'Projector',   icon: 'fa-solid fa-projector' },
  { id: 'tvDisplay',  label: 'TV Display',  icon: 'fa-solid fa-tv' },
  { id: 'ac',         label: 'AC',          icon: 'fa-solid fa-snowflake' },
  { id: 'computer',   label: 'Computer',    icon: 'fa-solid fa-desktop' },
  { id: 'smartBoard', label: 'Smart Board', icon: 'fa-solid fa-chalkboard' },
];

const FLOORS = ["1st floor", "2nd floor", "3rd floor", "4th floor"];

const INITIAL_EQUIPMENT = {
  projector: false, tvDisplay: false, ac: false,
  computer: false, smartBoard: false,
};

const MAX_PHOTO_MB = 5;

/* ─── Custom Dropdown ─────────────────────────────────── */
function CustomDropdown({ placeholder, options, value, onChange, hasError }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className={`custom-select ${open ? "open" : ""} ${hasError ? "has-error" : ""}`} ref={ref}>
      <div className="custom-select-trigger" onClick={() => setOpen(!open)}>
        <span className={value ? "" : "placeholder-text"}>{value || placeholder}</span>
        <svg className={`chevron-icon ${open ? "rotated" : ""}`} width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M2 4.5L7 9.5L12 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
      {open && (
        <div className="custom-select-dropdown">
          {options.map((option) => (
            <div
              key={option}
              className={`custom-select-option ${value === option ? "selected" : ""}`}
              onClick={() => { onChange(option); setOpen(false); }}
            >
              {value === option && (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{marginRight: 8, flexShrink: 0}}>
                  <path d="M2 7L5.5 10.5L12 3.5" stroke="#f57c00" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
              {option}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Main Component ──────────────────────────────────── */
function RoomManagementAddRoom({ onBack = () => {}, onSuccess = () => {} }) {
  const [roomName, setRoomName]       = useState('');
  const [capacity, setCapacity]       = useState(1);
  const [roomType, setRoomType]       = useState('');
  const [equipment, setEquipment]     = useState(INITIAL_EQUIPMENT);
  const [floor, setFloor]             = useState('');

  // DEFAULT BUILDING: "Pimentel Hall"
  const [building, setBuilding]       = useState('Pimentel Hall');
  const [buildingCustom, setBuildingCustom] = useState('');
  const [isOtherBuilding, setIsOtherBuilding] = useState(false);

  // OPTIONAL PHOTO
  const [photoFile, setPhotoFile]       = useState(null);
  const [photoPreview, setPhotoPreview] = useState('');
  const [dragOver, setDragOver]         = useState(false);
  const dragCounter = useRef(0);
  const photoInputRef = useRef(null);

  const [cancelModalOpen, setCancelModalOpen]   = useState(false);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [successModalOpen, setSuccessModalOpen] = useState(false);

  const [errors, setErrors]   = useState({});
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  // Toast
  const [toast, setToast] = useState({ show: false, type: "success", title: "", message: "" });
  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    if (type !== "loading") {
      setTimeout(() => setToast((prev) => ({ ...prev, show: false })), 3000);
    }
  };

  const toggleEquipment = (id) =>
    setEquipment((prev) => ({ ...prev, [id]: !prev[id] }));

  const adjustCapacity = (delta) =>
    setCapacity((prev) => Math.min(200, Math.max(1, Number(prev || 0) + delta)));

  /* ─── Photo processing (shared for input + drag-drop) ─── */
  const processFile = (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("error", "Invalid file", "Please choose an image file (JPG, PNG, WEBP).");
      return;
    }
    if (file.size > MAX_PHOTO_MB * 1024 * 1024) {
      showToast("error", "File too large", `Max photo size is ${MAX_PHOTO_MB}MB.`);
      return;
    }
    if (photoPreview && photoPreview.startsWith("blob:")) {
      URL.revokeObjectURL(photoPreview);
    }
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  };

  const handlePhotoSelect = (e) => {
    const file = e.target.files?.[0];
    processFile(file);
    e.target.value = "";
  };

  const handleRemovePhoto = () => {
    if (photoPreview && photoPreview.startsWith("blob:")) {
      URL.revokeObjectURL(photoPreview);
    }
    setPhotoFile(null);
    setPhotoPreview("");
    if (photoInputRef.current) photoInputRef.current.value = "";
  };

  /* ─── Drag & Drop handlers ─── */
  const handleDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    if (e.dataTransfer?.items?.length > 0) setDragOver(true);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragOver(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) processFile(file);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (photoPreview && photoPreview.startsWith("blob:")) {
        URL.revokeObjectURL(photoPreview);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* validation */
  const validateForm = () => {
    const errs = {};
    if (!floor)            errs.floor    = "Floor is required";
    if (!building)         errs.building = "Building is required";
    if (isOtherBuilding && !buildingCustom.trim()) errs.building = "Please enter the building name";
    if (!roomName.trim())  errs.roomName = "Room name is required";
    if (!capacity || capacity < 1 || capacity > 200)
      errs.capacity = "Capacity must be between 1 and 200";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleCreateClick = (e) => {
    e?.preventDefault?.();
    if (validateForm()) setPreviewModalOpen(true);
  };

  const handleConfirmCreate = async () => {
    setPreviewModalOpen(false);
    setLoading(true);
    showToast("loading", "Creating Room...", "Please wait...");
    try {
      const firebaseUser = auth.currentUser;
      if (!firebaseUser) {
        showToast("error", "Error", "No authenticated user found.");
        setLoading(false);
        return;
      }

      const userSnap = await getDoc(doc(db, "users", firebaseUser.uid));
      if (!userSnap.exists()) throw new Error("User record not found.");
      const currentUser = userSnap.data();
      const fullName = `${currentUser.firstName} ${currentUser.lastName}`.trim();

      const existingRoom = await getDocs(
        query(collection(db, "rooms"), where("roomName", "==", roomName.trim()))
      );
      if (!existingRoom.empty) {
        setErrors({ roomName: "Room name already exists." });
        showToast("error", "Duplicate Room", "Room name already exists.");
        setLoading(false);
        return;
      }

      const buildingFinal = isOtherBuilding ? buildingCustom.trim() : building;

      let photoUrl = "";
      if (photoFile) {
        try {
          photoUrl = await uploadToCloudinary(photoFile);
        } catch (uploadErr) {
          console.error("Cloudinary upload failed:", uploadErr);
          showToast("error", "Photo upload failed", "Room will be created without a photo.");
        }
      }

      const roomRef = await addDoc(collection(db, "rooms"), {
        roomName: roomName.trim(),
        capacity: Number(capacity),
        roomType,
        equipment,
        floor,
        building: buildingFinal,
        status: "AVAILABLE",
        roomStatus: "active",
        photoUrl: photoUrl || null,
      });

      await setDoc(doc(db, "rooms", roomRef.id, "schedules", "_metadata"), {
        initialized: true, totalSchedules: 0,
        semester: "", schoolYear: "", createdAt: serverTimestamp(),
      });

      await setDoc(doc(db, "rooms", roomRef.id, "originalSchedules", "_metadata"), {
        initialized: true, totalSchedules: 0,
        semester: "", schoolYear: "", createdAt: serverTimestamp(),
      });

      await logActivity({
        userId: firebaseUser.uid, user: fullName, role: currentUser.role,
        action: "Created Room", actionType: "success",
        target: roomName.trim(), status: "SUCCESS",
      });

      setSuccessModalOpen(true);
      showToast("success", "Room Created", `${roomName} has been added successfully.`);
    } catch (err) {
      console.error("Firestore Error:", err);
      setErrors({ submit: "Failed to create room. Please try again." });
      showToast("error", "Creation Failed", err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmSuccess = () => {
    setSuccessModalOpen(false);
    setFloor(''); setRoomName(''); setCapacity(1);
    setRoomType(''); setEquipment(INITIAL_EQUIPMENT);
    setBuilding('Pimentel Hall');
    setBuildingCustom('');
    setIsOtherBuilding(false);
    handleRemovePhoto();
    navigate("/clerk/room-management");
  };

  const checkedEquipment = EQUIPMENT_OPTIONS.filter(({ id }) => equipment[id]);

  return (
    <main className="add-room-page dashboard-main">

      {/* PAGE HEADER */}
      <div className="add-room-page-header">
        <div>
          <h1 className="page-title">Add New Room</h1>
        </div>
      </div>

      {/* FORM CARD */}
      <form className="form-card" onSubmit={handleCreateClick}>

        {/* SECTION: Basic Info */}
        <div className="form-section">
          <div className="form-section-label">
            <span className="section-badge">1</span>
            Basic Information
          </div>

          <div className="field-group">
            <label className="field-label">
              Room Name <span className="required-dot">*</span>
            </label>
            <input
              className={`field-input ${errors.roomName ? 'has-error' : ''}`}
              type="text"
              placeholder="e.g. B101, Lab-A, Conference Hall"
              value={roomName}
              onChange={(e) => { setRoomName(e.target.value); setErrors(p => ({...p, roomName: ''})); }}
            />
            {errors.roomName && <span className="field-error">{errors.roomName}</span>}
          </div>

          <div className="two-col">
            {/* Capacity */}
            <div className="field-group">
              <label className="field-label">
                Capacity <span className="required-dot">*</span>
              </label>
              <div className={`capacity-stepper ${errors.capacity ? 'has-error' : ''}`}>
                <button type="button" className="step-btn minus" onClick={() => adjustCapacity(-1)}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M3 7H11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </button>
                <input
                  type="number"
                  className="step-value"
                  value={capacity}
                  min={1} max={200}
                  onKeyDown={(e) => {
                    if (!/[0-9]/.test(e.key) && !['Backspace','ArrowLeft','ArrowRight'].includes(e.key))
                      e.preventDefault();
                  }}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '') { setCapacity(''); return; }
                    if (/^\d+$/.test(v)) setCapacity(Number(v));
                  }}
                />
                <button type="button" className="step-btn plus" onClick={() => adjustCapacity(1)}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M7 3V11M3 7H11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
              <span className="field-hint">Max 200 people</span>
              {errors.capacity && <span className="field-error">{errors.capacity}</span>}
            </div>

            {/* Room Type */}
            <div className="field-group">
              <label className="field-label">Room Type</label>
              <CustomDropdown
                placeholder="Select type..."
                options={ROOM_TYPES}
                value={roomType}
                onChange={(v) => setRoomType(v)}
              />
            </div>
          </div>

          {/* Floor */}
          <div className="field-group">
            <label className="field-label">
              Floor <span className="required-dot">*</span>
            </label>
            <CustomDropdown
              placeholder="Select floor..."
              options={FLOORS}
              value={floor}
              onChange={(v) => { setFloor(v); setErrors(p => ({...p, floor: ''})); }}
              hasError={!!errors.floor}
            />
            {errors.floor && <span className="field-error">{errors.floor}</span>}
          </div>

          {/* Building */}
          <div className="field-group">
            <label className="field-label">
              Building <span className="required-dot">*</span>
            </label>
            <CustomDropdown
              placeholder="Select building..."
              options={['Pimentel Hall', 'Other']}
              value={building}
              onChange={(v) => {
                setBuilding(v);
                setIsOtherBuilding(v === 'Other');
                if (v !== 'Other') setBuildingCustom('');
                setErrors(p => ({...p, building: ''}));
              }}
              hasError={!!errors.building}
            />
            {isOtherBuilding && (
              <input
                className={`field-input ${errors.building ? 'has-error' : ''}`}
                type="text"
                placeholder="Enter building name"
                value={buildingCustom}
                onChange={(e) => {
                  setBuildingCustom(e.target.value);
                  setErrors(p => ({...p, building: ''}));
                }}
                style={{ marginTop: 8 }}
              />
            )}
            {errors.building && <span className="field-error">{errors.building}</span>}
          </div>

          {/* Room Photo (Optional) — DRAG & DROP */}
          <div className="field-group">
            <label className="field-label">
              Room Photo <span className="photo-optional-tag">Optional</span>
            </label>

            <div
              className={`photo-dropzone ${dragOver ? 'drag-over' : ''} ${photoPreview ? 'has-image' : ''}`}
              onClick={() => { if (!photoPreview) photoInputRef.current?.click(); }}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                onChange={handlePhotoSelect}
                style={{ display: "none" }}
              />

              {photoPreview ? (
                <div className="photo-dropzone-preview">
                  <img src={photoPreview} alt="Room preview" />
                  <div className="photo-dropzone-overlay">
                    <button
                      type="button"
                      className="photo-action-btn change"
                      onClick={(e) => { e.stopPropagation(); photoInputRef.current?.click(); }}
                    >
                      <i className="fa-solid fa-arrow-up-from-bracket"></i>
                      Change
                    </button>
                    <button
                      type="button"
                      className="photo-action-btn remove"
                      onClick={(e) => { e.stopPropagation(); handleRemovePhoto(); }}
                    >
                      <i className="fa-solid fa-trash-can"></i>
                      Remove
                    </button>
                  </div>
                </div>
              ) : (
                <div className="photo-dropzone-empty">
                  <div className="photo-dropzone-icon">
                    <i className={`fa-solid ${dragOver ? 'fa-cloud-arrow-down' : 'fa-cloud-arrow-up'}`}></i>
                  </div>
                  <p className="photo-dropzone-title">
                    {dragOver ? "Drop your photo here" : "Drag & drop your photo"}
                  </p>
                  <p className="photo-dropzone-sub">
                    or <span className="photo-dropzone-browse">click to browse</span>
                  </p>
                  <span className="photo-dropzone-hint">
                    JPG, PNG, WEBP • Max {MAX_PHOTO_MB}MB
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="section-divider" />

        {/* SECTION: Equipment */}
        <div className="form-section">
          <div className="form-section-label">
            <span className="section-badge">2</span>
            Equipment
            {checkedEquipment.length > 0 && (
              <span className="equipment-count">{checkedEquipment.length} selected</span>
            )}
          </div>

          <div className="equipment-grid">
            {EQUIPMENT_OPTIONS.map(({ id, label, icon }) => (
              <label
                key={id}
                className={`equipment-chip ${equipment[id] ? 'checked' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={equipment[id]}
                  onChange={() => toggleEquipment(id)}
                  style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                />
                <span className="chip-icon"><i className={icon} style={{fontSize: 18}}></i></span>
                <span className="chip-label">{label}</span>
                <span className="chip-check">
                  {equipment[id]
                    ? <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6L4.5 8.5L10 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    : null
                  }
                </span>
              </label>
            ))}
          </div>
        </div>
      </form>

      {/* FOOTER ACTIONS */}
      {errors.submit && (
        <span className="field-error add-room-submit-error">{errors.submit}</span>
      )}
      <div className="add-room-footer">
        <button
          type="button"
          className="add-cancel-btn"
          onClick={() => setCancelModalOpen(true)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="add-confirm-btn"
          onClick={handleCreateClick}
          disabled={loading}
        >
          {loading ? (
            <span className="btn-loading">
              <span className="spinner" /> Creating...
            </span>
          ) : (
            <>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M13.5 4.5L6 12L2.5 8.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Review & Create
            </>
          )}
        </button>
      </div>

      {/* ── CANCEL MODAL ── */}
      {cancelModalOpen && (
        <div className="modal-overlay" onClick={() => setCancelModalOpen(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-icon-wrap warning">
              <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
                <path d="M13 9V14M13 17.5V18M3 21.5H23L13 4.5L3 21.5Z" stroke="#f57c00" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <h3 className="modal-title">Discard changes?</h3>
            <p className="modal-body">All information you've entered will be lost. This can't be undone.</p>
            <div className="modal-actions two">
              <button className="btn btn-outline" onClick={() => setCancelModalOpen(false)}>Keep editing</button>
              <button className="btn btn-danger" onClick={() => navigate("/clerk/room-management")}>Discard</button>
            </div>
          </div>
        </div>
      )}

      {/* ── PREVIEW / CONFIRM MODAL ── */}
      {previewModalOpen && (
        <div className="modal-overlay" onClick={() => setPreviewModalOpen(false)}>
          <div className="modal-box preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="preview-header">
              <div className="modal-icon-wrap accent">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path d="M9 12H15M9 16H15M7 4H5C3.9 4 3 4.9 3 6V20C3 21.1 3.9 22 5 22H19C20.1 22 21 21.1 21 20V6C21 4.9 20.1 4 19 4H17M9 4H15C15.6 4 16 4.4 16 5V5C16 5.6 15.6 6 15 6H9C8.4 6 8 5.6 8 5V5C8 4.4 8.4 4 9 4Z" stroke="#f57c00" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div>
                <h3 className="modal-title" style={{marginBottom: 2}}>Review room details</h3>
                <p className="modal-sub">Please confirm the information before creating.</p>
              </div>
            </div>

            <div className="preview-card">
              <div className="preview-photo">
                {photoPreview ? (
                  <img src={photoPreview} alt="Room preview" />
                ) : (
                  <div className="preview-photo-fallback">
                    <i className="fa-regular fa-image"></i>
                    <span>No image</span>
                  </div>
                )}
              </div>

              <div className="preview-room-name">
                <span className="room-name-badge">{roomName}</span>
                {roomType && <span className="room-type-badge">{roomType}</span>}
              </div>

              <div className="preview-row">
                <span className="preview-label">Floor</span>
                <span className="preview-value">{floor}</span>
              </div>

              <div className="preview-row">
                <span className="preview-label">Building</span>
                <span className="preview-value">{isOtherBuilding ? buildingCustom : building}</span>
              </div>

              <div className="preview-row">
                <span className="preview-label">Capacity</span>
                <span className="preview-value">{capacity} people</span>
              </div>

              <div className="preview-row" style={{alignItems:'flex-start'}}>
                <span className="preview-label" style={{paddingTop:2}}>Equipment</span>
                <div className="preview-equipment">
                  {checkedEquipment.length > 0
                      ? checkedEquipment.map(({ id, label, icon }) => (
                          <span key={id} className="preview-equipment-tag"><i className={icon} style={{fontSize: 14, marginRight: 4}}></i> {label}</span>
                        ))
                      : <span className="preview-none">None selected</span>
                    }
                </div>
              </div>
            </div>

            <div className="modal-actions two">
              <button className="btn btn-outline" onClick={() => setPreviewModalOpen(false)}>
                Edit details
              </button>
              <button className="btn btn-primary" onClick={handleConfirmCreate}>
                Confirm & Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── SUCCESS MODAL ── */}
      {successModalOpen && (
        <div className="modal-overlay">
          <div className="modal-box">
            <div className="modal-icon-wrap success">
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                <path d="M4 14L10.5 20.5L24 7" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <h3 className="modal-title">Room created!</h3>
            <p className="modal-body">
              <strong>{roomName}</strong> has been successfully added to the system.
            </p>
            <div className="modal-actions single">
              <button className="btn btn-primary" onClick={handleConfirmSuccess}>Done</button>
            </div>
          </div>
        </div>
      )}

      <Toast
        show={toast.show}
        type={toast.type}
        title={toast.title}
        message={toast.message}
        onClose={() => setToast({ show: false, type: "", title: "", message: "" })}
      />
    </main>
  );
}

export default RoomManagementAddRoom;