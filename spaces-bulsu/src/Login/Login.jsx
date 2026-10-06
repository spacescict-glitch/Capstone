import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { signInWithEmailAndPassword } from "firebase/auth";
import {
  doc,
  getDoc,
  getDocs,
  updateDoc,
  collection,
  query,
  where,
  addDoc,
  serverTimestamp,
} from "firebase/firestore";
import { auth, db } from "../firebase";
import Toast from "../Popup/Toast/Toast";
import heroBackground from "../assets/backgroundlogin.png";
import LoginNav from "../Components/LoginNav/LoginNav";
import "./login.css";
import logo from "../assets/logo.png";

// ─── Security constants ────────────────────────────────────────
const LOCKOUT_WINDOW_MS = 30 * 60 * 1000; // 30 min sliding window
const MAX_ATTEMPTS = 5;                   // block threshold
const WARN_ATTEMPT = 3;                   // warn admin threshold
const AUTO_UNBLOCK_MS = 30 * 60 * 1000;   // auto-unblock after 30 min
                                          // set to null para permanent

export default function Login() {
  const [selectedRole, setSelectedRole] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);

  // ─── Role dropdown ─────────────────────────────────────────────
  const [roleDropdownOpen, setRoleDropdownOpen] = useState(false);
  const roleDropdownRef = useRef(null);

  // ─── Info modal (Privacy / Terms / Accessibility / Support / FAQs) ─
  const [activeModal, setActiveModal] = useState(null);
  const [openFaqIndex, setOpenFaqIndex] = useState(null);

  // ─── Toast timer ref ───────────────────────────────────────────
  const toastTimeoutRef = useRef(null);

  const FAQ_ITEMS = [
    {
      question: "What is SpaceS CICT?",
      answer:
        "SpaceS CICT is a web and mobile-based platform for classroom allocation and scheduling at the College of Information and Communications Technology (CICT), Bulacan State University. It replaces the manual, meeting-based scheduling process with a centralized system where all room schedules, reservations, and conflicts can be viewed in one place.",
    },
    {
      question: "Who can create an account in the system?",
      answer:
        "Only the Admin has access to create user accounts for the Local Registrar, Clerk, and Faculty Members. Once an account is created, temporary login credentials are automatically sent to the user's registered email address.",
    },
    {
      question: "I forgot my password. What should I do?",
      answer:
        "Just click 'Forgot Password?' on the login page. You will receive a password reset link at your registered email address that you can use to set a new password.",
    },
    {
      question: "Why is my account blocked?",
      answer:
        "Your account is automatically blocked after 5 consecutive failed login attempts, for security purposes. On the 3rd attempt, a warning notification is already issued. If your account has been blocked, please contact the Admin to have it reactivated.",
    },
    {
      question: "How do I request a room reservation?",
      answer:
        "As a Faculty member, go to the Reservations page and click the '+' button. Fill in the course title, purpose, date, and time slot you need — the system will automatically show available rooms that match your requirements.",
    },
    {
      question: "How do I know if a room is available?",
      answer:
        "You can view the real-time status of each classroom (Available, Occupied, or Under Maintenance) on the Rooms page. You can also scan the QR code posted on each room's door to immediately view its current and upcoming schedule, even without logging in.",
    },
    {
      question: "What should I do if I won't be using my assigned room?",
      answer:
        "On the Schedule page, select the class or booking you want to release, provide a reason (for example: examination or class suspension), and confirm. The Admin and Clerk will be automatically notified so the room can be made available again to other users.",
    },
    {
      question: "Who can I contact if I have a problem with the system?",
      answer:
        "You can click 'Contact Support' at the bottom of the login form to see our official email addresses, or directly email us at spaces-bulsu@outlook.com or spacescict@gmail.com.",
    },
  ];

  useEffect(() => {
    const savedEmail = localStorage.getItem("login_email");
    const savedRole = localStorage.getItem("login_role");
    if (savedEmail) setEmail(savedEmail);
    if (savedRole) setSelectedRole(savedRole);
    if (savedEmail || savedRole) setRememberMe(true);
  }, []);

  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === "Escape") {
        setActiveModal(null);
        setRoleDropdownOpen(false);
      }
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, []);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        roleDropdownRef.current &&
        !roleDropdownRef.current.contains(e.target)
      ) {
        setRoleDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    setOpenFaqIndex(null);
  }, [activeModal]);

  // Cleanup toast timer on unmount
  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !loading) {
      handleSignIn();
    }
  };

  const [toast, setToast] = useState({
    show: false,
    type: "success",
    title: "",
    message: "",
  });

  const navigate = useNavigate();

  const ROLE_ROUTES = {
    "Local Registrar": "/local-registrar",
    Clerk: "/clerk",
    Admin: "/admin",
    Faculty: "/faculty",
  };

  const roles = [
    { name: "Admin", icon: "fa-user-tie" },
    { name: "Local Registrar", icon: "fa-building" },
    { name: "Clerk", icon: "fa-clipboard" },
    { name: "Faculty", icon: "fa-user" },
  ];

  // ─── Toast helper — with proper timer cleanup ───────────────────
  const showToast = (type, title, message) => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = null;
    }

    setToast({ show: true, type, title, message });

    if (type !== "loading") {
      toastTimeoutRef.current = setTimeout(() => {
        setToast((prev) => ({ ...prev, show: false }));
        toastTimeoutRef.current = null;
      }, 4000);
    }
  };

  // ─── Helper: notify all Admins (safe-fail) ──────────────────────
  const notifyAdmins = async (
    title,
    message,
    type = "login-attempt",
    extra = {}
  ) => {
    try {
      const q = query(collection(db, "users"), where("role", "==", "Admin"));
      const snap = await getDocs(q);
      const admins = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      await Promise.all(
        admins.map((admin) =>
          addDoc(collection(db, "notifications"), {
            userId: admin.id,
            ownerType: "admin",
            title,
            message,
            type,
            unread: true,
            archived: false,
            badge: type === "account-blocked" ? "ALERT" : "NEW",
            ...extra,
            createdAt: serverTimestamp(),
          }).catch((e) =>
            console.warn(`[notifyAdmins] failed for ${admin.id}:`, e)
          )
        )
      );
    } catch (err) {
      console.warn("Failed to notify admins:", err);
    }
  };

  // ─── Helper: log activity (safe-fail) ───────────────────────────
  const logActivity = async ({
    userId,
    user,
    role,
    action,
    actionType,
    target,
    status,
    details,
  }) => {
    try {
      await addDoc(collection(db, "activityLogs"), {
        userId,
        user,
        role,
        action,
        actionType,
        target,
        status,
        details: details || {},
        timestamp: serverTimestamp(),
      });
    } catch (err) {
      console.warn("Activity log error:", err);
    }
  };

  // ─── Helper: record a failed attempt (FULLY safe-fail) ──────────
  const recordFailedAttempt = async ({
    uid,
    userData,
    email,
    attemptedRole,
    reason, // "wrong_password" | "role_mismatch" | "invalid_credentials"
  }) => {
    const now = Date.now();
    const lastFailedMs =
      userData?.lastFailedAt?.toDate?.()?.getTime?.() || 0;
    const withinWindow = now - lastFailedMs < LOCKOUT_WINDOW_MS;
    const prevAttempts = withinWindow ? userData?.loginAttempts || 0 : 0;
    const nextAttempts = prevAttempts + 1;
    const willBlock = nextAttempts >= MAX_ATTEMPTS;

    // ── 1. Update user doc (own try-catch, hindi mag-throw) ──────
    if (uid) {
      try {
        const updates = {
          loginAttempts: nextAttempts,
          lastFailedAt: serverTimestamp(),
          lastFailedReason: reason,
          lastFailedRole: attemptedRole,
        };

        if (willBlock) {
          updates.status = "Blocked";
          updates.blockedAt = serverTimestamp();
          updates.blockReason = `Auto-blocked: ${nextAttempts} failed login attempts (${reason})`;
          updates.blockedUntil = AUTO_UNBLOCK_MS
            ? new Date(now + AUTO_UNBLOCK_MS)
            : null;
        }

        await updateDoc(doc(db, "users", uid), updates);
      } catch (e) {
        console.warn("[recordFailedAttempt] updateDoc failed:", e);
      }
    }

    // ── 2. Audit trail (securityLogs) — own try-catch ────────────
    try {
      await addDoc(collection(db, "securityLogs"), {
        uid: uid || null,
        email,
        attemptedRole,
        reason,
        attemptNumber: nextAttempts,
        blocked: willBlock,
        userAgent: navigator.userAgent,
        timestamp: serverTimestamp(),
      });
    } catch (e) {
      console.warn("[recordFailedAttempt] securityLogs write failed:", e);
    }

    // ── 3. Admin notification (3rd + blocked) — own try-catch ────
    if (nextAttempts >= WARN_ATTEMPT || willBlock) {
      try {
        const reasonLabel =
          reason === "role_mismatch"
            ? "wrong role"
            : reason === "wrong_password"
            ? "wrong password"
            : "invalid credentials";

        await notifyAdmins(
          willBlock
            ? "🚫 Account Auto-Blocked"
            : "⚠️ Suspicious Login Activity",
          `${email} — ${nextAttempts} failed attempts (${reasonLabel}). ` +
            (willBlock
              ? "Account has been blocked. " +
                (AUTO_UNBLOCK_MS
                  ? "Auto-unblock after 30 minutes, or manually unlock."
                  : "Requires Admin to manually unlock.")
              : "Please monitor."),
          willBlock ? "account-blocked" : "login-warning",
          { email, attemptCount: nextAttempts, reason }
        );
      } catch (e) {
        console.warn("[recordFailedAttempt] notifyAdmins failed:", e);
      }
    }

    // ── 4. Activity log — own try-catch ──────────────────────────
    try {
      await logActivity({
        userId: uid,
        user: userData
          ? `${userData.firstName || ""} ${userData.lastName || ""}`.trim() ||
            email
          : email,
        role: userData?.role || "Unknown",
        action: willBlock ? "Account Blocked" : "Failed Login Attempt",
        actionType: willBlock ? "failed" : "warning",
        target: email,
        status: willBlock ? "BLOCKED" : "WARNING",
        details: {
          reason,
          attempts: nextAttempts,
          roleAttempted: attemptedRole,
        },
      });
    } catch (e) {
      console.warn("[recordFailedAttempt] logActivity failed:", e);
    }

    return { nextAttempts, willBlock };
  };

  // ─── Main sign-in logic ─────────────────────────────────────────
  const handleSignIn = async () => {
    if (!selectedRole || !email || !password) {
      showToast("error", "Input Required", "Please fill all fields.");
      return;
    }

    setLoading(true);
    showToast(
      "loading",
      "Signing In",
      "Please wait while we verify your account."
    );

    let userData = null;
    let uid = null;

    try {
      // ─── 1. Find user by email ──────────────────────────────────
      const userQuery = query(
        collection(db, "users"),
        where("email", "==", email)
      );
      const userSnap = await getDocs(userQuery);

      if (userSnap.empty) {
        addDoc(collection(db, "securityLogs"), {
          uid: null,
          email,
          attemptedRole: selectedRole,
          reason: "user_not_found",
          attemptNumber: 1,
          blocked: false,
          userAgent: navigator.userAgent,
          timestamp: serverTimestamp(),
        }).catch((e) =>
          console.warn("[login] securityLogs write failed:", e)
        );

        showToast(
          "error",
          "Account Not Found",
          "No account exists with this email."
        );
        setLoading(false);
        return;
      }

      const userDoc = userSnap.docs[0];
      uid = userDoc.id;
      userData = userDoc.data();

      // ─── 2. Check blocked status (UNIFIED — manual + auto) ──────
      if (userData.status === "Blocked") {
        const blockedUntil = userData.blockedUntil?.toDate?.();
        const isTempBlockActive =
          blockedUntil && blockedUntil.getTime() > Date.now();

        // A) Manual block (no blockedUntil) OR auto-block still active → deny
        if (!blockedUntil || isTempBlockActive) {
          showToast(
            "error",
            "Account Blocked",
            blockedUntil
              ? "Your account is temporarily blocked due to multiple failed login attempts. Please try again later or contact the Admin."
              : "Your account has been blocked. Please contact the Admin for assistance."
          );
          setLoading(false);
          return;
        }

        // B) Auto-block timer expired → silent auto-unblock
        try {
          await updateDoc(doc(db, "users", uid), {
            status: "Active",
            loginAttempts: 0,
            blockReason: "",
            blockedUntil: null,
          });
          userData = {
            ...userData,
            status: "Active",
            loginAttempts: 0,
            blockReason: "",
            blockedUntil: null,
          };
        } catch (e) {
          console.warn("[login] auto-unblock failed:", e);
          userData = { ...userData, status: "Active" };
        }
      }

      // ─── 4. Attempt Firebase sign-in ────────────────────────────
      await signInWithEmailAndPassword(auth, email, password);

      // ─── 5. Role check — counted na ngayon ──────────────────────
      if (userData.role !== selectedRole) {
        await auth.signOut();

        const { nextAttempts, willBlock } = await recordFailedAttempt({
          uid,
          userData,
          email,
          attemptedRole: selectedRole,
          reason: "role_mismatch",
        });

        showToast(
          "error",
          willBlock ? "Account Blocked" : "Role Mismatch",
          willBlock
            ? "Your account has been blocked due to repeated failed attempts."
            : `Not registered as ${selectedRole}. Attempt ${nextAttempts}/${MAX_ATTEMPTS}.`
        );
        setLoading(false);
        return;
      }

      // ─── 6. Success — reset counters (safe) ─────────────────────
      if (userData.loginAttempts && userData.loginAttempts > 0) {
        try {
          await updateDoc(doc(db, "users", uid), {
            loginAttempts: 0,
            lastFailedAt: null,
            lastFailedReason: "",
            lastFailedRole: "",
          });
        } catch (e) {
          console.warn("[login] reset counters failed:", e);
        }
      }

      setRedirecting(true);
      showToast("success", "Login Successful", `Welcome ${userData.role}!`);

      if (rememberMe) {
        localStorage.setItem("login_email", email);
        localStorage.setItem("login_role", selectedRole);
      } else {
        localStorage.removeItem("login_email");
        localStorage.removeItem("login_role");
      }

      setTimeout(() => {
        setRedirecting(false);
        navigate(ROLE_ROUTES[userData.role] ?? "/");
      }, 2000);
    } catch (err) {
      console.error("Login error:", err);

      const MSG = {
        "auth/user-not-found": "No account found.",
        "auth/wrong-password": "Incorrect password.",
        "auth/invalid-email": "Invalid email format.",
        "auth/too-many-requests": "Too many attempts. Try again later.",
        "auth/invalid-credential": "Invalid credentials.",
      };
      const errorMessage = MSG[err.code] || "Login failed. Please try again.";

      if (!userData) {
        try {
          const userQuery = query(
            collection(db, "users"),
            where("email", "==", email)
          );
          const userSnap = await getDocs(userQuery);
          if (!userSnap.empty) {
            const doc0 = userSnap.docs[0];
            uid = doc0.id;
            userData = doc0.data();
          }
        } catch (_) {
          // ignore
        }
      }

      let shownTitle = "Login Failed";
      let shownMessage = errorMessage;
      let willBlockNow = false;
      let nextAttemptsNow = 1;

      if (userData && uid) {
        const lastFailedMs =
          userData?.lastFailedAt?.toDate?.()?.getTime?.() || 0;
        const withinWindow = Date.now() - lastFailedMs < LOCKOUT_WINDOW_MS;
        const prev = withinWindow ? userData.loginAttempts || 0 : 0;
        nextAttemptsNow = prev + 1;
        willBlockNow = nextAttemptsNow >= MAX_ATTEMPTS;

        if (willBlockNow) {
          shownTitle = "Account Blocked";
          shownMessage =
            "Your account has been blocked due to 5 failed login attempts. Please contact the Admin.";
        } else if (nextAttemptsNow === WARN_ATTEMPT) {
          shownTitle = "Multiple Failed Attempts";
          shownMessage = `Attempt ${nextAttemptsNow}/${MAX_ATTEMPTS}. Account will be blocked after ${MAX_ATTEMPTS}.`;
        } else if (nextAttemptsNow === MAX_ATTEMPTS - 1) {
          shownTitle = "Warning";
          shownMessage = "One more failed attempt will block your account.";
        }
      }

      showToast("error", shownTitle, shownMessage);

      if (userData && uid) {
        recordFailedAttempt({
          uid,
          userData,
          email,
          attemptedRole: selectedRole,
          reason:
            err.code === "auth/wrong-password" ||
            err.code === "auth/invalid-credential"
              ? "wrong_password"
              : "invalid_credentials",
        }).catch((e) =>
          console.warn("[login] recordFailedAttempt failed:", e)
        );
      } else {
        addDoc(collection(db, "securityLogs"), {
          uid: null,
          email,
          attemptedRole: selectedRole,
          reason: "user_not_found",
          attemptNumber: 1,
          blocked: false,
          userAgent: navigator.userAgent,
          timestamp: serverTimestamp(),
        }).catch((e) =>
          console.warn("[login] securityLogs write failed:", e)
        );
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <LoginNav
        activePage="login"
        onAboutClick={() => setActiveModal("about")}
        onContactClick={() => setActiveModal("support")}
      />
      <Toast
        show={toast.show}
        type={toast.type}
        title={toast.title}
        message={toast.message}
        onClose={() => setToast((prev) => ({ ...prev, show: false }))}
      />

      <div className="login-page-shell">
        <div
          className="login-hero"
          style={{
            backgroundImage: `
              linear-gradient(rgba(8,16,31,.75), rgba(8,16,31,.85)),
              url(${heroBackground})
            `,
          }}
        >
          <div className="hero-content">
            <h1>Smarter Classrooms. Better Scheduling.</h1>
            <p className="hero-copy">
              Optimize university resources with SpaceS CICT.
            </p>

            <div className="hero-features">
              <div className="feature-item">
                <i className="fa-regular fa-calendar" />
                <span>Real-Time Scheduling</span>
              </div>

              <div className="feature-item">
                <i className="fa-solid fa-chart-column" />
                <span>Resource Optimization</span>
              </div>

              <div className="feature-item">
                <i className="fa-solid fa-shield-halved" />
                <span>Secure &amp; Reliable</span>
              </div>
            </div>
          </div>
        </div>

        <section className="login-panel">
          <div
            className="login-card"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !loading) {
                handleSignIn();
              }
            }}
          >
            <div className="login-card-header">
              <div className="card-icon logo-icon">
                <img src={logo} alt="Logo" />
              </div>
              <div>
                <h2>SpaceS CICT</h2>
                <p className="card-subtitle">Sign in to access the system.</p>
              </div>
            </div>

            <div className="form-group">
              <label>Select Role</label>
              <div className="role-dropdown" ref={roleDropdownRef}>
                <button
                  type="button"
                  className={`role-dropdown-trigger ${
                    selectedRole ? "has-value" : ""
                  } ${roleDropdownOpen ? "open" : ""}`}
                  onClick={() => setRoleDropdownOpen((prev) => !prev)}
                  aria-haspopup="listbox"
                  aria-expanded={roleDropdownOpen}
                >
                  <i
                    className={`fa-solid ${
                      selectedRole
                        ? roles.find((r) => r.name === selectedRole)?.icon
                        : "fa-user-shield"
                    } role-dropdown-icon`}
                  />
                  <span className="role-dropdown-value">
                    {selectedRole || "Select your role"}
                  </span>
                  <i className="fa-solid fa-chevron-down role-dropdown-chevron" />
                </button>

                {roleDropdownOpen && (
                  <div className="role-dropdown-menu" role="listbox">
                    {roles.map((role) => (
                      <button
                        key={role.name}
                        type="button"
                        role="option"
                        aria-selected={selectedRole === role.name}
                        className={`role-dropdown-option ${
                          selectedRole === role.name ? "selected" : ""
                        }`}
                        onClick={() => {
                          setSelectedRole(role.name);
                          setRoleDropdownOpen(false);
                        }}
                      >
                        <i className={`fa-solid ${role.icon}`} />
                        <span>{role.name}</span>
                        {selectedRole === role.name && (
                          <i className="fa-solid fa-check option-check" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="form-group float-group">
              <div className="float-input">
                <i className="fa-solid fa-user input-icon" />
                <input
                  type="email"
                  value={email}
                  placeholder=" "
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={handleKeyDown}
                  required
                />
                <label>Email or University ID</label>
              </div>
            </div>

            <div className="form-group float-group">
              <div className="float-input">
                <i className="fa-solid fa-lock input-icon" />
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  placeholder=" "
                  onChange={(e) => {
                    setPassword(e.target.value);
                    e.target.setAttribute(
                      "data-filled",
                      e.target.value ? "true" : ""
                    );
                  }}
                  onKeyDown={handleKeyDown}
                  required
                />
                <label>Password</label>
                <button
                  type="button"
                  className="password-action"
                  onClick={() => setShowPassword((prev) => !prev)}
                >
                  <i
                    className={`fa-solid ${
                      showPassword ? "fa-eye-slash" : "fa-eye"
                    }`}
                  />
                </button>
              </div>
            </div>

            <div className="form-actions-row">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                Remember this device
              </label>
              <button
                className="link-button"
                onClick={() => navigate("/reset-password")}
              >
                Forgot Password?
              </button>
            </div>

            <button
              className="sign-in-btn"
              onClick={handleSignIn}
              disabled={loading}
            >
              {loading ? (
                <>
                  Signing in
                  <span className="btn-dots">
                    <span></span><span></span><span></span>
                  </span>
                </>
              ) : (
                <>
                  Sign In
                  <i className="fa-solid fa-arrow-right" />
                </>
              )}
            </button>

            <div className="support-text">
              Need help?{" "}
              <span onClick={() => setActiveModal("support")}>
                Contact Support
              </span>
            </div>
          </div>
        </section>
      </div>

      {redirecting && (
        <div className="login-loading-screen">
          <div className="loading-card">
            <div className="spinner" />
            <h2>Signing you in...</h2>
            <p>Please wait while we prepare your dashboard</p>
          </div>
        </div>
      )}

      <footer className="login-footer">
        <div className="footer-left">
          <i className="fa-solid fa-building-columns" />
          <span>© 2026 SpaceS CICT </span>
        </div>
        <div className="footer-right">
          <button
            className="footer-link"
            onClick={() => setActiveModal("privacy")}
          >
            Privacy Policy
          </button>
          <button
            className="footer-link"
            onClick={() => setActiveModal("terms")}
          >
            Terms of Use
          </button>
          <button
            className="footer-link"
            onClick={() => setActiveModal("accessibility")}
          >
            Accessibility
          </button>
          <button
            className="footer-link"
            onClick={() => setActiveModal("faq")}
          >
            FAQs
          </button>
        </div>
      </footer>

      {activeModal && (
        <div
          className="info-modal-overlay"
          onClick={() => setActiveModal(null)}
        >
          <div
            className="info-modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="info-modal-close"
              onClick={() => setActiveModal(null)}
            >
              <i className="fa-solid fa-xmark" />
            </button>

            {activeModal === "about" && (
              <>
                <div className="info-modal-icon">
                  <i className="fa-solid fa-building-columns" />
                </div>
                <h2>About SpaceS CICT</h2>
                <p className="info-modal-subtitle">
                  A Web and Mobile-Based Smart Platform for Allocation of
                  Classrooms and Efficient Scheduling.
                </p>
                <div className="info-modal-body">
                  <p>
                    SpaceS CICT was developed for the College of Information and
                    Communications Technology (CICT) at Bulacan State University
                    to replace the manual, meeting and group chat-dependent
                    process previously used for classroom scheduling. Preparing
                    a semester's timetable used to take 2 to 3 weeks of meetings
                    between the dean, program chairs, and registrar — with
                    SpaceS CICT, schedules, room activities, and reservations
                    are all managed in one centralized platform.
                  </p>

                  <h4>What It Does</h4>
                  <ul>
                    <li>
                      Detects double bookings and scheduling conflicts
                      automatically, with smart room suggestions.
                    </li>
                    <li>
                      Lets the Local Registrar bulk-upload official class
                      schedules via Excel or AI-assisted PDF extraction.
                    </li>
                    <li>
                      Gives Faculty a self-service way to check room
                      availability, request rooms, and release unused ones.
                    </li>
                    <li>
                      Lets Clerks handle walk-in and online reservations with
                      real-time room status.
                    </li>
                    <li>
                      Provides QR codes on classroom doors so anyone can check a
                      room's schedule without logging in.
                    </li>
                  </ul>

                  <h4>Who It's For</h4>
                  <p>
                    The platform serves four main roles — Admin, Local Registrar,
                    Clerk, and Faculty Members — covering the 22 classrooms of
                    CICT within Pimentel Hall, supporting the BSIT, BSIS, and
                    BLIS programs.
                  </p>
                </div>
              </>
            )}

            {activeModal === "privacy" && (
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
                    SpaceS CICT is a classroom allocation and scheduling
                    platform built for the College of Information and
                    Communications Technology (CICT) at Bulacan State
                    University. We are committed to protecting the personal
                    information of our Admins, Local Registrars, Clerks, and
                    Faculty Members in accordance with Republic Act No. 10173,
                    the Data Privacy Act of 2012.
                  </p>

                  <h4>Information We Collect</h4>
                  <ul>
                    <li>
                      Account details such as name, email address, and assigned
                      role.
                    </li>
                    <li>
                      Login activity and system usage logs for security and
                      accountability.
                    </li>
                    <li>
                      Class schedules, room reservations, and related academic
                      records.
                    </li>
                  </ul>

                  <h4>How We Use Your Information</h4>
                  <ul>
                    <li>
                      To authenticate accounts and provide role-based access to
                      the system.
                    </li>
                    <li>
                      To manage classroom scheduling, reservations, and conflict
                      resolution.
                    </li>
                    <li>
                      To send notifications about approvals, denials, and
                      schedule changes.
                    </li>
                  </ul>

                  <h4>Data Protection</h4>
                  <p>
                    All account and scheduling data is stored securely and is
                    accessible only to authorized personnel. Information is used
                    strictly for the operational purposes of classroom
                    allocation and scheduling within CICT and will not be shared
                    with unauthorized third parties.
                  </p>
                </div>
              </>
            )}

            {activeModal === "terms" && (
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
                    platform responsibly and only for its intended purpose:
                    managing classroom allocation, scheduling, and reservations
                    for the College of Information and Communications
                    Technology.
                  </p>

                  <h4>Account Responsibility</h4>
                  <ul>
                    <li>
                      Accounts are created and managed by the Admin and must not
                      be shared with other individuals.
                    </li>
                    <li>
                      Users are responsible for keeping their login credentials
                      confidential.
                    </li>
                    <li>
                      Repeated failed login attempts may result in a temporarily
                      blocked account for security purposes.
                    </li>
                  </ul>

                  <h4>Acceptable Use</h4>
                  <ul>
                    <li>
                      Room reservations and schedule changes must reflect genuine
                      academic or institutional needs.
                    </li>
                    <li>
                      Users must not attempt to bypass conflict detection or
                      falsify reservation details.
                    </li>
                    <li>
                      Access is limited to the features available to the user's
                      assigned role.
                    </li>
                  </ul>

                  <h4>Availability</h4>
                  <p>
                    While the system is designed for reliable, real-time use,
                    scheduled maintenance or unforeseen issues may occasionally
                    affect availability. Users will be notified of major changes
                    or disruptions when possible.
                  </p>
                </div>
              </>
            )}

            {activeModal === "accessibility" && (
              <>
                <div className="info-modal-icon">
                  <i className="fa-solid fa-universal-access" />
                </div>
                <h2>Accessibility</h2>
                <p className="info-modal-subtitle">
                  Our commitment to a usable experience for every CICT user.
                </p>
                <div className="info-modal-body">
                  <p>
                    SpaceS CICT is designed as a responsive web and mobile
                    platform so that Admins, Local Registrars, Clerks, and
                    Faculty Members can access scheduling and reservation
                    features comfortably across desktop and mobile devices.
                  </p>

                  <h4>Design Considerations</h4>
                  <ul>
                    <li>
                      Clear typography, consistent color contrast, and readable
                      layouts across pages.
                    </li>
                    <li>
                      Role-based interfaces that only display features relevant
                      to each user, reducing clutter.
                    </li>
                    <li>
                      Mobile-optimized views for Faculty to check schedules and
                      submit requests on the go.
                    </li>
                  </ul>

                  <h4>Ongoing Improvements</h4>
                  <p>
                    We continue to refine the interface based on feedback
                    gathered from actual CICT users during system testing and
                    evaluation. If you encounter any accessibility issue while
                    using SpaceS CICT, please let us know through Contact
                    Support so we can address it.
                  </p>
                </div>
              </>
            )}

            {activeModal === "support" && (
              <>
                <div className="info-modal-icon">
                  <i className="fa-solid fa-headset" />
                </div>
                <h2>Contact Support</h2>
                <p className="info-modal-subtitle">
                  Need help signing in or using SpaceS CICT? Reach out through
                  either email below.
                </p>
                <div className="contact-list">
                  <a
                    href="mailto:spaces-bulsu@outlook.com"
                    className="contact-item"
                  >
                    <i className="fa-brands fa-microsoft" />
                    <div>
                      <span className="contact-label">Outlook</span>
                      <span className="contact-value">
                        spaces-bulsu@outlook.com
                      </span>
                    </div>
                  </a>
                  <a
                    href="mailto:spacescict@gmail.com"
                    className="contact-item"
                  >
                    <i className="fa-brands fa-google" />
                    <div>
                      <span className="contact-label">Gmail</span>
                      <span className="contact-value">
                        spacescict@gmail.com
                      </span>
                    </div>
                  </a>
                </div>
                <button
                  type="button"
                  className="faq-jump-link"
                  onClick={() => setActiveModal("faq")}
                >
                  Check the FAQs first <i className="fa-solid fa-arrow-right" />
                </button>
              </>
            )}

            {activeModal === "faq" && (
              <>
                <div className="info-modal-icon">
                  <i className="fa-solid fa-circle-question" />
                </div>
                <h2>Frequently Asked Questions</h2>
                <p className="info-modal-subtitle">
                  Quick answers to the most common questions about SpaceS CICT.
                </p>
                <div className="faq-list">
                  {FAQ_ITEMS.map((item, index) => {
                    const isOpen = openFaqIndex === index;
                    return (
                      <div
                        key={index}
                        className={`faq-item ${isOpen ? "open" : ""}`}
                      >
                        <button
                          type="button"
                          className="faq-question"
                          onClick={() =>
                            setOpenFaqIndex(isOpen ? null : index)
                          }
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
    </>
  );
}