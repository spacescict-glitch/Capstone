import { useState, useRef, useEffect } from "react";
import "./bulk-schedule-upload1.css";
import { useNavigate } from "react-router-dom";
import { collection, onSnapshot, getDocs, query, where } from "firebase/firestore";
import { db } from "../../../firebase";
import Toast from "../../../Popup/Toast/Toast";

const steps = [
  { number: 1, label: "SETUP" },
  { number: 2, label: "UPLOAD" },
  { number: 3, label: "CALENDAR VIEW" },
  { number: 4, label: "CONFIRM" },
];

const semesters = ["1st Semester", "2nd Semester"];
const currentYear = new Date().getFullYear();
const schoolYears = [
  `${currentYear}-${currentYear + 1}`,
  `${currentYear + 1}-${currentYear + 2}`,
  `${currentYear + 2}-${currentYear + 3}`,
];

function CustomDropdown({ placeholder, options, value, onChange }) {
  // (same as original – unchanged)
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);
  return (
    <div className={`custom-select-one ${open ? "open" : ""}`} ref={ref}>
      <div
        className="custom-select-one__trigger"
        onClick={() => options.length > 0 && setOpen(!open)}
      >
        <span className={value ? "selected-value" : "placeholder"}>
          {value || placeholder}
        </span>
        <i
          className={`fas fa-chevron-down custom-select-one__icon ${open ? "rotated" : ""}`}
        />
      </div>
      {open && options.length > 0 && (
        <div className="custom-select-one__dropdown">
          {options.map((opt, index) => (
            <div
              key={index}
              className={`custom-select-one__option ${value === opt ? "active" : ""}`}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
            >
              {opt}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function BulkScheduleUpload1() {
  const navigate = useNavigate();
  const [semester, setSemester] = useState("");
  const [schoolYear, setSchoolYear] = useState("");
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

  const handleNext = () => {
    if (!semester || !schoolYear) {
      showToast("error", "Incomplete", "Please select both Semester and School Year.");
      return;
    }
    navigate("/admin/bulk-upload-2", { state: { semester, schoolYear } });
  };

  return (
    <div className="bulk-upload-page-one">
      <div className="bulk-header-one">
        <h1>Bulk Schedule Upload</h1>
        <p>Follow the steps to upload and process schedules.</p>
      </div>

      <div className="stepper-one">
        {steps.map((step, index) => (
          <div className="step-wrapper-one" key={step.number}>
            <div className="step-item-one">
              <div className={`step-circle-one ${step.number === 1 ? "active" : ""}`}>
                {step.number}
              </div>
              <span className={`step-label-one ${step.number === 1 ? "active" : ""}`}>
                {step.label}
              </span>
            </div>
            {index < steps.length - 1 && <div className="step-line-one" />}
          </div>
        ))}
      </div>

      <div className="form-card-one">
        <div className="form-group-one">
          <label>Semester</label>
          <CustomDropdown
            placeholder="Select Semester"
            options={semesters}
            value={semester}
            onChange={setSemester}
          />
        </div>
        <div className="form-group-one">
          <label>School Year</label>
          <CustomDropdown
            placeholder="Select School Year"
            options={schoolYears}
            value={schoolYear}
            onChange={setSchoolYear}
          />
        </div>
      </div>

      <div className="bulk-footer-one" style={{ justifyContent: "flex-end" }}>
        <button className="btn-next-one" onClick={handleNext}>
          Next
        </button>
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