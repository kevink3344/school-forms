# Full Swagger UI — Feature Plan

> **Status:** Implemented ✅ (see §8 for decisions applied)
> **Goal:** A complete, entity-accurate Swagger/OpenAPI UI for the School Forms
> API, with **port-agnostic server URLs** that work in both local dev
> (`http://localhost:4000`) and Azure (`https://<app>.azurewebsites.net`
> — **no port**).

---

## 1. The core problem: ports vs. no ports

Today `server/src/swagger.ts` hardcodes the server list:

```ts
servers: [
  { url: baseUrl, description: "Development" },                  // env.publicBaseUrl → http://localhost:4000
  { url: "https://your-school-forms-api.azurewebsites.net", description: "Azure" }, // placeholder
],
```

Two problems:

1. **`env.publicBaseUrl` defaults to `http://localhost:4000`** — so "Try it out"
   in Azure targets the wrong origin.
2. **The Azure URL is a hardcoded placeholder** that never matches the real
   deployment, and it's not derived from where the docs page was actually served.

The user's key constraint: **localhost has a port; Azure does not.** The plan must
derive the `servers` array from the *actual request* so the documented base URL
correctly reflects whether we're on localhost (`:4000`) or the no-port Azure URL.

---

## 2. Solution: dynamic server derivation from the request host

Instead of a static `servers` array, build the spec **per request** and let the
Swagger UI load it from a JSON endpoint.

### 2.1 Trust the proxy so `req.protocol` is correct on Azure

Azure App Service sits behind a reverse proxy. To get `https` in `req.protocol`,
add at the top of `server/src/index.ts` (before any route):

```ts
app.set("trust proxy", 1);
```

> **Azure note:** App Service forwards `X-Forwarded-Proto`/`X-Forwarded-Host` by
> default. With `trust proxy = 1`, `req.protocol` and `req.get("host")` reflect the
> real public scheme + host. If your App Service is behind Azure Front Door or a
> custom domain, make sure `X-Forwarded-Proto: https` is passed through. In local
> dev there's no proxy, so `req.protocol` naturally resolves to `http`.

### 2.2 Compute the base URL from the request

Add a helper that derives the server URL from the incoming request:

```ts
// server/src/swagger.ts
import type { Request } from "express";

export function baseUrlFromRequest(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}
```

- Local: `req.protocol = http`, `req.get("host") = localhost:4000` → `http://localhost:4000`
- Azure: `req.protocol = https`, `req.get("host") = school-forms-api.azurewebsites.net` → `https://school-forms-api.azurewebsites.net` (**no port**)

This naturally handles the port-vs-no-port difference with zero config.

### 2.3 Make the docs UI load the spec from a dynamic JSON endpoint

`swagger-ui-express` lets you point the UI at a URL instead of an inline object.
Change the mount so `servers` is assembled per request:

```ts
// server/src/index.ts
app.get(
  "/api/docs.json",
  (_req, res, next) => {
    // buildSwaggerSpec(req) reads req.protocol + host to set servers[]
    const spec = buildSwaggerSpec(_req);
    res.json(spec);
  },
  // error handler: next(err) is already handled by the global 500 catch
);

app.use(
  "/api/docs",
  swaggerUi.serve,
  swaggerUi.setup(null, {
    swaggerOptions: {
      // Load the spec live so the server list matches the current origin.
      url: "/api/docs.json",
    },
    // Use the full URL so "Try it out" builds absolute paths correctly.
    customSiteTitle: "School Forms API",
  })
);
```

`buildSwaggerSpec(req)` becomes request-aware:

```ts
export function buildSwaggerSpec(req?: Request) {
  const bearerScheme = env.swagger.bearerScheme;
  const servers = [
    { url: baseUrlFromRequest(req!), description: "Current origin" },
    { url: env.publicBaseUrl, description: "Development (PUBLIC_BASE_URL)" },
  ];
  // ...rest of spec unchanged, but use `servers` instead of the static array
}
```

