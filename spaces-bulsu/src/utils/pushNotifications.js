// ============================================================
// FILE: src/utils/pushNotifications.js
// Web push notification helpers using the browser Notification API.
// Preference is stored in localStorage so it persists across sessions.
// ============================================================

const LS_ENABLED_KEY = "spaces_push_enabled";
const LS_SEEN_KEY = "spaces_push_last_seen";

/* ─── Preference (user toggle) ─────────────────────────────── */
export const getPushEnabled = () => {
  if (typeof window === "undefined") return false;
  // Default: ON
  return localStorage.getItem(LS_ENABLED_KEY) !== "false";
};

export const setPushEnabled = (enabled) => {
  if (typeof window === "undefined") return;
  localStorage.setItem(LS_ENABLED_KEY, enabled ? "true" : "false");
};

/* ─── Browser permission ───────────────────────────────────── */
export const getBrowserPermission = () => {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission; // "default" | "granted" | "denied"
};

export const requestPushPermission = async () => {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  try {
    const result = await Notification.requestPermission();
    return result;
  } catch {
    return "default";
  }
};

/* ─── Fire a real browser notification ─────────────────────── */
export const showPushNotification = (title, options = {}) => {
  if (typeof window === "undefined" || !("Notification" in window)) return null;
  if (Notification.permission !== "granted") return null;
  if (!getPushEnabled()) return null;

  try {
    const notif = new Notification(title, {
      icon: "/SpaceSLogo.png",
      badge: "/SpaceSLogo.png",
      ...options,
    });

    // Focus the tab when the user clicks the notification
    notif.onclick = () => {
      try {
        window.focus();
        notif.close();
      } catch (err) {
        console.warn("Focus failed:", err);
      }
    };

    // Auto-close after 8s so it doesn't pile up
    setTimeout(() => {
      try {
        notif.close();
      } catch {
        /* noop */
      }
    }, 8000);

    return notif;
  } catch (err) {
    console.error("Push notification failed:", err);
    return null;
  }
};

/* ─── Last-seen push cursor (to avoid spamming old notifications) ── */
export const getLastSeenPushTime = () => {
  if (typeof window === "undefined") return Date.now();
  const raw = localStorage.getItem(LS_SEEN_KEY);
  if (!raw) return Date.now(); // first load → don't fire for old ones
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : Date.now();
};

export const setLastSeenPushTime = (ms) => {
  if (typeof window === "undefined") return;
  if (!Number.isFinite(ms)) return;
  localStorage.setItem(LS_SEEN_KEY, String(ms));
};

/* ─── Convenience: fire for a list of new notifications ───── */
export const fireNewNotifications = (notifications = []) => {
  if (!Array.isArray(notifications) || notifications.length === 0) return;

  // Only alert when the tab is hidden / in background
  const tabHidden =
    typeof document !== "undefined" && document.visibilityState === "hidden";
  if (!tabHidden) return;

  const lastSeen = getLastSeenPushTime();
  let maxCreated = lastSeen;
  let fired = 0;

  // Sort ascending so older ones fire first
  const sorted = [...notifications].sort((a, b) => {
    const aMs = a?.createdAt?.toMillis?.() ?? 0;
    const bMs = b?.createdAt?.toMillis?.() ?? 0;
    return aMs - bMs;
  });

  sorted.forEach((n) => {
    const createdMs = n?.createdAt?.toMillis?.() ?? 0;
    if (createdMs > lastSeen) {
      showPushNotification(n.title || "SpaceS CICT", {
        body: n.message || "You have a new notification.",
        tag: n.id,
      });
      fired++;
      if (createdMs > maxCreated) maxCreated = createdMs;
    }
  });

  if (fired > 0) setLastSeenPushTime(maxCreated);
};