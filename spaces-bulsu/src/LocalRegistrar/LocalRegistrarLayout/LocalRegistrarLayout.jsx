import { NavLink, Outlet, useNavigate, useLocation } from "react-router-dom";
import { useState, useEffect, useRef } from "react";
import "./local-registrar-layout.css";
import { auth, db } from "../../firebase";
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  doc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { onAuthStateChanged, signOut } from "firebase/auth";
import LogoutPopup from "../../Popup/LogoutPopup/LogoutPopup";
import NotificationCard from "../../Components/NotificationCard/Notification";
import { fireNewNotifications } from "../../utils/pushNotifications";

export default function LocalRegistrarLayout() {
  const [openSchedule, setOpenSchedule] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const profileMenuRef = useRef(null);
  const [profile, setProfile] = useState({
    firstName: "",
    lastName: "",
    role: "",
    photoUrl: "",
    email: "",
  });

  /* ---------- MOBILE DRAWER ---------- */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth <= 992 : false
  );

  /* ---------- Notification state ---------- */
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [activeTab, setActiveTab] = useState("all");
  const [selectedNotification, setSelectedNotification] = useState(null);

  const scheduleRoutes = [
    "/local-registrar/bulk-upload-1",
    "/local-registrar/academic-schedule",
    "/local-registrar/my-submitted-schedules",
    "/local-registrar/qr-code",
  ];

  const isScheduleActive = scheduleRoutes.some((path) =>
    location.pathname.startsWith(path)
  );

  useEffect(() => {
    setOpenSchedule(isScheduleActive);
  }, [isScheduleActive]);

  /* ---------- Auth + notifications ---------- */
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) return;

      const unsubscribeProfile = onSnapshot(doc(db, "users", user.uid), (snap) => {
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
        where("ownerType", "==", "local-registrar"),
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

      return () => {
        unsubscribeProfile();
        unsubscribeNotif();
      };
    });

    return () => unsubscribe();
  }, []);

  /* ---------- Close profile dropdown on outside click ---------- */
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
    setSelectedNotification(null);
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

  /* ---------- Lock body scroll while notification detail open ---------- */
  useEffect(() => {
    if (!selectedNotification) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, [selectedNotification]);

  /* ---------- Esc to close notification detail ---------- */
  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === "Escape") setSelectedNotification(null);
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, []);

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

  const formatFullTime = (timestamp) => {
    if (!timestamp?.toDate) return "—";
    return timestamp.toDate().toLocaleString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
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

  const openNotification = async (item) => {
    setSelectedNotification(item);
    if (item.unread) {
      await markAsRead(item.id);
    }
  };

  const closeNotificationDetail = () => setSelectedNotification(null);

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

  const typeLabel = {
    schedule: "Schedule",
    urgent: "Urgent",
    approved: "Approved",
    "room-reassignment": "Room Reassignment",
    "room-activity": "Room Activity",
    "room-release": "Room Release",
    "conflict-resolution": "Conflict Resolution",
    "schedule-upload": "Schedule Upload",
    default: "Notification",
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
      <div className="registrar-layout">

        {/* MOBILE OVERLAY */}
        {sidebarOpen && isMobile && (
          <div
            className="registrar-sidebar-overlay"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <aside
          className={`registrar-sidebar ${sidebarOpen ? "registrar-sidebar-open" : ""}`}
        >
          <div className="registrar-logo">
            <div className="logo-icon">
              <img src="/SpaceSLogo.png" alt="SpaceS Logo" className="clerk-logo-img" />
            </div>
            <div className="logo-text">
              <h2>SpaceS CICT</h2>
              <span>CICT Local Registrar</span>
            </div>

            <button
              type="button"
              className="registrar-drawer-close"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close menu"
            >
              <i className="fa-solid fa-xmark"></i>
            </button>
          </div>

          <nav className="registrar-nav">
            <NavLink end to="/local-registrar">
              <i className="fa-solid fa-table-columns"></i>
              <span>Dashboard</span>
            </NavLink>

            <div className="nav-group">
              <button
                type="button"
                className={`lr-nav-parent ${isScheduleActive ? "active-parent" : ""}`}
                onClick={() => setOpenSchedule(!openSchedule)}
              >
                <div className="nav-left">
                  <i className="fa-solid fa-calendar-days"></i>
                  <span>Schedule</span>
                </div>
                <i className={`fa-solid fa-chevron-down arrowLR ${openSchedule ? "open" : ""}`} />
              </button>

              <div className={`submenu-card ${openSchedule ? "open" : ""}`}>
                <NavLink to="/local-registrar/bulk-upload-1">Bulk Upload</NavLink>
                <NavLink to="/local-registrar/academic-schedule">View Academic Schedule</NavLink>
                <NavLink to="/local-registrar/my-submitted-schedules">My Submitted Schedules</NavLink>
                <NavLink to="/local-registrar/qr-code">QR Code Management</NavLink>
              </div>
            </div>

            <NavLink to="/local-registrar/broadcast-channel">
              <i className="fa-solid fa-bell"></i>
              <span>Announcement Channel</span>
            </NavLink>
          </nav>

          {/* PROFILE CARD + DROPDOWN */}
          <div className="lr-sidebar-profile-wrap" ref={profileMenuRef}>
            {showProfileMenu && (
              <>
                <span className="lr-profile-dropdown-arrow" />
                <div className="lr-profile-dropdown">
                  <div className="lr-profile-dropdown-header">
                    <div className="lr-profile-dropdown-avatar">
                      {profile.photoUrl ? (
                        <img src={profile.photoUrl} alt="Profile" />
                      ) : (
                        <span>{initials || <i className="fa-solid fa-user" />}</span>
                      )}
                    </div>
                    <div className="lr-profile-dropdown-user">
                      <span className="lr-profile-dropdown-name">{fullName || "My Profile"}</span>
                      <span className="lr-profile-dropdown-email">{profile.email || "—"}</span>
                    </div>
                  </div>

                  <div className="lr-profile-dropdown-divider" />

                  <button
                    className="lr-profile-dropdown-item"
                    onClick={() => { setShowProfileMenu(false); navigate("/local-registrar/profile"); }}
                  >
                    <i className="fa-regular fa-user"></i>
                    <span>Profile</span>
                  </button>
                  <button
                    className="lr-profile-dropdown-item"
                    onClick={() => { setShowProfileMenu(false); navigate("/local-registrar/settings"); }}
                  >
                    <i className="fa-solid fa-gear"></i>
                    <span>Settings</span>
                  </button>

                  <div className="lr-profile-dropdown-divider" />

                  <button
                    className="lr-profile-dropdown-item logout"
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
              className={`lr-sidebar-profile ${showProfileMenu ? "menu-open" : ""}`}
              onClick={() => setShowProfileMenu((v) => !v)}
            >
              <div className="lr-sidebar-avatar">
                {profile.photoUrl ? (
                  <img src={profile.photoUrl} alt="Profile" />
                ) : (
                  <span>{initials || <i className="fa-solid fa-user" />}</span>
                )}
              </div>
              <div className="lr-sidebar-profile-info">
                <span className="lr-sidebar-profile-name">{fullName || "My Profile"}</span>
                <span className="lr-sidebar-profile-role">{profile.role || profile.email}</span>
              </div>
              <i className={`fa-solid fa-chevron-down lr-profile-chev ${showProfileMenu ? "open" : ""}`} />
            </button>
          </div>
        </aside>

        <div className="registrar-main">
          <header className="registrar-header">
            {/* HAMBURGER — mobile only */}
            <button
              type="button"
              className="registrar-hamburger"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open menu"
            >
              <i className="fa-solid fa-bars"></i>
            </button>

            <div className="header-actions">
              {/* NOTIFICATION TRIGGER */}
              <div className="notification-container-LR">
                <button
                  type="button"
                  className={`header-btn lr-notif-btn-LR ${showNotifications ? "notif-btn-open-LR" : ""}`}
                  onClick={() => setShowNotifications((v) => !v)}
                  aria-label="Notifications"
                >
                  <i className={`fa-bell ${unreadCount > 0 ? "fa-solid bell-active-LR" : "fa-regular"}`}></i>
                  {unreadCount > 0 && (
                    <span className="notif-count-LR">
                      {unreadCount > 9 ? "9+" : unreadCount}
                    </span>
                  )}
                </button>

                {showNotifications && (
                  <>
                    <div className="notif-clickaway-LR" onClick={() => setShowNotifications(false)}></div>
                    <div className="notif-panel-LR">
                      <span className="notif-panel-arrow-LR"></span>

                      <div className="notif-top-LR">
                        <div className="notif-top-title-LR">
                          <h2>Notifications</h2>
                          {unreadCount > 0 && (
                            <span className="notif-top-badge-LR">{unreadCount} new</span>
                          )}
                        </div>
                        <button
                          type="button"
                          className="notif-close-LR"
                          onClick={() => setShowNotifications(false)}
                          aria-label="Close notifications"
                        >
                          <i className="fa-solid fa-xmark"></i>
                        </button>
                      </div>

                      <div className="notif-tabs-LR">
                        <button
                          type="button"
                          className={activeTab === "all" ? "active" : ""}
                          onClick={() => setActiveTab("all")}
                        >
                          All <span className="notif-tab-count-LR">{allCount}</span>
                        </button>
                        <button
                          type="button"
                          className={activeTab === "unread" ? "active" : ""}
                          onClick={() => setActiveTab("unread")}
                        >
                          Unread <span className="notif-tab-count-LR">{unreadCount}</span>
                        </button>
                      </div>

                      {activeTab === "unread" && unreadCount > 0 && (
                        <div className="notif-mark-all-row-LR">
                          <button type="button" className="notif-mark-all-LR" onClick={markAllAsRead}>
                            <i className="fa-solid fa-check-double"></i> Mark all as read
                          </button>
                        </div>
                      )}

                      <div className="notif-list-LR">
                        {filteredNotifications.length === 0 ? (
                          <div className="notif-empty-LR">
                            <div className="notif-empty-icon-LR">
                              <i className={`fa-solid ${emptyCopy.icon}`}></i>
                            </div>
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
                                onClick={() => openNotification(item)}
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
                className="header-btn lr-logout-btn"
                onClick={() => setShowLogoutConfirm(true)}
                aria-label="Logout"
              >
                <i className="fa-solid fa-arrow-right-from-bracket"></i>
              </button>
            </div>
          </header>

          <main className="registrar-content">
            <Outlet />
          </main>
        </div>
      </div>

      {/* ── NOTIFICATION DETAIL OVERLAY ─────────────────────── */}
      {selectedNotification && (
        <div
          className="notif-detail-overlay-LR"
          onClick={closeNotificationDetail}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="notif-detail-card-LR"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="notif-detail-handle-LR" aria-hidden="true" />

            <button
              type="button"
              className="notif-detail-close-LR"
              onClick={closeNotificationDetail}
              aria-label="Close"
            >
              <i className="fa-solid fa-xmark"></i>
            </button>

            <div className="notif-detail-head-LR">
              <div className={`notif-detail-icon-LR type-${selectedNotification.type || "default"}`}>
                <i className={typeIcon[selectedNotification.type] || typeIcon.default}></i>
              </div>
              <div className="notif-detail-head-text-LR">
                <div className="notif-detail-type-LR">
                  {typeLabel[selectedNotification.type] || typeLabel.default}
                </div>
                <h3 className="notif-detail-title-LR">
                  {selectedNotification.title || "Notification"}
                </h3>
              </div>
            </div>

            <div className="notif-detail-meta-LR">
              <span>
                <i className="fa-regular fa-clock"></i>
                {formatFullTime(selectedNotification.createdAt)}
              </span>
              {selectedNotification.badge && (
                <span className="notif-detail-badge-LR">
                  {selectedNotification.badge}
                </span>
              )}
            </div>

            <div className="notif-detail-message-LR">
              {selectedNotification.message || "No additional details."}
            </div>

            <div className="notif-detail-footer-LR">
              <button
                type="button"
                className="notif-detail-btn-LR"
                onClick={closeNotificationDetail}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showLogoutConfirm && (
        <LogoutPopup
          onCancel={() => setShowLogoutConfirm(false)}
          onConfirm={handleLogout}
        />
      )}

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