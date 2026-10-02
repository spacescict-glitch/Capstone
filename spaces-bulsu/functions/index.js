const { onDocumentWritten, onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// ════════════════════════════════════════════════════════════════
// ROOM AVAILABILITY WATCHERS
// ════════════════════════════════════════════════════════════════
async function isRoomAvailableAt(roomId, date, startTime, endTime) {
  const roomSnap = await db.collection("rooms").doc(roomId).get();
  if (!roomSnap.exists) return false;
  const room = roomSnap.data();

  if (String(room.roomStatus || "").toLowerCase() === "maintenance") return false;
  if (room.maintenance === true) return false;

  const toMin = (t) => {
    if (!t) return 0;
    if (t.includes(" ")) {
      const [clock, period] = t.trim().split(" ");
      let [h, m] = clock.split(":").map(Number);
      if (period === "PM" && h !== 12) h += 12;
      if (period === "AM" && h === 12) h = 0;
      return h * 60 + m;
    }
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };

  let wStart = toMin(startTime);
  let wEnd = toMin(endTime);
  if (wStart > wEnd) [wStart, wEnd] = [wEnd, wStart];
  const overlaps = (s, e) => s <= wEnd && e >= wStart;

  const d = new Date(date + "T00:00:00");
  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const dayName = days[d.getDay()];

  const releaseSnap = await db
    .collection("roomReleases")
    .where("date", "==", date)
    .get();

  const releaseSet = new Set(
    releaseSnap.docs
      .map((d) => d.data())
      .filter((r) => r.roomId === roomId || r.oldRoomId === roomId)
      .map((r) => `${r.scheduleId}_${r.date}`)
  );

  const reassignSnap = await db
    .collection("roomReassignments")
    .where("date", "==", date)
    .get();

  const awaySet = new Set(
    reassignSnap.docs
      .map((d) => d.data())
      .filter(
        (r) =>
          String(r.status || "").toLowerCase() === "approved" &&
          r.oldRoomId === roomId
      )
      .map((r) => `${r.scheduleId}_${r.date}`)
  );

  const schedSnap = await db
    .collection("rooms")
    .doc(roomId)
    .collection("schedules")
    .get();

  for (const doc of schedSnap.docs) {
    const s = doc.data();
    if (s.initialized) continue;
    if (s.day?.toUpperCase() !== dayName) continue;
    const key = `${doc.id}_${date}`;
    if (releaseSet.has(key)) continue;
    if (awaySet.has(key)) continue;
    if (overlaps(toMin(s.startTime), toMin(s.endTime))) return false;
  }

  const eventSnap = await db
    .collection("events")
    .where("roomId", "==", roomId)
    .where("date", "==", date)
    .get();

  for (const doc of eventSnap.docs) {
    const e = doc.data();
    if (e.status === "Cancelled") continue;
    if (overlaps(toMin(e.startTime), toMin(e.endTime))) return false;
  }

  const resSnap = await db
    .collection("reservationRequests")
    .where("roomId", "==", roomId)
    .where("date", "==", date)
    .get();

  for (const doc of resSnap.docs) {
    const r = doc.data();
    if (String(r.status || "").toLowerCase() !== "approved") continue;
    if (overlaps(toMin(r.startTime), toMin(r.endTime))) return false;
  }

  for (const doc of reassignSnap.docs) {
    const r = doc.data();
    if (String(r.status || "").toLowerCase() !== "approved") continue;
    if (r.newRoomId !== roomId) continue;
    if (overlaps(toMin(r.startTime), toMin(r.endTime))) return false;
  }

  return true;
}

async function notifyWatchers(roomId, date) {
  const watchSnap = await db
    .collection("roomAvailabilityWatches")
    .where("roomId", "==", roomId)
    .where("date", "==", date)
    .where("notified", "==", false)
    .get();

  if (watchSnap.empty) return;

  const promises = [];

  for (const watchDoc of watchSnap.docs) {
    const watch = watchDoc.data();

    const available = await isRoomAvailableAt(
      roomId,
      watch.date,
      watch.startTime,
      watch.endTime
    );

    if (!available) continue;

    promises.push(
      db.collection("notifications").add({
        userId: watch.userId,
        ownerType: "faculty",
        title: "Room Now Available",
        message: `${watch.roomName} is now available on ${watch.date} (${watch.startTime} – ${watch.endTime}). Book it now before someone else does!`,
        type: "room-available",
        roomId: watch.roomId,
        roomName: watch.roomName,
        date: watch.date,
        startTime: watch.startTime,
        endTime: watch.endTime,
        unread: true,
        archived: false,
        badge: "NEW",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      })
    );

    promises.push(watchDoc.ref.delete());
  }

  await Promise.all(promises);
  console.log(`Notified watchers for ${roomId} on ${date}`);
}

exports.onScheduleChange = onDocumentWritten(
  "rooms/{roomId}/schedules/{scheduleId}",
  async (event) => {
    const roomId = event.params.roomId;
    const data = event.data?.after?.data();
    if (!data) return;
    const today = new Date();
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      dates.push(d.toISOString().slice(0, 10));
    }
    for (const date of dates) {
      await notifyWatchers(roomId, date);
    }
  }
);

exports.onEventChange = onDocumentWritten(
  "events/{eventId}",
  async (event) => {
    const data = event.data?.after?.data() || event.data?.before?.data();
    if (!data || !data.roomId || !data.date) return;
    await notifyWatchers(data.roomId, data.date);
  }
);