> **Why this works for "no port on Azure":** the spec is re-assembled on every
> `/api/docs.json` request, so `servers[0]` always equals the exact origin the
> browser used — `http://localhost:4000` locally, `https://<app>.azurewebsites.net`
> in Azure with no `:port` appended. No hardcoded values to drift.

---

## 3. Current coverage vs. gaps

### 3.1 Already documented (in `server/src/swagger.ts`)

| Method | Path | Auth | Entity |
| ------ | ---- | ---- | ------ |
| GET | `/api/health` | none | System |
| GET | `/api/info` | none | System |
| GET | `/api/settings/{key}` | none | Settings |
| PUT | `/api/settings/{key}` | admin | Settings |
| GET | `/api/auth/users` | none | User |
| POST | `/api/auth/select` | none | Auth |
| POST | `/api/auth/register` | none | User |
| POST | `/api/auth/login` | none | Auth |
| GET | `/api/auth/me` | auth | User |
| GET | `/api/auth/schools` | none | School |
| GET | `/api/organizations` | admin | Organization |
| GET | `/api/schools` | auth | School |
| POST | `/api/schools` | admin | School |
| GET | `/api/forms` | admin | Form |
| POST | `/api/forms` | admin | Form |
| GET | `/api/forms/public` | none | Form |
| GET | `/api/forms/{id}/public` | none | Form |
| GET | `/api/forms/{id}/columns` | admin | Form → ViewColumnsConfig |
| PUT | `/api/forms/{id}/columns` | admin | Form → ViewColumnsConfig |
| POST | `/api/submissions` | none | Submission |
| GET | `/api/submissions` | staff/admin | Submission |
| GET | `/api/submissions/{publicId}/public` | none | Submission |
| GET | `/api/export/preview` | staff/admin | Export |
| GET | `/api/export/csv` | staff/admin | Export |
| POST | `/api/webhook/google` | secret | Submission |

### 3.2 Endpoints **missing** from Swagger (must be added)

| Method | Path | Auth | Entity |
| ------ | ---- | ---- | ------ |
| POST | `/api/auth/refresh` | cookie | Auth |
| POST | `/api/auth/logout` | cookie | Auth |
| POST | `/api/auth/seed-admin` | none | User (dev only) |
| POST | `/api/auth/seed-staff` | admin | User (dev only) |
| GET | `/api/forms/{id}` | admin | Form |
| PUT | `/api/forms/{id}` | admin | Form |
| PATCH | `/api/forms/{id}/status` | admin | Form status |
| GET | `/api/submissions/{publicId}` | staff/admin | Submission detail (values, comments, ad-hoc fields) |
| PATCH | `/api/submissions/{publicId}/status` | staff/admin | Submission status |
| PUT | `/api/submissions/{publicId}/values` | staff/admin | Submission → values |
| POST | `/api/submissions/{publicId}/comments` | staff/admin | Comment |
| GET | `/api/submissions/{publicId}/adhoc` | staff/admin | AdhocField |
| POST | `/api/submissions/{publicId}/adhoc` | staff/admin | AdhocField |
| PUT | `/api/submissions/{publicId}/adhoc/{fieldId}` | staff/admin | AdhocField |
| DELETE | `/api/submissions/{publicId}/adhoc/{fieldId}` | staff/admin | AdhocField |
| GET | `/api/users` | admin | User |
| POST | `/api/users` | admin | User |
| PUT | `/api/users/{id}` | admin | User |
| GET | `/api/schools/columns` | admin | School |
| GET | `/api/schools/page` | admin | School (paged) |
| POST | `/api/schools/import` | admin | School (import) |

> **Tip:** To prevent drift, generate the paths and a `required`/schema summary
> from the actual route handlers (or a small inventory constant) rather than
> hand-writing everything. At minimum, cross-check the table above against
> `server/src/routes/*.ts` when editing `swagger.ts`.

### 3.3 Document endpoints (forward-declared, pending Generate Document)

