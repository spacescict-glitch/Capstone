import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { auth, db } from "../../firebase";

const BLOCK_KEY = "spaces_block_info";

/**
 * Route guard — renders child routes via <Outlet />.
 * Use as a LAYOUT route wrapper:
 *
 *   <Route element={<ProtectedRoute allowedRoles={["admin"]} />}>
 *     <Route path="/admin" element={<AdminLayout />}>
 *       ...
 *     </Route>
 *   </Route>
 */
export default function ProtectedRoute({ allowedRoles = [] }) {
  const location = useLocation();
  const [status, setStatus] = useState("checking");
  const [role, setRole] = useState(null);
  const [debugInfo, setDebugInfo] = useState("");

  // Stable key para hindi mag-rerun ang effect sa bawat render
  const rolesKey = allowedRoles.map((r) => String(r).toLowerCase()).join("|");

  useEffect(() => {
    let unsubUserDoc = null;
    let cancelled = false;

    const unsubAuth = onAuthStateChanged(auth, (user) => {
      // Clean previous user-doc listener (auth fires multiple times)
      if (unsubUserDoc) {
        unsubUserDoc();
        unsubUserDoc = null;
      }

      // ── Walang naka-login ──
      if (!user) {
        if (!cancelled) {
          setDebugInfo("No Firebase user");
          setStatus("unauthenticated");
        }
        return;
      }

      // ── Live listener sa user's own document ──
      const ref = doc(db, "users", user.uid);

      unsubUserDoc = onSnapshot(
        ref,
        async (snap) => {
          if (cancelled) return;

          if (!snap.exists()) {
            setDebugInfo(`No /users doc for uid ${user.uid}`);
            setStatus("no-profile");
            return;
          }

          const data = snap.data();
          const userStatus = String(data.status || "").toLowerCase();

          // ═══════════════════════════════════════════════════
          // 🔒 BLOCKED — auto sign out + redirect sa /login
          // ═══════════════════════════════════════════════════
          if (userStatus === "blocked") {
            const blockInfo = {
              reason:
                data.blockReason ||
                "Your account has been blocked by an administrator. Please contact the admin for assistance.",
              email: data.email || user.email || "",
              blockedAt: Date.now(),
            };

            try {
              sessionStorage.setItem(BLOCK_KEY, JSON.stringify(blockInfo));
            } catch (e) {
              console.warn("Failed to save block info:", e);
            }

            setDebugInfo(`Account blocked (uid ${user.uid})`);
            setStatus("blocked");

            try {
              await signOut(auth);
            } catch (err) {
              console.warn("Sign out failed:", err);
            }
            return;
          }

          // ── Normal — role check ──
          const r = data.role || "";
          setRole(r);
          setDebugInfo(`role="${r}" (uid ${user.uid})`);
          setStatus("ok");
        },
        (err) => {
          console.error("ProtectedRoute: user doc listener failed:", err);
          if (!cancelled) {
            setDebugInfo(`Error: ${err.message}`);
            setStatus("error");
          }
        }
      );
    });

    return () => {
      cancelled = true;
      if (unsubUserDoc) unsubUserDoc();
      unsubAuth();
    };
  }, [rolesKey]);

  // ── 1. Still checking auth + role ──
  if (status === "checking") {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#F8F7F5",
          flexDirection: "column",
          gap: 14,
          fontFamily: "'Lexend', sans-serif",
          color: "#6b7280",
        }}
      >
        <i
          className="fa-solid fa-circle-notch fa-spin"
          style={{ fontSize: 32, color: "#f57c00" }}
        />
        <p style={{ margin: 0, fontWeight: 600 }}>Verifying access…</p>
      </div>
    );
  }

  // ── 2. Not logged in → send to login ──
  if (status === "unauthenticated") {
    return (
      <Navigate to="/login" replace state={{ from: location.pathname }} />
    );
  }

  // ── 3. 🔒 Blocked → already signed out above; just redirect ──
  if (status === "blocked") {
    return <Navigate to="/login" replace />;
  }

  // ── 4. Logged in but no profile / error ──
  if (status === "no-profile" || status === "error") {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#F8F7F5",
          padding: 24,
          flexDirection: "column",
          gap: 14,
          fontFamily: "'Lexend', sans-serif",
          textAlign: "center",
        }}
      >
        <i
          className="fa-solid fa-triangle-exclamation"
          style={{ fontSize: 42, color: "#dc2626" }}
        />
        <h2
          style={{
            margin: 0,
            color: "#16213e",
            fontWeight: 800,
            fontSize: 20,
          }}
        >
          Account Not Configured
        </h2>
        <p
          style={{
            margin: 0,
            color: "#6b7280",
            fontSize: 14,
            maxWidth: 400,
            lineHeight: 1.5,
          }}
        >
          Your account does not have a profile set up. Please contact the
          administrator.
        </p>
        <button
          onClick={() =>
            signOut(auth).then(() => window.location.replace("/login"))
          }
          style={{
            marginTop: 8,
            background: "#f57c00",
            color: "#fff",
            border: "none",
            padding: "10px 20px",
            borderRadius: 10,
            fontWeight: 700,
            fontSize: 14,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Back to Login
        </button>
      </div>
    );
  }

  // ── 5. Role check ──
  const normalized = String(role || "").trim().toLowerCase();
  const allowed = allowedRoles.map((r) => String(r).toLowerCase());

  if (allowed.length > 0 && !allowed.includes(normalized)) {
    console.warn(
      `ProtectedRoute: role "${role}" not allowed. Needed one of:`,
      allowedRoles
    );

    // Show access-denied page (NOT redirect — avoids infinite loop)
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#F8F7F5",
          padding: 24,
          flexDirection: "column",
          gap: 14,
          fontFamily: "'Lexend', sans-serif",
          textAlign: "center",
        }}
      >
        <i
          className="fa-solid fa-lock"
          style={{ fontSize: 42, color: "#dc2626" }}
        />
        <h2
          style={{
            margin: 0,
            color: "#16213e",
            fontWeight: 800,
            fontSize: 20,
          }}
        >
          Access Denied
        </h2>
        <p
          style={{
            margin: 0,
            color: "#6b7280",
            fontSize: 14,
            maxWidth: 400,
            lineHeight: 1.5,
          }}
        >
          Your role <strong>“{role}”</strong> does not have permission to view
          this page.
        </p>
        <p
          style={{
            margin: 0,
            color: "#9ca3af",
            fontSize: 12,
            maxWidth: 400,
            lineHeight: 1.5,
          }}
        >
          {debugInfo}
        </p>
        <button
          onClick={() =>
            signOut(auth).then(() => window.location.replace("/login"))
          }
          style={{
            marginTop: 8,
            background: "#f57c00",
            color: "#fff",
            border: "none",
            padding: "10px 20px",
            borderRadius: 10,
            fontWeight: 700,
            fontSize: 14,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Sign Out
        </button>
      </div>
    );
  }

  // ── 6. All good → render child routes ──
  return <Outlet />;
}