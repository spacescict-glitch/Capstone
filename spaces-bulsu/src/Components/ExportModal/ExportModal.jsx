import { useState, useEffect, useMemo, useRef } from "react";
import "./export-modal.css";

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const WEEKDAY_LABELS = ["Su","Mo","Tu","We","Th","Fr","Sa"];

const toDateInputValue = (date) => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const formatPrettyDate = (isoStr) => {
  if (!isoStr) return "—";
  const d = new Date(isoStr + "T00:00:00");
  if (Number.isNaN(d.getTime())) return isoStr;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

const buildCalendarGrid = (year, month) => {
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < startOffset; i++) {
    cells.push({
      day: daysInPrevMonth - startOffset + 1 + i,
      inMonth: false,
      date: new Date(year, month - 1, daysInPrevMonth - startOffset + 1 + i),
    });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, inMonth: true, date: new Date(year, month, d) });
  }
  while (cells.length % 7 !== 0 || cells.length < 42) {
    const nextIndex = cells.length - startOffset - daysInMonth + 1;
    cells.push({ day: nextIndex, inMonth: false, date: new Date(year, month + 1, nextIndex) });
    if (cells.length >= 42) break;
  }
  return cells;
};

const getTodayISO = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
};

function DatePickerInput({ value, onChange, placeholder = "Select a date", min, max, label, disabled }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const [cursor, setCursor] = useState(() => {
    const base = value ? new Date(value + "T00:00:00") : new Date();
    return { year: base.getFullYear(), month: base.getMonth() };
  });

  useEffect(() => {
    const handle = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    document.addEventListener("touchstart", handle);
    return () => {
      document.removeEventListener("mousedown", handle);
      document.removeEventListener("touchstart", handle);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const base = value ? new Date(value + "T00:00:00") : new Date();
    setCursor({ year: base.getFullYear(), month: base.getMonth() });
  }, [open, value]);

  const minDate = min ? new Date(min + "T00:00:00") : null;
  const maxDate = max ? new Date(max + "T00:00:00") : null;

  const handleDayClick = (cell) => {
    if (disabled) return;
    const cellStr = toDateInputValue(cell.date);
    if (minDate && cell.date < minDate) return;
    if (maxDate && cell.date > maxDate) return;
    onChange(cellStr);
    setOpen(false);
  };

  return (
    <div className="dp-wrap" ref={wrapRef}>
      {label && <label className="dp-label">{label}</label>}
      <button
        type="button"
        className={`dp-trigger ${open ? "open" : ""} ${!value ? "is-placeholder" : ""}`}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
      >
        <i className="fa-regular fa-calendar dp-trigger-icon" />
        <span className="dp-trigger-text">{value ? formatPrettyDate(value) : placeholder}</span>
        {value && !disabled ? (
          <span
            className="dp-clear"
            onClick={(e) => { e.stopPropagation(); onChange(""); }}
            role="button"
            aria-label="Clear date"
          >
            <i className="fa-solid fa-xmark" />
          </span>
        ) : (
          <i className={`fa-solid fa-chevron-down dp-caret ${open ? "open" : ""}`} />
        )}
      </button>

      {open && (
        <>
          <div className="dp-clickaway" onClick={() => setOpen(false)} />
          <div className="dp-popover">
            <span className="dp-arrow" />
            <div className="dp-cal-header">
              <button type="button" className="dp-cal-nav" onClick={() => setCursor((c) => {
                const m = c.month - 1;
                return m < 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month: m };
              })}>
                <i className="fa-solid fa-chevron-left" />
              </button>
              <span className="dp-cal-title">{MONTH_NAMES[cursor.month]} {cursor.year}</span>
              <button type="button" className="dp-cal-nav" onClick={() => setCursor((c) => {
                const m = c.month + 1;
                return m > 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: m };
              })}>
                <i className="fa-solid fa-chevron-right" />
              </button>
            </div>
            <div className="dp-cal-weekdays">
              {WEEKDAY_LABELS.map((w) => <span key={w}>{w}</span>)}
            </div>
            <div className="dp-cal-grid">
              {buildCalendarGrid(cursor.year, cursor.month).map((cell, i) => {
                const cellStr = toDateInputValue(cell.date);
                const isSelected = cellStr === value;
                const isToday = cellStr === toDateInputValue(new Date());
                const isDisabled = (minDate && cell.date < minDate) || (maxDate && cell.date > maxDate);
                return (
                  <button
                    type="button"
                    key={i}
                    disabled={isDisabled}
                    className={[
                      "dp-cal-day",
                      !cell.inMonth && "is-outside",
                      isSelected && "is-selected",
                      isToday && !isSelected && "is-today",
                      isDisabled && "is-disabled",
                    ].filter(Boolean).join(" ")}
                    onClick={() => handleDayClick(cell)}
                  >
                    {cell.day}
                  </button>
                );
              })}
            </div>
            <div className="dp-cal-footer">
              <button type="button" className="dp-cal-footer-btn" onClick={() => {
                const t = new Date();
                setCursor({ year: t.getFullYear(), month: t.getMonth() });
                if (minDate && t < minDate) return;
                if (maxDate && t > maxDate) return;
                onChange(toDateInputValue(t));
                setOpen(false);
              }}>Today</button>
              <button type="button" className="dp-cal-footer-btn muted" onClick={() => setOpen(false)}>Close</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function ExportModal({
  isOpen,
  onClose,
  title = "Export Report",
  filenamePrefix = "SpaceSCICT_Report",
  exporting = false,
  onExport,
}) {
  const [range, setRange] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [format, setFormat] = useState("csv");

  useEffect(() => {
    if (isOpen) {
      setRange("all");
      setFrom("");
      setTo("");
      setFormat("csv");
    }
  }, [isOpen]);

  const dateError = useMemo(() => {
    if (range !== "range") return "";
    if (!from || !to) return "";
    if (new Date(to) < new Date(from)) return "The 'To' date cannot be earlier than the 'From' date.";
    return "";
  }, [range, from, to]);

  const isValid = useMemo(() => {
    if (range === "all") return true;
    if (!from || !to) return false;
    if (dateError) return false;
    return true;
  }, [range, from, to, dateError]);

  const handleClose = () => { if (!exporting) onClose?.(); };

  const handleExport = async () => {
    if (!isValid || exporting) return;
    await onExport?.({ range, from, to, format });
  };

  if (!isOpen) return null;
  const previewFilename = `${filenamePrefix}(${getTodayISO()}).${format}`;

  return (
    <div className="export-modal-overlay" onClick={handleClose}>
      <div className="export-modal" onClick={(e) => e.stopPropagation()}>
        <div className="export-modal-header">
          <div className="export-modal-title">
            <i className="fa-solid fa-download"></i>
            <h3>{title}</h3>
          </div>
          <button type="button" className="export-modal-close" onClick={handleClose} disabled={exporting} aria-label="Close">
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div className="export-modal-body">
          <div className="export-section">
            <label className="export-section-label">DATE RANGE</label>
            <div className="export-range-options">
              <button type="button" className={`export-range-btn ${range === "all" ? "active" : ""}`} onClick={() => setRange("all")} disabled={exporting}>
                <i className="fa-solid fa-infinity"></i>
                <span>All Records</span>
              </button>
              <button type="button" className={`export-range-btn ${range === "range" ? "active" : ""}`} onClick={() => setRange("range")} disabled={exporting}>
                <i className="fa-regular fa-calendar"></i>
                <span>Custom Range</span>
              </button>
            </div>
          </div>

          {range === "range" && (
            <div className="export-section">
              <div className="export-date-row">
                <DatePickerInput label="FROM" value={from} onChange={setFrom} placeholder="Pick start date" max={to || undefined} disabled={exporting} />
                <DatePickerInput label="TO" value={to} onChange={setTo} placeholder="Pick end date" min={from || undefined} disabled={exporting} />
              </div>
              {dateError && (
                <p className="export-error">
                  <i className="fa-solid fa-circle-exclamation"></i> {dateError}
                </p>
              )}
              {!dateError && from && to && (
                <p className="export-range-summary">
                  <i className="fa-solid fa-circle-check"></i>
                  Exporting from <strong>{formatPrettyDate(from)}</strong> to <strong>{formatPrettyDate(to)}</strong>
                </p>
              )}
            </div>
          )}

          <div className="export-section">
            <label className="export-section-label">FORMAT</label>
            <div className="export-format-options">
              <button type="button" className={`export-format-btn ${format === "csv" ? "active" : ""}`} onClick={() => setFormat("csv")} disabled={exporting}>
                <i className="fa-solid fa-file-csv"></i>
                <div className="export-format-text">
                  <span className="export-format-name">CSV</span>
                  <span className="export-format-desc">Spreadsheet format</span>
                </div>
              </button>
              <button type="button" className={`export-format-btn ${format === "pdf" ? "active" : ""}`} onClick={() => setFormat("pdf")} disabled={exporting}>
                <i className="fa-solid fa-file-pdf"></i>
                <div className="export-format-text">
                  <span className="export-format-name">PDF</span>
                  <span className="export-format-desc">Formatted document</span>
                </div>
              </button>
            </div>
          </div>

          <div className="export-file-preview">
            <i className="fa-solid fa-file-arrow-down"></i>
            <span>File: <strong>{previewFilename}</strong></span>
          </div>
        </div>

        <div className="export-modal-footer">
          <button type="button" className="export-btn cancel" onClick={handleClose} disabled={exporting}>Cancel</button>
          <button type="button" className="export-btn confirm" onClick={handleExport} disabled={!isValid || exporting}>
            {exporting ? (
              <><i className="fa-solid fa-circle-notch fa-spin"></i> Exporting...</>
            ) : (
              <><i className="fa-solid fa-download"></i> Export {format.toUpperCase()}</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}