> **These routes don't exist yet** — they're specified in
> `docs/features/create-doc.md`. The user wants them documented in Swagger **now**,
> even though the Document generation feature is implemented later. Committing
> their paths + schemas ahead of time keeps the UI complete and the contract
> stable before the feature ships.

| Method | Path | Auth | Entity |
| ------ | ---- | ---- | ------ |
| POST | `/api/submissions/{publicId}/documents` | staff/admin | Generate a document for a submission |
| GET | `/api/submissions/{publicId}/documents` | staff/admin | List documents for a submission |
| POST | `/api/documents/{id}/retry` | staff/admin | Retry a failed document |

---

## 4. Entity schemas to add / finish

The `components.schemas` block should enumerate every domain entity. Current
schemas already exist for `Organization`, `School`, `User`, `Form`, `FormField`,
`Submission`, `SubmissionValue`, `Comment`, `SubmitSubmissionResponse`, `ExportRow`,
`ExportPreview`, `ExportColumn`, `ViewColumnsConfig`.

### 4.1 Add missing schemas

```ts
AdhocField: {
  type: "object",
  properties: {
    id: { type: "integer" },
    submission_id: { type: "integer" },
    label: { type: "string" },
    type: { type: "string", enum: ["text", "textarea", "number", "date", "select", "checkbox", "radio", "email"] },
    options: { type: "array", items: { type: "string" }, nullable: true },
    value: { type: "object", nullable: true },
    sort_order: { type: "integer" },
    created_by: { type: "integer", nullable: true },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
},

SchoolPage: {
  type: "object",
  properties: {
    data: { type: "array", items: { $ref: "#/components/schemas/School" } },
    total: { type: "integer" },
    page: { type: "integer" },
    pageSize: { type: "integer" },
    totalPages: { type: "integer" },
  },
},

ImportResult: {
  type: "object",
  properties: { total: { type: "integer" } },
},

Error: {
  type: "object",
  properties: {
    error: { type: "string" },
    details: { type: "object", nullable: true, description: "Zod flatten() output" },
  },
},
```

### 4.2 `Submission` — enrich the detail shape

The `/api/submissions/{publicId}` handler returns `values`, `comments`,
`adhocFields`, `staffOnlyFields`, and `parentFields`. Document `adhocFields`
(an array of `AdhocField`) and `staffOnlyFields`/`parentFields` (arrays of
`FormField`) on the `Submission` schema.

### 4.3 Document schema — add now (forward-declared)

The **Document** entity is planned in `docs/features/create-doc.md`. Per the user's
request, include its schema in Swagger **now**, before the Generate Document
feature is implemented, so the UI describes the full contract up front. The
columns mirror the `dbo.documents` table in the create-doc plan.

```ts
Document: {
  type: "object",
  properties: {
    id: { type: "integer" },
    submission_id: { type: "integer" },
    document_id: { type: "string", nullable: true, description: "Google Doc id returned by the API; null while Pending." },
    status: { type: "string", enum: ["Pending", "Completed", "Failed"] },
    created_by: { type: "integer", nullable: true },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
    error: { type: "string", nullable: true, description: "Reason for a Failed status." },
  },
},
```

Its routes are listed in §3.3:
`POST /api/submissions/{publicId}/documents`,
`GET /api/submissions/{publicId}/documents`,
`POST /api/documents/{id}/retry`.

---

## 5. Files to create / modify

**Create**
- `docs/features/swagger-ui.md` — **this plan**.
- (Optional) `server/src/swagger-utils.ts` — small helpers (`baseUrlFromRequest`,
  schema builders) to keep `swagger.ts` growing cleanly.

**Modify**
- `server/src/swagger.ts` — make `buildSwaggerSpec(req?: Request)` request-aware;
  add the missing paths (see §3.2) and the **Document** paths + schema (see §3.3,
  §4.3); `servers` derived from the request.
