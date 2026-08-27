import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { AppShell, ProtectedRoute } from "./components/layout";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import AdminDashboard from "./pages/admin/AdminDashboard";
import AdminForms from "./pages/admin/AdminForms";
import AdminFormDesigner from "./pages/admin/AdminFormDesigner";
import StaffQueue from "./pages/staff/StaffQueue";
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

      {/* Staff */}
      <Route
        path="/staff"
        element={
          <ProtectedRoute roles={["staff"]}>
            <AppShell>
              <StaffQueue />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/staff/:publicId"
        element={
          <ProtectedRoute roles={["staff"]}>
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
