import React, { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import LoginNav from "../Components/LoginNav/LoginNav";
import "./Home.css";
import logo from "../assets/logo.png"; // Ensure you have a logo.png in assets

// Placeholders for images - replace with your actual image paths
const heroImage = "https://images.unsplash.com/photo-1541339907198-e08756dedf3f?q=80&w=2070&auto=format&fit=crop"; // Classroom image
const aboutImage = "https://images.unsplash.com/photo-1523050854058-8df90110c9f1?q=80&w=2070&auto=format&fit=crop"; // Students/Campus image

const researchers = [
  { name: "Dan Ivan V. Cajucom", role: "Project Leader" },
  { name: "Mark William P. Bravo", role: "Researcher" },
  { name: "Theodora Gwyleth Margareth N. Gabriel", role: "Researcher" },
  { name: "Raiza Shane Torres", role: "Researcher" },
  { name: "Renzo O. Tuazon", role: "Researcher" },
];

export default function Home() {
  const navigate = useNavigate();
  const fadeRefs = useRef([]);

  // Intersection Observer for scroll animations
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
    navigate("/login"); // Adjust this path if your login route is different
  };

  return (
    <div className="home-page-shell">
      <LoginNav
        activePage="home"
        onChangePage={(page) => navigate(`/${page}`)}
        onSignIn={handleSignIn}
        onAboutClick={() => document.getElementById("about").scrollIntoView({ behavior: "smooth" })}
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
            Optimize university resources with SpaceS CICT. A web and mobile-based platform designed to replace manual scheduling, prevent conflicts, and streamline classroom allocation for the College of Information and Communications Technology.
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
          <div className="proof-item">
            <i className="fa-solid fa-user-tie"></i>
            <span>Adviser: Dr. Virginia Natividad Franco</span>
          </div>
        </div>
      </section>

      {/* --- ABOUT SECTION --- */}
      <section className="home-about" id="about">
        <div className="home-about-image fade-up" ref={addToRefs}>
          <img src={aboutImage} alt="About SpaceS CICT" />
        </div>
        <div className="home-about-text fade-up" ref={addToRefs}>
          <h2>About SpaceS CICT</h2>
          <p>
            SpaceS CICT is a centralized web and mobile-based smart platform for classroom allocation and efficient scheduling. It replaces the current manual, meeting-based process that takes 2 to 3 weeks, providing a system where all room schedules, reservations, and conflicts can be viewed in one place.
          </p>
          <p>
            Designed for Admin, Local Registrar, Clerk, and Faculty Members, the system automates conflict detection, recommends alternative rooms, and provides real-time room availability. With AI-assisted schedule extraction from PDFs and Excel files, SpaceS CICT ensures that schedules are accurate, organized, and easily accessible for the entire department.
          </p>
          <ul className="about-checklist">
            <li><i className="fa-solid fa-check-circle"></i> Centralized schedule management</li>
            <li><i className="fa-solid fa-check-circle"></i> Automated conflict detection & resolution</li>
            <li><i className="fa-solid fa-check-circle"></i> Real-time room availability tracking</li>
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
        </div>
      </section>

      {/* --- LEAD MAGNET / CTA SECTION --- */}
      <section className="home-cta fade-up" ref={addToRefs}>
        <div className="cta-content">
          <h2>Ready to transform your classroom management?</h2>
          <p>Sign in to access your role-based dashboard and start scheduling smarter today.</p>
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
                {researcher.name.split(" ").map(n => n[0]).join("").substring(0, 2)}
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
            <span>Privacy Policy</span>
            <span>Terms of Use</span>
            <span>Accessibility</span>
          </div>
        </div>
      </footer>
    </div>
  );
}