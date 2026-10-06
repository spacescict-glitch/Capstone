import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

// Local Registrar
import LocalRegistrarLayout from "./LocalRegistrar/LocalRegistrarLayout/LocalRegistrarLayout";
import LocalRegistrarViewAcademicSchedule from "./LocalRegistrar/LocalRegistrarViewAcademicSchedule/LocalRegistrarViewAcademicSchedule";
import LocalRegistrarViewRoomCard from "./LocalRegistrar/LocalRegistrarViewAcademicSchedule/LocalRegistrarViewRoomCard";
import LocalRegistrarQRCode from "./LocalRegistrar/LocalRegistrarQRCode/LocalRegistrarQRCode";
import LocalRegistrarActivityLog from "./LocalRegistrar/LocalRegistrarActivityLog/LocalRegistrarActivityLog";
import BulkScheduleUpload1 from "./LocalRegistrar/LocalRegistrarBulkUpload/bulkUpload1/BulkScheduleUpload1";
import BulkScheduleUpload2 from "./LocalRegistrar/LocalRegistrarBulkUpload/bulkUpload2/BulkScheduleUpload2";
import BulkScheduleUpload3 from "./LocalRegistrar/LocalRegistrarBulkUpload/bulkUpload3/BulkScheduleUpload3";
import BulkScheduleUpload4 from "./LocalRegistrar/LocalRegistrarBulkUpload/bulkUpload4/BulkScheduleUpload4";
import MySubmittedSchedules from "./LocalRegistrar/LocalRegistrarMySubmittedSchedules/MySubmittedSchedules";
import LocalRegistrarDashboard from "./LocalRegistrar/LocalRegistrarDashboard/LocalRegistrarDashboard";
import LocalRegistrarProfile from "./LocalRegistrar/LocalRegistrarProfile/LocalRegistrarProfile";
import LocalRegistrarSettings from "./LocalRegistrar/LocalRegistrarSettings/LocalRegistrarSettings";

// Admin (formerly Department Head)
import AdminConflicts from "./Admin/AdminConflicts/AdminConflicts";
import AdminLayout from "./Admin/AdminLayout/AdminLayout";
import AdminReservations from "./Admin/AdminReservations/AdminReservations";
import AdminViewReservation from "./Admin/AdminReservations/AdminViewReservation";
import AdminViewReservationApproved from "./Admin/AdminReservations/AdminViewReservationApproved";
import AdminEditApprovedReservation from "./Admin/AdminReservations/AdminEditApprovedReservation";
import AdminViewReservationDenied from "./Admin/AdminReservations/AdminViewReservationDenied";
import RoomActivity from "./Admin/AdminRoomActivity/RoomActivity";
import UserManagement from "./Admin/AdminUserManagement/UserManagement";
import AdminDashboard from "./Admin/AdminDashboard/AdminDashboard";
import AdminActivityLog from "./Admin/AdminActivityLog/AdminActivityLog";
import AdminProfile from "./Admin/AdminProfile/AdminProfile";
import AdminViewAcademicSchedule from "./Admin/AdminSchedule/AdminViewAcademicSchedule";
import AdminViewRoomCard from "./Admin/AdminSchedule/AdminViewRoomCard";
import AdminViewReservationCancelled from "./Admin/AdminReservations/AdminViewReservationCancelled";
import AdminSettings from "./Admin/AdminSettings/AdminSettings";
import AdminRoomIssues from "./Admin/AdminRoomIssues/AdminRoomIssues";
import AdminReassignment from "./Admin/AdminReassignments/AdminReassignments";

// Clerk
import ClerkLayout from "./Clerk/ClerkLayout/ClerkLayout";
import ClerkDashboard from "./Clerk/ClerkDashboard/ClerkDashboard";
import ClerkReservations from "./Clerk/ClerkOnlineReservations/ClerkReservations";
import ClerkViewReservation from "./Clerk/ClerkOnlineReservations/ClerkViewReservation";
import ClerkViewReservationApproved from "./Clerk/ClerkOnlineReservations/ClerkViewReservationApproved";
import ClerkEditApprovedReservation from "./Clerk/ClerkOnlineReservations/ClerkEditApprovedReservation";
import ClerkViewReservationDenied from "./Clerk/ClerkOnlineReservations/ClerkViewReservationDenied";
import WalkInReservation from "./Clerk/ClerkWalkInReservation/WalkInReservation";
import ReleasedRooms from "./Clerk/ClerkReleasedRooms/ReleasedRooms";
import RoomDetails from "./Clerk/ClerkRoomDetails/RoomDetails";
import ClerkProfile from "./Clerk/ClerkProfile/ClerkProfile";
import ClerkViewAcademicSchedule from "./Clerk/ClerkSchedule/ClerkViewAcademicSchedule";
import ClerkViewRoomCard from "./Clerk/ClerkSchedule/ClerkViewRoomCard";
import ClerkViewReservationCancelled from "./Clerk/ClerkOnlineReservations/ClerkViewReservationCancelled";
import ClerkRoomUsage from "./Clerk/ClerkRoomUsageTracking/RoomUsageTracking";
import ClerkRoomManagement from "./Clerk/ClerkRoomManagement/RoomManagementView";
import ClerkAddRoom from "./Clerk/ClerkRoomManagement/AddRoom/RoomManagementAddRoom";
import ClerkEditRoom from "./Clerk/ClerkRoomManagement/EditDetails/RoomManagementEditDetails";
import ClerkRoomActivity from "./Clerk/ClerkRoomActivity/RoomActivity";
import ClerkConflicts from "./Clerk/ClerkConflicts/ClerkConflicts";
import ClerkReassignRoom from "./Clerk/ClerkConflicts/ClerkReassignRoom";
import ClerkSettings from "./Clerk/ClerkSettings/ClerkSettings";
import ClerkRoomIssues from "./Clerk/ClerkRoomIssues/ClerkRoomIssues";

