// ============================================================
// FILE: src/utils/pushNotifications.js
// Web push notification helpers using the browser Notification API.
// Preference + seen notification IDs are stored in localStorage
// so they persist across sessions and avoid duplicate alerts.
// ============================================================

const LS_ENABLED_KEY = "spaces_push_enabled";
const LS_SEEN_IDS_KEY = "spaces_push_seen_ids";
const MAX_SEEN_IDS = 300;

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
  if (typeof window === "undefined" || !("Notification" in window)) {
    console.warn("[push] Notification API not supported");
    return null;
  }
  if (Notification.permission !== "granted") {
    console.warn("[push] Permission not granted:", Notification.permission);
    return null;
  }
  if (!getPushEnabled()) {
    console.warn("[push] Push disabled by user preference");
    return null;
  }

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
        console.warn("[push] Focus failed:", err);
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
    console.error("[push] Failed to show notification:", err);
    return null;
  }
};

/* ─── Seen IDs (avoid duplicate alerts) ────────────────────── */
const loadSeenIds = () => {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(LS_SEEN_IDS_KEY);
    if (!raw) return null; // null = never initialized
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return null;
  }
};

const saveSeenIds = (set) => {
  if (typeof window === "undefined") return;
  try {
    const arr = Array.from(set).slice(-MAX_SEEN_IDS);
    localStorage.setItem(LS_SEEN_IDS_KEY, JSON.stringify(arr));
  } catch (err) {
    console.warn("[push] Failed to save seen IDs:", err);
  }
};

/* ─── Fire for new notifications ───────────────────────────── */
export const fireNewNotifications = (notifications = []) => {
  if (!Array.isArray(notifications) || notifications.length === 0) return 0;
  if (!getPushEnabled()) return 0;
  if (typeof window === "undefined" || !("Notification" in window)) return 0;
  if (Notification.permission !== "granted") return 0;

  const seenSet = loadSeenIds();

  // ── First ever run: mark all existing notifications as seen,
  //    don't fire anything (avoids spamming old ones).
  if (seenSet === null) {
    const initial = new Set(
      notifications.map((n) => n.id).filter(Boolean)
    );
    saveSeenIds(initial);
    console.log("[push] Initialized seen IDs:", initial.size);
    return 0;
  }

  // ── Find new ones (by ID)
  const newOnes = notifications.filter((n) => n.id && !seenSet.has(n.id));

  // ── Mark everything as seen (whether or not we fire)
  notifications.forEach((n) => n.id && seenSet.add(n.id));
  saveSeenIds(seenSet);

  if (newOnes.length === 0) return 0;

  console.log("[push] New notifications detected:", newOnes.length);

  // Fire oldest → newest so the newest sits on top of the tray
  newOnes
    .sort((a, b) => {
      const aMs = a?.createdAt?.toMillis?.() ?? 0;
      const bMs = b?.createdAt?.toMillis?.() ?? 0;
      return aMs - bMs;
    })
    .forEach((n) => {
      showPushNotification(n.title || "SpaceS CICT", {
        body: n.message || "You have a new notification.",
        tag: n.id,
      });
    });

  return newOnes.length;
};