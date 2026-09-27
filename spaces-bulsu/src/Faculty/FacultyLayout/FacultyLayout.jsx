import { NavLink, Outlet, useNavigate, useLocation } from "react-router-dom";
import "./faculty-layout.css";
import { useState, useEffect, useRef } from "react";
import { auth, db } from "../../firebase";
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  doc,
  updateDoc,
  getDoc,
  writeBatch,
} from "firebase/firestore";
import { onAuthStateChanged, signOut } from "firebase/auth";
import NotificationCard from "../../Components/NotificationCard/Notification";
import { fireNewNotifications } from "../../utils/pushNotifications";

export default function FacultyLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [activeTab, setActiveTab] = useState("all");
  const [loggingOut, setLoggingOut] = useState(false);
  const [profile, setProfile] = useState({
    firstName: "",
    lastName: "",
    role: "",
    photoUrl: "",
    email: "",
  });
  const profileMenuRef = useRef(null);

  /* ---------- MOBILE DRAWER ---------- */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth <= 992 : false
  );

  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, async (user) => {
      if (!user) return;

      const userSnap = await getDoc(doc(db, "users", user.uid));
      if (userSnap.exists()) {
        const d = userSnap.data();
        setProfile({
          firstName: d.firstName || "",
          lastName: d.lastName || "",
          role: d.role || "",
          photoUrl: d.photoUrl || "",
          email: d.email || user.email || "",
        });
      } else {
        setProfile((p) => ({ ...p, email: user.email || "" }));
      }

      const q = query(
        collection(db, "notifications"),
        where("userId", "==", user.uid),
        where("ownerType", "==", "faculty"),
        where("archived", "==", false),
        orderBy("createdAt", "desc")
      );

      const unsubscribeNotif = onSnapshot(
        q,
        (snapshot) => {
          const list = snapshot.docs.map((doc) => ({
            id: doc.id,
            ...doc.data(),
          }));
          setNotifications(list);

          // 🔔 Fire real browser push for any NEW notifications
          fireNewNotifications(list);
        },
        (error) => console.error("❌ Notifications query failed:", error.code, error.message)
      );

      return unsubscribeNotif;
    });

    return () => unsubscribeAuth();
  }, []);

  /* ---------- Close dropdown on outside click ---------- */
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

  /* ---------- Viewport watcher ---------- */
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

  /* ---------- Auto-close drawer on route change ---------- */
  useEffect(() => {
    setSidebarOpen(false);
    setShowProfileMenu(false);
    setShowNotifications(false);
  }, [location.pathname]);

  /* ---------- Lock body scroll while drawer open ---------- */
  useEffect(() => {
    if (!isMobile) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = sidebarOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = original;
    };
  }, [sidebarOpen, isMobile]);

  /* ---------- Notification helpers ---------- */
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
      unread.forEach((n) => batch.update(doc(db, "notifications", n.id), { unread: false }));
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

  /* ---------- Logout ---------- */
  const handleLogout = async () => {
    try {
      setShowLogoutConfirm(false);
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

  return (
    <>
      <div className="faculty-layout">

        {/* MOBILE OVERLAY */}
        {sidebarOpen && isMobile && (
          <div
            className="faculty-sidebar-overlay"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* SIDEBAR */}
        <aside className={`faculty-sidebar ${sidebarOpen ? "faculty-sidebar-open" : ""}`}>
          <div className="faculty-logo">
            <img src="/SpaceSLogo.png" alt="SpaceS Logo" className="faculty-logo-img" />
            <div className="faculty-logo-text">
              <h2>SpaceS</h2>
              <span>CICT Faculty</span>
            </div>

            <button
              type="button"
              className="faculty-drawer-close"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close menu"
            >
              <i className="fa-solid fa-xmark"></i>
            </button>
          </div>

          <nav className="faculty-nav">
            <NavLink end to="/faculty" className={({ isActive }) => (isActive ? "faculty-active" : "")}>
              <i className="fa-solid fa-house"></i><span>Dashboard</span>
            </NavLink>
            <NavLink to="/faculty/schedule" className={({ isActive }) => (isActive ? "faculty-active" : "")}>
              <i className="fa-solid fa-calendar-days"></i><span>Schedule</span>
            </NavLink>
            <NavLink to="/faculty/rooms" className={({ isActive }) => (isActive ? "faculty-active" : "")}>
              <i className="fa-solid fa-building"></i><span>Rooms</span>
            </NavLink>
            <NavLink to="/faculty/reservations" className={({ isActive }) => (isActive ? "faculty-active" : "")}>
              <i className="fa-solid fa-bookmark"></i><span>Reservations</span>
            </NavLink>
            <NavLink to="/faculty/room-issues" className={({ isActive }) => (isActive ? "faculty-active" : "")}>
              <i className="fa-solid fa-clipboard-list"></i><span>Room Issues</span>
            </NavLink>
            <NavLink to="/faculty/broadcast-channel" className={({ isActive }) => (isActive ? "faculty-active" : "")}>
              <i className="fa-solid fa-bell"></i><span>Announcement Channel</span>
            </NavLink>
          </nav>

          {/* PROFILE CARD + DROPDOWN */}
          <div className="sidebar-profile-wrap" ref={profileMenuRef}>
            {showProfileMenu && (
              <>
                <span className="profile-dropdown-arrow" />
                <div className="profile-dropdown">
                  <div className="profile-dropdown-header">
                    <div className="profile-dropdown-avatar">
                      {profile.photoUrl ? (
                        <img src={profile.photoUrl} alt="Profile" />
                      ) : (
                        <span>{initials || <i className="fa-solid fa-user" />}</span>
                      )}
                    </div>
                    <div className="profile-dropdown-user">
                      <span className="profile-dropdown-name">{fullName || "My Profile"}</span>
                      <span className="profile-dropdown-email">{profile.email || "—"}</span>
                    </div>
                  </div>

                  <div className="profile-dropdown-divider" />

                  <button
                    className="profile-dropdown-item"
                    onClick={() => { setShowProfileMenu(false); navigate("/faculty/profile"); }}
                  >
                    <i className="fa-regular fa-user"></i>
                    <span>Profile</span>
                  </button>
                  <button
                    className="profile-dropdown-item"
                    onClick={() => { setShowProfileMenu(false); navigate("/faculty/settings"); }}
                  >
                    <i className="fa-solid fa-gear"></i>
                    <span>Settings</span>
                  </button>

                  <div className="profile-dropdown-divider" />

                  <button
                    className="profile-dropdown-item logout"
                    onClick={() => { setShowProfileMenu(false); setShowLogoutConfirm(true); }}
                  >
                    <i className="fa-solid fa-arrow-right-from-bracket"></i>
                    <span>Logout</span>
                  </button>
                </div>
              </>
            )}

            <button
              type="button"
              className={`sidebar-profile ${showProfileMenu ? "menu-open" : ""}`}
              onClick={() => setShowProfileMenu((v) => !v)}
            >
              <div className="sidebar-avatar">
                {profile.photoUrl ? (
                  <img src={profile.photoUrl} alt="Profile" />
                ) : (
                  <span>{initials || <i className="fa-solid fa-user" />}</span>
                )}
              </div>
              <div className="sidebar-profile-info">
                <span className="sidebar-profile-name">{fullName || "My Profile"}</span>
                <span className="sidebar-profile-role">{profile.role || profile.email}</span>
              </div>
              <i className={`fa-solid fa-chevron-down profile-chev ${showProfileMenu ? "open" : ""}`} />
            </button>
          </div>
        </aside>

        {/* MAIN */}
        <div className="faculty-main">
          <header className="faculty-header">
            {/* HAMBURGER — mobile only */}
            <button
              type="button"
              className="faculty-hamburger"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open menu"
            >
              <i className="fa-solid fa-bars"></i>
            </button>

            <div className="header-actions">
              {/* NOTIFICATION TRIGGER */}
              <div className="notification-container">
                <button
                  type="button"
                  className={`header-btn ${showNotifications ? "notif-btn-open" : ""}`}
                  onClick={() => setShowNotifications((v) => !v)}
                  aria-label="Notifications"
                >
                  <i className={`fa-bell ${unreadCount > 0 ? "fa-solid bell-active" : "fa-regular"}`}></i>
                  {unreadCount > 0 && (
                    <span className="notif-count">{unreadCount > 9 ? "9+" : unreadCount}</span>
                  )}
                </button>

                {showNotifications && (
                  <>
                    <div className="notif-clickaway" onClick={() => setShowNotifications(false)}></div>
                    <div className="notif-panel">
                      <span className="notif-panel-arrow"></span>
                      <div className="notif-top">
                        <div className="notif-top-title">
                          <h2>Notifications</h2>
                          {unreadCount > 0 && (<span className="notif-top-badge">{unreadCount} new</span>)}
                        </div>
                        <button
                          type="button"
                          className="notif-close"
                          onClick={() => setShowNotifications(false)}
                          aria-label="Close notifications"
                        >
                          <i className="fa-solid fa-xmark"></i>
                        </button>
                      </div>

                      <div className="notif-tabs">
                        <button type="button" className={activeTab === "all" ? "active" : ""} onClick={() => setActiveTab("all")}>
                          All <span className="notif-tab-count">{allCount}</span>
                        </button>
                        <button type="button" className={activeTab === "unread" ? "active" : ""} onClick={() => setActiveTab("unread")}>
                          Unread <span className="notif-tab-count">{unreadCount}</span>
                        </button>
                      </div>

                      {activeTab === "unread" && unreadCount > 0 && (
                        <div className="notif-mark-all-row">
                          <button type="button" className="notif-mark-all" onClick={markAllAsRead}>
                            <i className="fa-solid fa-check-double"></i> Mark all as read
                          </button>
                        </div>
                      )}

                      <div className="notif-list">
                        {filteredNotifications.length === 0 ? (
                          <div className="notif-empty">
                            <div className="notif-empty-icon"><i className={`fa-solid ${emptyCopy.icon}`}></i></div>
                            <h4>{emptyCopy.title}</h4>
                            <p>{emptyCopy.text}</p>
                          </div>
                        ) : (
                          filteredNotifications.map((item, i) => (
                            <div key={item.id} style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                              <NotificationCard
                                icon={typeIcon[item.type] || typeIcon.default}
                                title={item.title}
                                message={item.message}
                                time={formatTime(item.createdAt)}
                                badge={item.badge}
                                type={item.type}
                                unread={item.unread}
                                archived={item.archived}
                                assignmentId={item.assignmentId}
                                onClick={() => { if (item.unread) markAsRead(item.id); }}
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
                className="header-btn logout"
                onClick={() => setShowLogoutConfirm(true)}
                aria-label="Logout"
              >
                <i className="fa-solid fa-arrow-right-from-bracket"></i>
              </button>
            </div>
          </header>

          <main className="faculty-content">
            <Outlet />
          </main>
        </div>
      </div>

      {/* LOGOUT MODAL */}
      {showLogoutConfirm && (
        <div className="modal-overlay">
          <div className="logout-modal">
            <div className="modal-icon"><i className="fa-solid fa-triangle-exclamation"></i></div>
            <h2>Are you sure you want to log out?</h2>
            <div className="modal-actions">
              <button className="modal-btn cancel" onClick={() => setShowLogoutConfirm(false)}>Cancel</button>
              <button className="modal-btn confirm" onClick={handleLogout}>Confirm</button>
            </div>
          </div>
        </div>
      )}

      {/* LOGOUT LOADING */}
      {loggingOut && (
        <div className="login-loading-screen">
          <div className="loading-card">
            <div className="spinner" />
            <h2>Signing you out...</h2>
            <p>Please wait while we securely end your session</p>
          </div>
        </div>
      )}
    </>
  );
}