// Faculty
import FacultyLayout from "./Faculty/FacultyLayout/FacultyLayout";
import FacultyDashboard from "./Faculty/FacultyDashboard/FacultyDashboard";
import FacultyProfile from "./Faculty/FacultyProfile/FacultyProfile";
import FacultyReservations from "./Faculty/FacultyReservations/FacultyReservations";
import FacultyEditPendingReservations from "./Faculty/FacultyReservations/FacultyEditPendingReservation";
import FacultySubmitReservation from "./Faculty/FacultyReservations/FacultySubmitReservation";
import FacultyViewApprovedReservation from "./Faculty/FacultyReservations/FacultyViewApprovedReservation";
import FacultyViewCancelledReservation from "./Faculty/FacultyReservations/FacultyViewCancelledReservation";
import FacultyViewPendingReservation from "./Faculty/FacultyReservations/FacultyViewPendingReservation";
import FacultyRoom from "./Faculty/FacultyRoom/FacultyRoom";
import FacultySchedule from "./Faculty/FacultySchedule/FacultySchedule";
import FacultyViewRoom from "./Faculty/FacultyRoom/FacultyViewRoom";
import FacultyRoomReassignment from "./Faculty/FacultyLayout/FacultyRoomReassignment";
import FacultyViewDenied from "./Faculty/FacultyReservations/FacultyViewDeniedReservation";
import FacultySettings from "./Faculty/FacultySettings/FacultySettings";
import FacultyRoomIssues from "./Faculty/FacultyRoomIssues/FacultyRoomIssues";

// Login
import Home from "./Home/Home";
import Login from "./Login/Login";
import BroadcastChannel from "./Components/BroadcastChannel/BroadcastChannel";
import ResetPassword from "./ResetPassword/ResetPassword";
import PublicRoomSchedule from "./Pages/PublicRoomSchedule/PublicRoomSchedule";

