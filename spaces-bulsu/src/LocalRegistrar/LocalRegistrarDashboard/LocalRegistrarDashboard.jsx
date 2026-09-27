import "./LocalRegistrarDashboard.css";
import { useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";

import {
  collection,
  getDocs,
  query,
  orderBy,
  limit,
  where,
} from "firebase/firestore";

import { db, auth } from "../../firebase";
import { onAuthStateChanged } from "firebase/auth";

export default function LocalRegistrarDashboard() {
  const navigate = useNavigate();
  const [totalSchedules, setTotalSchedules] = useState(0);
  const [qrGenerated, setQrGenerated] = useState(0);
  const [actionsToday, setActionsToday] = useState(0);
  const [activityLogs, setActivityLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  const [currentUid, setCurrentUid] = useState(null);

  // Kunin muna ang current user bago mag-load ng data
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setCurrentUid(user ? user.uid : null);
    });
    return () => unsub();
  }, []);

  // I-load lang kapag may uid na
  useEffect(() => {
    if (!currentUid) return;
    loadDashboardStats();
    loadActivityLogs();
  }, [currentUid]);

  const loadDashboardStats = async () => {
    try {
      // =========================
      // TOTAL SCHEDULES
      // =========================
      const roomsSnapshot = await getDocs(collection(db, "rooms"));

      let total = 0;

      for (const room of roomsSnapshot.docs) {
        const schedulesSnapshot = await getDocs(
          collection(db, "rooms", room.id, "schedules")
        );

        total += schedulesSnapshot.docs.filter(
          (doc) => !doc.data().initialized
        ).length;
      }

      setTotalSchedules(total);

      // =========================
      // QR GENERATED
      // =========================
      let qrCount = 0;

      roomsSnapshot.forEach((doc) => {
        const room = doc.data();

        // kapag may QR field
        if (room.qrCode || room.qrGenerated || room.qrUrl) {
          qrCount++;
        }
      });

      setQrGenerated(qrCount);

      // =========================
      // ACTIONS TODAY (para sa current user lang)
      // =========================
      const logsSnapshot = await getDocs(collection(db, "activityLogs"));

      const today = new Date();

      let todayCount = 0;

      logsSnapshot.forEach((doc) => {
        const data = doc.data();

        if (!data.timestamp) return;

        // Pareho na ng basis sa activity log page: userId
        if (data.userId !== currentUid) return;

        const date = data.timestamp.toDate();

        const sameDay =
          date.getDate() === today.getDate() &&
          date.getMonth() === today.getMonth() &&
          date.getFullYear() === today.getFullYear();

        if (sameDay) todayCount++;
      });

      setActionsToday(todayCount);
    } catch (error) {
      console.error(error);
    }
  };

  const loadActivityLogs = async () => {
    if (!currentUid) return;
    try {
      setLoading(true);

      // Recent 5 lang, para sa current user lang
      const q = query(
        collection(db, "activityLogs"),
        where("userId", "==", currentUid),
        orderBy("timestamp", "desc"),
        limit(5)
      );

      const snap = await getDocs(q);

      const logs = snap.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));

      setActivityLogs(logs);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="registrar-dashboard">
      <div className="dashboard-hero">
        <div>
          <h1>Local Registrar Dashboard</h1>
          <p>Real-time overview of room schedules and academic allocations.</p>
        </div>

        <button
          className="bulk-upload-btn"
          onClick={() => navigate("/local-registrar/bulk-upload-1")}
        >
          <i className="fa-solid fa-upload"></i>
          Bulk Upload
        </button>
      </div>

      <div className="dashboard-stats-LR">
        <div className="stat-card">
          <h2>{totalSchedules}</h2>
          <p>Total Schedules</p>
        </div>

        <div className="stat-card">
          <h2>{actionsToday}</h2>
          <p>Actions Today</p>
        </div>
      </div>

      <div className="dashboard-table-card">
        <div className="lr-dashboard-table-header">
          <h2>Activity Log</h2>

          <button
            className="lr-dashboard-view-all-btn"
            onClick={() => navigate("/local-registrar/activity-log")}
          >
            View All
          </button>
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Date & Time</th>
                <th>Action</th>
                <th>Performed By</th>
                <th>Status</th>
              </tr>
            </thead>

            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="4">
                    <div className="room-empty">
                      <i className="fa-solid fa-spinner fa-spin"></i>
                      <h2>Loading Activity Logs</h2>
                      <p>Please wait while we retrieve activity logs.</p>
                    </div>
                  </td>
                </tr>
              ) : activityLogs.length === 0 ? (
                <tr>
                  <td colSpan="4" style={{ textAlign: "center" }}>
                    No activity found.
                  </td>
                </tr>
              ) : (
                activityLogs.map((log) => (
                  <tr key={log.id}>
                    <td>{log.timestamp?.toDate().toLocaleString()}</td>
                    <td>{log.action}</td>
                    <td>{log.user}</td>
                    <td>
                      <span
                        className={`status-chip ${
                          log.status === "SUCCESS" ? "success" : "failed"
                        }`}
                      >
                        {log.status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}