import { useState, useEffect, useRef, useMemo } from "react";
import {
  collection,
  addDoc,
  serverTimestamp,
  getDocs,
  doc,
  updateDoc,
  setDoc,
  query,
  orderBy,
} from "firebase/firestore";
import { sendPasswordResetEmail } from "firebase/auth";
import { initializeApp, deleteApp } from "firebase/app";
import { getAuth, createUserWithEmailAndPassword } from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";
import { auth, db } from "../../firebase";
import { logActivity } from "../../utils/logActivity";
import "./user-management.css";
import * as XLSX from "xlsx";
import emailjs from "@emailjs/browser";
import Toast from "../../Popup/Toast/Toast";
import ConfirmPopup from "../../Popup/ConfirmPopup/ConfirmPopup";

emailjs.init("bNsod6OOQzMmRo0Cs");

const firebaseConfig = {
  apiKey: "AIzaSyAQRQ0DcO-giGzZN46w91TJb2NGZ1S8ykQ",
  authDomain: "spaces-cict.firebaseapp.com",
  projectId: "spaces-cict",
  storageBucket: "spaces-cict.firebasestorage.app",
  messagingSenderId: "268419005346",
  appId: "1:268419005346:web:6c2bb5f113f46ff28890fb",
};

const functions = getFunctions();
const deleteUserFn = httpsCallable(functions, "deleteUser");

const ROLE_COLORS = {
  Faculty: { bg: "#EDE9FE", text: "#5B21B6" },
  "Local Registrar": { bg: "#FEF3C7", text: "#92400E" },
  Clerk: { bg: "#FEF0E7", text: "#F97316" },
  Admin: { bg: "#DBEAFE", text: "#1D4ED8" },
};

const ROLES = ["Faculty", "Local Registrar", "Clerk", "Admin"];

const SORT_OPTIONS = [
  { value: "name-asc", label: "Name (A–Z)", icon: "fa-arrow-down-a-z" },
  { value: "name-desc", label: "Name (Z–A)", icon: "fa-arrow-down-z-a" },
  { value: "role", label: "Role", icon: "fa-user-tag" },
  { value: "status", label: "Status", icon: "fa-circle-dot" },
];

const steps = [{ number: 1, label: "DETAILS" }, { number: 2, label: "CONFIRM" }];

const DELETE_PHRASE = "DELETE USER";

const PER_PAGE = 10; // ← Max users per page

async function createUserSecondaryApp(email, password) {
  const secondaryApp = initializeApp(firebaseConfig, `secondary-${Date.now()}`);
  const secondaryAuth = getAuth(secondaryApp);
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    return cred.user.uid;
  } finally {
    await deleteApp(secondaryApp);
  }
}

function generateTempPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function downloadUserTemplate() {
  const headers = ["First Name", "Last Name", "Email", "Role"];
  const sampleRows = [
    ["Juan", "Dela Cruz", "juan.delacruz@bulsu.edu.ph", "Faculty"],
    ["Maria", "Santos", "maria.santos@bulsu.edu.ph", "Local Registrar"],
    ["Pedro", "Reyes", "pedro.reyes@bulsu.edu.ph", "Clerk"],
  ];
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...sampleRows]);
  worksheet["!cols"] = [{ wch: 18 }, { wch: 18 }, { wch: 38 }, { wch: 22 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Users");
  XLSX.writeFile(workbook, "SpaceS_CICT_User_Template.xlsx");
}

function Stepper({ current }) {
  return (
    <div className="um-stepper">
      {steps.map((s, i) => (
        <div className="um-step-wrapper" key={s.number}>
          <div className="um-step-item">
            <div
              className={`um-step-circle ${current === s.number ? "active" : ""} ${
                current > s.number ? "completed" : ""
              }`}
            >
              {current > s.number ? <i className="fa-solid fa-check" /> : s.number}
            </div>
            <span className={`um-step-label ${current === s.number ? "active" : ""}`}>{s.label}</span>
          </div>
          {i < steps.length - 1 && <div className={`um-step-line ${current > s.number ? "completed" : ""}`} />}
        </div>
      ))}
    </div>
  );
}

function SortMenu({ sortBy, setSortBy }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const current = SORT_OPTIONS.find((o) => o.value === sortBy) || SORT_OPTIONS[0];

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="um-sort-menu" ref={ref}>
      <button className="um-filter-btn" onClick={() => setOpen((v) => !v)} type="button">
        <i className={`fa-solid ${current.icon}`} />
        Sort: {current.label}
        <i className={`fa-solid fa-chevron-down um-sort-chevron ${open ? "is-open" : ""}`} />
      </button>

      {open && (
        <div className="um-sort-dropdown">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`um-sort-option ${sortBy === opt.value ? "active" : ""}`}
              onClick={() => {
                setSortBy(opt.value);
                setOpen(false);
              }}
            >
              <i className={`fa-solid ${opt.icon}`} />
              {opt.label}
              {sortBy === opt.value && <i className="fa-solid fa-check um-sort-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Pagination control component ──
function Pagination({ currentPage, totalPages, onPageChange, totalItems, startIndex, endIndex }) {
  if (totalPages <= 1) return null;

  // Build visible page numbers (window of 5)
  const getPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;
    let start = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    let end = Math.min(totalPages, start + maxVisible - 1);

    if (end - start + 1 < maxVisible) {
      start = Math.max(1, end - maxVisible + 1);
    }

    if (start > 1) {
      pages.push(1);
      if (start > 2) pages.push("...");
    }

    for (let i = start; i <= end; i++) pages.push(i);

    if (end < totalPages) {
      if (end < totalPages - 1) pages.push("...");
      pages.push(totalPages);
    }

    return pages;
  };

  return (
    <div className="um-pagination">
      <span className="um-pagination-info">
        Showing <strong>{startIndex + 1}</strong>–<strong>{endIndex}</strong> of <strong>{totalItems}</strong>
      </span>

      <div className="um-pagination-controls">
        <button
          type="button"
          className="um-page-btn"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          title="Previous page"
        >
          <i className="fa-solid fa-chevron-left" />
        </button>

        {getPageNumbers().map((p, idx) =>
          p === "..." ? (
            <span key={`ellipsis-${idx}`} className="um-page-ellipsis">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              className={`um-page-btn ${p === currentPage ? "active" : ""}`}
              onClick={() => onPageChange(p)}
            >
              {p}
            </button>
          )
        )}

        <button
          type="button"
          className="um-page-btn"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          title="Next page"
        >
          <i className="fa-solid fa-chevron-right" />
        </button>
      </div>
    </div>
  );
}

function UserList({ onCreateAccount, logActivity, getFullName, showToast }) {
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [resetTarget, setResetTarget] = useState(null);
  const [sortBy, setSortBy] = useState("name-asc");
  const [roleFilter, setRoleFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [deleting, setDeleting] = useState(false);

  // ── Pagination state ──
  const [currentPage, setCurrentPage] = useState(1);

  // ── 2-step strong warning delete ──
  const [deleteStep, setDeleteStep] = useState(1);
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const handleDeleteUser = (user) => {
    setDeleteTarget(user);
    setDeleteStep(1);
    setDeleteAcknowledged(false);
    setDeleteConfirmText("");
  };

  const closeDeleteModal = () => {
    if (deleting) return;
    setDeleteTarget(null);
    setDeleteStep(1);
    setDeleteAcknowledged(false);
    setDeleteConfirmText("");
  };

  const confirmDeleteUser = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const targetUser = deleteTarget;

    try {
      const result = await deleteUserFn({ userId: targetUser.id });
      if (!result.data?.success) throw new Error("Cloud function did not return success.");

      setUsers((prev) => prev.filter((u) => u.id !== targetUser.id));

      await logActivity({
        userId: targetUser.id,
        user: getFullName(targetUser),
        role: targetUser.role,
        action: "Deleted User (Auth + Firestore)",
        actionType: "failed",
        target: targetUser.email,
        status: "SUCCESS",
      });

      showToast("success", "User Deleted", `${targetUser.email} was removed. The email can now be reused.`);
      closeDeleteModal();
    } catch (e) {
      console.error("Delete error:", e);
      if (e?.code === "functions/not-found" || e?.code === "functions/unavailable") {
        showToast("error", "Function Not Deployed", "The deleteUser Cloud Function is not deployed yet. Run: firebase deploy --only functions");
      } else if (e?.code === "functions/permission-denied") {
        showToast("error", "Permission Denied", e.message || "You cannot delete this user.");
      } else if (e?.code === "functions/failed-precondition") {
        showToast("error", "Not Allowed", e.message || "Action blocked by server.");
      } else {
        showToast("error", "Delete Failed", e?.message || "Could not delete the user.");
      }
    } finally {
      setDeleting(false);
    }
  };

  const isDeleteReady =
    deleteStep === 2 &&
    deleteAcknowledged &&
    deleteConfirmText.trim() === DELETE_PHRASE;

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const q = query(collection(db, "users"), orderBy("lastName"));
      const snap = await getDocs(q);
      setUsers(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.error("Failed to fetch users:", e);
      showToast("error", "Load Failed", "Could not fetch the user list.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchUsers(); }, []);

  const roleCounts = ROLES.reduce((acc, r) => {
    acc[r] = users.filter((u) => u.role === r).length;
    return acc;
  }, {});

  const totalCount = users.length;
  const activeCount = users.filter((u) => u.status === "Active").length;
  const blockedCount = users.filter((u) => u.status === "Blocked").length;

  // ── Filtered + sorted list ──
  const filtered = useMemo(() => {
    return users
      .filter(
        (u) =>
          `${u.firstName} ${u.lastName}`.toLowerCase().includes(search.toLowerCase()) ||
          u.email?.toLowerCase().includes(search.toLowerCase()) ||
          u.role?.toLowerCase().includes(search.toLowerCase())
      )
      .filter((u) => roleFilter === "All" || u.role === roleFilter)
      .filter((u) => statusFilter === "All" || u.status === statusFilter)
      .sort((a, b) => {
        const nameA = `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim().toLowerCase();
        const nameB = `${b.firstName ?? ""} ${b.lastName ?? ""}`.trim().toLowerCase();
        switch (sortBy) {
          case "name-desc": return nameB.localeCompare(nameA);
          case "role": return (a.role || "").localeCompare(b.role || "") || nameA.localeCompare(nameB);
          case "status": return (a.status || "").localeCompare(b.status || "") || nameA.localeCompare(nameB);
          case "name-asc":
          default: return nameA.localeCompare(nameB);
        }
      });
  }, [users, search, roleFilter, statusFilter, sortBy]);

  // ── Pagination computation ──
  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const startIndex = (currentPage - 1) * PER_PAGE;
  const endIndex = Math.min(startIndex + PER_PAGE, filtered.length);
  const paginatedUsers = filtered.slice(startIndex, endIndex);

  // Reset to page 1 whenever filters/search/sort change
  useEffect(() => {
    setCurrentPage(1);
  }, [search, roleFilter, statusFilter, sortBy]);

  // Guard: if current page exceeds total pages (e.g., after deletion), clamp
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  // ── Toggle Active ↔ Blocked (unified) ──
  const handleToggleStatus = async (user) => {
    const isUnblocking = user.status === "Blocked";
    const newStatus = isUnblocking ? "Active" : "Blocked";

    const updates = isUnblocking
      ? {
          status: "Active",
          loginAttempts: 0,
          blockReason: "",
          blockedAt: null,
          blockedUntil: null,
          lastFailedAt: null,
          lastFailedReason: "",
          lastFailedRole: "",
        }
      : {
          status: "Blocked",
          loginAttempts: 0,
          blockReason: "Manually blocked by Admin",
          blockedAt: serverTimestamp(),
          blockedUntil: null,
          lastFailedAt: null,
          lastFailedReason: "",
          lastFailedRole: "",
        };

    try {
      await updateDoc(doc(db, "users", user.id), updates);
      await logActivity({
        userId: user.id,
        user: getFullName(user),
        role: user.role,
        action: isUnblocking ? "Unblocked User" : "Blocked User",
        actionType: "edit",
        target: user.email,
        status: "SUCCESS",
      });
      setUsers((prev) =>
        prev.map((u) => (u.id === user.id ? { ...u, ...updates } : u))
      );
      showToast(
        "success",
        isUnblocking ? "User Unblocked" : "User Blocked",
        `${getFullName(user)} is now ${newStatus.toLowerCase()}.`
      );
    } catch (e) {
      showToast("error", "Update Failed", e.message);
    }
  };

  const requestResetPassword = (user) => setResetTarget(user);

  const confirmResetPassword = async () => {
    if (!resetTarget) return;
    const user = resetTarget;
    setResetTarget(null);
    setSending(user.id);
    try {
      await sendPasswordResetEmail(auth, user.email, {
        url: `${window.location.origin}/reset-password`,
        handleCodeInApp: false,
      });
      await logActivity({
        userId: user.id,
        user: getFullName(user),
        role: user.role,
        action: "Sent Password Reset Email",
        actionType: "success",
        target: user.email,
        status: "SUCCESS",
      });
      showToast("success", "Email Sent", `Password reset email sent to ${user.email}.`);
    } catch (e) {
      showToast("error", "Send Failed", e.message);
    } finally {
      setSending(null);
    }
  };

  const formatBlockedUntil = (blockedUntil) => {
    const d = blockedUntil?.toDate?.();
    if (!d) return null;
    return d.toLocaleString();
  };

  return (
    <div className="um-page">
      <div className="um-header">
        <div>
          <h1 className="um-title">User Management</h1>
          <p className="um-subtitle">Manage university staff roles and system access permissions.</p>
        </div>
        <button className="um-create-btn" onClick={onCreateAccount}>
          <i className="fa-solid fa-user-plus" /> Create New Account
        </button>
      </div>

      {/* ── STATS — 3 cards ── */}
      <div className="um-stats-row">
        <div className="um-stat-card">
          <div className="um-stat-icon"><i className="fa-solid fa-users" /></div>
          <div>
            <div className="um-stat-value">{totalCount}</div>
            <div className="um-stat-label">Total Users</div>
          </div>
        </div>

        <div className="um-stat-card">
          <div className="um-stat-icon is-success"><i className="fa-solid fa-circle-check" /></div>
          <div>
            <div className="um-stat-value">{activeCount}</div>
            <div className="um-stat-label">Active</div>
          </div>
        </div>

        <div className="um-stat-card">
          <div className="um-stat-icon is-blocked"><i className="fa-solid fa-lock" /></div>
          <div>
            <div className="um-stat-value">{blockedCount}</div>
            <div className="um-stat-label">Blocked</div>
          </div>
        </div>
      </div>

      <div className="um-search-row">
        <div className="um-search-bar">
          <i className="fa-solid fa-magnifying-glass" />
          <input
            placeholder="Search by name, email, or role..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <SortMenu sortBy={sortBy} setSortBy={setSortBy} />
      </div>

      <div className="um-chip-row">
        <button className={`um-chip ${roleFilter === "All" ? "active" : ""}`} onClick={() => setRoleFilter("All")}>
          All <span className="um-chip-count">{totalCount}</span>
        </button>

        {ROLES.map((r) => {
          const rc = ROLE_COLORS[r];
          return (
            <button
              key={r}
              className={`um-chip ${roleFilter === r ? "active" : ""}`}
              style={roleFilter === r ? { background: rc.bg, color: rc.text, borderColor: rc.text } : undefined}
              onClick={() => setRoleFilter(r)}
            >
              {r} <span className="um-chip-count">{roleCounts[r]}</span>
            </button>
          );
        })}
      </div>

      {/* ── STATUS FILTER CHIPS ── */}
      <div className="um-chip-row um-status-chip-row">
        <button
          className={`um-chip ${statusFilter === "All" ? "active" : ""}`}
          onClick={() => setStatusFilter("All")}
        >
          Any Status
        </button>
        <button
          className={`um-chip ${statusFilter === "Active" ? "active" : ""}`}
          onClick={() => setStatusFilter("Active")}
        >
          Active
        </button>
        <button
          className={`um-chip ${statusFilter === "Blocked" ? "active" : ""}`}
          onClick={() => setStatusFilter("Blocked")}
        >
          Blocked {blockedCount > 0 && <span className="um-chip-count">{blockedCount}</span>}
        </button>
      </div>

      <div className="um-table-card">
        {loading ? (
          <div className="um-loading-state">
            <span className="um-spinner" />
            Loading users…
          </div>
        ) : (
          <table className="um-table">
            <thead>
              <tr>
                <th>NAME</th><th>EMAIL</th><th>ROLE</th><th>STATUS</th><th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {paginatedUsers.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <div className="um-empty-state">
                      <i className="fa-solid fa-user-slash" />
                      <p>No users found.</p>
                      <span>Try a different search term or filter.</span>
                    </div>
                  </td>
                </tr>
              ) : (
                paginatedUsers.map((u) => {
                  const rc = ROLE_COLORS[u.role] || { bg: "#f3f4f6", text: "#374151" };
                  const fullName = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
                  const isBlocked = u.status === "Blocked";
                  const blockedUntilStr = formatBlockedUntil(u.blockedUntil);

                  return (
                    <tr key={u.id}>
                      <td>
                        <div className="um-user-cell">
                          <div className={`um-avatar ${isBlocked ? "blocked" : ""}`}>
                            {fullName.charAt(0).toUpperCase() || "?"}
                          </div>
                          <span className="um-name">{fullName || "—"}</span>
                        </div>
                      </td>
                      <td className="um-email">{u.email}</td>
                      <td>
                        <span className="um-role-badge" style={{ backgroundColor: rc.bg, color: rc.text }}>
                          {u.role}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`um-status ${u.status?.toLowerCase()}`}
                          title={isBlocked ? (u.blockReason || "Account blocked") : undefined}
                        >
                          <span className="um-status-dot" />
                          {u.status}
                        </span>
                        {isBlocked && blockedUntilStr && (
                          <div className="um-block-info">
                            <i className="fa-solid fa-clock" /> Auto-unblock: {blockedUntilStr}
                          </div>
                        )}
                        {isBlocked && !blockedUntilStr && (
                          <div className="um-block-info">
                            <i className="fa-solid fa-triangle-exclamation" /> Requires manual unblock
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="um-actions">
                          <button className="um-action-icon danger" title="Delete User" onClick={() => handleDeleteUser(u)}>
                            <i className="fa-solid fa-trash" />
                          </button>

                          <button
                            className="um-action-icon"
                            title="Send password reset email"
                            onClick={() => requestResetPassword(u)}
                            disabled={sending === u.id}
                          >
                            <i className={`fa-solid ${sending === u.id ? "fa-spinner fa-spin" : "fa-rotate-right"}`} />
                          </button>

                          {u.status === "Active" ? (
                            <button
                              className="um-action-icon danger"
                              title="Block this account"
                              onClick={() => handleToggleStatus(u)}
                            >
                              <i className="fa-solid fa-ban" />
                            </button>
                          ) : (
                            <button
                              className="um-action-icon success"
                              title="Unblock this account"
                              onClick={() => handleToggleStatus(u)}
                            >
                              <i className="fa-solid fa-circle-check" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        )}

        {/* ── PAGINATION ── */}
        {!loading && filtered.length > 0 && (
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={setCurrentPage}
            totalItems={filtered.length}
            startIndex={startIndex}
            endIndex={endIndex}
          />
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════
          DELETE USER — 2-step strong warning modal
          ═══════════════════════════════════════════════════════ */}
      {deleteTarget && (
        <div className="um-modal-overlay" onClick={closeDeleteModal}>
          <div className="um-modal um-modal-delete-warning" onClick={(e) => e.stopPropagation()}>
            {deleteStep === 1 && (
              <>
                <div className="um-modal-icon is-danger um-modal-icon-pulse">
                  <i className="fa-solid fa-triangle-exclamation" />
                </div>
                <h3 className="um-modal-title">Delete User Account?</h3>
                <p className="um-modal-text">
                  This is a <strong>permanent and irreversible</strong> action.
                  Please read carefully before continuing.
                </p>

                <div className="um-modal-target">
                  <i className="fa-solid fa-user-xmark" />
                  <div>
                    <span className="um-target-label">Target Account</span>
                    <span className="um-target-value">{deleteTarget.email}</span>
                  </div>
                </div>

                <div className="um-delete-warning-box">
                  <div className="um-delete-warning-title">
                    <i className="fa-solid fa-circle-exclamation" />
                    What will be permanently destroyed
                  </div>
                  <ul className="um-delete-warning-list">
                    <li><i className="fa-solid fa-xmark" />The Firebase Authentication account (email becomes reusable)</li>
                    <li><i className="fa-solid fa-xmark" />All profile data — name, role, status, temp password</li>
                    <li><i className="fa-solid fa-xmark" />All rooms the user is currently watching ("Notify Me")</li>
                    <li><i className="fa-solid fa-xmark" />Entire notification history and unread alerts</li>
                    <li><i className="fa-solid fa-xmark" />All class schedules, reservations, and bookings tied to this account</li>
                    <li><i className="fa-solid fa-xmark" />Login audit trail and account activity logs</li>
                  </ul>
                </div>

                <label className="um-delete-ack">
                  <input
                    type="checkbox"
                    checked={deleteAcknowledged}
                    onChange={(e) => setDeleteAcknowledged(e.target.checked)}
                  />
                  <span>
                    I understand this action is <strong>permanent</strong> and
                    cannot be undone. All data associated with{" "}
                    <strong>{deleteTarget.email}</strong> will be erased.
                  </span>
                </label>

                <div className="um-modal-actions">
                  <button
                    type="button"
                    className="um-modal-cancel"
                    onClick={closeDeleteModal}
                    disabled={deleting}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="um-modal-confirm is-danger"
                    disabled={!deleteAcknowledged}
                    onClick={() => setDeleteStep(2)}
                  >
                    Continue to Confirmation <i className="fa-solid fa-arrow-right" />
                  </button>
                </div>
              </>
            )}

            {deleteStep === 2 && (
              <>
                <div className="um-modal-icon is-danger um-modal-icon-pulse">
                  <i className="fa-solid fa-trash-can" />
                </div>
                <h3 className="um-modal-title">Final Confirmation</h3>
                <p className="um-modal-text">
                  This is your <strong>last chance</strong>. Once you click the delete
                  button below, this account is gone forever.
                </p>

                <div className="um-delete-danger-banner">
                  <i className="fa-solid fa-skull-crossbones" />
                  <span>Point of no return</span>
                </div>

                <div className="um-modal-target is-danger">
                  <i className="fa-solid fa-user-xmark" />
                  <div>
                    <span className="um-target-label">Deleting</span>
                    <span className="um-target-value">{deleteTarget.email}</span>
                  </div>
                </div>

                <div className="um-form-group" style={{ width: "100%", textAlign: "left" }}>
                  <label>
                    Type <span className="um-danger-text">{DELETE_PHRASE}</span> to confirm
                  </label>
                  <input
                    type="text"
                    className="um-input"
                    value={deleteConfirmText}
                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                    placeholder={DELETE_PHRASE}
                    autoComplete="off"
                    spellCheck="false"
                  />
                  <small
                    className={
                      deleteConfirmText === DELETE_PHRASE
                        ? "um-phrase-ok"
                        : deleteConfirmText.length > 0
                        ? "um-phrase-bad"
                        : ""
                    }
                  >
                    {deleteConfirmText === DELETE_PHRASE ? (
                      <><i className="fa-solid fa-circle-check" /> Phrase matched</>
                    ) : deleteConfirmText.length > 0 ? (
                      <><i className="fa-solid fa-circle-xmark" /> Phrase doesn't match</>
                    ) : (
                      "Type the exact phrase to enable the delete button."
                    )}
                  </small>
                </div>

                <div className="um-modal-actions">
                  <button
                    type="button"
                    className="um-modal-cancel"
                    onClick={() => setDeleteStep(1)}
                    disabled={deleting}
                  >
                    <i className="fa-solid fa-arrow-left" /> Back
                  </button>
                  <button
                    type="button"
                    className="um-modal-confirm is-danger"
                    onClick={confirmDeleteUser}
                    disabled={!isDeleteReady || deleting}
                  >
                    {deleting ? (
                      <><i className="fa-solid fa-spinner fa-spin" /> Deleting…</>
                    ) : (
                      <><i className="fa-solid fa-trash-can" /> Delete Forever</>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Reset password modal ── */}
      {resetTarget && (
        <div className="um-modal-overlay">
          <div className="um-modal">
            <div className="um-modal-icon"><i className="fa-solid fa-rotate-right" /></div>
            <h3 className="um-modal-title">Send Reset Email</h3>
            <p className="um-modal-text">
              Send a password reset email to<br /><strong>{resetTarget.email}</strong>?
            </p>
            <div className="um-modal-actions">
              <button className="um-modal-cancel" onClick={() => setResetTarget(null)}>Cancel</button>
              <button className="um-modal-confirm" onClick={confirmResetPassword}>Send Email</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateAccountStep1({ form, setForm, entryMode, setEntryMode, excelFile, setExcelFile, onNext, onBack }) {
  const canProceed =
    entryMode === "manual"
      ? form.firstName && form.lastName && form.email && form.role
      : entryMode === "excel" && excelFile;

  return (
    <div className="um-page">
      <div className="um-create-header">
        <h1 className="um-title">Create New Account</h1>
        <p className="um-subtitle">Create users either individually or through bulk Excel upload.</p>
      </div>

      <Stepper current={1} />

      <div className="um-form-card">
        <div className="um-form-group">
          <label>Select Account Creation Method</label>
          <div className="um-mode-selector">
            <button type="button" className={`um-mode-btn ${entryMode === "manual" ? "active" : ""}`} onClick={() => setEntryMode("manual")}>
              <i className="fa-solid fa-user" /> Individual Entry
            </button>
            <button type="button" className={`um-mode-btn ${entryMode === "excel" ? "active" : ""}`} onClick={() => setEntryMode("excel")}>
              <i className="fa-solid fa-file-excel" /> Upload Excel
            </button>
          </div>
        </div>

        {entryMode === "manual" && (
          <>
            {[
              { label: "First Name", key: "firstName", placeholder: "Enter first name" },
              { label: "Last Name", key: "lastName", placeholder: "Enter last name" },
            ].map((f) => (
              <div className="um-form-group" key={f.key}>
                <label>{f.label}</label>
                <input
                  className="um-input"
                  placeholder={f.placeholder}
                  value={form[f.key]}
                  onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                />
              </div>
            ))}

            <div className="um-form-group">
              <label>Email Address</label>
              <input
                className="um-input"
                type="email"
                placeholder="Enter email address"
                value={form.email}
                onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
              />
            </div>

            <div className="um-form-group">
              <label>Role</label>
              <select
                className="um-input um-select"
                value={form.role}
                onChange={(e) => setForm((prev) => ({ ...prev, role: e.target.value }))}
              >
                <option value="">Select role</option>
                <option>Faculty</option>
                <option>Local Registrar</option>
                <option>Clerk</option>
                <option>Admin</option>
              </select>
            </div>
          </>
        )}

        {entryMode === "excel" && (
          <>
            <div className="um-upload-info">
              <div className="um-upload-info-head">
                <h3><i className="fa-solid fa-table-list" /> Required Excel Columns</h3>
                <button type="button" className="um-template-btn" onClick={downloadUserTemplate}>
                  <i className="fa-solid fa-download" /> Download Template
                </button>
              </div>
              <ul>
                <li>First Name</li><li>Last Name</li><li>Email</li><li>Role</li>
              </ul>
              <p>Download the template above, fill in the rows, then upload the file below. Every row will automatically create a new user account.</p>
            </div>

            <div className="um-form-group">
              <label>Upload Excel File</label>
              <label className="um-dropzone">
                <i className="fa-solid fa-cloud-arrow-up" />
                <span>{excelFile ? "Choose a different file" : "Click to browse, or drag a file here"}</span>
                <input type="file" accept=".xlsx,.xls" hidden onChange={(e) => setExcelFile(e.target.files?.[0] || null)} />
              </label>
            </div>

            {excelFile && (
              <div className="um-file-preview">
                <i className="fa-solid fa-file-excel" />
                <span>{excelFile.name}</span>
                <button type="button" className="um-file-remove" onClick={() => setExcelFile(null)} aria-label="Remove file">
                  <i className="fa-solid fa-xmark" />
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="um-footer step2">
        <button className="um-back-btn" onClick={onBack}>Back</button>
        <button className="um-next-btn" onClick={onNext} disabled={!canProceed}>Next</button>
      </div>
    </div>
  );
}

function CreateAccountStep2({ form, entryMode, excelFile, onBack, onConfirm }) {
  return (
    <div className="um-page">
      <div className="um-create-header">
        <h1 className="um-title">Create New Account</h1>
        <p className="um-subtitle">Review the information before proceeding.</p>
      </div>

      <Stepper current={2} />

      <div className="um-form-card">
        <h2 className="um-confirm-title">Account Details</h2>
        <hr className="um-confirm-divider" />
        <div className="um-confirm-body">
          {entryMode === "manual" ? (
            <>
              <div className="um-confirm-row"><span>First Name</span><strong>{form.firstName}</strong></div>
              <div className="um-confirm-row"><span>Last Name</span><strong>{form.lastName}</strong></div>
              <div className="um-confirm-row"><span>Email</span><strong>{form.email}</strong></div>
              <div className="um-confirm-row"><span>Role</span><strong>{form.role}</strong></div>
            </>
          ) : (
            <>
              <div className="um-confirm-row"><span>Upload Type</span><strong>Bulk Excel Upload</strong></div>
              <div className="um-confirm-row"><span>File</span><strong>{excelFile?.name}</strong></div>
            </>
          )}
        </div>
        <div className="um-info-box">
          <i className="fa-solid fa-circle-info" />
          <span>An automated email will be sent to all created users.</span>
        </div>
      </div>

      <div className="um-footer step2">
        <button className="um-back-btn" onClick={onBack}>Back</button>
        <button className="um-next-btn" onClick={onConfirm}>Confirm</button>
      </div>
    </div>
  );
}

const EMPTY_FORM = { firstName: "", lastName: "", email: "", role: "" };

export default function UserManagement() {
  const [view, setView] = useState("list");
  const [showModal, setShowModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [entryMode, setEntryMode] = useState("");
  const [excelFile, setExcelFile] = useState(null);
  const toastTimeoutRef = useRef(null);

  const [toast, setToast] = useState({ show: false, type: "success", title: "", message: "" });

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

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  const getFullName = (u) => `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();

  const logActivity = async ({ userId, user, role, action, actionType, target, status }) => {
    try {
      await addDoc(collection(db, "activityLogs"), {
        userId, user, role, action, actionType, target, status, timestamp: serverTimestamp(),
      });
    } catch (err) {
      console.error("Activity log error:", err);
    }
  };

  const reset = () => {
    setForm(EMPTY_FORM);
    setEntryMode("");
    setExcelFile(null);
    setView("list");
  };

  const parseExcelFile = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = e.target.result;
          const workbook = XLSX.read(data, { type: "array" });
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet);
          resolve(rows);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  };

  const handleFinalConfirm = async () => {
    setCreating(true);
    showToast("loading", "Creating", "Creating account(s)...");

    try {
      if (entryMode === "manual") {
        const tempPassword = generateTempPassword();
        const uid = await createUserSecondaryApp(form.email, tempPassword);

        await setDoc(doc(db, "users", uid), {
          firstName: form.firstName,
          lastName: form.lastName,
          email: form.email,
          role: form.role,
          status: "Active",
          tempPassword,
          passwordReset: false,
          createdAt: new Date().toISOString(),
        });

        try {
          await emailjs.send(
            "service_qogg8xj",
            "template_okil0d3",
            {
              user_email: form.email,
              first_name: form.firstName,
              last_name: form.lastName,
              role: form.role,
              temp_password: tempPassword,
            },
            "bNsod6OOQzMmRo0Cs"
          );
        } catch (emailError) {
          console.error("EMAILJS ERROR:", emailError);
          showToast("error", "Email Not Sent", "Account was created, but the welcome email failed to send.");
        }

        await logActivity({
          userId: uid,
          user: `${form.firstName} ${form.lastName}`,
          role: form.role,
          action: "Created User Account",
          actionType: "success",
          target: form.email,
          status: "SUCCESS",
        });

        showToast("success", "Account Created", `Account created for ${form.email}.`);
      } else {
        const rows = await parseExcelFile(excelFile);

        const normalizedRows = rows.map((row) => ({
          firstName: row["First Name"] || row["firstName"],
          lastName: row["Last Name"] || row["lastName"],
          email: row["Email"] || row["email"],
          role: row["Role"] || row["role"],
        }));

        let successCount = 0;
        let failedRows = [];

        for (let i = 0; i < normalizedRows.length; i++) {
          const row = normalizedRows[i];
          try {
            if (!row.firstName || !row.lastName || !row.email || !row.role) throw new Error("Missing required fields");
            const tempPassword = generateTempPassword();
            const uid = await createUserSecondaryApp(row.email, tempPassword);

            await setDoc(doc(db, "users", uid), {
              firstName: row.firstName,
              lastName: row.lastName,
              email: row.email,
              role: row.role,
              status: "Active",
              tempPassword,
              passwordReset: false,
              createdAt: new Date().toISOString(),
            });

            try {
              await emailjs.send(
                "service_qogg8xj",
                "template_okil0d3",
                {
                  user_email: row.email,
                  first_name: row.firstName,
                  last_name: row.lastName,
                  role: row.role,
                  temp_password: tempPassword,
                },
                "bNsod6OOQzMmRo0Cs"
              );
            } catch (emailError) {
              console.error("EMAILJS ERROR:", emailError);
            }

            await logActivity({
              userId: uid,
              user: `${row.firstName} ${row.lastName}`,
              role: row.role,
              action: "Bulk Created User",
              actionType: "success",
              target: row.email,
              status: "SUCCESS",
            });

            successCount++;
          } catch (err) {
            console.error(err);
            failedRows.push({ row: i + 2, email: row.email, error: err.code || err.message });
          }
        }

        showToast(
          failedRows.length === 0 ? "success" : "error",
          "Bulk Upload Complete",
          `Created ${successCount} account${successCount === 1 ? "" : "s"}${failedRows.length ? `, ${failedRows.length} failed (see console for details).` : "."}`
        );

        console.log("Failed Rows:", failedRows);
      }

      setShowModal(false);
      reset();
    } catch (err) {
      console.error(err);
      if (err.code === "auth/email-already-in-use") {
        showToast(
          "error",
          "Email Already In Use",
          "This email already exists in Firebase Authentication. Delete the existing user first to reuse the email."
        );
      } else {
        showToast("error", "Failed", err.message || String(err.code));
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={{ position: "relative" }}>
      {view === "list" && (
        <UserList
          onCreateAccount={() => setView("step1")}
          logActivity={logActivity}
          getFullName={getFullName}
          showToast={showToast}
        />
      )}
      {view === "step1" && (
        <CreateAccountStep1
          form={form}
          setForm={setForm}
          entryMode={entryMode}
          setEntryMode={setEntryMode}
          excelFile={excelFile}
          setExcelFile={setExcelFile}
          onNext={() => setView("step2")}
          onBack={reset}
        />
      )}
      {view === "step2" && (
        <CreateAccountStep2
          form={form}
          entryMode={entryMode}
          excelFile={excelFile}
          onBack={() => setView("step1")}
          onConfirm={() => setShowModal(true)}
        />
      )}
      {showModal && (
        <ConfirmPopup onCancel={() => setShowModal(false)} onConfirm={handleFinalConfirm} />
      )}

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