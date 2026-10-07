import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import LoginNav from "../Components/LoginNav/LoginNav";
import "./Home.css";
import logo from "../assets/logo.png"; 

// --- Researcher Images ---
import danImage from "../assets/Cajucom.png"; 
import markImage from "../assets/Bravo.jpg";
import theaImage from "../assets/Gabriel.png";
import raizaImage from "../assets/Torres.jpg";
import renzoImage from "../assets/Tuazon.jpg";

import heroImage from "../assets/backgroundlogin.png"; // <--- DITO ANG FIX
import aboutImage from "../assets/backgroundlogin.png"; // <--- DITO ANG FIX

const researchers = [
  { name: "Dan Ivan V. Cajucom", role: "Project Leader", image: danImage },
  { name: "Mark William P. Bravo", role: "Researcher", image: markImage },
  { name: "Theodora Gwyleth Margareth N. Gabriel", role: "Researcher", image: theaImage },
  { name: "Raiza Shane Torres", role: "Researcher", image: raizaImage },
  { name: "Renzo O. Tuazon", role: "Researcher", image: renzoImage },
];

export default function Home() {
  const navigate = useNavigate();
  const fadeRefs = useRef([]);
  const [activeModal, setActiveModal] = useState(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
          }
        });
      },
      { threshold: 0.1 }
    );

    fadeRefs.current.forEach((el) => {
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, []);

  const addToRefs = (el) => {
    if (el && !fadeRefs.current.includes(el)) {
      fadeRefs.current.push(el);
    }
  };

  const handleSignIn = () => {
    navigate("/login"); 
  };

    const openModal = (name) => {
    setActiveModal(name);
    document.body.style.overflow = "hidden";
  };

  const closeModal = () => {
    setActiveModal(null);
    document.body.style.overflow = "";
  };

  return (
    <div className="home-page-shell">
        <LoginNav
            activePage="home"
            onChangePage={(page) => navigate(page === 'home' ? '/' : `/${page}`)}
            onSignIn={handleSignIn}
            onAboutClick={() => document.getElementById("about").scrollIntoView({ behavior: "smooth" })}
            onFeaturesClick={() => document.getElementById("features").scrollIntoView({ behavior: "smooth" })}
            onContactClick={() => document.getElementById("contact").scrollIntoView({ behavior: "smooth" })}
        />

      {/* --- HERO SECTION --- */}
      <section className="home-hero">
        <div className="home-hero-content">
          <h1 className="fade-up" ref={addToRefs}>
            Smarter Classrooms.<br />
            Better Scheduling.
          </h1>
          <p className="home-hero-copy fade-up" ref={addToRefs}>
            Optimize university resources with SpaceS CICT. A web and mobile-based platform designed to prevent conflicts, and streamline classroom allocation, and reservations for the College of Information and Communications Technology.
          </p>
          <div className="home-hero-actions fade-up" ref={addToRefs}>
            <button className="home-btn-primary" onClick={handleSignIn}>
              Sign In to the System <i className="fa-solid fa-arrow-right" />
            </button>
            <button className="home-btn-secondary" onClick={() => document.getElementById("features").scrollIntoView({ behavior: "smooth" })}>
              Explore Features
            </button>
          </div>
        </div>
        <div className="home-hero-image fade-up" ref={addToRefs}>
          <img src={heroImage} alt="SpaceS CICT Classroom" />
          <div className="hero-image-overlay"></div>
        </div>
      </section>

      {/* --- SOCIAL PROOF / RECOGNITION --- */}
      <section className="home-social-proof fade-up" ref={addToRefs}>
        <p className="social-proof-title">Developed for the College of Information and Communications Technology</p>
        <div className="social-proof-logos">
          <div className="proof-item">
            <i className="fa-solid fa-building-columns"></i>
            <span>Bulacan State University</span>
          </div>
          <div className="proof-item">
            <i className="fa-solid fa-graduation-cap"></i>
            <span>CICT Department</span>
          </div>
        </div>
      </section>

      {/* --- ABOUT SECTION --- */}
      <section className="home-about" id="about">
        <div className="home-about-image fade-up" ref={addToRefs}>
          {/* Dito na lalabas ang Pimentel Hall picture */}
          <img src={aboutImage} alt="CICT Pimentel Hall - Bulacan State University" />
        </div>
        <div className="home-about-text fade-up" ref={addToRefs}>
          <h2>About SpaceS CICT</h2>
          <p>
            SpaceS CICT is a centralized web and mobile-based smart platform for classroom allocation and efficient scheduling. It provides a unified system where all room schedules, reservations, and institutional events can be viewed and managed in one place.
          </p>
          <p>
            Designed for Admin, Local Registrar, Clerk, and Faculty Members, the system offers comprehensive tools for room reservation management, room issue reporting, and event scheduling. It automates conflict detection, recommends alternative rooms, and ensures that schedules are accurate, organized, and easily accessible for the entire department.
          </p>
          <ul className="about-checklist">
            <li><i className="fa-solid fa-check-circle"></i> Centralized schedule, reservation, and event management</li>
            <li><i className="fa-solid fa-check-circle"></i> Automated conflict detection & resolution</li>
            <li><i className="fa-solid fa-check-circle"></i> Room availability and issue tracking</li>
          </ul>
        </div>
      </section>

      {/* --- KEY FEATURES SECTION --- */}
      <section className="home-features" id="features">
        <div className="section-header fade-up" ref={addToRefs}>
          <h2>Key Features & Capabilities</h2>
          <p>Everything you need to manage CICT's 22 classrooms in Pimentel Hall efficiently.</p>
        </div>
        <div className="features-grid">
          <div className="feature-card fade-up" ref={addToRefs}>
            <div className="feature-icon"><i className="fa-solid fa-robot"></i></div>
            <h3>AI-Assisted Extraction</h3>
            <p>Upload PDF or Excel schedules. Our AI extracts subjects, faculty, and time slots automatically, reducing manual encoding errors.</p>
          </div>
          <div className="feature-card fade-up" ref={addToRefs}>
            <div className="feature-icon"><i className="fa-solid fa-triangle-exclamation"></i></div>
            <h3>Conflict Detection</h3>
            <p>Automatically detects double bookings and overlapping schedules, suggesting available rooms that match your class size and equipment needs.</p>
          </div>
          <div className="feature-card fade-up" ref={addToRefs}>
            <div className="feature-icon"><i className="fa-solid fa-calendar-check"></i></div>
            <h3>Reservation Management</h3>
            <p>Faculty can request rooms, track approval status, and mark unused rooms as available. Clerks manage walk-in and online reservations seamlessly.</p>
          </div>
          <div className="feature-card fade-up" ref={addToRefs}>
            <div className="feature-icon"><i className="fa-solid fa-qrcode"></i></div>
            <h3>QR Code Access</h3>
            <p>Each classroom has a unique QR code. Scan it to view the room's current and upcoming schedule instantly without logging in.</p>
          </div>
          <div className="feature-card fade-up" ref={addToRefs}>
            <div className="feature-icon"><i className="fa-solid fa-screwdriver-wrench"></i></div>
            <h3>Room Issue Reporting</h3>
            <p>Faculty can report classroom or equipment problems with photos. Admins acknowledge reports and Clerks track resolutions until the room is restored and available again.</p>
          </div>
        </div>
      </section>

      {/* --- LEAD MAGNET / CTA SECTION --- */}
      <section className="home-cta fade-up" ref={addToRefs}>
        <div className="cta-content">
          <h2>Ready to make classroom scheduling easier?</h2>
          <p>Sign in to your role-based dashboard and start managing schedules, reservations, and rooms — all in one place.</p>
          <button className="home-btn-primary cta-button" onClick={handleSignIn}>
            Access Your Account <i className="fa-solid fa-arrow-right" />
          </button>
        </div>
      </section>

      {/* --- CONTENT SECTION (RESEARCHERS) --- */}
      <section className="home-content-team" id="team">
        <div className="section-header fade-up" ref={addToRefs}>
          <h2>Meet the Researchers</h2>
          <p>Group 4 | Bachelor of Science in Information Technology</p>
        </div>
        <div className="team-grid">
          {researchers.map((researcher, index) => (
            <div className="team-card fade-up" key={index} ref={addToRefs}>
              <div className="team-avatar">
                {researcher.image ? (
                  <img src={researcher.image} alt={researcher.name} />
                ) : (
                  researcher.name.split(" ").map(n => n[0]).join("").substring(0, 2)
                )}
              </div>
              <h4>{researcher.name}</h4>
              <p>{researcher.role}</p>
            </div>
          ))}
        </div>
        <div className="adviser-card fade-up" ref={addToRefs}>
          <i className="fa-solid fa-user-tie"></i>
          <div>
            <span>Project Adviser</span>
            <h4>Dr. Virginia Natividad Franco</h4>
          </div>
        </div>
      </section>

      {/* --- FOOTER --- */}
      <footer className="home-footer" id="contact">
        <div className="footer-top">
          <div className="footer-brand">
            <img src={logo} alt="SpaceS CICT Logo" />
            <div>
              <h3>SpaceS CICT</h3>
              <p>Smarter Classrooms. Better Scheduling.</p>
            </div>
          </div>
          <div className="footer-links">
            <h4>Quick Links</h4>
            <button onClick={() => document.getElementById("about").scrollIntoView({ behavior: "smooth" })}>About</button>
            <button onClick={() => document.getElementById("features").scrollIntoView({ behavior: "smooth" })}>Features</button>
            <button onClick={handleSignIn}>Sign In</button>
          </div>
          <div className="footer-contact">
            <h4>Contact Support</h4>
            <a href="mailto:spaces-bulsu@outlook.com"><i className="fa-brands fa-microsoft"></i> spaces-bulsu@outlook.com</a>
            <a href="mailto:spacescict@gmail.com"><i className="fa-brands fa-google"></i> spacescict@gmail.com</a>
          </div>
        </div>
        <div className="footer-bottom">
          <p>© 2026 SpaceS CICT. College of Information and Communications Technology, Bulacan State University.</p>
            <div className="footer-legal">
                <button type="button" className="footer-legal-btn" onClick={() => openModal("privacy")}>
                Privacy Policy
                </button>
                <button type="button" className="footer-legal-btn" onClick={() => openModal("terms")}>
                Terms of Use
                </button>
                <button type="button" className="footer-legal-btn" onClick={() => openModal("accessibility")}>
                Accessibility
                </button>
            </div>
                </div>
      </footer>

      {activeModal && (
        <div className="info-modal-overlay" onClick={closeModal}>
          <div className="info-modal-card" onClick={(e) => e.stopPropagation()}>
            <button className="info-modal-close" onClick={closeModal} aria-label="Close">
              <i className="fa-solid fa-xmark" />
            </button>

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
                    SpaceS CICT is a classroom allocation and scheduling platform built for the
                    College of Information and Communications Technology (CICT) at Bulacan State
                    University. We are committed to protecting the personal information of our
                    Admins, Local Registrars, Clerks, and Faculty Members in accordance with
                    Republic Act No. 10173, the Data Privacy Act of 2012.
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

                  <h4>Data Protection</h4>
                  <p>
                    All account and scheduling data is stored securely and is accessible only to
                    authorized personnel. Information is used strictly for the operational purposes
                    of classroom allocation and scheduling within CICT and will not be shared with
                    unauthorized third parties.
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
                    By using SpaceS CICT, you agree to use the platform responsibly and only for
                    its intended purpose: managing classroom allocation, scheduling, and
                    reservations for the College of Information and Communications Technology.
                  </p>

                  <h4>Account Responsibility</h4>
                  <ul>
                    <li>Accounts are created and managed by the Admin and must not be shared.</li>
                    <li>Users are responsible for keeping their login credentials confidential.</li>
                    <li>Repeated failed login attempts may result in a temporarily blocked account.</li>
                  </ul>

                  <h4>Acceptable Use</h4>
                  <ul>
                    <li>Room reservations must reflect genuine academic or institutional needs.</li>
                    <li>Users must not attempt to bypass conflict detection or falsify details.</li>
                    <li>Access is limited to features available to the user's assigned role.</li>
                  </ul>

                  <h4>Availability</h4>
                  <p>
                    While the system is designed for reliable, immediate use, scheduled maintenance
                    or unforeseen issues may occasionally affect availability. Users will be notified
                    of major changes or disruptions when possible.
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
                    SpaceS CICT is designed as a responsive web and mobile platform so that Admins,
                    Local Registrars, Clerks, and Faculty Members can access scheduling and
                    reservation features comfortably across desktop and mobile devices.
                  </p>

                  <h4>Design Considerations</h4>
                  <ul>
                    <li>Clear typography, consistent color contrast, and readable layouts.</li>
                    <li>Role-based interfaces that only display relevant features.</li>
                    <li>Mobile-optimized views for Faculty to check schedules on the go.</li>
                  </ul>

                  <h4>Ongoing Improvements</h4>
                  <p>
                    We continue to refine the interface based on feedback gathered from actual CICT
                    users during system testing and evaluation. If you encounter any accessibility
                    issue while using SpaceS CICT, please let us know through Contact Support so we
                    can address it.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}