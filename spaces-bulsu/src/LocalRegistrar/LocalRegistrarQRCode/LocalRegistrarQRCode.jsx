import { useEffect, useMemo, useRef, useState } from "react";
import "./local-registrar-qr-code.css";
import { collection, getDocs, addDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "../../firebase";
import QRCode from "react-qr-code";
import { toPng } from "html-to-image";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import Toast from "../../Popup/Toast/Toast";
import {
  getCurrentTerm,
  getTermLabel,
  getTermShortLabel,
} from "../../utils/academicTerm";

// ─── PDF Libraries & Logos ──────────────────────────────────────────
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import universityLogo from "../../assets/BSU-Logo.png";
import collegeLogo from "../../assets/CICT-Logo.png";

// ─── School Header ──────────────────────────────────────────────────
const SCHOOL_HEADER = {
  universityLogoUrl: universityLogo,
  collegeLogoUrl: collegeLogo,
  universityName: "Bulacan State University",
  collegeName: "College of Information and Communications Technology",
  systemName: "SpaceS CICT",
};

const CARDS_PER_PAGE = 9;

function LocalRegistrarQRCode() {
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [zipping, setZipping] = useState(false);
  const [exportingPDF, setExportingPDF] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [downloading, setDownloading] = useState({});

  // ─── CURRENT TERM (used to scope QR codes) ─────────────────
  const currentTerm = useMemo(() => getCurrentTerm(), []);
  const termLabel    = useMemo(() => getTermLabel(currentTerm), [currentTerm]);
  const termShort    = useMemo(() => getTermShortLabel(currentTerm), [currentTerm]);

  // Helper — build the term-aware public URL for a room
  const buildQrUrl = (roomId) =>
    `${window.location.origin}/room/${roomId}?term=${currentTerm}`;

  // ─── FILTER STATE ──────────────────────────────────────────
  const [selectedBuilding, setSelectedBuilding] = useState("All Buildings");
  const [selectedFloor, setSelectedFloor] = useState("All Floors");
  const [buildingSearch, setBuildingSearch] = useState("");
  const [showBuildingPicker, setShowBuildingPicker] = useState(false);

  const hiddenQrRefs = useRef({});
  const pdfQrRefs = useRef({});
  const cardRefs = useRef({});

  const [toast, setToast] = useState({
    show: false, type: "", title: "", message: "",
  });

  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    if (type !== "loading") {
      setTimeout(() => setToast((prev) => ({ ...prev, show: false })), 3000);
    }
  };

  useEffect(() => { loadRooms(); }, []);

  const loadRooms = async () => {
    setLoading(true);
    try {
      const snapshot = await getDocs(collection(db, "rooms"));
      const roomList = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .sort((a, b) => (a.roomName || "").localeCompare(b.roomName || ""));
      setRooms(roomList);
    } catch (err) {
      console.error(err);
      showToast("error", "Load Failed", "Could not load rooms.");
    }
    setLoading(false);
  };

  // ─── FILTERED ROOMS ────────────────────────────────────────
  const filteredRooms = useMemo(() => {
    let list = rooms;
    if (selectedBuilding !== "All Buildings") {
      list = list.filter((r) => r.building === selectedBuilding);
    }
    if (selectedFloor !== "All Floors") {
      list = list.filter((r) => String(r.floor) === String(selectedFloor));
    }
    return list;
  }, [rooms, selectedBuilding, selectedFloor]);

  // ─── Building options ──
  const buildingOptions = useMemo(() => {
    const set = new Set();
    rooms.forEach((r) => r.building && set.add(r.building));
    return ["All Buildings", ...Array.from(set).sort()];
  }, [rooms]);

  const filteredBuildings = useMemo(() => {
    const q = buildingSearch.trim().toLowerCase();
    if (!q) return buildingOptions;
    return buildingOptions.filter((b) => String(b).toLowerCase().includes(q));
  }, [buildingOptions, buildingSearch]);

  // ─── Floor options (based on selected building) ──
  const floorOptions = useMemo(() => {
    const set = new Set();
    rooms
      .filter((r) =>
        selectedBuilding === "All Buildings" || r.building === selectedBuilding
      )
      .forEach((r) => r.floor && set.add(String(r.floor)));
    const sorted = Array.from(set).sort((a, b) => {
      const na = parseInt(a, 10) || 0;
      const nb = parseInt(b, 10) || 0;
      return na - nb;
    });
    return ["All Floors", ...sorted];
  }, [rooms, selectedBuilding]);

  useEffect(() => {
    if (!floorOptions.includes(selectedFloor)) setSelectedFloor("All Floors");
  }, [floorOptions, selectedFloor]);

  useEffect(() => { setPage(1); }, [selectedBuilding, selectedFloor]);

  // ─── INDIVIDUAL QR DOWNLOAD (PNG) ────────────────────────────────
  const downloadSingleQR = async (room) => {
    setDownloading(prev => ({ ...prev, [room.id]: true }));
    showToast("loading", "Generating QR...", `Preparing ${room.roomName} QR code.`);

    try {
      const ref = cardRefs.current[room.id];
      if (!ref) throw new Error("QR element not found.");

      const dataUrl = await toPng(ref, {
        cacheBust: true, pixelRatio: 2, backgroundColor: "#ffffff",
      });

      const link = document.createElement("a");
      link.download = `${room.roomName || room.id}-QR-${currentTerm}.png`;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      showToast("success", "QR Downloaded", `${room.roomName} QR code saved.`);
    } catch (err) {
      console.error("Individual download failed:", err);
      showToast("error", "Download Failed", "Could not generate QR image.");
    }
    setDownloading(prev => ({ ...prev, [room.id]: false }));
  };

  // ─── DOWNLOAD ALL ZIP (filtered rooms only) ────────────────────
  const downloadAllZip = async () => {
    if (filteredRooms.length === 0) {
      showToast("error", "No Rooms", "No rooms to export under current filters.");
      return;
    }

    setZipping(true);
    showToast("loading", "Preparing ZIP...", "Generating QR codes...");

    try {
      const zip = new JSZip();

      for (const room of filteredRooms) {
        const ref = hiddenQrRefs.current[room.id];
        if (!ref) continue;

        const dataUrl = await toPng(ref, {
          cacheBust: true, pixelRatio: 2, backgroundColor: "#ffffff",
        });
        const base64 = dataUrl.split(",")[1];
        zip.file(`${room.roomName || room.id}-QR-${currentTerm}.png`, base64, { base64: true });
      }

      const blob = await zip.generateAsync({ type: "blob" });
      saveAs(blob, `SpaceS-QR-Codes-${currentTerm}.zip`);

      await addDoc(collection(db, "activityLogs"), {
        userId: auth.currentUser?.uid,
        user: auth.currentUser?.displayName || "Local Registrar",
        role: "Local Registrar",
        action: "Downloaded All QR ZIP",
        actionType: "success",
        target: "QR Codes",
        details: `Downloaded ${filteredRooms.length} QR codes as ZIP for ${termLabel} (Building: ${selectedBuilding}, Floor: ${selectedFloor}).`,
        status: "SUCCESS",
        timestamp: serverTimestamp(),
      });

      showToast("success", "ZIP Downloaded", `${filteredRooms.length} QR codes exported.`);
    } catch (err) {
      console.error("ZIP failed:", err);
      showToast("error", "ZIP Failed", "Could not generate ZIP file.");
    }
    setZipping(false);
    setExportMenuOpen(false);
  };

  // ─── EXPORT PDF (filtered rooms only) ─────────────────────────
  const exportPDF = async () => {
    if (filteredRooms.length === 0) {
      showToast("error", "No Rooms", "No rooms to export under current filters.");
      return;
    }

    setExportingPDF(true);
    showToast("loading", "Generating PDF...", "Please wait.");

    try {
      const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const marginX = 40;
      const marginY = 40;
      const logoSize = 40;
      const centerX = pageWidth / 2;

      if (SCHOOL_HEADER.universityLogoUrl) {
        pdf.addImage(SCHOOL_HEADER.universityLogoUrl, "PNG", marginX, 20, logoSize, logoSize);
      }
      if (SCHOOL_HEADER.collegeLogoUrl) {
        pdf.addImage(SCHOOL_HEADER.collegeLogoUrl, "PNG", pageWidth - marginX - logoSize, 20, logoSize, logoSize);
      }

      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(13);
      pdf.setTextColor(20, 27, 45);
      pdf.text(SCHOOL_HEADER.universityName, centerX, 34, { align: "center" });

      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      pdf.setTextColor(107, 114, 128);
      pdf.text(SCHOOL_HEADER.collegeName, centerX, 48, { align: "center" });
      pdf.text(SCHOOL_HEADER.systemName, centerX, 58, { align: "center" });

      pdf.setDrawColor(245, 124, 0);
      pdf.setLineWidth(1.5);
      pdf.line(marginX, 74, pageWidth - marginX, 74);

      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(14);
      pdf.setTextColor(245, 124, 0);
      pdf.text("QR Code Directory", marginX, 96);

      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      pdf.setTextColor(107, 114, 128);
      pdf.text(`Total Rooms: ${filteredRooms.length}`, marginX, 110);
      pdf.text(
        `Building: ${selectedBuilding}  ·  Floor: ${selectedFloor}`,
        marginX, 122
      );
      pdf.text(
        `Term: ${termLabel}`,
        marginX, 134
      );
      pdf.text(
        `Generated: ${new Date().toLocaleString()}`,
        pageWidth - marginX, 110, { align: "right" }
      );

      const qrSize = 100;
      const spacing = 20;
      const colsPerRow = 4;
      const totalWidth = colsPerRow * (qrSize + spacing) - spacing;
      const startX = (pageWidth - totalWidth) / 2;
      let currentX = startX;
      let currentY = 152;
      let col = 0;

      for (let i = 0; i < filteredRooms.length; i++) {
        const room = filteredRooms[i];

        if (currentY + qrSize + 30 > pageHeight - marginY) {
          pdf.addPage();
          currentY = marginY + 20;
          currentX = startX;
          col = 0;
        }

        try {
          const ref = pdfQrRefs.current[room.id];
          if (ref) {
            const dataUrl = await toPng(ref, {
              cacheBust: true, pixelRatio: 2, backgroundColor: "#ffffff",
            });
            pdf.addImage(dataUrl, "PNG", currentX, currentY, qrSize, qrSize);
          }
        } catch (err) {
          console.warn(`Could not render QR for ${room.id}`);
        }

        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(8);
        pdf.setTextColor(26, 26, 26);
        const name = room.roomName || room.id || "Room";
        const nameWidth = pdf.getStringUnitWidth(name) * 8 / pdf.internal.scaleFactor;
        const nameX = currentX + (qrSize / 2) - (nameWidth / 2);
        pdf.text(name, nameX, currentY + qrSize + 14);

        if (room.floor) {
          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(7);
          pdf.setTextColor(107, 114, 128);
          const floorText = `Floor ${room.floor}`;
          const floorWidth = pdf.getStringUnitWidth(floorText) * 7 / pdf.internal.scaleFactor;
          const floorX = currentX + (qrSize / 2) - (floorWidth / 2);
          pdf.text(floorText, floorX, currentY + qrSize + 26);
        }

        col++;
        if (col >= colsPerRow) {
          col = 0;
          currentX = startX;
          currentY += qrSize + 40;
        } else {
          currentX += qrSize + spacing;
        }
      }

      const pageCount = pdf.internal.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        pdf.setPage(i);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(7);
        pdf.setTextColor(150, 150, 150);
        pdf.text(`Page ${i} of ${pageCount}`, pageWidth - marginX, pageHeight - 16, { align: "right" });
        pdf.text(`${SCHOOL_HEADER.systemName} — Confidential`, marginX, pageHeight - 16);
      }

      pdf.save(`SpaceS-QR-Codes-${currentTerm}.pdf`);

      await addDoc(collection(db, "activityLogs"), {
        userId: auth.currentUser?.uid,
        user: auth.currentUser?.displayName || "Local Registrar",
        role: "Local Registrar",
        action: "Downloaded QR PDF",
        actionType: "success",
        target: "QR Codes",
        details: `Downloaded ${filteredRooms.length} QR codes as PDF for ${termLabel} (Building: ${selectedBuilding}, Floor: ${selectedFloor}).`,
        status: "SUCCESS",
        timestamp: serverTimestamp(),
      });

      showToast("success", "PDF Downloaded", `${filteredRooms.length} QR codes exported.`);
    } catch (err) {
      console.error("PDF failed:", err);
      showToast("error", "PDF Failed", "Could not generate PDF file.");
    }
    setExportingPDF(false);
    setExportMenuOpen(false);
  };

  const totalPages = Math.ceil(filteredRooms.length / CARDS_PER_PAGE);
  const currentRooms = useMemo(() => {
    const start = (page - 1) * CARDS_PER_PAGE;
    return filteredRooms.slice(start, start + CARDS_PER_PAGE);
  }, [filteredRooms, page]);

  const hasActiveFilters =
    selectedBuilding !== "All Buildings" || selectedFloor !== "All Floors";

  const clearFilters = () => {
    setSelectedBuilding("All Buildings");
    setSelectedFloor("All Floors");
  };

  return (
    <div className="lr-qr-code">
      <div className="lr-qr-page-header">
        <div>
          <h1>QR Code Management</h1>
          <p>Centralized hub for auto-generated digital access codes. Download and print labels for secure classroom identification.</p>
        </div>

        {/* ── Export Dropdown ── */}
        <div className="lr-qr-export-dropdown">
          <button
            className="lr-qr-download-btn"
            onClick={() => setExportMenuOpen(!exportMenuOpen)}
            disabled={loading || filteredRooms.length === 0}
          >
            <i className="fa-solid fa-download"></i> Export Report
            <i className={`fa-solid fa-chevron-down ${exportMenuOpen ? "rotate" : ""}`}></i>
          </button>
          {exportMenuOpen && (
            <div className="lr-qr-export-menu">
              <button onClick={exportPDF} disabled={exportingPDF}>
                <i className="fa-regular fa-file-pdf"></i> Export as PDF
                {exportingPDF && <span className="lr-qr-spinner-small"></span>}
              </button>
              <button onClick={downloadAllZip} disabled={zipping}>
                <i className="fa-solid fa-file-archive"></i> Download as ZIP
                {zipping && <span className="lr-qr-spinner-small"></span>}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── ACTIVE TERM BANNER ── */}
      <div className="lr-qr-term-banner">
        <div className="lr-qr-term-icon">
          <i className="fa-solid fa-calendar-check"></i>
        </div>

        <div className="lr-qr-term-text">
          <span className="lr-qr-term-label">Active Term</span>
          <strong className="lr-qr-term-value">{termLabel}</strong>
        </div>

        <div className="lr-qr-term-hint">
          <i className="fa-solid fa-circle-info"></i>
          <span>
            QR codes automatically expire at the end of this term.
            Re-export fresh codes at the start of each new term.
          </span>
        </div>
      </div>

      {/* ─── FILTER BAR ─── */}
      <div className="lr-qr-filter-bar">
        {/* Building picker */}
        <div className="lqr-buildingpicker">
          <button
            type="button"
            className={`lqr-building-trigger ${showBuildingPicker ? "open" : ""}`}
            onClick={() => { setBuildingSearch(""); setShowBuildingPicker((v) => !v); }}
          >
            <i className="fa-solid fa-building"></i>
            <span className="lqr-building-trigger-text">
              {selectedBuilding}
            </span>
            <i className={`fa-solid fa-chevron-down lqr-building-caret ${showBuildingPicker ? "open" : ""}`}></i>
          </button>

          {showBuildingPicker && (
            <>
              <div className="lqr-picker-clickaway" onClick={() => setShowBuildingPicker(false)}></div>
              <div className="lqr-building-popover">
                <span className="lqr-popover-arrow"></span>

                <div className="lqr-search-wrap">
                  <i className="fa-solid fa-magnifying-glass"></i>
                  <input type="text" className="lqr-search" placeholder="Search building..."
                    value={buildingSearch} onChange={(e) => setBuildingSearch(e.target.value)} autoFocus />
                  {buildingSearch && (
                    <button type="button" className="lqr-search-clear" onClick={() => setBuildingSearch("")}>
                      <i className="fa-solid fa-xmark"></i>
                    </button>
                  )}
                </div>

                <div className="lqr-building-list">
                  {filteredBuildings.length === 0 ? (
                    <div className="lqr-picker-empty">
                      <i className="fa-regular fa-face-frown"></i>
                      <span>No buildings match.</span>
                    </div>
                  ) : (
                    filteredBuildings.map((b) => {
                      const isActive = b === selectedBuilding;
                      return (
                        <button type="button" key={b}
                          className={`lqr-building-option ${isActive ? "is-active" : ""}`}
                          onClick={() => {
                            setSelectedBuilding(b);
                            setSelectedFloor("All Floors");
                            setShowBuildingPicker(false);
                            setBuildingSearch("");
                          }}>
                          <div className="lqr-building-option-icon">
                            <i className="fa-solid fa-building"></i>
                          </div>
                          <span className="lqr-building-option-name">{b}</span>
                          {isActive && <i className="fa-solid fa-circle-check lqr-building-option-check"></i>}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Floor pills */}
        <div className="lqr-floor-pills">
          {floorOptions.map((f) => (
            <button
              key={f}
              type="button"
              className={`lqr-floor-pill ${selectedFloor === f ? "active" : ""}`}
              onClick={() => setSelectedFloor(f)}
            >
              {f === "All Floors" ? "All Floors" : `${f} Floor`}
            </button>
          ))}
        </div>

        {hasActiveFilters && (
          <button className="lqr-clear-btn" onClick={clearFilters}>
            <i className="fa-solid fa-filter-circle-xmark"></i> Clear
          </button>
        )}

        <span className="lqr-result-count">
          {filteredRooms.length} room{filteredRooms.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Hidden QR divs para sa ZIP generation — filtered rooms */}
      <div style={{ position: "absolute", left: "-9999px", top: "-9999px" }}>
        {filteredRooms.map(room => (
          <div key={`hidden-${room.id}`}
            ref={el => hiddenQrRefs.current[room.id] = el}
            style={{
              background: "#fff", padding: 18, borderRadius: 10,
              display: "flex", flexDirection: "column", alignItems: "center",
              gap: 10, width: "fit-content",
            }}>
            <QRCode value={buildQrUrl(room.id)} size={220} />
            <strong>{room.roomName}</strong>
          </div>
        ))}
      </div>

      {/* Hidden QR divs para sa PDF generation — filtered rooms */}
      <div style={{ position: "absolute", left: "-9999px", top: "-9999px" }}>
        {filteredRooms.map(room => (
          <div key={`pdf-${room.id}`}
            ref={el => pdfQrRefs.current[room.id] = el}
            style={{
              background: "#fff", padding: 10, borderRadius: 8,
              display: "flex", flexDirection: "column", alignItems: "center",
              gap: 6, width: "fit-content",
            }}>
            <QRCode value={buildQrUrl(room.id)} size={150} />
            <strong style={{ fontSize: 12 }}>{room.roomName}</strong>
          </div>
        ))}
      </div>

      <div className="white-box-qr">
        {loading ? (
          <div className="qr-loading">
            <span className="qr-spinner"></span>
            <p>Loading QR Codes...</p>
          </div>
        ) : filteredRooms.length === 0 ? (
          <div className="qr-empty">
            <i className="fa-solid fa-qrcode"></i>
            <p>No rooms under current filter</p>
            <span className="qr-empty-hint">
              Try clearing the building or floor filter.
            </span>
          </div>
        ) : (
          <>
            <div className="qr-cards-grid">
              {currentRooms.map(room => (
                <div key={room.id} className="qr-card-item"
                  ref={el => cardRefs.current[room.id] = el}>
                  <div className="qr-card-content">
                    <QRCode value={buildQrUrl(room.id)} size={160} />
                    <div className="qr-room-name">{room.roomName}</div>
                    {room.floor && <div className="qr-room-floor">Floor {room.floor}</div>}
                    <div className="qr-term-badge">{termShort}</div>
                    <button
                      className="qr-download-single-btn"
                      onClick={() => downloadSingleQR(room)}
                      disabled={downloading[room.id]}
                    >
                      {downloading[room.id] ? (
                        <span className="qr-spinner-small"></span>
                      ) : (
                        <><i className="fa-solid fa-download"></i> Download PNG</>
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="qr-pagination">
              <span className="qr-showing">
                Showing {currentRooms.length === 0 ? 0 : (page - 1) * CARDS_PER_PAGE + 1}
                {" - "}
                {(page - 1) * CARDS_PER_PAGE + currentRooms.length}
                {" of "}
                {filteredRooms.length} rooms
              </span>

              <div className="qr-pagination-controls">
                <i className="fa-solid fa-chevron-left"
                  style={{ opacity: page === 1 ? 0.4 : 1, cursor: page === 1 ? "default" : "pointer" }}
                  onClick={() => { if (page > 1) setPage(page - 1); }} />
                <span>{page} / {Math.max(totalPages, 1)}</span>
                <i className="fa-solid fa-chevron-right"
                  style={{ opacity: page === totalPages || totalPages === 0 ? 0.4 : 1, cursor: page === totalPages || totalPages === 0 ? "default" : "pointer" }}
                  onClick={() => { if (page < totalPages) setPage(page + 1); }} />
              </div>
            </div>
          </>
        )}
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

export default LocalRegistrarQRCode;