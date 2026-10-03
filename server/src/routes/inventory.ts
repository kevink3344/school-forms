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
  { method: "post", path: "/api/auth/change-password", auth: "staff", tags: "Auth" },
  { method: "get", path: "/api/auth/schools", auth: "none", tags: "Auth" },
  { method: "post", path: "/api/auth/seed-admin", auth: "none", tags: "Auth" },
  { method: "post", path: "/api/auth/seed-staff", auth: "admin", tags: "Auth" },
  { method: "get", path: "/api/organizations", auth: "admin", tags: "Organizations" },
  { method: "post", path: "/api/organizations", auth: "admin", tags: "Organizations" },
  { method: "put", path: "/api/organizations/{id}", auth: "admin", tags: "Organizations" },
  { method: "get", path: "/api/schools", auth: "staff", tags: "Schools" },
  { method: "get", path: "/api/schools/columns", auth: "admin", tags: "Schools" },
  { method: "get", path: "/api/schools/page", auth: "admin", tags: "Schools" },
  { method: "post", path: "/api/schools", auth: "admin", tags: "Schools" },
  { method: "post", path: "/api/schools/import", auth: "admin", tags: "Schools" },
  { method: "get", path: "/api/forms", auth: "admin", tags: "Forms" },
  { method: "post", path: "/api/forms", auth: "admin", tags: "Forms" },
  // Public/Private forms (docs/plans/public-private-forms.md). `/available` is
  // declared BEFORE `/{id}` so the literal is matched first — Express matches in
  // registration order, and a dynamic route registered earlier would swallow it.
  { method: "get", path: "/api/forms/available", auth: "staff", tags: "Forms" },
  { method: "get", path: "/api/forms/public", auth: "none", tags: "Forms" },
  { method: "get", path: "/api/forms/{id}/public", auth: "none", tags: "Forms" },
  { method: "get", path: "/api/forms/{id}", auth: "admin", tags: "Forms" },
  { method: "put", path: "/api/forms/{id}", auth: "admin", tags: "Forms" },
  { method: "patch", path: "/api/forms/{id}/status", auth: "admin", tags: "Forms" },
  { method: "patch", path: "/api/forms/{id}/visibility", auth: "admin", tags: "Forms" },
  { method: "get", path: "/api/forms/{id}/columns", auth: "staff", tags: "Forms" },
  { method: "put", path: "/api/forms/{id}/columns", auth: "staff", tags: "Forms" },
  // Form access — requests, decisions and grants. `staff` in this vocabulary
  // means "staff, School Contacts and admins"; the admin-only routes are marked
  // `admin` individually (there is no router-level guard, by design).
  { method: "get", path: "/api/form-access/mine", auth: "staff", tags: "Form Access" },
  { method: "post", path: "/api/form-access/requests", auth: "staff", tags: "Form Access" },
  { method: "post", path: "/api/form-access/requests/withdraw", auth: "staff", tags: "Form Access" },
  { method: "get", path: "/api/form-access/requests", auth: "admin", tags: "Form Access" },
  { method: "post", path: "/api/form-access/requests/decide", auth: "admin", tags: "Form Access" },
  { method: "get", path: "/api/form-access/grants", auth: "admin", tags: "Form Access" },
  { method: "get", path: "/api/form-access/summary", auth: "admin", tags: "Form Access" },
  // Per-account access, for the admin's Edit User drawer.
  { method: "get", path: "/api/form-access/user/{userId}", auth: "admin", tags: "Form Access" },
  { method: "post", path: "/api/form-access/user/{userId}/remove", auth: "admin", tags: "Form Access" },
  { method: "post", path: "/api/submissions", auth: "none", tags: "Submissions" },
  { method: "get", path: "/api/submissions", auth: "staff", tags: "Submissions" },
  // Archive line. `counts` is two-segment on purpose so it cannot be captured by
  // the single-segment `{publicId}` route. `archive`/`restore` are staff-scoped
  // like the rest of this router — the row is org- and school-gated at the
  // handler, so "staff" here means "staff or admin".
  { method: "get", path: "/api/submissions/archive/counts", auth: "staff", tags: "Submissions" },
  { method: "post", path: "/api/submissions/{publicId}/archive", auth: "staff", tags: "Submissions" },
  { method: "post", path: "/api/submissions/{publicId}/restore", auth: "staff", tags: "Submissions" },
  // The one admin-only submission action: DELETE destroys the row, and it will
  // only do so once `archive` above has already been applied to it.
  { method: "delete", path: "/api/submissions/{publicId}", auth: "admin", tags: "Submissions" },
  { method: "get", path: "/api/submissions/{publicId}/public", auth: "none", tags: "Submissions" },
  { method: "get", path: "/api/submissions/{publicId}", auth: "staff", tags: "Submissions" },
  { method: "patch", path: "/api/submissions/{publicId}/status", auth: "staff", tags: "Submissions" },
  { method: "put", path: "/api/submissions/{publicId}/values", auth: "staff", tags: "Submissions" },
  { method: "get", path: "/api/submissions/{publicId}/adhoc", auth: "staff", tags: "Submissions" },
  { method: "post", path: "/api/submissions/{publicId}/adhoc", auth: "staff", tags: "Submissions" },
  { method: "put", path: "/api/submissions/{publicId}/adhoc/{fieldId}", auth: "staff", tags: "Submissions" },
  { method: "delete", path: "/api/submissions/{publicId}/adhoc/{fieldId}", auth: "staff", tags: "Submissions" },
  // Admin-only, unlike the ad-hoc CRUD above it: promoting writes the form's
  // DEFINITION (`form_fields`) and rewrites the same question on the form's other
  // submissions, so it is a form-design action rather than a queue action.
  { method: "post", path: "/api/submissions/{publicId}/adhoc/{fieldId}/promote", auth: "admin", tags: "Submissions" },
  { method: "get", path: "/api/users", auth: "admin", tags: "Users" },
  { method: "post", path: "/api/users", auth: "admin", tags: "Users" },
  { method: "put", path: "/api/users/{id}", auth: "admin", tags: "Users" },
  { method: "post", path: "/api/users/{id}/reset-password", auth: "admin", tags: "Users" },
  { method: "get", path: "/api/export/preview", auth: "staff", tags: "Export" },
  { method: "get", path: "/api/export/csv", auth: "staff", tags: "Export" },
  { method: "get", path: "/api/reports/preview", auth: "staff", tags: "Reports" },
  { method: "get", path: "/api/reports/export", auth: "staff", tags: "Reports" },
  { method: "get", path: "/api/reports/views", auth: "staff", tags: "Reports" },
  { method: "post", path: "/api/reports/views", auth: "staff", tags: "Reports" },
  { method: "put", path: "/api/reports/views/{id}", auth: "staff", tags: "Reports" },
  { method: "delete", path: "/api/reports/views/{id}", auth: "staff", tags: "Reports" },
  { method: "post", path: "/api/reports/views/{id}/default", auth: "staff", tags: "Reports" },
  { method: "post", path: "/api/reports/views/{id}/use", auth: "staff", tags: "Reports" },
  { method: "post", path: "/api/webhook/google", auth: "secret", tags: "Submissions" },
  { method: "get", path: "/api/webhook/events", auth: "admin", tags: "Webhooks" },
  { method: "get", path: "/api/webhook/events/summary", auth: "admin", tags: "Webhooks" },
  { method: "get", path: "/api/webhook/events/{id}", auth: "admin", tags: "Webhooks" },
  { method: "post", path: "/api/webhook/events/{id}/replay", auth: "admin", tags: "Webhooks" },
  { method: "post", path: "/api/webhook/events/replay", auth: "admin", tags: "Webhooks" },
  { method: "get", path: "/api/documents", auth: "staff", tags: "Documents" },
  { method: "get", path: "/api/submissions/{publicId}/documents", auth: "staff", tags: "Documents" },
  { method: "post", path: "/api/documents/{id}/retry", auth: "staff", tags: "Documents" },
  { method: "post", path: "/api/documents/{id}/regenerate", auth: "staff", tags: "Documents" },
  // System Messages. The two reader routes are `staff` in this vocabulary's
  // PERMISSIVE sense ("a valid bearer token with any role"), which is the same
  // label the submissions router uses for its staff-or-admin routes — there is no
  // "any signed-in user" value, and `none` would be wrong because a token is
  // required. The other four are admin-only: authoring a notice is an
  // administrative function.
  { method: "get", path: "/api/system-messages/active", auth: "staff", tags: "System Messages" },
  { method: "post", path: "/api/system-messages/{id}/dismiss", auth: "staff", tags: "System Messages" },
  { method: "get", path: "/api/system-messages", auth: "admin", tags: "System Messages" },
  { method: "post", path: "/api/system-messages", auth: "admin", tags: "System Messages" },
  { method: "put", path: "/api/system-messages/{id}", auth: "admin", tags: "System Messages" },
  { method: "delete", path: "/api/system-messages/{id}", auth: "admin", tags: "System Messages" },
];