// ✅ NEW — route guard
import ProtectedRoute from "./Components/ProtectedRoute/ProtectedRoute";
import { LogInIcon } from "lucide-react";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* ═══════════════════════════════════════════════════════
            PUBLIC ROUTES — walang login required
            ═══════════════════════════════════════════════════════ */}
        <Route path="/" element={<Login />} />
        <Route path="/login" element={<Login />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/room/:roomId" element={<PublicRoomSchedule />} />

        {/* ═══════════════════════════════════════════════════════
            ADMIN — only role "admin" / "department-head"
            ═══════════════════════════════════════════════════════ */}
        <Route
          element={
            <ProtectedRoute
              allowedRoles={["admin","Admin","department-head", "department head"]}
            />
          }
        >
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<AdminDashboard />} />
            <Route path="profile" element={<AdminProfile />} />
            <Route path="activity-log" element={<AdminActivityLog />} />
            <Route path="conflicts" element={<AdminConflicts />} />
            <Route path="reservations" element={<AdminReservations />} />
            <Route path="view-reservation" element={<AdminViewReservation />} />
            <Route
              path="view-reservation-approved"
              element={<AdminViewReservationApproved />}
            />
            <Route
              path="edit-approved-reservation"
              element={<AdminEditApprovedReservation />}
            />
            <Route
              path="view-reservation-denied"
              element={<AdminViewReservationDenied />}
            />
            <Route
              path="view-reservation-cancelled"
              element={<AdminViewReservationCancelled />}
            />
            <Route
              path="schedule-view-academic-schedule"
              element={<AdminViewAcademicSchedule />}
            />
            <Route path="schedule-room-card" element={<AdminViewRoomCard />} />
            <Route path="room-activity" element={<RoomActivity />} />
            <Route path="user-management" element={<UserManagement />} />
            <Route path="broadcast-channel" element={<BroadcastChannel />} />
            <Route path="settings" element={<AdminSettings />} />
            <Route path="room-issues" element={<AdminRoomIssues />} />
            <Route path="reassign-room" element={<AdminReassignment />} />
          </Route>
        </Route>

        {/* ═══════════════════════════════════════════════════════
            LOCAL REGISTRAR
            ═══════════════════════════════════════════════════════ */}
        <Route
          element={
            <ProtectedRoute
              allowedRoles={[
                "local-registrar",
                "local registrar",
                "localregistrar",
                "registrar",
              ]}
            />
          }
        >
          <Route path="/local-registrar" element={<LocalRegistrarLayout />}>
            <Route path="profile" element={<LocalRegistrarProfile />} />
            <Route index element={<LocalRegistrarDashboard />} />
            <Route
              path="academic-schedule"
              element={<LocalRegistrarViewAcademicSchedule />}
            />
            <Route path="room-card" element={<LocalRegistrarViewRoomCard />} />
            <Route path="qr-code" element={<LocalRegistrarQRCode />} />
            <Route path="activity-log" element={<LocalRegistrarActivityLog />} />
            <Route
              path="my-submitted-schedules"
              element={<MySubmittedSchedules />}
            />
            <Route path="bulk-upload-1" element={<BulkScheduleUpload1 />} />
            <Route path="bulk-upload-2" element={<BulkScheduleUpload2 />} />
            <Route path="bulk-upload-3" element={<BulkScheduleUpload3 />} />
            <Route path="bulk-upload-4" element={<BulkScheduleUpload4 />} />
            <Route path="broadcast-channel" element={<BroadcastChannel />} />
            <Route path="settings" element={<LocalRegistrarSettings />} />
          </Route>
        </Route>

        {/* ═══════════════════════════════════════════════════════
            CLERK
            ═══════════════════════════════════════════════════════ */}
        <Route element={<ProtectedRoute allowedRoles={["clerk"]} />}>
          <Route path="/clerk" element={<ClerkLayout />}>
            <Route path="profile" element={<ClerkProfile />} />
            <Route index element={<ClerkDashboard />} />
            <Route
              path="schedule-view-academic-schedule"
              element={<ClerkViewAcademicSchedule />}
            />
            <Route path="schedule-room-card" element={<ClerkViewRoomCard />} />
            <Route path="online-reservations" element={<ClerkReservations />} />
            <Route
              path="view-online-reservation"
              element={<ClerkViewReservation />}
            />
            <Route
              path="view-reservation-approved"
              element={<ClerkViewReservationApproved />}
            />
            <Route
              path="view-reservation-denied"
              element={<ClerkViewReservationDenied />}
            />
            <Route
              path="view-reservation-cancelled"
              element={<ClerkViewReservationCancelled />}
            />
            <Route
              path="edit-approved-reservation"
              element={<ClerkEditApprovedReservation />}
            />
            <Route path="walk-in-reservation" element={<WalkInReservation />} />
            <Route path="released-rooms" element={<ReleasedRooms />} />
            <Route path="room-details" element={<RoomDetails />} />
            <Route path="broadcast-channel" element={<BroadcastChannel />} />
            <Route path="room-usage" element={<ClerkRoomUsage />} />
            <Route path="room-management" element={<ClerkRoomManagement />} />
            <Route path="add-room" element={<ClerkAddRoom />} />
            <Route path="edit-room/:id" element={<ClerkEditRoom />} />
            <Route path="room-activity" element={<ClerkRoomActivity />} />
            <Route path="conflicts" element={<ClerkConflicts />} />
            <Route path="reassign-room" element={<ClerkReassignRoom />} />
            <Route path="settings" element={<ClerkSettings />} />
            <Route path="room-issues" element={<ClerkRoomIssues />} />
          </Route>
        </Route>

        {/* ═══════════════════════════════════════════════════════
            FACULTY
            ═══════════════════════════════════════════════════════ */}
        <Route element={<ProtectedRoute allowedRoles={["faculty"]} />}>
          <Route path="/faculty" element={<FacultyLayout />}>
            <Route index element={<FacultyDashboard />} />
            <Route path="schedule" element={<FacultySchedule />} />
            <Route path="rooms" element={<FacultyRoom />} />
            <Route path="view-room" element={<FacultyViewRoom />} />
            <Route path="reservations" element={<FacultyReservations />} />
            <Route
              path="room-reassignment/:assignmentId"
              element={<FacultyRoomReassignment />}
            />
            <Route path="profile" element={<FacultyProfile />} />
            <Route
              path="submit-reservation"
              element={<FacultySubmitReservation />}
            />
            <Route
              path="view-approved-reservation"
              element={<FacultyViewApprovedReservation />}
            />
            <Route
              path="view-pending-reservation"
              element={<FacultyViewPendingReservation />}
            />
            <Route
              path="edit-pending-reservation"
              element={<FacultyEditPendingReservations />}
            />
            <Route
              path="view-denied-reservation"
              element={<FacultyViewDenied />}
            />
            <Route
              path="view-cancelled-reservation"
              element={<FacultyViewCancelledReservation />}
            />
            <Route path="settings" element={<FacultySettings />} />
            <Route path="broadcast-channel" element={<BroadcastChannel />} />
            <Route path="room-issues" element={<FacultyRoomIssues />} />
          </Route>
        </Route>

        {/* ═══════════════════════════════════════════════════════
            CATCH-ALL — redirect sa login kung walang match
            ═══════════════════════════════════════════════════════ */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;