import { NavLink, Outlet, useNavigate, useLocation } from "react-router-dom";
import { useState, useEffect, useRef } from "react";
import "./clerk-layout.css";
import { auth, db } from "../../firebase";
import { signOut, onAuthStateChanged } from "firebase/auth";
import {
  doc,
  getDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import NotificationCard from "../../Components/NotificationCard/Notification";
import LogoutPopup from "../../Popup/LogoutPopup/LogoutPopup";
import { fireNewNotifications } from "../../utils/pushNotifications";

export default function ClerkLayout() {
  const navigate = useNavigate();
  const location = useLocation();

  const [showLogout, setShowLogout] = useState(false);
  const [openReservations, setOpenReservations] = useState(false);
  const [openRoom, setOpenRoom] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const profileMenuRef = useRef(null);

  /* ---------- MOBILE DRAWER ---------- */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth <= 992 : false
  );

  const [profile, setProfile] = useState({
    firstName: "",
    lastName: "",
    role: "",
    photoUrl: "",
    email: "",
  });

  /* ---------- Notifications ---------- */
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [activeTab, setActiveTab] = useState("all");

  /* ================= AUTH + NOTIFICATIONS ================= */
  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      if (!user) return;

      getDoc(doc(db, "users", user.uid)).then((snap) => {
        if (snap.exists()) {
          const d = snap.data();
          setProfile({
            firstName: d.firstName || "",
            lastName: d.lastName || "",
            role: d.role || "",
            photoUrl: d.photoUrl || "",
            email: d.email || user.email || "",
          });
        }
      });

      const q = query(
        collection(db, "notifications"),
        where("userId", "==", user.uid),
        where("ownerType", "==", "clerk"),
        where("archived", "==", false),
        orderBy("createdAt", "desc")
      );

      const unsubscribeNotif = onSnapshot(q, (snapshot) => {
        const list = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));
        setNotifications(list);

        // 🔔 Fire real browser push for any NEW notifications
        fireNewNotifications(list);
      });

      return unsubscribeNotif;
    });

    return () => unsubscribeAuth();
  }, []);

  /* ================= VIEWPORT WATCHER ================= */
  useEffect(() => {
    const checkViewport = () => {
      const mobile = window.innerWidth <= 992;
      setIsMobile(mobile);
      if (!mobile) setSidebarOpen(false);
    };
    checkViewport();
    window.addEventListener("resize", checkViewport);
    window.addEventListener("orientationchange", checkViewport);
    return () => {
      window.removeEventListener("resize", checkViewport);
      window.removeEventListener("orientationchange", checkViewport);
    };
  }, []);

  /* ============ CLOSE DRAWER ON ROUTE CHANGE ============ */
  useEffect(() => {
    setSidebarOpen(false);
    setShowProfileMenu(false);
    setShowNotifications(false);
  }, [location.pathname]);

  /* ============ LOCK BODY SCROLL WHILE DRAWER OPEN ============ */
  useEffect(() => {
    if (!isMobile) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = sidebarOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = original;
    };
  }, [sidebarOpen, isMobile]);

  /* ============ CLOSE PROFILE MENU ON OUTSIDE CLICK ============ */
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target)) {
        setShowProfileMenu(false);
      }
    };
    if (showProfileMenu) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("touchstart", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, [showProfileMenu]);

  /* ================= NOTIFICATION HELPERS ================= */
  const formatTime = (timestamp) => {
    if (!timestamp) return "";
    const now = new Date();
    const date = timestamp.toDate();
    const diff = Math.floor((now - date) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  const markAsRead = async (id) => {
    try {
      await updateDoc(doc(db, "notifications", id), { unread: false });
    } catch (err) {
      console.error(err);
    }
  };

  const markAllAsRead = async () => {
    const unread = notifications.filter((n) => n.unread && !n.archived);
    if (unread.length === 0) return;
    try {
      const batch = writeBatch(db);
      unread.forEach((n) =>
        batch.update(doc(db, "notifications", n.id), { unread: false })
      );
      await batch.commit();
    } catch (err) {
      console.error(err);
    }
  };

  const unreadCount = notifications.filter((n) => n.unread && !n.archived).length;
  const allCount = notifications.filter((n) => !n.archived).length;

  const filteredNotifications = notifications.filter((item) => {
    if (activeTab === "unread") return item.unread && !item.archived;
    return !item.archived;
  });

  const emptyCopy = {
    all: {
      icon: "fa-bell-slash",
      title: "No notifications",
      text: "Updates about schedules, reservations, and conflicts will appear here.",
    },
    unread: {
      icon: "fa-check-double",
      title: "All caught up!",
      text: "You've read all your notifications.",
    },
  }[activeTab];

  const typeIcon = {
    schedule: "fa-regular fa-calendar",
    urgent: "fa-solid fa-exclamation",
    approved: "fa-solid fa-check",
    "room-reassignment": "fa-solid fa-arrows-rotate",
    "room-activity": "fa-solid fa-calendar-plus",
    "room-release": "fa-solid fa-door-open",
    "conflict-resolution": "fa-solid fa-circle-check",
    "schedule-upload": "fa-solid fa-upload",
    default: "fa-solid fa-bell",
  };

  /* ================= LOGOUT ================= */
  const handleLogout = async () => {
    try {
      setShowLogout(false);
      setLoggingOut(true);
      setTimeout(async () => {
        await signOut(auth);
        navigate("/login");
      }, 2000);
    } catch (error) {
      console.error(error);
      setLoggingOut(false);
    }
  };

  const fullName = `${profile.firstName} ${profile.lastName}`.trim();
  const initials = `${profile.firstName.charAt(0)}${profile.lastName.charAt(0)}`.toUpperCase();

  /* ================= RENDER ================= */
  return (
    <>
      <div className="clerk-layout">

        {/* MOBILE OVERLAY */}
        {sidebarOpen && isMobile && (
          <div
            className="clerk-sidebar-overlay"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* ================= SIDEBAR ================= */}
        <aside
          className={`clerk-sidebar ${sidebarOpen ? "clerk-sidebar-open" : ""}`}
        >
          <div className="clerk-logo">
            <img src="/SpaceSLogo.png" alt="SpaceS Logo" className="clerk-logo-img" />
            <div className="clerk-logo-text">
              <h2>SpaceS CICT</h2>
              <span>CICT Clerk</span>
            </div>

            <button
              type="button"
              className="clerk-drawer-close"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close menu"
            >
              <i className="fa-solid fa-xmark"></i>
            </button>
          </div>

          <nav className="clerk-nav">
            <NavLink
              end
              to="/clerk"
              className={({ isActive }) => (isActive ? "clerk-active" : "")}
            >
              <i className="fa-solid fa-house"></i><span>Dashboard</span>
            </NavLink>

            <NavLink
              to="/clerk/schedule-view-academic-schedule"
              className={({ isActive }) => (isActive ? "clerk-active" : "")}
            >
              <i className="fa-solid fa-calendar"></i><span>Schedule</span>
            </NavLink>

            <div className="clerk-nav-group">
              <button
                type="button"
                className="clerk-nav-parent"
                onClick={() => setOpenReservations((v) => !v)}
              >
                <i className="fa-solid fa-bookmark"></i>
                <span>Reservations</span>
                <i
                  className={`fa-solid fa-chevron-down clerk-arrow ${
                    openReservations ? "clerk-open" : ""
                  }`}
                ></i>
              </button>

              <div
                className={`clerk-submenu ${openReservations ? "clerk-open" : ""}`}
              >
                <NavLink
                  to="/clerk/online-reservations"
                  className={({ isActive }) => (isActive ? "clerk-active" : "")}
                >
                  Online Reservations
                </NavLink>
                <NavLink
                  to="/clerk/walk-in-reservation"
                  className={({ isActive }) => (isActive ? "clerk-active" : "")}
                >
                  Walk-in Reservations
                </NavLink>
              </div>
            </div>

            <div className="clerk-nav-group">
              <button
                type="button"
                className="clerk-nav-parent"
                onClick={() => setOpenRoom((v) => !v)}
              >
                <i className="fa-solid fa-door-open"></i>
                <span>Rooms</span>
                <i
                  className={`fa-solid fa-chevron-down clerk-arrow ${
                    openRoom ? "clerk-open" : ""
                  }`}
                ></i>
              </button>

              <div className={`clerk-submenu ${openRoom ? "clerk-open" : ""}`}>
                <NavLink
                  to="/clerk/room-activity"
                  className={({ isActive }) => (isActive ? "clerk-active" : "")}
                >
                  <i className="fa-solid fa-clock"></i><span>Room Activity</span>
                </NavLink>
                <NavLink
                  to="/clerk/room-issues"
                  className={({ isActive }) => (isActive ? "clerk-active" : "")}
                >
                  <i className="fa-solid fa-clipboard-list"></i><span>Room Issues</span>
                </NavLink>
                <NavLink
                  to="/clerk/room-management"
                  className={({ isActive }) => (isActive ? "clerk-active" : "")}
                >
                  <i className="fa-solid fa-door-open"></i><span>Room Management</span>
                </NavLink>
                <NavLink
                  to="/clerk/room-usage"
                  className={({ isActive }) => (isActive ? "clerk-active" : "")}
                >
                  <i className="fa-solid fa-chart-simple"></i><span>Room Usage</span>
                </NavLink>
              </div>
            </div>

            <NavLink
              to="/clerk/conflicts"
              className={({ isActive }) => (isActive ? "clerk-active" : "")}
            >
              <i className="fa-solid fa-exclamation-triangle"></i><span>Conflicts</span>
            </NavLink>

            <NavLink
              to="/clerk/broadcast-channel"
              className={({ isActive }) => (isActive ? "clerk-active" : "")}
            >
              <i className="fa-solid fa-bullhorn"></i><span>Announcement Channel</span>
            </NavLink>
          </nav>

          {/* PROFILE CARD + DROPDOWN */}
          <div className="clerk-sidebar-profile-wrap" ref={profileMenuRef}>
            {showProfileMenu && (
              <>
                <span className="clerk-profile-dropdown-arrow" />
                <div className="clerk-profile-dropdown">
                  <div className="clerk-profile-dropdown-header">
                    <div className="clerk-profile-dropdown-avatar">
                      {profile.photoUrl ? (
                        <img src={profile.photoUrl} alt="Profile" />
                      ) : (
                        <span>{initials || <i className="fa-solid fa-user" />}</span>
                      )}
                    </div>
                    <div className="clerk-profile-dropdown-user">
                      <span className="clerk-profile-dropdown-name">
                        {fullName || "My Profile"}
                      </span>
                      <span className="clerk-profile-dropdown-email">
                        {profile.email || "—"}
                      </span>
                    </div>
                  </div>

                  <div className="clerk-profile-dropdown-divider" />

                  <button
                    className="clerk-profile-dropdown-item"
                    onClick={() => {
                      setShowProfileMenu(false);
                      navigate("/clerk/profile");
                    }}
                  >
                    <i className="fa-regular fa-user"></i>
                    <span>Profile</span>
                  </button>
                  <button
                    className="clerk-profile-dropdown-item"
                    onClick={() => {
                      setShowProfileMenu(false);
                      navigate("/clerk/settings");
                    }}
                  >
                    <i className="fa-solid fa-gear"></i>
                    <span>Settings</span>
                  </button>

                  <div className="clerk-profile-dropdown-divider" />

                  <button
                    className="clerk-profile-dropdown-item logout"
                    onClick={() => {
                      setShowProfileMenu(false);
                      setShowLogout(true);
                    }}
                  >
                    <i className="fa-solid fa-arrow-right-from-bracket"></i>
                    <span>Logout</span>
                  </button>
                </div>
              </>
            )}

            <button
              type="button"
              className={`clerk-sidebar-profile ${showProfileMenu ? "menu-open" : ""}`}
              onClick={() => setShowProfileMenu((v) => !v)}
            >
              <div className="clerk-sidebar-avatar">
                {profile.photoUrl ? (
                  <img src={profile.photoUrl} alt="Profile" />
                ) : (
                  <span>{initials || <i className="fa-solid fa-user" />}</span>
                )}
              </div>
              <div className="clerk-sidebar-profile-info">
                <span className="clerk-sidebar-profile-name">
                  {fullName || "My Profile"}
                </span>
                <span className="clerk-sidebar-profile-role">
                  {profile.role || profile.email}
                </span>
              </div>
              <i
                className={`fa-solid fa-chevron-down clerk-profile-chev ${
                  showProfileMenu ? "open" : ""
                }`}
              />
            </button>
          </div>
        </aside>

        {/* ================= MAIN ================= */}
        <div className="clerk-main">

          <header className="clerk-header">
            {/* HAMBURGER — mobile only */}
            <button
              type="button"
              className="clerk-hamburger"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open menu"
            >
              <i className="fa-solid fa-bars"></i>
            </button>

            <div className="clerk-header-actions">
              {/* NOTIFICATION TRIGGER */}
              <div className="clerk-notification-container">
                <button
                  type="button"
                  className={`clerk-header-btn ${
                    showNotifications ? "clerk-notif-btn-open" : ""
                  }`}
                  onClick={() => setShowNotifications((v) => !v)}
                  aria-label="Notifications"
                >
                  <i
                    className={`fa-bell ${
                      unreadCount > 0 ? "fa-solid clerk-bell-active" : "fa-regular"
                    }`}
                  ></i>
                  {unreadCount > 0 && (
                    <span className="clerk-notif-count">
                      {unreadCount > 9 ? "9+" : unreadCount}
                    </span>
                  )}
                </button>

                {showNotifications && (
                  <>
                    <div
                      className="clerk-notif-clickaway"
                      onClick={() => setShowNotifications(false)}
                    ></div>

                    <div className="clerk-notif-panel">
                      <span className="clerk-notif-panel-arrow"></span>

                      <div className="clerk-notif-top">
                        <div className="clerk-notif-top-title">
                          <h2>Notifications</h2>
                          {unreadCount > 0 && (
                            <span className="clerk-notif-top-badge">
                              {unreadCount} new
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          className="clerk-notif-close"
                          onClick={() => setShowNotifications(false)}
                          aria-label="Close notifications"
                        >
                          <i className="fa-solid fa-xmark"></i>
                        </button>
                      </div>

                      <div className="clerk-notif-tabs">
                        <button
                          type="button"
                          className={activeTab === "all" ? "clerk-active" : ""}
                          onClick={() => setActiveTab("all")}
                        >
                          All <span className="clerk-notif-tab-count">{allCount}</span>
                        </button>
                        <button
                          type="button"
                          className={activeTab === "unread" ? "clerk-active" : ""}
                          onClick={() => setActiveTab("unread")}
                        >
                          Unread{" "}
                          <span className="clerk-notif-tab-count">{unreadCount}</span>
                        </button>
                      </div>

                      {activeTab === "unread" && unreadCount > 0 && (
                        <div className="clerk-notif-mark-all-row">
                          <button
                            type="button"
                            className="clerk-notif-mark-all"
                            onClick={markAllAsRead}
                          >
                            <i className="fa-solid fa-check-double"></i> Mark all as read
                          </button>
                        </div>
                      )}

                      <div className="clerk-notif-list">
                        {filteredNotifications.length === 0 ? (
                          <div className="clerk-notif-empty">
                            <div className="clerk-notif-empty-icon">
                              <i className={`fa-solid ${emptyCopy.icon}`}></i>
                            </div>
                            <h4>{emptyCopy.title}</h4>
                            <p>{emptyCopy.text}</p>
                          </div>
                        ) : (
                          filteredNotifications.map((item, i) => (
                            <div
                              key={item.id}
                              style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                            >
                              <NotificationCard
                                icon={typeIcon[item.type] || typeIcon.default}
                                title={item.title}
                                message={item.message}
                                time={formatTime(item.createdAt)}
                                badge={item.badge}
                                type={item.type}
                                unread={item.unread}
                                archived={item.archived}
                                onClick={() => markAsRead(item.id)}
                              />
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>

              <button
                type="button"
                className="clerk-header-btn clerk-logout"
                onClick={() => setShowLogout(true)}
                aria-label="Logout"
              >
                <i className="fa-solid fa-arrow-right-from-bracket"></i>
              </button>
            </div>
          </header>

          <main className="clerk-content">
            <Outlet />
          </main>
        </div>
      </div>

      {showLogout && (
        <LogoutPopup
          onCancel={() => setShowLogout(false)}
          onConfirm={handleLogout}
        />
      )}

      {loggingOut && (
        <div className="clerk-logout-loading-screen">
          <div className="clerk-logout-loading-card">
            <div className="clerk-logout-spinner" />
            <h2>Signing you out...</h2>
            <p>Please wait while we securely end your session</p>
          </div>
        </div>
      )}
    </>
  );
}