exports.onReservationChange = onDocumentWritten(
  "reservationRequests/{reservationId}",
  async (event) => {
    const data = event.data?.after?.data() || event.data?.before?.data();
    if (!data || !data.roomId || !data.date) return;
    await notifyWatchers(data.roomId, data.date);
  }
);

exports.onRoomRelease = onDocumentCreated(
  "roomReleases/{releaseId}",
  async (event) => {
    const data = event.data?.data();
    if (!data || !data.roomId || !data.date) return;
    await notifyWatchers(data.roomId, data.date);
    if (data.oldRoomId && data.oldRoomId !== data.roomId) {
      await notifyWatchers(data.oldRoomId, data.date);
    }
  }
);

exports.onReassignmentChange = onDocumentWritten(
  "roomReassignments/{reassignId}",
  async (event) => {
    const data = event.data?.after?.data() || event.data?.before?.data();
    if (!data || !data.date) return;
    if (data.oldRoomId) await notifyWatchers(data.oldRoomId, data.date);
    if (data.newRoomId) await notifyWatchers(data.newRoomId, data.date);
  }
);

exports.scheduledWatcherCheck = onSchedule(
  "every 5 minutes",
  async () => {
    const watchSnap = await db
      .collection("roomAvailabilityWatches")
      .where("notified", "==", false)
      .get();

    if (watchSnap.empty) return;

    const today = new Date().toISOString().slice(0, 10);

    for (const watchDoc of watchSnap.docs) {
      const watch = watchDoc.data();
      if (watch.date < today) {
        await watchDoc.ref.delete();
        continue;
      }

      const available = await isRoomAvailableAt(
        watch.roomId,
        watch.date,
        watch.startTime,
        watch.endTime
      );

      if (!available) continue;

      await db.collection("notifications").add({
        userId: watch.userId,
        ownerType: "faculty",
        title: "Room Now Available",
        message: `${watch.roomName} is now available on ${watch.date} (${watch.startTime} – ${watch.endTime}). Book it now!`,
        type: "room-available",
        roomId: watch.roomId,
        roomName: watch.roomName,
        date: watch.date,
        startTime: watch.startTime,
        endTime: watch.endTime,
        unread: true,
        archived: false,
        badge: "NEW",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await watchDoc.ref.delete();
    }
  }
);

// ════════════════════════════════════════════════════════════════
// DELETE USER — Auth + Firestore + related cleanup
// Callable from:
//   • Admin UserManagement (delete OTHER users)
//   • FacultySettings (delete OWN account)
// ════════════════════════════════════════════════════════════════
exports.deleteUser = onCall(
  {
    cors: true,
    invoker: "public",
  },
  async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in.");
  }

  const { userId } = request.data || {};
  if (!userId || typeof userId !== "string") {
    throw new HttpsError("invalid-argument", "userId is required.");
  }

  const callerUid = request.auth.uid;
  const isSelfDelete = userId === callerUid;

  // ── Permission check ────────────────────────────────────────
  if (!isSelfDelete) {
    const callerDoc = await db.collection("users").doc(callerUid).get();
    const callerRole = callerDoc.data()?.role;
    const allowed = ["Clerk", "Admin"];
    if (!allowed.includes(callerRole)) {
      throw new HttpsError(
        "permission-denied",
        "You don't have permission to delete other users."
      );
    }
  }

  // ── Prevent self-deletion by Admin/Clerk of their own admin account ──
  if (isSelfDelete) {
    const selfDoc = await db.collection("users").doc(userId).get();
    const selfRole = selfDoc.data()?.role;
    if (selfRole === "Admin") {
      throw new HttpsError(
        "failed-precondition",
        "Admin accounts cannot be self-deleted. Contact system administrator."
      );
    }
  }

  // ── 1. Delete from Firebase Auth ────────────────────────────
  try {
    await admin.auth().deleteUser(userId);
    console.log(`Auth user deleted: ${userId}`);
  } catch (err) {
    if (err.code !== "auth/user-not-found") {
      console.error("Auth delete failed:", err);
      throw new HttpsError("internal", `Failed to delete auth user: ${err.message}`);
    }
  }

  // ── 2. Delete from Firestore (users collection) ─────────────
  try {
    await db.collection("users").doc(userId).delete();
  } catch (err) {
    console.error("Firestore user delete failed:", err);
    throw new HttpsError("internal", `Firestore cleanup failed: ${err.message}`);
  }

  // ── 3. Clean up related data ────────────────────────────────
  try {
    // Room availability watches
    const watchesSnap = await db
      .collection("roomAvailabilityWatches")
      .where("userId", "==", userId)
      .get();
    const watchDeletes = watchesSnap.docs.map((d) => d.ref.delete());

    // Notifications
    const notifSnap = await db
      .collection("notifications")
      .where("userId", "==", userId)
      .get();
    const notifDeletes = notifSnap.docs.map((d) => d.ref.delete());

    await Promise.all([...watchDeletes, ...notifDeletes]);
    console.log(
      `Cleanup: ${watchDeletes.length} watches, ${notifDeletes.length} notifications`
    );
  } catch (err) {
    // Non-fatal — log and continue
    console.error("Cleanup warning:", err);
  }

  return { success: true, userId, selfDelete: isSelfDelete };
});