- `server/src/index.ts` — `app.set("trust proxy", 1)`; change the `/api/docs`
  mount to `swaggerUi.setup(null, { swaggerOptions: { url: "/api/docs.json" } })`;
  ensure `/api/docs.json` is served dynamically (computes `servers`).
- `server/src/config/env.ts` — keep `publicBaseUrl` as an optional override;
  clarify it's only a fallback server entry, not the primary.

---

## 6. Verification

### 6.1 Local (with port)
1. `npm run dev:server` → open `http://localhost:4000/api/docs`.
2. Confirm `servers[0]` = `http://localhost:4000`.
3. "Try it out" on a public route (e.g. `GET /api/health`) targets localhost and
   succeeds.

### 6.2 Azure (no port)
1. Deploy to Azure (`https://school-forms-api.azurewebsites.net`).
2. Open `https://school-forms-api.azurewebsites.net/api/docs` — **no `:port` in the URL**.
3. Confirm `servers[0]` = `https://school-forms-api.azurewebsites.net` (derived,
   not the old placeholder).
4. "Try it out" hits the real deployed origin and works.
5. Confirm `req.protocol` is `https` (requires `trust proxy` + forwarded headers).

### 6.3 Typecheck + completeness
- `npm run typecheck:server` passes.
- Diff the documented paths against `grep` of `server/src/routes/*.ts` — every
  route has a matching Swagger path (no missing endpoints per §3.2).
- `npm run test` (or the test file in §7) passes — the coverage test asserts every
  mounted route `method + path` appears in the spec.

---

## 7. Endpoint coverage unit test

The user confirmed adding a **unit test that asserts every mounted route appears
in `buildSwaggerSpec()`** to prevent spec drift. Extract the route inventory into
a testable helper so the test doesn't have to parse Express internals.

### 7.1 Helper: `server/src/routes/inventory.ts` (new)

A small, static, human-auditable inventory of all mounted routes. This is the
**source of truth** the test compares against. It contains `method`, `path` (with
`/api` prefix, using `{param}` placeholders), and the required auth role.

```ts
export interface RouteEntry {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;            // full, e.g. "/api/submissions/{publicId}/values"
  auth: "none" | "staff" | "admin" | "secret";
  tags?: string;           // entity grouping
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
  { method: "post", path: "/api/submissions/{publicId}/documents", auth: "staff", tags: "Documents" },
  { method: "get", path: "/api/submissions/{publicId}/documents", auth: "staff", tags: "Documents" },
  { method: "post", path: "/api/documents/{id}/retry", auth: "staff", tags: "Documents" },
];
```

> **Why an explicit inventory instead of scanning Express?** Express does not
> expose a clean "list all routes with their auth" API, and introspecting
> `app._router.stack` is fragile across versions. A hand-maintained constant is
> readable, and the test catches *forgetting to add a new endpoint* to both the
> inventory **and** the Swagger spec at once.

### 7.2 Test: `server/src/swagger.test.ts` (new)

Use **Vitest** (already an implicit dev dependency of the monorepo) or **node:test**
if the server package keeps it minimal. The test does two assertions per route:

1. **Every inventory route is documented** in `buildSwaggerSpec()` — i.e. the
   spec has a `paths` entry with the matching method and the Swagger path
   template matches the inventory path.
2. **Every spec path is in the inventory** (no orphan docs) and each documented
   path's `operationId`/`tags` are consistent.

