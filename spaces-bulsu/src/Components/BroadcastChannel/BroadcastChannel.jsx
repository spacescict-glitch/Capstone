import { useState, useEffect, useRef } from "react";
import "./broadcast-channel.css";
import {
  collection,
  addDoc,
  query,
  orderBy,
  serverTimestamp,
  onSnapshot,
  doc,
  updateDoc,
  deleteDoc,
  arrayUnion,
  arrayRemove,
  getDoc,
  getDocs,
} from "firebase/firestore";
import { db, auth } from "../../firebase";
import { logActivity } from "../../utils/logActivity";
import Toast from "../../Popup/Toast/Toast";

// ─── Cloudinary constants ─────────────────────────────────────────────
const CLOUDINARY_CLOUD_NAME = "dzu1qb8oz";
const CLOUDINARY_UPLOAD_PRESET = "SpacesCICT";

// ═══════════════════════════════════════════════════════════════════
// ✅ UPLOAD LIMITS
// ═══════════════════════════════════════════════════════════════════
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB per image
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file
const MAX_TOTAL_SIZE = 25 * 1024 * 1024; // 25 MB total per announcement
const MAX_IMAGES_COUNT = 5; // max 5 images per announcement
const MAX_FILES_COUNT = 5; // max 5 files per announcement

// ✅ Human-readable byte formatter
const formatBytes = (bytes) => {
  if (!bytes || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

async function uploadToCloudinary(file, folder) {
  // Final safety net — reject before hitting the network
  const isImage = file.type?.startsWith("image/");
  const limit = isImage ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;
  if (file.size > limit) {
    throw new Error(
      `"${file.name}" (${formatBytes(file.size)}) exceeds the ${formatBytes(
        limit
      )} limit.`
    );
  }

  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  formData.append("folder", `spaces/${folder}`);

  const resourceType = isImage ? "image" : "raw";
  const endpoint = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`;

  const res = await fetch(endpoint, { method: "POST", body: formData });
  if (!res.ok) {
    const errorText = await res.text();
    let errorMessage = `Upload failed: ${res.status}`;
    try {
      const errorJson = JSON.parse(errorText);
      if (errorJson.error?.message) errorMessage = errorJson.error.message;
    } catch (e) {}
    throw new Error(errorMessage);
  }
  const data = await res.json();
  return data.secure_url;
}

// ─── Helpers ──────────────────────────────────────────────────────────
const getInitials = (name = "") => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

const getFileIcon = (fileName = "") => {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  if (["pdf"].includes(ext)) return "fa-solid fa-file-pdf";
  if (["doc", "docx"].includes(ext)) return "fa-solid fa-file-word";
  if (["xls", "xlsx"].includes(ext)) return "fa-solid fa-file-excel";
  if (["ppt", "pptx"].includes(ext)) return "fa-solid fa-file-powerpoint";
  if (["zip", "rar", "7z"].includes(ext)) return "fa-solid fa-file-zipper";
  if (["txt"].includes(ext)) return "fa-solid fa-file-lines";
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "fa-solid fa-file-image";
  return "fa-solid fa-file";
};

const getFileColor = (fileName = "") => {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  if (["pdf"].includes(ext)) return "#dc2626";
  if (["doc", "docx"].includes(ext)) return "#2563eb";
  if (["xls", "xlsx"].includes(ext)) return "#16a34a";
  if (["ppt", "pptx"].includes(ext)) return "#ea580c";
  if (["zip", "rar", "7z"].includes(ext)) return "#8b5cf6";
  if (["txt"].includes(ext)) return "#6b7280";
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "#ec4899";
  return "#64748b";
};

// ─── Link Preview ─────────────────────────────────────────────────────
const extractUrls = (text) => {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const matches = text.match(urlRegex);
  return matches || [];
};

const fetchLinkPreview = async (url) => {
  try {
    const response = await fetch(
      `https://api.microlink.io?url=${encodeURIComponent(url)}`
    );
    if (!response.ok) throw new Error(`Microlink API error: ${response.status}`);
    const data = await response.json();
    if (!data.data) throw new Error("No preview data returned");
    const { title, description, image } = data.data;
    return {
      title: title || url,
      description: description || "",
      image: image?.url || null,
      url: url,
    };
  } catch (err) {
    console.warn("Link preview failed:", err);
    return null;
  }
};

