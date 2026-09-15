import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { AppShell, ProtectedRoute } from "./components/layout";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import AdminDashboard from "./pages/admin/AdminDashboard";
import AdminForms from "./pages/admin/AdminForms";
import AdminFormDesigner from "./pages/admin/AdminFormDesigner";
import AdminSettings from "./pages/admin/AdminSettings";
import WebhookLog from "./pages/admin/WebhookLog";
import StaffQueue from "./pages/staff/StaffQueue";
import StaffDocuments from "./pages/staff/StaffDocuments";
import StaffSubmissionDetail from "./pages/staff/StaffSubmissionDetail";
import ReportsPage from "./pages/reports/ReportsPage";
import ChangePasswordPage, { FORCED_PASSWORD_PATH } from "./pages/account/ChangePasswordPage";
import ParentSubmit from "./pages/parent/ParentSubmit";
import ParentConfirmation from "./pages/parent/ParentConfirmation";
import HomeRedirect from "./pages/HomeRedirect";

export default function App() {
  const { user } = useAuth();

  return (
    <Routes>
      {/* Public: anonymous parent submission */}
      <Route path="/submit" element={<ParentSubmit />} />
      <Route path="/submit/:formId" element={<ParentSubmit />} />
      <Route path="/submission/:publicId" element={<ParentConfirmation />} />

      {/* Public: org-scoped parent submission */}
      <Route path="/org/:slug/submit" element={<ParentSubmit />} />
      <Route path="/org/:slug/forms/:formId" element={<ParentSubmit />} />
      <Route path="/org/:slug/submission/:publicId" element={<ParentConfirmation />} />

      {/* Auth */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      {/* Admin */}
      <Route
        path="/admin"
        element={
          <ProtectedRoute roles={["admin"]}>
            <AppShell>
              <AdminDashboard />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/forms"
        element={
          <ProtectedRoute roles={["admin"]}>
            <AppShell>
              <AdminForms />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/forms/:id"
        element={
          <ProtectedRoute roles={["admin"]}>
            <AppShell>
              <AdminFormDesigner />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/documents"
        element={
          <ProtectedRoute roles={["admin"]}>
            <AppShell>
              <StaffDocuments />
            </AppShell>
          </ProtectedRoute>
        }
      />
      {/* Schools moved into Settings — keep the old URL working for bookmarks. */}
      <Route
        path="/admin/schools"
        element={
          <ProtectedRoute roles={["admin"]}>
            <Navigate to="/admin/settings" replace />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/settings"
        element={
          <ProtectedRoute roles={["admin"]}>
            <AppShell>
              <AdminSettings />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/submissions/:publicId"
        element={
          <ProtectedRoute roles={["admin"]}>
            <AppShell>
              <StaffSubmissionDetail />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/reports"
        element={
          <ProtectedRoute roles={["admin"]}>
            <AppShell>
              <ReportsPage />
            </AppShell>
          </ProtectedRoute>
        }
      />
      {/* Admin only, with no separate visibility setting (Q2): every inbound
          webhook attempt is recorded, so an admin must always be able to see
          what arrived and re-send what did not land. */}
      <Route
        path="/admin/webhooks"
        element={
          <ProtectedRoute roles={["admin"]}>
            <AppShell>
              <WebhookLog />
            </AppShell>
          </ProtectedRoute>
        }
      />

      {/* Staff + School Contact */}
      <Route
        path="/staff"
        element={
          <ProtectedRoute roles={["staff", "cdm_contact"]}>
            <AppShell>
              <StaffQueue />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/staff/documents"
        element={
          <ProtectedRoute roles={["staff", "cdm_contact"]}>
            <AppShell>
              <StaffDocuments />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/staff/:publicId"
        element={
          <ProtectedRoute roles={["staff", "cdm_contact"]}>
            <AppShell>
              <StaffSubmissionDetail />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/staff/reports"
        element={
          <ProtectedRoute roles={["staff", "cdm_contact"]}>
            <AppShell>
              <ReportsPage />
            </AppShell>
          </ProtectedRoute>
        }
      />

      {/* Forced password change — an administrator-issued temporary password must
          be replaced before the app is usable. Deliberately OUTSIDE <AppShell>:
          rendering it without the sidebar and account menu means there is nothing
          to navigate away to, and therefore nothing to escape the gate with.
          ProtectedRoute sends every other authenticated path here while
          `user.must_change_password` is true. */}
      <Route
        path={FORCED_PASSWORD_PATH}
        element={
          <ProtectedRoute>
            <ChangePasswordPage forced />
          </ProtectedRoute>
        }
      />

      {/* Account — every authenticated role. No `roles` prop on purpose: an
          admin, staff member and School Contact all change their own password
          on the same page. */}
      <Route
        path="/account/password"
        element={
          <ProtectedRoute>
            <AppShell>
              <ChangePasswordPage />
            </AppShell>
          </ProtectedRoute>
        }
      />

      {/* Home redirect based on role */}
      <Route path="/" element={<HomeRedirect user={user} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
