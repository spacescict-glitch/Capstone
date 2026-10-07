import React from 'react';
import './LoginNav.css';
import logo from '../../assets/logo.png';

export default function LoginNav({
  activePage,
  onChangePage,
  onSignIn,
  onLogout,
  onAboutClick,
  onFeaturesClick,
  onContactClick,
}) {
  // Roles na naka-login na (admin, faculty, etc.)
  const isLoggedIn = ['admin', 'faculty', 'clerk', 'local-registrar'].includes(activePage);

  const goHome = () => {
    if (onChangePage) onChangePage('home');
  };

  const handleSignInClick = () => {
    if (onSignIn) onSignIn();
    else if (onChangePage) onChangePage('login');
  };

  return (
    <nav className="site-nav">
      <div
        className="brand-block"
        onClick={goHome}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && goHome()}
      >
        <img
          src={logo}
          alt="Spaces CICT Logo"
          className="brand-logo"
        />
        <div>
          <p className="brand-name">SpaceS CICT</p>
        </div>
      </div>

      <div className="nav-right">
        {/* ── LOGGED IN: Notifications + Logout ── */}
        {isLoggedIn && (
          <>
            <button type="button" className="nav-icon-btn" aria-label="Notifications">
              <i className="fa-solid fa-bell"></i>
            </button>
            <button type="button" className="nav-icon-btn" aria-label="Log out" onClick={onLogout}>
              <i className="fa-solid fa-arrow-right-from-bracket"></i>
            </button>
          </>
        )}

        {/* ── HOME PAGE: About, Features, Contact, Sign In ── */}
        {activePage === 'home' && (
          <>
            <button type="button" className="nav-link" onClick={onAboutClick}>
              About
            </button>
            <button type="button" className="nav-link" onClick={onFeaturesClick}>
              Features
            </button>
            <button type="button" className="nav-link" onClick={onContactClick}>
              Contact
            </button>
            <button
              type="button"
              className="nav-signin-text"
              onClick={handleSignInClick}
            >
              Sign In
            </button>
          </>
        )}

        {/* ── LOGIN PAGE: Back to Home ── */}
        {activePage === 'login' && (
          <button type="button" className="nav-back-home" onClick={goHome}>
            <i className="fa-solid fa-arrow-left"></i>
            <span>Back to Home</span>
          </button>
        )}
      </div>
    </nav>
  );
}