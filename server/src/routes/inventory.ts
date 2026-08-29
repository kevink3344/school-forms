// Static, human-auditable inventory of every mounted API route.
//
// This is the single source of truth the Swagger coverage test compares against.
// Keep it in sync with routes/*.ts AND server/src/swagger.ts — the test fails if
// you add a route in one place without updating the others.
//
// `auth` meanings:
//   - "none"    — no auth at all (public/anonymous)
//   - "cookie"  — protected but uses the httpOnly refresh cookie, not a bearer
//                 token (so Swagger's Authorize button cannot send it)
//   - "secret"  — protected by a shared secret header (X-Webhook-Secret)
//   - "staff"   — requires a valid bearer token; staff or admin
//   - "admin"   — requires a valid bearer token with the admin role

export interface RouteEntry {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string; // full, e.g. "/api/submissions/{publicId}/values"
  auth: "none" | "cookie" | "secret" | "staff" | "admin";
  tags?: string; // entity grouping
}

export const ROUTES: RouteEntry[] = [
  { method: "get", path: "/api/health", auth: "none", tags: "System" },
  { method: "get", path: "/api/info", auth: "none", tags: "System" },
  { method: "get", path: "/api/settings/{key}", auth: "none", tags: "Settings" },
  { method: "put", path: "/api/settings/{key}", auth: "admin", tags: "Settings" },
  { method: "get", path: "/api/auth/users", auth: "none", tags: "Auth" },
  { method: "post", path: "/api/auth/select", auth: "none", tags: "Auth" },
  { method: "post", path: "/api/auth/register", auth: "none", tags: "Auth" },
  { method: "post", path: "/api/auth/login", auth: "none", tags: "Auth" },
  { method: "post", path: "/api/auth/refresh", auth: "cookie", tags: "Auth" },
  { method: "post", path: "/api/auth/logout", auth: "cookie", tags: "Auth" },
  { method: "get", path: "/api/auth/me", auth: "staff", tags: "Auth" },
  { method: "get", path: "/api/auth/schools", auth: "none", tags: "Auth" },
  { method: "post", path: "/api/auth/seed-admin", auth: "none", tags: "Auth" },
  { method: "post", path: "/api/auth/seed-staff", auth: "admin", tags: "Auth" },
  { method: "get", path: "/api/organizations", auth: "admin", tags: "Organizations" },
  { method: "get", path: "/api/schools", auth: "staff", tags: "Schools" },
  { method: "get", path: "/api/schools/columns", auth: "admin", tags: "Schools" },
  { method: "get", path: "/api/schools/page", auth: "admin", tags: "Schools" },
  { method: "post", path: "/api/schools", auth: "admin", tags: "Schools" },
  { method: "post", path: "/api/schools/import", auth: "admin", tags: "Schools" },
  { method: "get", path: "/api/forms", auth: "admin", tags: "Forms" },
  { method: "post", path: "/api/forms", auth: "admin", tags: "Forms" },
  { method: "get", path: "/api/forms/public", auth: "none", tags: "Forms" },
  { method: "get", path: "/api/forms/{id}/public", auth: "none", tags: "Forms" },
  { method: "get", path: "/api/forms/{id}", auth: "admin", tags: "Forms" },
  { method: "put", path: "/api/forms/{id}", auth: "admin", tags: "Forms" },
  { method: "patch", path: "/api/forms/{id}/status", auth: "admin", tags: "Forms" },
  { method: "get", path: "/api/forms/{id}/columns", auth: "admin", tags: "Forms" },
  { method: "put", path: "/api/forms/{id}/columns", auth: "admin", tags: "Forms" },
  { method: "post", path: "/api/submissions", auth: "none", tags: "Submissions" },
  { method: "get", path: "/api/submissions", auth: "staff", tags: "Submissions" },
  { method: "get", path: "/api/submissions/{publicId}/public", auth: "none", tags: "Submissions" },
  { method: "get", path: "/api/submissions/{publicId}", auth: "staff", tags: "Submissions" },
  { method: "patch", path: "/api/submissions/{publicId}/status", auth: "staff", tags: "Submissions" },
  { method: "put", path: "/api/submissions/{publicId}/values", auth: "staff", tags: "Submissions" },
  { method: "post", path: "/api/submissions/{publicId}/comments", auth: "staff", tags: "Submissions" },
  { method: "get", path: "/api/submissions/{publicId}/adhoc", auth: "staff", tags: "Submissions" },
  { method: "post", path: "/api/submissions/{publicId}/adhoc", auth: "staff", tags: "Submissions" },
  { method: "put", path: "/api/submissions/{publicId}/adhoc/{fieldId}", auth: "staff", tags: "Submissions" },
  { method: "delete", path: "/api/submissions/{publicId}/adhoc/{fieldId}", auth: "staff", tags: "Submissions" },
  { method: "get", path: "/api/users", auth: "admin", tags: "Users" },
  { method: "post", path: "/api/users", auth: "admin", tags: "Users" },
  { method: "put", path: "/api/users/{id}", auth: "admin", tags: "Users" },
  { method: "get", path: "/api/export/preview", auth: "staff", tags: "Export" },
  { method: "get", path: "/api/export/csv", auth: "staff", tags: "Export" },
  { method: "post", path: "/api/webhook/google", auth: "secret", tags: "Submissions" },
  // Forward-declared (Generate Document feature is planned, not yet mounted).
  { method: "post", path: "/api/submissions/{publicId}/documents", auth: "staff", tags: "Documents" },
  { method: "get", path: "/api/submissions/{publicId}/documents", auth: "staff", tags: "Documents" },
  { method: "post", path: "/api/documents/{id}/retry", auth: "staff", tags: "Documents" },
];
