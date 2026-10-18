import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { collection, onSnapshot, getDocs, query, where } from "firebase/firestore";
import { db } from "../../../firebase";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import * as XLSX from "xlsx";
import "./bulk-schedule-upload2.css";
import Toast from "../../../Popup/Toast/Toast";
import { extractInChunks } from "../../../utils/extractInChunks";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const steps = [
  { number: 1, label: "SETUP" },
  { number: 2, label: "UPLOAD" },
  { number: 3, label: "CALENDAR VIEW" },
  { number: 4, label: "CONFIRM" },
];

// ---------- helper functions ----------
async function parseExcelFile(file) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet);
  return rows.map((row, index) => {
    const normalized = {};
    Object.keys(row).forEach((key) => {
      normalized[key.toLowerCase().trim()] = row[key];
    });
    const startTime =
      normalized["start time"] || normalized["starttime"] || normalized["start_time"] || "";
    const endTime =
      normalized["end time"] || normalized["endtime"] || normalized["end_time"] || "";
    return {
      id: index + 1,
      subject: normalized["subject"] || "",
      section: normalized["section"] || "",
      faculty: normalized["faculty"] || "",
      day: normalized["day"] || "",
      startTime,
      endTime,
      time: startTime && endTime ? `${startTime} - ${endTime}` : "",
      room: normalized["room"] || "",
    };
  });
}

async function extractRawText(file) {
  if (file.type === "application/pdf") {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      fullText += content.items.map((item) => item.str).join(" ") + "\n";
    }
    return fullText;
  } else if (file.name.endsWith(".xlsx") || file.name.endsWith(".xls")) {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: "array" });
    let allText = "";
    workbook.SheetNames.forEach((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      allText += XLSX.utils.sheet_to_csv(sheet) + "\n";
    });
    return allText;
  } else {
    throw new Error("Unsupported file type");
  }
}