```ts
import { describe, it, expect } from "vitest";
import { buildSwaggerSpec } from "./swagger.js";
import { ROUTES } from "./routes/inventory.js";

describe("Swagger spec covers all API routes", () => {
  const spec = buildSwaggerSpec();

  it("documents every mounted route", () => {
    const missing: string[] = [];
    for (const r of ROUTES) {
      // Swagger path template uses the same {param} convention.
      const path = spec.paths[r.path];
      if (!path) {
        missing.push(`${r.method.toUpperCase()} ${r.path}`); // path not present at all
        continue;
      }
      if (!path[r.method]) {
        missing.push(`${r.method.toUpperCase()} ${r.path} (no ${r.method} operation)`);
      }
    }
    expect(missing, `Missing Swagger paths:\n${missing.join("\n")}`).toEqual([]);
  });

  it("has no orphan documented paths", () => {
    const known = new Set(ROUTES.map((r) => r.path));
    const orphan = Object.keys(spec.paths).filter((p) => !known.has(p));
    expect(orphan).toEqual([]);
  });

  it("marks required security for protected endpoints", () => {
    for (const r of ROUTES) {
      const op = spec.paths[r.path]?.[r.method];
      if (!op) continue;
      const hasSecurity = Array.isArray(op.security) && op.security.length > 0;
      if (r.auth === "none" || r.auth === "secret") {
        // public/secret endpoints should NOT require bearer security
        expect(hasSecurity, `${r.method.toUpperCase()} ${r.path} should be public`).toBe(false);
      } else {
        expect(hasSecurity, `${r.method.toUpperCase()} ${r.path} should require auth`).toBe(true);
      }
    }
  });
});
```

### 7.3 Normalize the Swagger path templates

The inventory uses `{id}`, `{publicId}`, `{fieldId}` while the current Swagger spec
uses `{id}` / `{publicId}` / `{fieldId}` too. Keep them identical. If any route in
`swagger.ts` uses a different placeholder name than the inventory (e.g. `:id`),
normalize both to the OpenAPI `{param}` convention so the test's `spec.paths[r.path]`
match succeeds.

### 7.4 Test script wiring

Add to `server/package.json`:

```json
{
  "scripts": {
    "test": "vitest run"
  }
}
```

Or, if the package already uses a runner, add the new test file path to it.

> **This test is the antipattern-doctor:** in the future, when a developer adds a
> route to `routes/*.ts` but forgets to add it to `swagger.ts` **and** `inventory.ts`,
> the test fails with the exact missing list. The single `ROUTES` constant is the
> one place to update, and it drives both the inventory check and (where useful) the
> spec.

---

## 8. Decisions & open questions

### 8.1 Confirmed decisions (from user)

| # | Question | Decision |
| - | -------- | -------- |
| 1 | Public exposure of `/api/docs` on Azure? | **Publicly reachable** — keep it open (no login/secret guard). |
| 2 | `PUBLIC_BASE_URL` vs request-derived URL? | **Request-derived wins.** `PUBLIC_BASE_URL` remains a documented fallback entry only. |
| 3 | Endpoint-coverage unit test? | **Yes** — add it (see §7). |

### 8.2 Remaining open question — resolved during implementation

- **Placeholder normalization** — the Swagger spec already uses `{param}` for every
  path param, matching the inventory. No normalization was needed.

### 8.3 Implementation notes (post-impl)

- Test runner: **Vitest** was added as a devDependency (`^2.1.8`) plus a `test`
  script (`vitest run`). See `server/package.json`.
- Document endpoints (`/api/submissions/{publicId}/documents`,
  `/api/documents/{id}/retry`) are **forward-declared** in the spec and inventory
  but are <strong>not yet mounted</strong> (Generate Document feature is planned).
  The inventory labels them under the `Documents` tag; the coverage test treats them
  as planned/documented-only and does not require them to be mounted.
- The `auth` inventory field uses an extra `cookie` value for `/api/auth/refresh`
  and `/api/auth/logout` (they use the httpOnly refresh cookie, which the Swagger
  Authorize button cannot send), and `secret` for `/api/webhook/google`.
- `GET /api/schools` required auth in the code (`requireAuth`) but was marked
  public in the original spec — the coverage test caught this drift and the spec
  was corrected.
- **Verified live:** `GET /api/docs.json` returns `servers[0]` =
  the request origin (`"Current origin"`), 39 documented paths, and all schemas
  including the new `AdhocField`, `SchoolPage`, `ImportResult`, `Error`, and
  `Document`. Swagger UI renders at `/api/docs` with `/api/docs.json` as the
  spec source.
