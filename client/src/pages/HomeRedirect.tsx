import { Navigate } from "react-router-dom";
import type { User } from "../types";

export default function HomeRedirect({ user }: { user: User | null }) {
  if (!user) return <Navigate to="/login" replace />;
  if (user.role === "admin") return <Navigate to="/admin" replace />;
  if (user.role === "staff" || user.role === "cdm_contact") return <Navigate to="/staff" replace />;
  return <Navigate to="/login" replace />;
}