function RoomCard({ roomName, file, onRemove, onFileChange, isDuplicate }) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (isDuplicate) return;
    const dropped = e.dataTransfer.files && e.dataTransfer.files[0];
    if (dropped) onFileChange(roomName, dropped);
  };

  return (
    <div className={`room-card ${isDuplicate ? "is-duplicate" : ""}`}>
      <div className="room-card-header">
        <span className="room-name">{roomName}</span>
        <button
          type="button"
          className="remove-room-btn"
          onClick={() => onRemove(roomName)}
          aria-label={`Remove ${roomName}`}
        >
          <i className="fas fa-times" />
        </button>
      </div>

      {isDuplicate && (
        <div className="room-duplicate-banner">
          <i className="fas fa-circle-exclamation" />
          Schedule already uploaded for this term.
        </div>
      )}

      <div
        className={`room-dropzone ${isDragging ? "dragging" : ""} ${file ? "has-file" : ""} ${isDuplicate ? "disabled" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!isDuplicate) setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        <input
          type="file"
          accept=".pdf,.xlsx,.xls"
          disabled={isDuplicate}
          onChange={(e) => {
            const selected = e.target.files[0];
            if (selected && !isDuplicate) onFileChange(roomName, selected);
          }}
          id={`file-${roomName}`}
        />
        <label htmlFor={`file-${roomName}`} className="dropzone-label">
          {file ? (
            <>
              <i className="fas fa-file-circle-check" />
              <span className="file-name">{file.name}</span>
              <span className="dropzone-hint">Click or drop to replace</span>
            </>
          ) : (
            <>
              <i className="fas fa-cloud-upload-alt" />
              <span>Click to browse or drag file here</span>
              <span className="dropzone-hint">PDF, XLSX, XLS</span>
            </>
          )}
        </label>
      </div>
    </div>
  );
}

function AddRoomBox({ availableRooms, onAdd, disabledRooms }) {
  const [isSelecting, setIsSelecting] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = availableRooms.filter((r) =>
    r.roomName.toLowerCase().includes(search.toLowerCase())
  );

  const closeSelecting = () => {
    setIsSelecting(false);
    setSearch("");
  };

  const handlePick = (roomName) => {
    onAdd(roomName);
    closeSelecting();
  };

  if (isSelecting) {
    return (
      <div className="add-room-box selecting">
        <div className="add-room-box-head">
          <span className="add-room-box-label">Select a room to add</span>
          <button
            type="button"
            className="add-room-close-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={closeSelecting}
            aria-label="Cancel"
          >
            <i className="fas fa-times" />
          </button>
        </div>

        <div className="add-room-search-wrap">
          <i className="fas fa-magnifying-glass" />
          <input
            type="text"
            autoFocus
            className="add-room-search"
            placeholder="Search room…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                closeSelecting();
              } else if (e.key === "Enter" && filtered.length > 0) {
                handlePick(filtered[0].roomName);
              }
            }}
          />
        </div>

        <div className="add-room-list">
          {filtered.length === 0 ? (
            <span className="add-room-empty">No matching rooms</span>
          ) : (
            filtered.map((r) => (
              <div
                key={r.id}
                className="add-room-option"
                onMouseDown={(e) => {
                  e.preventDefault();
                  handlePick(r.roomName);
                }}
              >
                <i className="fas fa-door-closed" />
                {r.roomName}
              </div>
            ))
          )}
        </div>

        <span className="add-room-footnote">Press Esc to cancel, Enter to pick the top result</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="add-room-box"
      onClick={() => setIsSelecting(true)}
      disabled={availableRooms.length === 0}
    >
      <i className="fas fa-plus" />
      <span className="add-room-label">
        {availableRooms.length === 0 ? "No rooms to add" : "Add Room"}
      </span>
      <span className="add-room-hint">
        {availableRooms.length === 0
          ? disabledRooms && disabledRooms.size > 0
            ? "All rooms already uploaded for this term"
            : "All rooms added"
          : "Select a room to upload its schedule"}
      </span>
    </button>
  );
}

export default function BulkScheduleUpload2() {
  const navigate = useNavigate();
  const location = useLocation();
  const { semester, schoolYear } = location.state || {};

  const [rooms, setRooms] = useState([]);
  const [selectedRooms, setSelectedRooms] = useState([]);
  const [loading, setLoading] = useState(false);

  // ─── Duplicate detection state ─────────────────────────────
  const [duplicateRoomNames, setDuplicateRoomNames] = useState(new Set());
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);

  const [toast, setToast] = useState({
    show: false,
    type: "success",
    title: "",
    message: "",
  });

  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    if (type !== "loading") {
      setTimeout(() => setToast((prev) => ({ ...prev, show: false })), 4000);
    }
  };

  // ─── Load rooms from Firestore ─────────────────────────────
  useEffect(() => {
    const unsub = onSnapshot(collection(db, "rooms"), (snapshot) => {
      const roomList = snapshot.docs.map((doc) => ({
        id: doc.id,
        roomName: doc.data().roomName,
      }));
      setRooms(roomList);
    });
    return () => unsub();
  }, []);

  // ─── Pre-flight duplicate scan for the current term ────────
  // Runs whenever the room list, semester, or school year changes.
  // Marks any room that already has a schedule for this term.
  useEffect(() => {
    if (!semester || !schoolYear || rooms.length === 0) return;
    let cancelled = false;

    (async () => {
      setCheckingDuplicates(true);
      try {
        const checks = rooms.map(async (room) => {
          const q = query(
            collection(db, "rooms", room.id, "schedules"),
            where("schoolYear", "==", schoolYear),
            where("semester", "==", semester)
          );
          const snap = await getDocs(q);
          return { roomName: room.roomName, hasExisting: !snap.empty };
        });
        const results = await Promise.all(checks);
        if (cancelled) return;
        const dups = new Set();
        results.forEach((r) => {
          if (r.hasExisting) dups.add(r.roomName);
        });
        setDuplicateRoomNames(dups);
      } catch (err) {
        console.error("Duplicate scan failed:", err);
        if (!cancelled) showToast("error", "Check Failed", "Could not verify existing schedules.");
      } finally {
        if (!cancelled) setCheckingDuplicates(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [rooms, semester, schoolYear]);

  // ─── Available rooms exclude duplicates + already-selected ─
  const availableRooms = rooms.filter(
    (r) =>
      !selectedRooms.some((sr) => sr.roomName === r.roomName) &&
      !duplicateRoomNames.has(r.roomName)
  );

  const hiddenDuplicateCount = duplicateRoomNames.size;

  const handleAddRoom = (roomName) => {
    if (selectedRooms.some((r) => r.roomName === roomName)) {
      showToast("error", "Duplicate", "Room already added.");
      return;
    }
    if (duplicateRoomNames.has(roomName)) {
      showToast(
        "error",
        "Schedule Already Exists",
        `Schedule already exists for ${schoolYear}, ${semester}, ${roomName}.`
      );
      return;
    }
    setSelectedRooms([...selectedRooms, { roomName, file: null }]);
  };

  const handleRemoveRoom = (roomName) => {
    setSelectedRooms(selectedRooms.filter((r) => r.roomName !== roomName));
  };

  const handleFileChange = (roomName, file) => {
    setSelectedRooms((prev) =>
      prev.map((r) => (r.roomName === roomName ? { ...r, file } : r))
    );
  };

  // ─── Final safety check right before parsing ────────────────
  const recheckDuplicatesForSelected = async () => {
    const dupRooms = [];
    await Promise.all(
      selectedRooms.map(async ({ roomName }) => {
        const room = rooms.find((r) => r.roomName === roomName);
        if (!room) return;
        const q = query(
          collection(db, "rooms", room.id, "schedules"),
          where("schoolYear", "==", schoolYear),
          where("semester", "==", semester)
        );
        const snap = await getDocs(q);
        if (!snap.empty) dupRooms.push(roomName);
      })
    );
    return dupRooms;
  };

  const handleProcessAll = async () => {
    const hasFile = selectedRooms.some((r) => r.file !== null);
    if (!hasFile) {
      showToast("error", "Incomplete", "Please attach at least one schedule file.");
      return;
    }

    if (!semester || !schoolYear) {
      showToast("error", "Missing Term", "Semester and school year are required.");
      return;
    }

    setLoading(true);
    showToast("loading", "Checking", "Verifying existing schedules...");

    try {
      // ── Final duplicate safety check (in case another user just uploaded)
      const duplicates = await recheckDuplicatesForSelected();
      if (duplicates.length > 0) {
        // refresh the set so UI hides them
        setDuplicateRoomNames((prev) => {
          const next = new Set(prev);
          duplicates.forEach((d) => next.add(d));
          return next;
        });
        // Drop them from the selected list
        setSelectedRooms((prev) =>
          prev.filter((r) => !duplicates.includes(r.roomName))
        );
        throw new Error(
          `Schedule already exists for ${schoolYear}, ${semester}, ${duplicates.join(", ")}.`
        );
      }

      showToast("loading", "Processing", "Parsing schedule files...");

      const roomData = [];

      for (const roomEntry of selectedRooms) {
        const { roomName, file } = roomEntry;
        if (!file) continue;

        let schedules = [];

        if (file.name.endsWith(".xlsx") || file.name.endsWith(".xls")) {
          schedules = await parseExcelFile(file);
        } else {
          const rawText = await extractRawText(file);
          schedules = await extractInChunks({
            rawText,
            endpoint: "/api/extract-schedule",
            payload: { room: roomName, semester, schoolYear },
            maxChunkChars: 2000,
            onProgress: (i, total) =>
              showToast("loading", "Processing", `${roomName}: ${i}/${total}...`),
          });
        }

        roomData.push({ room: roomName, schedules });
      }

      navigate("/local-registrar/bulk-upload-3", {
        state: { semester, schoolYear, roomData },
      });
    } catch (error) {
      console.error(error);
      showToast("error", "Processing Error", error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bulk-upload-page-two">
      <div className="bulk-header-two">
        <h1>Bulk Schedule Upload</h1>
        <p>Add rooms and upload schedule files.</p>
      </div>

      <div className="stepper-two">
        {steps.map((step, index) => (
          <div className="step-wrapper-two" key={step.number}>
            <div className="step-item-two">
              <div className={`step-circle-two ${step.number < 2 ? "completed" : ""} ${step.number === 2 ? "active" : ""}`}>
                {step.number < 2 ? <i className="fas fa-check" /> : step.number}
              </div>
              <span className={`step-label-two ${step.number === 2 ? "active" : ""}`}>{step.label}</span>
            </div>
            {index < steps.length - 1 && <div className={`step-line-two ${step.number === 1 ? "completed" : ""}`} />}
          </div>
        ))}
      </div>

      <div className="form-card-two">
        <div className="rooms-title-row">
          <div>
            <div className="upload-title-two">Rooms</div>
            <p className="upload-subtitle-two">
              Add each room, then click its box to upload the class schedule — PDF or Excel.
            </p>
          </div>
          {selectedRooms.length > 0 && (
            <span className="rooms-count-hint">
              {selectedRooms.filter((r) => r.file).length} of {selectedRooms.length} room
              {selectedRooms.length > 1 ? "s" : ""} have a file
            </span>
          )}
        </div>

        {checkingDuplicates && (
          <p className="room-grid-empty-hint">
            <i className="fas fa-spinner fa-spin" /> Checking existing schedules for {schoolYear} — {semester}…
          </p>
        )}

        {!checkingDuplicates && hiddenDuplicateCount > 0 && (
          <p className="room-grid-empty-hint">
            <i className="fas fa-circle-info" />{" "}
            {hiddenDuplicateCount} room{hiddenDuplicateCount > 1 ? "s" : ""} hidden — schedule
            already exists for {schoolYear}, {semester}.
          </p>
        )}

        {selectedRooms.length === 0 && !checkingDuplicates && (
          <p className="room-grid-empty-hint">
            <i className="fas fa-circle-info" /> No rooms added yet. Click the box below to add your first room.
          </p>
        )}

        <div className="room-grid">
          {selectedRooms.map(({ roomName, file }) => (
            <RoomCard
              key={roomName}
              roomName={roomName}
              file={file}
              onRemove={handleRemoveRoom}
              onFileChange={handleFileChange}
              isDuplicate={duplicateRoomNames.has(roomName)}
            />
          ))}

          <AddRoomBox
            availableRooms={availableRooms}
            onAdd={handleAddRoom}
            disabledRooms={duplicateRoomNames}
          />
        </div>

        {selectedRooms.length > 0 && (
          <p className="footer-hint-two">
            You can still add more rooms or swap files before continuing.
          </p>
        )}

        <div className="bulk-footer-two">
          <button className="btn-back-two" onClick={() => navigate(-1)}>Back</button>
          <button
            className="btn-next-two"
            onClick={handleProcessAll}
            disabled={loading || selectedRooms.length === 0 || checkingDuplicates}
          >
            {loading ? "Processing..." : "Next"}
          </button>
        </div>
      </div>

      <Toast
        show={toast.show}
        type={toast.type}
        title={toast.title}
        message={toast.message}
        onClose={() => setToast((prev) => ({ ...prev, show: false }))}
      />
    </div>
  );
}