// ─── Search highlight helper ───────────────────────────────────────────
const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function highlightText(text, query) {
  if (!text || !query || !query.trim()) return text;
  const q = query.trim();
  const parts = text.split(new RegExp(`(${escapeRegExp(q)})`, "gi"));
  return parts.map((part, i) =>
    part.toLowerCase() === q.toLowerCase() ? (
      <mark className="bc-highlight" key={i}>{part}</mark>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

// ═════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═════════════════════════════════════════════════════════════════════
export default function BroadcastChannel() {
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState("");
  const [recipient, setRecipient] = useState("All Staffs");
  const [userRole, setUserRole] = useState("");
  const [senderName, setSenderName] = useState("");
  const [selectedImages, setSelectedImages] = useState([]);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [usersMap, setUsersMap] = useState({});
  const [lightboxImage, setLightboxImage] = useState(null);
  const [openMenuId, setOpenMenuId] = useState(null);
  const [confirmingId, setConfirmingId] = useState(null);
  const [linkPreview, setLinkPreview] = useState(null);
  const [fetchingPreview, setFetchingPreview] = useState(false);

  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showPinnedPanel, setShowPinnedPanel] = useState(false);

  const [editingMessage, setEditingMessage] = useState(null);
  const [editContent, setEditContent] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const [activeMessageId, setActiveMessageId] = useState(null);
  const [reactPickerId, setReactPickerId] = useState(null);

  const imageRef = useRef(null);
  const fileRef = useRef(null);
  const bottomRef = useRef(null);
  const menuRefs = useRef(new Map());
  const messageRefs = useRef(new Map());
  const searchInputRef = useRef(null);
  const pinnedPanelRef = useRef(null);

  const longPressTimer = useRef(null);
  const longPressTriggered = useRef(false);

  const [toast, setToast] = useState({
    show: false,
    type: "success",
    title: "",
    message: "",
  });

  const showToast = (type, title, msg) => {
    setToast({ show: true, type, title, message: msg });
    if (type !== "loading") {
      setTimeout(() => setToast((prev) => ({ ...prev, show: false })), 4000);
    }
  };

  // ─── Auth & User Data ─────────────────────────────────────────────
  useEffect(() => {
    const fetchUserData = async () => {
      if (!auth.currentUser) return;
      try {
        const snap = await getDoc(doc(db, "users", auth.currentUser.uid));
        if (snap.exists()) {
          const data = snap.data();
          setUserRole(data.role || "");
          setSenderName(`${data.firstName || ""} ${data.lastName || ""}`.trim());
        }
      } catch (err) {
        console.error(err);
      }
    };
    fetchUserData();
  }, []);

  useEffect(() => {
    const fetchAllUsers = async () => {
      try {
        const snap = await getDocs(collection(db, "users"));
        const map = {};
        snap.docs.forEach((d) => {
          const u = d.data();
          map[d.id] = `${u.firstName || ""} ${u.lastName || ""}`.trim() || "Unknown User";
        });
        setUsersMap(map);
      } catch (err) {
        console.error(err);
      }
    };
    fetchAllUsers();
  }, []);

  // ─── Messages Listener ─────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    if (!userRole) return;

    const q = query(collection(db, "broadcastChannels"), orderBy("createdAt", "asc"));

    const unsub = onSnapshot(q, (snapshot) => {
      const allMessages = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));

      const filteredMessages = allMessages.filter((msg) => {
        if (msg.recipient === "All Staffs") return true;
        if (msg.senderId === auth.currentUser?.uid) return true;
        return msg.recipient === userRole;
      });
      setMessages(filteredMessages);
      setLoading(false);
    });

    return () => unsub();
  }, [userRole]);

  useEffect(() => {
    if (!searchQuery && !showPinnedPanel) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages.length]);

  // ─── Link preview ──────────────────────────────────────────────────
  useEffect(() => {
    const fetchPreview = async () => {
      const urls = extractUrls(message);
      if (urls.length === 0) {
        setLinkPreview(null);
        setFetchingPreview(false);
        return;
      }
      setFetchingPreview(true);
      try {
        const preview = await fetchLinkPreview(urls[0]);
        setLinkPreview(preview);
      } catch (err) {
        console.error("❌ Preview fetch error:", err);
        setLinkPreview(null);
      } finally {
        setFetchingPreview(false);
      }
    };
    const timer = setTimeout(fetchPreview, 700);
    return () => clearTimeout(timer);
  }, [message]);

  // ─── Click outside ───────────────────────────────────────────────
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (openMenuId) {
        const el = menuRefs.current.get(openMenuId);
        if (el && !el.contains(e.target)) {
          setOpenMenuId(null);
          setConfirmingId(null);
        }
      }
      if (showPinnedPanel && pinnedPanelRef.current && !pinnedPanelRef.current.contains(e.target)) {
        if (!e.target.closest(".bc-pin-toggle-btn")) {
          setShowPinnedPanel(false);
        }
      }
      if (
        !e.target.closest(".bc-react-picker") &&
        !e.target.closest(".bc-react-trigger")
      ) {
        setReactPickerId(null);
      }
      if (!e.target.closest(".bc-message-wrapper")) {
        setActiveMessageId(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, [openMenuId, showPinnedPanel]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key !== "Escape") return;
      setLightboxImage(null);
      setOpenMenuId(null);
      setConfirmingId(null);
      setShowPinnedPanel(false);
      setReactPickerId(null);
      setActiveMessageId(null);
      setEditingMessage(null);
      if (showSearch) {
        setShowSearch(false);
        setSearchQuery("");
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showSearch]);

  useEffect(() => {
    if (showSearch) searchInputRef.current?.focus();
  }, [showSearch]);

  // ─── Long-press handlers ─────────────────────────────────────────
  const handleMsgTouchStart = (id) => {
    longPressTriggered.current = false;
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      setActiveMessageId(id);
    }, 500);
  };

  const handleMsgTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handleMsgTouchMove = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handleBubbleClick = (id) => {
    if (longPressTriggered.current) {
      longPressTriggered.current = false;
      return;
    }
    setActiveMessageId((prev) => (prev === id ? null : id));
  };

  // ═════════════════════════════════════════════════════════════════
  // ✅ ATTACHMENT HANDLERS — may size & count validation
  // ═════════════════════════════════════════════════════════════════
  const currentTotalSize = () =>
    selectedImages.reduce((sum, f) => sum + (f.size || 0), 0) +
    selectedFiles.reduce((sum, f) => sum + (f.size || 0), 0);

  const handleImageSelect = (e) => {
    const incoming = Array.from(e.target.files || []);
    e.target.value = ""; // reset input
    if (incoming.length === 0) return;

    // ── Count check ──
    const totalCount = selectedImages.length + incoming.length;
    if (totalCount > MAX_IMAGES_COUNT) {
      showToast(
        "error",
        "Too Many Images",
        `Maximum of ${MAX_IMAGES_COUNT} images per announcement. You already have ${selectedImages.length}.`
      );
      return;
    }

    // ── Per-image size check ──
    const accepted = [];
    const tooLarge = [];
    for (const file of incoming) {
      if (file.size > MAX_IMAGE_SIZE) {
        tooLarge.push(file);
      } else {
        accepted.push(file);
      }
    }

    // ── Total size check ──
    const acceptedTotal = accepted.reduce((sum, f) => sum + (f.size || 0), 0);
    if (currentTotalSize() + acceptedTotal > MAX_TOTAL_SIZE) {
      showToast(
        "error",
        "Total Size Exceeded",
        `Adding these would exceed the total limit of ${formatBytes(MAX_TOTAL_SIZE)} per announcement.`
      );
      return;
    }

    // ── Show errors for rejected files ──
    if (tooLarge.length > 0) {
      const first = tooLarge[0];
      showToast(
        "error",
        "Image Too Large",
        tooLarge.length === 1
          ? `"${first.name}" (${formatBytes(first.size)}) exceeds the ${formatBytes(
              MAX_IMAGE_SIZE
            )} per-image limit.`
          : `${tooLarge.length} images exceed the ${formatBytes(MAX_IMAGE_SIZE)} limit and were skipped.`
      );
    }

    if (accepted.length > 0) {
      setSelectedImages((prev) => [...prev, ...accepted]);
    }
  };

  const handleFileSelect = (e) => {
    const incoming = Array.from(e.target.files || []);
    e.target.value = "";
    if (incoming.length === 0) return;

    // ── Count check ──
    const totalCount = selectedFiles.length + incoming.length;
    if (totalCount > MAX_FILES_COUNT) {
      showToast(
        "error",
        "Too Many Files",
        `Maximum of ${MAX_FILES_COUNT} files per announcement. You already have ${selectedFiles.length}.`
      );
      return;
    }

    // ── Per-file size check ──
    const accepted = [];
    const tooLarge = [];
    for (const file of incoming) {
      if (file.size > MAX_FILE_SIZE) {
        tooLarge.push(file);
      } else {
        accepted.push(file);
      }
    }

    // ── Total size check ──
    const acceptedTotal = accepted.reduce((sum, f) => sum + (f.size || 0), 0);
    if (currentTotalSize() + acceptedTotal > MAX_TOTAL_SIZE) {
      showToast(
        "error",
        "Total Size Exceeded",
        `Adding these would exceed the total limit of ${formatBytes(MAX_TOTAL_SIZE)} per announcement.`
      );
      return;
    }

    // ── Show errors for rejected files ──
    if (tooLarge.length > 0) {
      const first = tooLarge[0];
      showToast(
        "error",
        "File Too Large",
        tooLarge.length === 1
          ? `"${first.name}" (${formatBytes(first.size)}) exceeds the ${formatBytes(
              MAX_FILE_SIZE
            )} per-file limit.`
          : `${tooLarge.length} files exceed the ${formatBytes(MAX_FILE_SIZE)} limit and were skipped.`
      );
    }

    if (accepted.length > 0) {
      setSelectedFiles((prev) => [...prev, ...accepted]);
    }
  };

  const removeImage = (index) => {
    setSelectedImages((prev) => prev.filter((_, i) => i !== index));
  };

  const removeFile = (index) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // ─── Send Message ─────────────────────────────────────────────────────
  const sendMessage = async () => {
    if (userRole !== "Admin") {
      showToast("error", "Not Allowed", "Only Admin can send announcements.");
      return;
    }

    if (!message.trim() && selectedImages.length === 0 && selectedFiles.length === 0) return;

    // ✅ Final safety check on total size
    if (currentTotalSize() > MAX_TOTAL_SIZE) {
      showToast(
        "error",
        "Total Size Exceeded",
        `Total attachments (${formatBytes(currentTotalSize())}) exceed the ${formatBytes(
          MAX_TOTAL_SIZE
        )} limit.`
      );
      return;
    }

    setUploading(true);

    try {
      const imageUrls = [];
      for (const img of selectedImages) {
        try {
          const url = await uploadToCloudinary(img, "broadcast-images");
          imageUrls.push(url);
        } catch (err) {
          showToast("error", "Image Upload Failed", err.message);
          setUploading(false);
          return;
        }
      }

      const filesData = [];
      for (const file of selectedFiles) {
        try {
          const url = await uploadToCloudinary(file, "broadcast-files");
          filesData.push({ url, name: file.name, type: file.type });
        } catch (err) {
          showToast("error", "File Upload Failed", err.message);
          setUploading(false);
          return;
        }
      }

      const previewData = linkPreview;

      const data = {
        content: message,
        senderId: auth.currentUser.uid,
        senderName,
        senderRole: userRole,
        recipient,
        createdAt: serverTimestamp(),
        reactions: { like: [], love: [] },
        linkPreview: previewData || null,
        pinned: false,
        edited: false,
        editedAt: null,
      };

      if (imageUrls.length > 0) {
        data.imageUrl = imageUrls[0];
        data.imageUrls = imageUrls;
      }

      if (filesData.length > 0) {
        data.fileUrl = filesData[0].url;
        data.fileName = filesData[0].name;
        data.fileType = filesData[0].type;
        data.files = filesData;
      }

      const broadcastRef = await addDoc(collection(db, "broadcastChannels"), data);

      const usersSnap = await getDocs(collection(db, "users"));
      const notifications = [];

      usersSnap.forEach((userDoc) => {
        const user = userDoc.data();
        const shouldNotify =
          recipient === "All Staffs"
            ? true
            : user.role?.toLowerCase() === recipient.toLowerCase();

        if (shouldNotify) {
          notifications.push(
            addDoc(collection(db, "notifications"), {
              userId: userDoc.id,
              ownerType: user.role.toLowerCase(),
              broadcastId: broadcastRef.id,
              title: "New Announcement",
              message: `${senderName} posted a new announcement.`,
              imageUrl: imageUrls.length ? imageUrls[0] : null,
              type: "broadcast",
              unread: true,
              archived: false,
              badge: "NEW",
              sender: senderName,
              createdAt: serverTimestamp(),
            })
          );
        }
      });

      await Promise.all(notifications);

      await logActivity({
        userId: auth.currentUser.uid,
        user: senderName,
        role: userRole,
        action: "Sent Broadcast Announcement",
        actionType: "success",
        target: recipient,
        status: "SUCCESS",
        details: {
          message: message.trim() || (imageUrls.length ? "Image Attachments" : filesData.length ? "File Attachments" : "Announcement"),
          imageCount: imageUrls.length,
          fileCount: filesData.length,
          hasLink: !!previewData,
        },
      });

      setMessage("");
      setSelectedImages([]);
      setSelectedFiles([]);
      setLinkPreview(null);
      showToast("success", "Sent", "Announcement published successfully!");
    } catch (err) {
      console.error(err);
      showToast("error", "Send Failed", err.message || "Something went wrong.");
    } finally {
      setUploading(false);
    }
  };

  // ─── Reactions & Unsend ────────────────────────────────────────────
  const toggleReaction = async (id, type) => {
    try {
      const messageRef = doc(db, "broadcastChannels", id);
      const msg = messages.find((m) => m.id === id);
      if (!msg) return;

      const uids = msg.reactions?.[type] || [];
      const hasReacted = uids.includes(auth.currentUser?.uid);

      await updateDoc(messageRef, {
        [`reactions.${type}`]: hasReacted ? arrayRemove(auth.currentUser.uid) : arrayUnion(auth.currentUser.uid),
      });
    } catch (err) {
      console.error(err);
    }
  };

  const unsendMessage = async (id) => {
    try {
      await deleteDoc(doc(db, "broadcastChannels", id));
      showToast("success", "Removed", "Message unsent for everyone.");
    } catch (err) {
      console.error(err);
      showToast("error", "Failed", "Could not unsend the message.");
    } finally {
      setOpenMenuId(null);
      setConfirmingId(null);
    }
  };

  const togglePin = async (id, currentlyPinned) => {
    try {
      await updateDoc(doc(db, "broadcastChannels", id), {
        pinned: !currentlyPinned,
        pinnedAt: !currentlyPinned ? serverTimestamp() : null,
      });
      showToast(
        "success",
        currentlyPinned ? "Unpinned" : "Pinned",
        currentlyPinned
          ? "Removed from pinned announcements."
          : "Added to pinned announcements."
      );
    } catch (err) {
      console.error(err);
      showToast("error", "Failed", "Could not update the pin status.");
    } finally {
      setOpenMenuId(null);
    }
  };

  // ─── Edit handlers ──────────────────────────────────────────────
  const startEdit = (msg) => {
    setEditingMessage(msg);
    setEditContent(msg.content || "");
    setOpenMenuId(null);
    setConfirmingId(null);
    setActiveMessageId(null);
  };

  const cancelEdit = () => {
    if (editSaving) return;
    setEditingMessage(null);
    setEditContent("");
  };

  const saveEdit = async () => {
    if (!editingMessage) return;
    if (!editContent.trim()) {
      showToast("error", "Empty Content", "Announcement cannot be empty.");
      return;
    }

    setEditSaving(true);
    try {
      const msg = editingMessage;

      await updateDoc(doc(db, "broadcastChannels", msg.id), {
        content: editContent.trim(),
        edited: true,
        editedAt: serverTimestamp(),
      });

      const usersSnap = await getDocs(collection(db, "users"));
      const notifications = [];

      usersSnap.forEach((userDoc) => {
        if (userDoc.id === auth.currentUser.uid) return;

        const user = userDoc.data();
        const shouldNotify =
          msg.recipient === "All Staffs"
            ? true
            : user.role?.toLowerCase() === msg.recipient.toLowerCase();

        if (shouldNotify) {
          notifications.push(
            addDoc(collection(db, "notifications"), {
              userId: userDoc.id,
              ownerType: user.role.toLowerCase(),
              broadcastId: msg.id,
              title: "Announcement Edited",
              message: `${senderName} edited an announcement. Tap to view the updated version.`,
              type: "broadcast",
              unread: true,
              archived: false,
              badge: "EDITED",
              sender: senderName,
              createdAt: serverTimestamp(),
            })
          );
        }
      });

      await Promise.all(notifications);

      await logActivity({
        userId: auth.currentUser.uid,
        user: senderName,
        role: userRole,
        action: "Edited Broadcast Announcement",
        actionType: "update",
        target: msg.recipient,
        status: "SUCCESS",
        details: {
          broadcastId: msg.id,
          newContent: editContent.trim().slice(0, 120),
        },
      });

      setEditingMessage(null);
      setEditContent("");
      showToast("success", "Updated", "Announcement edited successfully.");
    } catch (err) {
      console.error(err);
      showToast("error", "Update Failed", err.message || "Could not update the announcement.");
    } finally {
      setEditSaving(false);
    }
  };

  const scrollToMessage = (id) => {
    const el = messageRefs.current.get(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("bc-message-flash");
      setTimeout(() => el.classList.remove("bc-message-flash"), 1400);
    }
    setShowPinnedPanel(false);
  };

  // ─── Helpers ─────────────────────────────────────────────────────────
  const getReactorNames = (uids = []) => {
    if (uids.length === 0) return "";
    return uids
      .map((uid) => (uid === auth.currentUser?.uid ? "You" : usersMap[uid] || "Someone"))
      .join(", ");
  };

  const formatDateDivider = (timestamp) => {
    if (!timestamp) return "";
    const date = timestamp.toDate();
    return date.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  };

  const formatTimestamp = (timestamp) => {
    if (!timestamp) return "";
    const date = timestamp.toDate();
    return date.toLocaleString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const shouldShowDivider = (currentMsg, previousMsg) => {
    if (!currentMsg?.createdAt) return false;
    if (!previousMsg?.createdAt) return true;
    const current = currentMsg.createdAt.toDate();
    const previous = previousMsg.createdAt.toDate();
    const sameDay = current.toDateString() === previous.toDateString();
    const diffMinutes = (current - previous) / 1000 / 60;
    return !sameDay || diffMinutes >= 20;
  };

  const canSend =
    !uploading && (message.trim() || selectedImages.length > 0 || selectedFiles.length > 0);

  const pinnedMessages = messages.filter((m) => m.pinned);

  const visibleMessages = searchQuery.trim()
    ? messages.filter((m) => {
        const q = searchQuery.trim().toLowerCase();
        const matchesContent = (m.content || "").toLowerCase().includes(q);
        const matchesSender = (m.senderName || "").toLowerCase().includes(q);
        const matchesFile =
          (m.fileName || "").toLowerCase().includes(q) ||
          (m.files || []).some((f) => (f.name || "").toLowerCase().includes(q));
        return matchesContent || matchesSender || matchesFile;
      })
    : messages;

  const pinnedPreviewText = (m) => {
    if (m.content) return m.content;
    const imgCount = (m.imageUrls || (m.imageUrl ? [m.imageUrl] : [])).length;
    const fileCount = (m.files || (m.fileUrl ? [1] : [])).length;
    if (imgCount) return `📷 ${imgCount} photo${imgCount > 1 ? "s" : ""}`;
    if (fileCount) return `📎 ${fileCount} file${fileCount > 1 ? "s" : ""}`;
    return "Announcement";
  };

  // ─── File display component ─────────────────────────────────────────
  const FileAttachment = ({ fileUrl, fileName }) => {
    if (!fileUrl) return null;

    const icon = getFileIcon(fileName);
    const color = getFileColor(fileName);
    const viewUrl = fileUrl.includes("?")
      ? `${fileUrl}&fl_attachment=0`
      : `${fileUrl}?fl_attachment=0`;

    return (
      <div className="bc-file-attachment">
        <div className="bc-file-icon-wrapper" style={{ color }}>
          <i className={icon}></i>
        </div>
        <div className="bc-file-info">
          <span className="bc-file-name">{fileName || "File"}</span>
          <div className="bc-file-actions">
            <a
              href={viewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="bc-file-action-btn view"
            >
              <i className="fa-solid fa-eye"></i> View
            </a>
            <a
              href={fileUrl}
              download={fileName || "file"}
              className="bc-file-action-btn download"
            >
              <i className="fa-solid fa-download"></i> Download
            </a>
          </div>
        </div>
      </div>
    );
  };

  // ═════════════════════════════════════════════════════════════════
  // RENDER
  // ═════════════════════════════════════════════════════════════════
  return (
    <div className="bc-container">
      {/* HEADER */}
      <div className="bc-topbar">
        <div className="bc-channel-info">
          <div className="bc-channel-icon">
            <i className="fa-solid fa-bullhorn"></i>
          </div>
          <div>
            <h2>Announcement Channel</h2>
            <span>
              {userRole === "Admin" ? "Send announcements" : "Department announcements"}
            </span>
          </div>
        </div>

        <div className="bc-topbar-actions">
          <button
            className={`bc-icon-btn ${showSearch ? "is-active" : ""}`}
            onClick={() => {
              setShowSearch((s) => {
                if (s) setSearchQuery("");
                return !s;
              });
              setShowPinnedPanel(false);
            }}
            aria-label="Search announcements"
          >
            <i className="fa-solid fa-magnifying-glass"></i>
          </button>

          <button
            className={`bc-icon-btn bc-pin-toggle-btn ${showPinnedPanel ? "is-active" : ""}`}
            onClick={() => {
              setShowPinnedPanel((p) => !p);
              setShowSearch(false);
            }}
            aria-label="Pinned announcements"
            disabled={pinnedMessages.length === 0}
          >
            <i className="fa-solid fa-thumbtack"></i>
            {pinnedMessages.length > 0 && (
              <span className="bc-icon-badge">{pinnedMessages.length}</span>
            )}
          </button>

          <div className="bc-message-counter">
            <i className="fa-regular fa-message"></i>
            <span>{messages.length} announcement{messages.length === 1 ? "" : "s"}</span>
          </div>
        </div>
      </div>

      {/* SEARCH BAR */}
      {showSearch && (
        <div className="bc-search-bar">
          <i className="fa-solid fa-magnifying-glass"></i>
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search announcements, senders, or files…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <span className="bc-search-count">
              {visibleMessages.length} result{visibleMessages.length === 1 ? "" : "s"}
            </span>
          )}
          <button
            className="bc-search-close"
            onClick={() => {
              setShowSearch(false);
              setSearchQuery("");
            }}
            aria-label="Close search"
          >
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>
      )}

      {/* PINNED PANEL */}
      {showPinnedPanel && pinnedMessages.length > 0 && (
        <div className="bc-pinned-panel" ref={pinnedPanelRef}>
          <div className="bc-pinned-panel-header">
            <i className="fa-solid fa-thumbtack"></i>
            <span>Pinned Announcements ({pinnedMessages.length})</span>
          </div>
          <div className="bc-pinned-list">
            {pinnedMessages.map((m) => (
              <button key={m.id} className="bc-pinned-item" onClick={() => scrollToMessage(m.id)}>
                <div className="bc-pinned-item-avatar">{getInitials(m.senderName)}</div>
                <div className="bc-pinned-item-body">
                  <strong>{m.senderName}</strong>
                  <span>{pinnedPreviewText(m)}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* MESSAGES */}
      <div className="bc-messages">
        {loading ? (
          <div className="room-empty">
            <i className="fa-solid fa-spinner fa-spin"></i>
            <h2>Loading</h2>
            <p>Please wait while we retrieve available contents.</p>
          </div>
        ) : visibleMessages.length === 0 ? (
          searchQuery.trim() ? (
            <div className="bc-empty-state">
              <i className="fa-solid fa-magnifying-glass"></i>
              <p>No results for "{searchQuery}"</p>
              <span className="bc-empty-hint">Try a different keyword or sender name.</span>
            </div>
          ) : (
            <div className="bc-empty-state">
              <i className="fa-solid fa-bullhorn"></i>
              <p>No announcements yet.</p>
              {userRole === "Admin" && (
                <span className="bc-empty-hint">Your first announcement will appear here.</span>
              )}
            </div>
          )
        ) : (
          visibleMessages.map((msg, index) => {
            const previousMsg = visibleMessages[index - 1];
            const isMine = auth.currentUser && msg.senderId === auth.currentUser.uid;
            const likeUids = msg.reactions?.like ?? [];
            const loveUids = msg.reactions?.love ?? [];
            const iLiked = likeUids.includes(auth.currentUser?.uid);
            const iLoved = loveUids.includes(auth.currentUser?.uid);
            const canManage = isMine || userRole === "Admin";
            const isActive = activeMessageId === msg.id;
            const hasReactions = likeUids.length > 0 || loveUids.length > 0;

            const imageUrls = msg.imageUrls || (msg.imageUrl ? [msg.imageUrl] : []);
            const files =
              msg.files ||
              (msg.fileUrl
                ? [{ url: msg.fileUrl, name: msg.fileName || "File", type: msg.fileType || "" }]
                : []);

            return (
              <div
                key={msg.id}
                ref={(el) => messageRefs.current.set(msg.id, el)}
                onTouchStart={() => handleMsgTouchStart(msg.id)}
                onTouchEnd={handleMsgTouchEnd}
                onTouchMove={handleMsgTouchMove}
              >
                {!searchQuery.trim() && shouldShowDivider(msg, previousMsg) && (
                  <div className="bc-divider">
                    <span>{formatDateDivider(msg.createdAt)}</span>
                  </div>
                )}

                <div
                  className={`bc-message-wrapper ${
                    isMine ? "bc-message-wrapper-right" : "bc-message-wrapper-left"
                  } ${isActive ? "is-active" : ""}`}
                >
                  {!isMine && (
                    <div className="bc-avatar" aria-hidden="true">
                      {getInitials(msg.senderName)}
                    </div>
                  )}

                  <div className="bc-message-card">
                    <div className="bc-message-meta">
                      <strong>{isMine ? "You" : highlightText(msg.senderName, searchQuery)}</strong>
                      <span className="bc-role-chip">{msg.senderRole}</span>
                      {msg.recipient && msg.recipient !== "All Staffs" && (
                        <span className="bc-to-chip">
                          <i className="fa-solid fa-arrow-right"></i>
                          {msg.recipient}
                        </span>
                      )}
                      {msg.pinned && (
                        <span className="bc-pinned-chip">
                          <i className="fa-solid fa-thumbtack"></i> Pinned
                        </span>
                      )}
                    </div>

                    <div className="bc-bubble-wrap">
                      <div
                        className={`bc-bubble ${
                          isMine ? "bc-bubble-right" : "bc-bubble-left"
                        } ${msg.pinned ? "bc-bubble-pinned" : ""}`}
                        onClick={() => handleBubbleClick(msg.id)}
                        title={formatTimestamp(msg.createdAt)}
                      >
                        {imageUrls.length > 0 && (
                          <div className="bc-images-grid">
                            {imageUrls.map((url, i) => (
                              <img
                                key={i}
                                src={url}
                                alt={`attachment ${i}`}
                                className="bc-image"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setLightboxImage(url);
                                }}
                              />
                            ))}
                          </div>
                        )}

                        {files.length > 0 && (
                          <div className="bc-files-list">
                            {files.map((file, i) => (
                              <FileAttachment
                                key={i}
                                fileUrl={file.url}
                                fileName={file.name}
                              />
                            ))}
                          </div>
                        )}

                        {msg.linkPreview && (
                          <a
                            href={msg.linkPreview.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="bc-link-preview"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {msg.linkPreview.image && (
                              <img
                                src={msg.linkPreview.image}
                                alt=""
                                className="bc-link-image"
                              />
                            )}
                            <div className="bc-link-content">
                              <strong className="bc-link-title">
                                {msg.linkPreview.title}
                              </strong>
                              {msg.linkPreview.description && (
                                <span className="bc-link-description">
                                  {msg.linkPreview.description}
                                </span>
                              )}
                              <span className="bc-link-url">
                                {msg.linkPreview.url}
                              </span>
                            </div>
                          </a>
                        )}

                        {msg.content && (
                          <div className="bc-bubble-text">
                            {highlightText(msg.content, searchQuery)}
                          </div>
                        )}

                        {msg.createdAt && (
                          <div className="bc-message-time">
                            {msg.createdAt.toDate().toLocaleTimeString([], {
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                            {msg.edited && (
                              <span className="bc-edited-tag"> · edited</span>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="bc-message-actions">
                        <div className="bc-react-wrap">
                          <button
                            type="button"
                            className={`bc-react-trigger ${
                              reactPickerId === msg.id ? "is-open" : ""
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setReactPickerId((prev) =>
                                prev === msg.id ? null : msg.id
                              );
                              setOpenMenuId(null);
                            }}
                            aria-label="Add reaction"
                            title="React"
                          >
                            <i className="fa-regular fa-face-smile"></i>
                          </button>

                          {reactPickerId === msg.id && (
                            <div className="bc-react-picker">
                              <button
                                type="button"
                                className={`bc-react-picker-btn ${
                                  iLiked ? "is-active" : ""
                                }`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleReaction(msg.id, "like");
                                  setReactPickerId(null);
                                }}
                              >
                                👍
                              </button>
                              <button
                                type="button"
                                className={`bc-react-picker-btn ${
                                  iLoved ? "is-active" : ""
                                }`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleReaction(msg.id, "love");
                                  setReactPickerId(null);
                                }}
                              >
                                ❤️
                              </button>
                            </div>
                          )}
                        </div>

                        {canManage && (
                          <div
                            className="bc-msg-menu"
                            ref={(el) => menuRefs.current.set(msg.id, el)}
                          >
                            <button
                              className={`bc-msg-menu-trigger ${
                                openMenuId === msg.id ? "is-open" : ""
                              }`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenMenuId((prev) =>
                                  prev === msg.id ? null : msg.id
                                );
                                setConfirmingId(null);
                                setReactPickerId(null);
                              }}
                              aria-label="Message options"
                              title="More"
                            >
                              <i className="fa-solid fa-ellipsis"></i>
                            </button>

                            {openMenuId === msg.id && (
                              <div className="bc-msg-menu-dropdown">
                                {confirmingId === msg.id ? (
                                  <div className="bc-msg-menu-confirm">
                                    <span>Unsend this message?</span>
                                    <div className="bc-msg-menu-confirm-actions">
                                      <button
                                        className="bc-msg-menu-confirm-cancel"
                                        onClick={() => setConfirmingId(null)}
                                      >
                                        Keep
                                      </button>
                                      <button
                                        className="bc-msg-menu-confirm-danger"
                                        onClick={() => unsendMessage(msg.id)}
                                      >
                                        Unsend
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    {(isMine || userRole === "Admin") && msg.content && (
                                      <button
                                        className="bc-msg-menu-item"
                                        onClick={() => startEdit(msg)}
                                      >
                                        <i className="fa-solid fa-pen"></i>
                                        Edit announcement
                                      </button>
                                    )}
                                    {userRole === "Admin" && (
                                      <button
                                        className="bc-msg-menu-item"
                                        onClick={() => togglePin(msg.id, msg.pinned)}
                                      >
                                        <i className="fa-solid fa-thumbtack"></i>
                                        {msg.pinned ? "Unpin message" : "Pin message"}
                                      </button>
                                    )}
                                    {isMine && (
                                      <button
                                        className="bc-msg-menu-item is-danger"
                                        onClick={() => setConfirmingId(msg.id)}
                                      >
                                        <i className="fa-solid fa-trash"></i>
                                        Unsend for everyone
                                      </button>
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {hasReactions && (
                      <div className="bc-reactions">
                        {likeUids.length > 0 && (
                          <div className="bc-reaction-wrap">
                            <button
                              className={`bc-reaction-chip ${iLiked ? "is-active" : ""}`}
                              onClick={() => toggleReaction(msg.id, "like")}
                            >
                              👍 {likeUids.length}
                            </button>
                            <div className="bc-reaction-tooltip">
                              {getReactorNames(likeUids)}
                            </div>
                          </div>
                        )}
                        {loveUids.length > 0 && (
                          <div className="bc-reaction-wrap">
                            <button
                              className={`bc-reaction-chip ${iLoved ? "is-active" : ""}`}
                              onClick={() => toggleReaction(msg.id, "love")}
                            >
                              ❤️ {loveUids.length}
                            </button>
                            <div className="bc-reaction-tooltip">
                              {getReactorNames(loveUids)}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* COMPOSER */}
      {userRole === "Admin" && (
        <div className="bc-composer">
          {(selectedImages.length > 0 || selectedFiles.length > 0) && (
            <div className="bc-attachments-preview">
              {selectedImages.map((img, idx) => (
                <div key={`img-${idx}`} className="bc-attachment-chip">
                  <img
                    src={URL.createObjectURL(img)}
                    alt=""
                    className="bc-attachment-thumb"
                  />
                  <span>
                    {img.name}{" "}
                    <span className="bc-attachment-size">
                      · {formatBytes(img.size)}
                    </span>
                  </span>
                  <button
                    className="bc-remove-attachment"
                    onClick={() => removeImage(idx)}
                  >
                    <i className="fa-solid fa-xmark"></i>
                  </button>
                </div>
              ))}
              {selectedFiles.map((file, idx) => (
                <div key={`file-${idx}`} className="bc-attachment-chip">
                  <i className="fa-solid fa-file"></i>
                  <span>
                    {file.name}{" "}
                    <span className="bc-attachment-size">
                      · {formatBytes(file.size)}
                    </span>
                  </span>
                  <button
                    className="bc-remove-attachment"
                    onClick={() => removeFile(idx)}
                  >
                    <i className="fa-solid fa-xmark"></i>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* ✅ Total size indicator */}
          {(selectedImages.length > 0 || selectedFiles.length > 0) && (
            <div className="bc-total-size-hint">
              <i className="fa-solid fa-database"></i>
              <span>
                Total: <strong>{formatBytes(currentTotalSize())}</strong> /{" "}
                {formatBytes(MAX_TOTAL_SIZE)}
              </span>
              <span className="bc-total-size-breakdown">
                {selectedImages.length > 0 && (
                  <>
                    <i className="fa-regular fa-image"></i> {selectedImages.length}/
                    {MAX_IMAGES_COUNT}
                  </>
                )}
                {selectedFiles.length > 0 && (
                  <>
                    <i className="fa-solid fa-paperclip"></i> {selectedFiles.length}/
                    {MAX_FILES_COUNT}
                  </>
                )}
              </span>
            </div>
          )}

          {fetchingPreview && selectedImages.length === 0 && selectedFiles.length === 0 && (
            <div className="bc-composer-link-preview bc-composer-link-loading">
              <div className="bc-spinner-small" />
              <span>Loading preview…</span>
            </div>
          )}

          {linkPreview && selectedImages.length === 0 && selectedFiles.length === 0 && (
            <div className="bc-composer-link-preview">
              {linkPreview.image && (
                <img
                  src={linkPreview.image}
                  alt=""
                  className="bc-composer-link-image"
                />
              )}
              <div className="bc-composer-link-content">
                <strong>{linkPreview.title}</strong>
                {linkPreview.description && <span>{linkPreview.description}</span>}
                <span className="bc-composer-link-url">{linkPreview.url}</span>
              </div>
              <button
                className="bc-composer-link-remove"
                onClick={() => setLinkPreview(null)}
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>
          )}

          <div className="bc-toolbar">
            <div className="bc-toolbar-left">
              <button
                onClick={() => fileRef.current.click()}
                disabled={uploading || selectedFiles.length >= MAX_FILES_COUNT}
                type="button"
                title={
                  selectedFiles.length >= MAX_FILES_COUNT
                    ? `Maximum ${MAX_FILES_COUNT} files reached`
                    : `Attach files (max ${MAX_FILES_COUNT}, ${formatBytes(
                        MAX_FILE_SIZE
                      )} each)`
                }
              >
                <i className="fa-solid fa-paperclip"></i>{" "}
                <span>
                  Attach{selectedFiles.length > 0 ? ` (${selectedFiles.length}/${MAX_FILES_COUNT})` : ""}
                </span>
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                onChange={handleFileSelect}
              />

              <button
                onClick={() => imageRef.current.click()}
                disabled={uploading || selectedImages.length >= MAX_IMAGES_COUNT}
                type="button"
                title={
                  selectedImages.length >= MAX_IMAGES_COUNT
                    ? `Maximum ${MAX_IMAGES_COUNT} images reached`
                    : `Add images (max ${MAX_IMAGES_COUNT}, ${formatBytes(
                        MAX_IMAGE_SIZE
                      )} each)`
                }
              >
                <i className="fa-regular fa-image"></i>{" "}
                <span>
                  Image{selectedImages.length > 0 ? ` (${selectedImages.length}/${MAX_IMAGES_COUNT})` : ""}
                </span>
              </button>
              <input
                ref={imageRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={handleImageSelect}
              />
            </div>

            <div className="bc-select-wrap">
              <i className="fa-solid fa-users"></i>
              <select
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                disabled={uploading}
              >
                <option>All Staffs</option>
                <option>Faculty</option>
                <option>Admin</option>
                <option>Clerk</option>
                <option>Local Registrar</option>
              </select>
              <i className="fa-solid fa-chevron-down bc-chevron"></i>
            </div>
          </div>

          <div className="bc-send-area">
            <textarea
              rows={1}
              placeholder="Write an announcement…"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={uploading}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (canSend) sendMessage();
                }
              }}
            />

            <button
              className="bc-send-btn"
              onClick={sendMessage}
              disabled={!canSend}
              aria-label="Send announcement"
            >
              {uploading ? (
                <span className="bc-spinner" />
              ) : (
                <i className="fa-solid fa-paper-plane"></i>
              )}
            </button>
          </div>

          <div className="bc-note">
            {uploading
              ? "Uploading…"
              : `Only Admins can publish. Max ${MAX_IMAGES_COUNT} images + ${MAX_FILES_COUNT} files, ${formatBytes(
                  MAX_FILE_SIZE
                )} each, ${formatBytes(MAX_TOTAL_SIZE)} total.`}
          </div>
        </div>
      )}

      {/* IMAGE LIGHTBOX */}
      {lightboxImage && (
        <div
          className="bc-lightbox-overlay"
          onClick={() => setLightboxImage(null)}
        >
          <button
            className="bc-lightbox-close"
            onClick={() => setLightboxImage(null)}
            aria-label="Close image"
          >
            <i className="fa-solid fa-xmark"></i>
          </button>
          <img
            src={lightboxImage}
            alt="Full size attachment"
            className="bc-lightbox-image"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* EDIT MODAL */}
      {editingMessage && (
        <div
          className="bc-edit-modal-overlay"
          onClick={() => !editSaving && cancelEdit()}
        >
          <div className="bc-edit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="bc-edit-modal-header">
              <div className="bc-edit-modal-title">
                <div className="bc-edit-modal-icon">
                  <i className="fa-solid fa-pen"></i>
                </div>
                <div>
                  <h3>Edit Announcement</h3>
                  <p>Receivers will be notified of this edit.</p>
                </div>
              </div>
              <button
                className="bc-edit-modal-close"
                onClick={cancelEdit}
                disabled={editSaving}
                aria-label="Close"
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>

            <div className="bc-edit-modal-body">
              <label className="bc-edit-modal-label">Content</label>
              <textarea
                className="bc-edit-modal-textarea"
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                rows={6}
                disabled={editSaving}
                placeholder="Write your announcement…"
                autoFocus
              />
            </div>

            <div className="bc-edit-modal-footer">
              <button
                className="bc-edit-modal-cancel"
                onClick={cancelEdit}
                disabled={editSaving}
              >
                Cancel
              </button>
              <button
                className="bc-edit-modal-save"
                onClick={saveEdit}
                disabled={editSaving || !editContent.trim()}
              >
                {editSaving ? (
                  <>
                    <i className="fa-solid fa-spinner fa-spin"></i> Saving…
                  </>
                ) : (
                  <>
                    <i className="fa-solid fa-circle-check"></i> Save Changes
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
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