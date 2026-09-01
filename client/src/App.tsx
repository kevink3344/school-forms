import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { AppShell, ProtectedRoute } from "./components/layout";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import AdminDashboard from "./pages/admin/AdminDashboard";
import AdminForms from "./pages/admin/AdminForms";
import AdminFormDesigner from "./pages/admin/AdminFormDesigner";
import AdminSchools from "./pages/admin/AdminSchools";
import AdminSettings from "./pages/admin/AdminSettings";
import StaffQueue from "./pages/staff/StaffQueue";
import StaffDocuments from "./pages/staff/StaffDocuments";
import StaffSubmissionDetail from "./pages/staff/StaffSubmissionDetail";
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
      <Route
        path="/admin/schools"
        element={
          <ProtectedRoute roles={["admin"]}>
            <AppShell>
              <AdminSchools />
            </AppShell>
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

      {/* Staff + CDM Contact */}
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

      {/* Home redirect based on role */}
      <Route path="/" element={<HomeRedirect user={user} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
