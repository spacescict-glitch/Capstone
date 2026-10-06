import "./Toast.css";

const Toast = ({
  show,
  type = "success",
  title,
  message,
  onClose,
}) => {
  if (!show) return null;

  const icons = {
    success: "✓",
    error: "✕",
    loading: "⟳",
  };

  return (
    <div className={`toast-container ${type}`}>
      {/* Accent + progress bar handled via ::before and .toast-progress */}
      <div className="toast-icon">{icons[type]}</div>

      <div className="toast-content">
        <h3>{title}</h3>
        <p>{message}</p>
      </div>

      <button
        className="toast-close"
        onClick={onClose}
        aria-label="Close notification"
      >
        ✕
      </button>

      {type !== "loading" && <div className="toast-progress" />}
    </div>
  );
};

export default Toast;