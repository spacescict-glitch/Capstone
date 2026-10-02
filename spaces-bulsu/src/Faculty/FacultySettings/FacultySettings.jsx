import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import "./faculty-settings.css";
import { auth, db } from "../../firebase";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import {
  onAuthStateChanged,
  EmailAuthProvider,
  reauthenticateWithCredential,
  verifyBeforeUpdateEmail,
  updatePassword,
} from "firebase/auth";
import Toast from "../../Popup/Toast/Toast";
import OtpInput from "../../Components/OtpInput/OtpInput";
import {
  createAndSendCode,
  verifyCode,
  CODE_LENGTH,
  CODE_TTL_MIN,
} from "../../utils/verification";
import { logActivity } from "../../utils/logActivity";
import {
  getPushEnabled,
  setPushEnabled as persistPushEnabled,
  getBrowserPermission,
  requestPushPermission,
} from "../../utils/pushNotifications";

// ── Password rules ────────────────────────────────────────────────
const passwordChecks = (pw) => ({
  length:    pw.length >= 8,
  uppercase: /[A-Z]/.test(pw),
  lowercase: /[a-z]/.test(pw),
  number:    /[0-9]/.test(pw),
  special:   /[!@#$%^&*()_\-+=\[\]{};:'",.<>/?\\|`~]/.test(pw),
});
const isStrong = (pw) => Object.values(passwordChecks(pw)).every(Boolean);

// ── FAQ items ─────────────────────────────────────────────────────
const FAQ_ITEMS = [
  {
    question: "What is SpaceS CICT?",
    answer:
      "SpaceS CICT is a web and mobile-based platform for classroom allocation and scheduling at the College of Information and Communications Technology (CICT), Bulacan State University.",
  },
  {
    question: "Who can create an account in the system?",
    answer:
      "Only the Admin has access to create user accounts for the Local Registrar, Clerk, and Faculty Members.",
  },
  {
    question: "I forgot my password. What should I do?",
    answer:
      "Just click 'Forgot Password?' on the login page. You will receive a password reset link at your registered email address.",
  },
  {
    question: "Why is my account blocked?",
    answer:
      "Your account is automatically blocked after 5 consecutive failed login attempts, for security purposes.",
  },
  {
    question: "How do I request a room reservation?",
    answer:
      "As a Faculty member, go to the Reservations page and click the '+' button. Fill in the course title, purpose, date, and time slot you need.",
  },
  {
    question: "How do I know if a room is available?",
    answer:
      "You can view the real-time status of each classroom on the Rooms page. You can also scan the QR code posted on each room's door.",
  },
  {
    question: "What should I do if I won't be using my assigned room?",
    answer:
      "On the Schedule page, select the class or booking you want to release, provide a reason, and confirm.",
  },
  {
    question: "Who can I contact if I have a problem with the system?",
    answer:
      "You can click 'Contact Support' or directly email us at spaces-bulsu@outlook.com or spacescict@gmail.com.",
  },
];

export default function FacultySettings() {
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [user, setUser]       = useState(null);
  const [email, setEmail]     = useState("");

  // ── Security section — password change ─────────────────────────
  const [pwForm, setPwForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew]         = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const [pwStep, setPwStep] = useState("password");
  const [pwCode, setPwCode] = useState(Array(CODE_LENGTH).fill(""));
  const [pwResendIn, setPwResendIn] = useState(0);

  // ── Push notification toggle ───────────────────────────────────
  const [pushEnabled, setPushEnabledState] = useState(() => getPushEnabled());
  const [browserPermission, setBrowserPermission] = useState(() =>
    getBrowserPermission()
  );

  // ── Modals ─────────────────────────────────────────────────────
  const [showEmailModal, setShowEmailModal]   = useState(false);
  const [emailForm, setEmailForm]   = useState({ currentPassword: "", newEmail: "" });

  // Email sub-flow state
  const [emailStep, setEmailStep] = useState("form");
  const [emailCode, setEmailCode] = useState(Array(CODE_LENGTH).fill(""));
  const [emailResendIn, setEmailResendIn] = useState(0);

  // ── Info modal ─────────────────────────────────────────────────
  const [activeInfoModal, setActiveInfoModal] = useState(null);
  const [openFaqIndex, setOpenFaqIndex] = useState(null);

  const [busy, setBusy] = useState(false);

  const [toast, setToast] = useState({
    show: false, type: "success", title: "", message: "",
  });
  const showToast = (type, title, message) => {
    setToast({ show: true, type, title, message });
    setTimeout(
      () => setToast((prev) => ({ ...prev, show: false })),
      3500
    );
  };

  // ✅ Helper: build the activity log payload from current user data
  const logSettingsActivity = async (action, target, details = {}) => {
    try {
      const firebaseUser = auth.currentUser;
      if (!firebaseUser) return;

      const snap = await getDoc(doc(db, "users", firebaseUser.uid));
      const userData = snap.exists() ? snap.data() : {};
      const fullName =
        `${userData.firstName || ""} ${userData.lastName || ""}`.trim() ||
        firebaseUser.email ||
        "Faculty";

      await logActivity({
        userId: firebaseUser.uid,
        user: fullName,
        role: userData.role || "Faculty",
        action,
        actionType: "edit",
        target,
        status: "Success",
        details,
      });
    } catch (err) {
      console.error("logSettingsActivity failed:", err);
    }
  };

  // ── Load user ──────────────────────────────────────────────────
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) { setLoading(false); return; }
      setUser(u);
      try {
        const snap = await getDoc(doc(db, "users", u.uid));
        setEmail(
          snap.exists()
            ? snap.data().email || u.email || ""
            : u.email || ""
        );
      } catch (err) { console.error(err); }
      finally { setLoading(false); }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    const sync = () => setBrowserPermission(getBrowserPermission());
    sync();
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === "Escape") setActiveInfoModal(null);
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, []);

  useEffect(() => { setOpenFaqIndex(null); }, [activeInfoModal]);

  useEffect(() => {
    if (pwResendIn <= 0) return;
    const t = setInterval(
      () => setPwResendIn((s) => (s > 0 ? s - 1 : 0)),
      1000
    );
    return () => clearInterval(t);
  }, [pwResendIn]);

  useEffect(() => {
    if (emailResendIn <= 0) return;
    const t = setInterval(
      () => setEmailResendIn((s) => (s > 0 ? s - 1 : 0)),
      1000
    );
    return () => clearInterval(t);
  }, [emailResendIn]);

  const reauthenticate = async (currentPassword) => {
    const cred = EmailAuthProvider.credential(user.email, currentPassword);
    await reauthenticateWithCredential(user, cred);
  };

  const resetPwForm = () => {
    setPwForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
    setShowCurrent(false); setShowNew(false); setShowConfirm(false);
    setPwStep("password");
    setPwCode(Array(CODE_LENGTH).fill(""));
  };

  const closeEmailModal = () => {
    setShowEmailModal(false);
    setEmailForm({ currentPassword: "", newEmail: "" });
    setEmailStep("form");
    setEmailCode(Array(CODE_LENGTH).fill(""));
  };

  // ══════════════════════════════════════════════════════════════
  // PUSH NOTIFICATION TOGGLE
  // ══════════════════════════════════════════════════════════════
  const handlePushToggle = async (e) => {
    const wantsOn = e.target.checked;

    if (wantsOn) {
      const perm = await requestPushPermission();
      setBrowserPermission(perm);

      if (perm === "unsupported") {
        showToast(
          "error",
          "Not Supported",
          "Your browser doesn't support push notifications."
        );
        return;
      }

      if (perm === "denied") {
        showToast(
          "error",
          "Notifications Blocked",
          "Your browser has blocked notifications. Enable them in your browser site settings to receive alerts."
        );
        return;
      }

      if (perm === "granted") {
        persistPushEnabled(true);
        setPushEnabledState(true);
        showToast(
          "success",
          "Notifications Enabled",
          "You'll now receive real-time alerts for reservations, approvals, and schedules."
        );
      }
      return;
    }

    persistPushEnabled(false);
    setPushEnabledState(false);
    showToast(
      "success",
      "Notifications Disabled",
      "Push notifications have been turned off."
    );
  };

  const pushSubText = (() => {
    if (browserPermission === "unsupported") return "Not supported on this browser";
    if (browserPermission === "denied") return "Blocked by browser — check site settings";
    if (browserPermission === "default" && pushEnabled === false)
      return "Click toggle to allow alerts";
    if (pushEnabled) return "Real-time alerts are ON";
    return "Turned off";
  })();

  // ── PASSWORD FLOW ──────────────────────────────────────────────
  const handlePasswordStepOne = async (e) => {
    e.preventDefault();
    const { currentPassword, newPassword, confirmPassword } = pwForm;

    if (!currentPassword)
      return showToast("error", "Missing Password", "Please enter your current password.");

    if (newPassword || confirmPassword) {
      if (!isStrong(newPassword))
        return showToast("error", "Weak Password", "New password does not meet all requirements.");
      if (newPassword !== confirmPassword)
        return showToast("error", "Passwords Don't Match", "New and confirm password must match.");
      if (newPassword === currentPassword)
        return showToast("error", "Same Password", "New password must differ from current one.");
    }

    setBusy(true);
    try {
      await reauthenticate(currentPassword);

      await createAndSendCode({
        email: user.email,
        purpose: "password-change",
        name: "",
      });

      setPwCode(Array(CODE_LENGTH).fill(""));
      setPwStep("code");
      setPwResendIn(30);
      showToast("success", "Code Sent", `A 6-digit code was sent to ${user.email}.`);
    } catch (err) {
      console.error(err);
      let msg = err?.message || "Verification failed.";
      if (err.code === "auth/wrong-password")
        msg = "Your current password is incorrect.";
      if (err.code === "auth/too-many-requests")
        msg = "Too many attempts. Try again later.";
      showToast("error", "Verification Failed", msg);
    } finally {
      setBusy(false);
    }
  };

  const handlePasswordVerifyCode = async () => {
    const entered = pwCode.join("");
    if (entered.length !== CODE_LENGTH)
      return showToast("error", "Invalid Code", `Enter the ${CODE_LENGTH}-digit code.`);

    setBusy(true);
    try {
      await verifyCode({ email: user.email, purpose: "password-change", entered });
      setPwStep("newpw");
      showToast("success", "Verified", "You can now set your new password.");
    } catch (err) {
      showToast("error", "Verification Failed", err.message);
    } finally {
      setBusy(false);
    }
  };

  const handlePasswordFinalSubmit = async (e) => {
    e.preventDefault();
    const { newPassword, confirmPassword, currentPassword } = pwForm;

    if (!isStrong(newPassword))
      return showToast("error", "Weak Password", "Your new password does not meet all requirements.");
    if (newPassword !== confirmPassword)
      return showToast("error", "Passwords Don't Match", "New and confirm password must match.");

    setBusy(true);
    try {
      await reauthenticate(currentPassword);
      await updatePassword(user, newPassword);

      await logSettingsActivity(
        "Changed password",
        "Account Security",
        { method: "verified-code" }
      );

      showToast("success", "Password Updated", "Your password has been changed successfully.");
      resetPwForm();
    } catch (err) {
      console.error(err);
      let msg = err?.message || "Update failed.";
      if (err.code === "auth/wrong-password")
        msg = "Your current password is incorrect.";
      if (err.code === "auth/weak-password")
        msg = "New password is too weak.";
      if (err.code === "auth/requires-recent-login")
        msg = "Please log out and log back in, then try again.";
      showToast("error", "Update Failed", msg);
    } finally {
      setBusy(false);
    }
  };

  const resendPwCode = async () => {
    if (pwResendIn > 0) return;
    try {
      await createAndSendCode({ email: user.email, purpose: "password-change" });
      setPwCode(Array(CODE_LENGTH).fill(""));
      setPwResendIn(30);
    } catch (err) {
      showToast("error", "Resend Failed", err?.text || err?.message || "Try again.");
    }
  };

  // ── EMAIL FLOW ─────────────────────────────────────────────────
  const handleEmailStepOne = async (e) => {
    e.preventDefault();
    const { currentPassword, newEmail } = emailForm;

    if (!currentPassword)
      return showToast("error", "Missing Password", "Please enter your current password.");
    if (!newEmail || !/^\S+@\S+\.\S+$/.test(newEmail))
      return showToast("error", "Invalid Email", "Please enter a valid new email address.");
    if (newEmail.toLowerCase() === email.toLowerCase())
      return showToast("error", "Same Email", "New email is the same as your current email.");

    setBusy(true);
    try {
      await reauthenticate(currentPassword);

      await createAndSendCode({
        email: newEmail,
        purpose: "email-change",
        name: "",
      });

      setEmailCode(Array(CODE_LENGTH).fill(""));
      setEmailStep("code");
      setEmailResendIn(30);
      showToast("success", "Code Sent", `A 6-digit code was sent to ${newEmail}.`);
    } catch (err) {
      console.error(err);
      let msg = err?.message || "Verification failed.";
      if (err.code === "auth/wrong-password")
        msg = "Your current password is incorrect.";
      if (err.code === "auth/too-many-requests")
        msg = "Too many attempts. Try again later.";
      showToast("error", "Verification Failed", msg);
    } finally {
      setBusy(false);
    }
  };

  // ✅ verifyBeforeUpdateEmail instead of updateEmail
  const handleEmailVerifyAndUpdate = async () => {
    const entered = emailCode.join("");
    if (entered.length !== CODE_LENGTH)
      return showToast("error", "Invalid Code", `Enter the ${CODE_LENGTH}-digit code.`);

    const { currentPassword, newEmail } = emailForm;
    const oldEmail = email;
    setBusy(true);
    try {
      await verifyCode({ email: newEmail, purpose: "email-change", entered });

      await reauthenticate(currentPassword);

      // Sends verification link to new email (works with Email Enumeration Protection)
      await verifyBeforeUpdateEmail(user, newEmail);

      await updateDoc(doc(db, "users", user.uid), { email: newEmail });

      await logSettingsActivity(
        "Changed email address",
        "Account Settings",
        { oldEmail, newEmail }
      );

      setEmail(newEmail);
      showToast(
        "success",
        "Verification Email Sent",
        `A verification link was sent to ${newEmail}. Click the link in your inbox to complete the change.`
      );
      closeEmailModal();
    } catch (err) {
      console.error(err);
      let msg = err?.message || "Update failed.";
      if (err.code === "auth/wrong-password")
        msg = "Your current password is incorrect.";
      if (err.code === "auth/email-already-in-use")
        msg = "That email is already in use by another account.";
      if (err.code === "auth/requires-recent-login")
        msg = "Please log out and log back in, then try again.";
      if (err.code === "auth/operation-not-allowed")
        msg = "Email change is currently disabled. Please contact the system administrator.";
      showToast("error", "Update Failed", msg);
    } finally {
      setBusy(false);
    }
  };

  const resendEmailCode = async () => {
    if (emailResendIn > 0) return;
    try {
      await createAndSendCode({
        email: emailForm.newEmail,
        purpose: "email-change",
      });
      setEmailCode(Array(CODE_LENGTH).fill(""));
      setEmailResendIn(30);
    } catch (err) {
      showToast("error", "Resend Failed", err?.text || err?.message || "Try again.");
    }
  };

  if (loading) {
    return (
      <div className="fs-page">
        <div className="fs-card"><h3>Loading settings...</h3></div>
      </div>
    );
  }

  const pwChecks = passwordChecks(pwForm.newPassword);

  return (
    <>
      <div className="fs-page">
        <div className="fs-page-header">
          <h1><span className="fs-bar" /> Settings</h1>
          <p>Manage your account security and notification settings.</p>
        </div>

        <div className="fs-grid">
          {/* ── LEFT COLUMN ─────────────────────────────────────── */}
          <div className="fs-col">
            <div className="fs-section-title">
              <i className="fa-solid fa-shield-halved"></i>
              <span>SECURITY</span>
            </div>

            {pwStep === "password" && (
              <form className="fs-card" onSubmit={handlePasswordStepOne}>
                <div className="fs-field">
                  <label>CURRENT PASSWORD</label>
                  <div className="fs-input-wrap">
                    <input
                      type={showCurrent ? "text" : "password"}
                      className="fs-input"
                      placeholder="Enter current password"
                      value={pwForm.currentPassword}
                      onChange={(e) =>
                        setPwForm((f) => ({ ...f, currentPassword: e.target.value }))
                      }
                      autoComplete="current-password"
                    />
                    <button
                      type="button"
                      className="fs-eye"
                      onClick={() => setShowCurrent((v) => !v)}
                      tabIndex={-1}
                    >
                      <i className={`fa-regular ${showCurrent ? "fa-eye" : "fa-eye-slash"}`}></i>
                    </button>
                  </div>
                </div>

                <p className="fs-muted" style={{ margin: 0 }}>
                  For your security, we'll email you a 6-digit code to confirm this change.
                </p>

                <button type="submit" className="fs-primary-btn" disabled={busy}>
                  {busy ? (
                    <><i className="fa-solid fa-circle-notch fa-spin"></i> Sending…</>
                  ) : (
                    "Send Verification Code"
                  )}
                </button>
              </form>
            )}

            {pwStep === "code" && (
              <div className="fs-card">
                <div className="fs-step-head">
                  <i className="fa-solid fa-shield-halved" />
                  <div>
                    <h4>Enter Verification Code</h4>
                    <p>
                      We sent a 6-digit code to <strong>{user?.email}</strong>.
                      It expires in {CODE_TTL_MIN} minutes.
                    </p>
                  </div>
                </div>

                <OtpInput
                  value={pwCode}
                  onChange={setPwCode}
                  length={CODE_LENGTH}
                  disabled={busy}
                />

                <div className="fs-step-actions">
                  <button
                    type="button"
                    className="fs-modal-btn cancel"
                    onClick={() => {
                      setPwStep("password");
                      setPwCode(Array(CODE_LENGTH).fill(""));
                    }}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="fs-primary-btn"
                    onClick={handlePasswordVerifyCode}
                    disabled={busy}
                    style={{ flex: 1 }}
                  >
                    {busy ? (
                      <><i className="fa-solid fa-circle-notch fa-spin"></i> Verifying…</>
                    ) : (
                      "Verify Code"
                    )}
                  </button>
                </div>

                <p
                  className="fs-resend-link"
                  onClick={resendPwCode}
                  style={{ opacity: pwResendIn > 0 ? 0.6 : 1 }}
                >
                  {pwResendIn > 0
                    ? `Resend code in ${pwResendIn}s`
                    : "Didn't get the code? Resend"}
                </p>
              </div>
            )}

            {pwStep === "newpw" && (
              <form className="fs-card" onSubmit={handlePasswordFinalSubmit}>
                <div className="fs-row">
                  <div className="fs-field">
                    <label>NEW PASSWORD</label>
                    <div className="fs-input-wrap">
                      <input
                        type={showNew ? "text" : "password"}
                        className="fs-input"
                        placeholder="Enter new password"
                        value={pwForm.newPassword}
                        onChange={(e) =>
                          setPwForm((f) => ({ ...f, newPassword: e.target.value }))
                        }
                        autoComplete="new-password"
                      />
                      <button
                        type="button"
                        className="fs-eye"
                        onClick={() => setShowNew((v) => !v)}
                        tabIndex={-1}
                      >
                        <i className={`fa-regular ${showNew ? "fa-eye" : "fa-eye-slash"}`}></i>
                      </button>
                    </div>
                  </div>

                  <div className="fs-field">
                    <label>CONFIRM PASSWORD</label>
                    <div className="fs-input-wrap">
                      <input
                        type={showConfirm ? "text" : "password"}
                        className="fs-input"
                        placeholder="Confirm new password"
                        value={pwForm.confirmPassword}
                        onChange={(e) =>
                          setPwForm((f) => ({ ...f, confirmPassword: e.target.value }))
                        }
                        autoComplete="new-password"
                      />
                      <button
                        type="button"
                        className="fs-eye"
                        onClick={() => setShowConfirm((v) => !v)}
                        tabIndex={-1}
                      >
                        <i className={`fa-regular ${showConfirm ? "fa-eye" : "fa-eye-slash"}`}></i>
                      </button>
                    </div>
                  </div>
                </div>

                {(pwForm.newPassword || pwForm.confirmPassword) && (
                  <ul className="fs-pw-rules">
                    <li className={pwChecks.length    ? "ok" : ""}>
                      <i className={`fa-solid ${pwChecks.length    ? "fa-circle-check" : "fa-circle"}`} />8+ characters
                    </li>
                    <li className={pwChecks.uppercase ? "ok" : ""}>
                      <i className={`fa-solid ${pwChecks.uppercase ? "fa-circle-check" : "fa-circle"}`} />Uppercase
                    </li>
                    <li className={pwChecks.lowercase ? "ok" : ""}>
                      <i className={`fa-solid ${pwChecks.lowercase ? "fa-circle-check" : "fa-circle"}`} />Lowercase
                    </li>
                    <li className={pwChecks.number    ? "ok" : ""}>
                      <i className={`fa-solid ${pwChecks.number    ? "fa-circle-check" : "fa-circle"}`} />Number
                    </li>
                    <li className={pwChecks.special   ? "ok" : ""}>
                      <i className={`fa-solid ${pwChecks.special   ? "fa-circle-check" : "fa-circle"}`} />Special char
                    </li>
                  </ul>
                )}

                <button type="submit" className="fs-primary-btn" disabled={busy}>
                  {busy ? (
                    <><i className="fa-solid fa-circle-notch fa-spin"></i> Updating…</>
                  ) : (
                    "Update Password"
                  )}
                </button>
              </form>
            )}
          </div>

          {/* ── RIGHT COLUMN ────────────────────────────────────── */}
          <div className="fs-col">
            <div className="fs-section-title">
              <i className="fa-solid fa-bell"></i>
              <span>NOTIFICATIONS &amp; PRIVACY</span>
            </div>

            <div className="fs-card fs-card-flush">
              <div className="fs-list-row">
                <i className="fa-solid fa-bell fs-row-icon accent"></i>
                <div className="fs-row-text">
                  <span className="fs-row-title accent">Push Notifications</span>
                  <span className={`fs-row-sub ${browserPermission === "denied" ? "warn" : ""}`}>
                    {pushSubText}
                  </span>
                </div>
                <label className={`fs-switch ${browserPermission === "unsupported" ? "is-disabled" : ""}`}>
                  <input
                    type="checkbox"
                    checked={pushEnabled}
                    onChange={handlePushToggle}
                    disabled={browserPermission === "unsupported" || busy}
                  />
                  <span className="fs-switch-slider"></span>
                </label>
              </div>

              <div className="fs-list-row clickable" onClick={() => setActiveInfoModal("privacy")}>
                <i className="fa-solid fa-shield fs-row-icon"></i>
                <div className="fs-row-text">
                  <span className="fs-row-title">Privacy Policy</span>
                </div>
                <i className="fa-solid fa-chevron-right fs-row-chev"></i>
              </div>

              <div className="fs-list-row clickable" onClick={() => setActiveInfoModal("terms")}>
                <i className="fa-solid fa-file-lines fs-row-icon"></i>
                <div className="fs-row-text">
                  <span className="fs-row-title">Terms of Service</span>
                </div>
                <i className="fa-solid fa-chevron-right fs-row-chev"></i>
              </div>
            </div>

            <div className="fs-section-title">
              <i className="fa-solid fa-life-ring"></i>
              <span>ACCOUNT &amp; SUPPORT</span>
            </div>

            <div className="fs-card fs-card-flush">
              <div
                className="fs-list-row clickable"
                onClick={() => setShowEmailModal(true)}
              >
                <i className="fa-solid fa-envelope fs-row-icon"></i>
                <div className="fs-row-text">
                  <span className="fs-row-title">Change Email</span>
                  <span className="fs-row-sub">{email}</span>
                </div>
                <i className="fa-solid fa-chevron-right fs-row-chev"></i>
              </div>

              <div
                className="fs-list-row clickable"
                onClick={() => setActiveInfoModal("help")}
              >
                <i className="fa-regular fa-circle-question fs-row-icon"></i>
                <div className="fs-row-text">
                  <span className="fs-row-title">Help Center</span>
                </div>
                <i className="fa-solid fa-chevron-right fs-row-chev"></i>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── CHANGE EMAIL MODAL ─────────────────────────────────── */}
      {showEmailModal && (
        <div className="fs-modal-overlay" onClick={() => !busy && closeEmailModal()}>
          <div className="fs-modal" onClick={(e) => e.stopPropagation()}>
            {emailStep === "form" && (
              <form onSubmit={handleEmailStepOne}>
                <div className="fs-modal-icon blue">
                  <i className="fa-solid fa-envelope"></i>
                </div>
                <h3>Change Email</h3>
                <p className="fs-modal-sub">
                  Verify your current password, then enter the new email. We'll
                  send a code to the new email.
                </p>

                <div className="fs-field">
                  <label>Current Password</label>
                  <input
                    type="password"
                    className="fs-input"
                    value={emailForm.currentPassword}
                    onChange={(e) =>
                      setEmailForm((f) => ({ ...f, currentPassword: e.target.value }))
                    }
                    autoComplete="current-password"
                    required
                  />
                </div>

                <div className="fs-field">
                  <label>New Email</label>
                  <input
                    type="email"
                    className="fs-input"
                    value={emailForm.newEmail}
                    onChange={(e) =>
                      setEmailForm((f) => ({ ...f, newEmail: e.target.value }))
                    }
                    autoComplete="email"
                    required
                  />
                </div>

                <div className="fs-modal-actions">
                  <button
                    type="button"
                    className="fs-modal-btn cancel"
                    onClick={closeEmailModal}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="fs-modal-btn confirm"
                    disabled={busy}
                  >
                    {busy ? (
                      <><i className="fa-solid fa-circle-notch fa-spin"></i> Sending…</>
                    ) : (
                      "Send Code to New Email"
                    )}
                  </button>
                </div>
              </form>
            )}

            {emailStep === "code" && (
              <div>
                <div className="fs-modal-icon blue">
                  <i className="fa-solid fa-shield-halved"></i>
                </div>
                <h3>Verify New Email</h3>
                <p className="fs-modal-sub">
                  Enter the 6-digit code sent to{" "}
                  <strong>{emailForm.newEmail}</strong>. Expires in{" "}
                  {CODE_TTL_MIN} minutes.
                </p>

                <OtpInput
                  value={emailCode}
                  onChange={setEmailCode}
                  length={CODE_LENGTH}
                  disabled={busy}
                />

                <div className="fs-modal-actions" style={{ marginTop: 20 }}>
                  <button
                    type="button"
                    className="fs-modal-btn cancel"
                    onClick={() => {
                      setEmailStep("form");
                      setEmailCode(Array(CODE_LENGTH).fill(""));
                    }}
                    disabled={busy}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    className="fs-modal-btn confirm"
                    onClick={handleEmailVerifyAndUpdate}
                    disabled={busy}
                  >
                    {busy ? (
                      <><i className="fa-solid fa-circle-notch fa-spin"></i> Sending…</>
                    ) : (
                      "Verify & Send Link"
                    )}
                  </button>
                </div>

                <p
                  className="fs-resend-link"
                  onClick={resendEmailCode}
                  style={{
                    opacity: emailResendIn > 0 ? 0.6 : 1,
                    textAlign: "center",
                    marginTop: 12,
                  }}
                >
                  {emailResendIn > 0
                    ? `Resend code in ${emailResendIn}s`
                    : "Didn't get the code? Resend"}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════ INFO MODAL (Privacy / Terms / Help / FAQ) ═══════ */}
      {activeInfoModal && (
        <div
          className="info-modal-overlay"
          onClick={() => setActiveInfoModal(null)}
        >
          <div
            className="info-modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="info-modal-close"
              onClick={() => setActiveInfoModal(null)}
            >
              <i className="fa-solid fa-xmark" />
            </button>

            {activeInfoModal === "privacy" && (
              <>
                <div className="info-modal-icon">
                  <i className="fa-solid fa-shield-halved" />
                </div>
                <h2>Privacy Policy</h2>
                <p className="info-modal-subtitle">
                  How SpaceS CICT collects, uses, and protects your information.
                </p>
                <div className="info-modal-body">
                  <p>
                    SpaceS CICT is a classroom allocation and scheduling platform
                    built for the College of Information and Communications
                    Technology (CICT) at Bulacan State University.
                  </p>
                  <h4>Information We Collect</h4>
                  <ul>
                    <li>Account details such as name, email address, and assigned role.</li>
                    <li>Login activity and system usage logs for security and accountability.</li>
                    <li>Class schedules, room reservations, and related academic records.</li>
                  </ul>
                  <h4>How We Use Your Information</h4>
                  <ul>
                    <li>To authenticate accounts and provide role-based access to the system.</li>
                    <li>To manage classroom scheduling, reservations, and conflict resolution.</li>
                    <li>To send notifications about approvals, denials, and schedule changes.</li>
                  </ul>
                </div>
              </>
            )}

            {activeInfoModal === "terms" && (
              <>
                <div className="info-modal-icon">
                  <i className="fa-solid fa-file-signature" />
                </div>
                <h2>Terms of Use</h2>
                <p className="info-modal-subtitle">
                  Please read these terms before using SpaceS CICT.
                </p>
                <div className="info-modal-body">
                  <p>
                    By logging in and using SpaceS CICT, you agree to use the
                    platform responsibly and only for its intended purpose.
                  </p>
                  <h4>Account Responsibility</h4>
                  <ul>
                    <li>Accounts are created and managed by the Admin and must not be shared.</li>
                    <li>Users are responsible for keeping their login credentials confidential.</li>
                  </ul>
                  <h4>Acceptable Use</h4>
                  <ul>
                    <li>Room reservations and schedule changes must reflect genuine academic needs.</li>
                    <li>Users must not attempt to bypass conflict detection or falsify reservation details.</li>
                  </ul>
                </div>
              </>
            )}

            {activeInfoModal === "help" && (
              <>
                <div className="info-modal-icon">
                  <i className="fa-solid fa-headset" />
                </div>
                <h2>Help Center</h2>
                <p className="info-modal-subtitle">
                  Need help? Reach out through either email below, or check the FAQs.
                </p>
                <div className="contact-list">
                  <a href="mailto:spaces-bulsu@outlook.com" className="contact-item">
                    <i className="fa-brands fa-microsoft" />
                    <div>
                      <span className="contact-label">Outlook</span>
                      <span className="contact-value">spaces-bulsu@outlook.com</span>
                    </div>
                  </a>
                  <a href="mailto:spacescict@gmail.com" className="contact-item">
                    <i className="fa-brands fa-google" />
                    <div>
                      <span className="contact-label">Gmail</span>
                      <span className="contact-value">spacescict@gmail.com</span>
                    </div>
                  </a>
                </div>
                <button
                  type="button"
                  className="faq-jump-link"
                  onClick={() => setActiveInfoModal("faq")}
                >
                  Check the FAQs first <i className="fa-solid fa-arrow-right" />
                </button>
              </>
            )}

            {activeInfoModal === "faq" && (
              <>
                <div className="info-modal-icon">
                  <i className="fa-solid fa-circle-question" />
                </div>
                <h2>Frequently Asked Questions</h2>
                <p className="info-modal-subtitle">
                  Quick answers to the most common questions.
                </p>
                <div className="faq-list">
                  {FAQ_ITEMS.map((item, index) => {
                    const isOpen = openFaqIndex === index;
                    return (
                      <div key={index} className={`faq-item ${isOpen ? "open" : ""}`}>
                        <button
                          type="button"
                          className="faq-question"
                          onClick={() => setOpenFaqIndex(isOpen ? null : index)}
                        >
                          <span>{item.question}</span>
                          <i className="fa-solid fa-chevron-down faq-chevron" />
                        </button>
                        <div className="faq-answer-wrapper">
                          <p className="faq-answer">{item.answer}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <Toast
        show={toast.show}
        type={toast.type}
        title={toast.title}
        message={toast.message}
        onClose={() => setToast((prev) => ({ ...prev, show: false }))}
      />
    </>
  );
}