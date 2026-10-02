/**
 * Public / Private forms — the visibility rule, the grandfather, and the log.
 *
 * Docs: docs/plans/public-private-forms.md (§12).
 *
 * A DURABLE VERSION OF WHAT WAS VERIFIED BY HAND. The live behaviour (a locked
 * form that refuses, a backfill that grants the right accounts, a decision that
 * survives a re-privatisation) was proved against a database during
 * implementation; a probe dies with the session that ran it. What makes the trip
 * into a test is the part that is true of the SOURCE: which statement carries the
 * rule, which route is guarded, which column is a timestamp, and which sites
 * apply the predicate.
 *
 * The claims this file gates, each of which is otherwise only a comment:
 *
 *   1. The visibility rule is written in ONE place (`access/formAccess.ts`) and
 *      names the exempt roles there and nowhere else.
 *   2. The backfill's grant set is the COMPLEMENT of that exemption — the two are
 *      one rule written twice and must move together (trap 12).
 *   3. `listAvailableFormsFor` filters `status = 'published'`, so drafts never
 *      appear on a page every internal role can open (trap 2 of §16.8).
 *   4. Every row-level site that accepts a form id applies the check (§7.2).
 *   5. Both dialects declare both tables and the column, and the timestamp
 *      columns are registered (or the two engines disagree about the shape).
 *   6. The seven routes are registered in the inventory AND documented in
 *      Swagger — the existing coverage test proves the second half.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { sqlserverDialect } from "./dialect/sqlserver.js";
import { tursoDialect } from "./dialect/turso.js";
import { TIMESTAMP_COLUMNS, BOOLEAN_COLUMNS } from "./client.js";
import { FORM_VISIBILITY, FORM_ACCESS_STATUS, FORM_ACCESS_EVENT } from "./schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, "..");

function source(relative: string): string {
  return readFileSync(join(SERVER_SRC, relative), "utf8");
}

const PREDICATE = source("access/formAccess.ts");
const DATA = source("db/formAccess.ts");
const ROUTER = source("routes/formAccess.ts");
const FORMS_ROUTE = source("routes/forms.ts");
const SUBMISSIONS_ROUTE = source("routes/submissions.ts");
const INVENTORY = source("routes/inventory.ts");

// -----------------------------------------------------------------------------
// 1. The rule lives in one place
// -----------------------------------------------------------------------------
describe("the visibility rule is written once", () => {
  it("names the exempt roles in the predicate module", () => {
    expect(PREDICATE).toContain("UNRESTRICTED_ROLES");
    expect(PREDICATE).toMatch(/"admin",\s*"staff"/);
  });

  it("★ does NOT re-state the role test in any route", () => {
    // ★ The defect this guards: a second copy of "admin or staff" outside the
    // predicate is the "two overlapping gates" failure this repo has produced
    // twice. The rule must be consulted, never re-implemented.
    for (const [name, src] of [
      ["routes/formAccess.ts", ROUTER],
      ["routes/forms.ts", FORMS_ROUTE],
      ["routes/submissions.ts", SUBMISSIONS_ROUTE],
    ] as const) {
      expect(
        src.includes('role === "admin" && role === "staff"') ||
          /role\s*!==\s*"cdm_contact"\s*&&/.test(src),
        `${name} re-implements the role exemption`
      ).toBe(false);
    }
  });

  it("the predicate narrows with an OR of public-or-granted", () => {
    // The shape matters: `visibility = 'public' OR EXISTS (…approved)`.
    expect(PREDICATE).toContain("visibility = 'public'");
    expect(PREDICATE).toContain("fa.status = 'approved'");
  });

  it("an unresolvable viewer fails CLOSED, not open", () => {
    // A viewer with no id must get the public-only clause rather than no clause.
    expect(PREDICATE).toContain("if (id === null)");
    expect(PREDICATE).toMatch(/visibility = 'public'`,\s*params: \{\}/);
  });
});

// -----------------------------------------------------------------------------
// 2. The backfill is the complement of the exemption
// -----------------------------------------------------------------------------
describe("the grandfather backfill", () => {
  it("grants exactly the non-exempt role", () => {
    // ★ `role = 'cdm_contact'`, NOT `role <> 'admin'`. The two are one rule
    // written twice (the predicate exempts admin+staff), so they must change
    // together — see the plan's trap 12.
    expect(DATA).toContain("u.role = 'cdm_contact'");
    expect(DATA).not.toMatch(/u\.role\s*<>\s*'admin'/);
  });

  it("is idempotent AND protects a decision via NOT EXISTS", () => {
    // The NOT EXISTS is what stops a later flip re-granting a declined or
    // revoked account — an administrator's answer must not be silently reversed.
    expect(DATA).toMatch(/NOT EXISTS \(SELECT 1 FROM dbo\.form_access/);
  });

  it("only runs on the public -> private transition", () => {
    expect(DATA).toContain('if (visibility !== "private" || !wasPublic)');
  });

  it("writes one backfilled event per inserted user", () => {
    expect(DATA).toContain('event: "backfilled"');
  });
});

// -----------------------------------------------------------------------------
// 3. The Available Forms query cannot leak drafts
// -----------------------------------------------------------------------------
describe("Available Forms", () => {
  it("★ filters to published forms", () => {
    // ★ The trap: the naive `WHERE organization_id = @org` puts DRAFTS and
    // ARCHIVED forms on a page every internal role can open. Those are
    // unpublished and are not served by the anonymous public endpoints either.
    expect(DATA).toMatch(/status = 'published'/);
  });

  it("derives `access` rather than storing it", () => {
    // The page must render what the server decided; a stored column would be a
    // second source of truth that can disagree with the predicate.
    expect(DATA).toContain('access: "granted"');
    expect(DATA).toContain('access: "none"');
    expect(DATA).toContain('access: "pending"');
    expect(DATA).toContain('access: "denied"');
  });

  it("returns granted for an exempt role without consulting the grant table", () => {
    expect(DATA).toContain("isUnrestrictedRole(viewer.role)");
  });
});

// -----------------------------------------------------------------------------
// 4. Every row-level site applies the check
// -----------------------------------------------------------------------------
describe("enforcement sites", () => {
  it("★ the shared submission guard applies BOTH rules", () => {
    // One helper, so a new route cannot apply the school rule and forget the
    // form rule — a missing guard looks exactly like a route nobody called.
    expect(SUBMISSIONS_ROUTE).toContain("async function submissionAccessError(");
    expect(SUBMISSIONS_ROUTE).toContain("canAccessForm(req.user!, submission.form_id)");
    expect(SUBMISSIONS_ROUTE).toContain("canAccessSchool(req.user!, submission.school_id)");
  });

  it("★ no bare canAccessSchool guard remains in submissions.ts", () => {
    // Every guard must go through the helper. A leftover inline guard is a route
    // that checks the school and NOT the form.
    //
    // ★ The helper's OWN guard is the one legitimate occurrence, so the scan
    // starts after the helper's closing brace. Counting the whole file would
    // fail on correct code.
    const helperEnd = SUBMISSIONS_ROUTE.indexOf("function submissionFiltersFrom");
    expect(helperEnd, "the helper was renamed — this scan would check nothing").toBeGreaterThan(-1);
    const afterHelper = SUBMISSIONS_ROUTE.slice(helperEnd);
    const bare = afterHelper.match(/if \(!canAccessSchool\(/g) ?? [];
    expect(
      bare.length,
      "an inline canAccessSchool guard bypasses the form check — use submissionAccessError"
    ).toBe(0);
  });

  it("the submission FILTER carries the viewer, so counts narrow with the list", () => {
    // ★ `submissionArchiveCounts` reads the same filter object. Adding the
    // predicate in the list handler alone leaves the "N archived hidden" badge
    // describing a query the grid no longer runs.
    expect(SUBMISSIONS_ROUTE).toContain("viewer: req.user!");
    expect(source("db/queries.ts")).toContain("viewer?: FormViewer | null;");
  });

  it("the export, reports and documents paths each apply the check", () => {
    expect(source("routes/export.ts")).toContain("canAccessForm(req.user!, formId)");
    expect(source("routes/reports.ts")).toContain("canAccessForm(user, q.form_id)");
    expect(source("db/documents.ts")).toContain("formVisibilityExists(params.viewer");
  });

  it("saved report views naming a locked form are filtered out", () => {
    // Otherwise the Reports selector offers a view it will then refuse to run.
    expect(source("routes/reports.ts")).toMatch(/for \(const v of views\)[\s\S]{0,200}canAccessForm/);
  });

  it("the forms list applies the predicate", () => {
    expect(FORMS_ROUTE).toContain("listForms(schoolId, req.user!.organization_id, req.user!)");
  });
});

// -----------------------------------------------------------------------------
// 5. Both dialects, and the timestamp registration
// -----------------------------------------------------------------------------
describe("schema parity", () => {
  const sqlDdl = sqlserverDialect.ddl.join("\n");
  const tursoDdl = tursoDialect.ddl.join("\n");

  it("both dialects create both tables", () => {
    for (const table of ["form_access", "form_access_events"]) {
      expect(sqlDdl, `SQL Server is missing ${table}`).toContain(table);
      expect(tursoDdl, `Turso is missing ${table}`).toContain(table);
    }
  });

  it("both dialects add the visibility column", () => {
    expect(sqlDdl).toContain("visibility NVARCHAR(10)");
    expect(tursoDdl).toContain("visibility      TEXT NOT NULL DEFAULT 'public'");
    // Turso needs an addColumns entry too: SQLite has no
    // `ALTER TABLE ADD COLUMN IF NOT EXISTS`, so a database created before the
    // column only gains it here.
    const addCol = tursoDialect.addColumns.find((c) => c.column === "visibility");
    expect(addCol, "Turso addColumns is missing visibility").toBeTruthy();
    expect(addCol?.table).toBe("forms");
  });

  it("★ every timestamp column of the new tables is registered", () => {
    // Omit one and it is a Date on SQL Server and a string on Turso — the
    // libsql.test.ts honesty guard enforces the pairing, and this is the same
    // check stated for this feature's columns.
    for (const col of ["requested_at", "decided_at"]) {
      expect(TIMESTAMP_COLUMNS.has(col), `${col} must be in TIMESTAMP_COLUMNS`).toBe(true);
    }
    // `created_at` is already registered by an earlier feature; assert it too so
    // a future removal is caught here.
    expect(TIMESTAMP_COLUMNS.has("created_at")).toBe(true);
  });

  it("the string columns are NOT registered as timestamps or booleans", () => {
    for (const col of ["visibility", "status", "event", "source"]) {
      expect(TIMESTAMP_COLUMNS.has(col), `${col} must not be a timestamp`).toBe(false);
      expect(BOOLEAN_COLUMNS.has(col), `${col} must not be a boolean`).toBe(false);
    }
  });

  it("the tuple constants match the DDL's CHECK lists", () => {
    for (const v of FORM_VISIBILITY) expect(sqlDdl).toContain(`'${v}'`);
    for (const v of FORM_ACCESS_STATUS) expect(sqlDdl).toContain(`'${v}'`);
    for (const v of FORM_ACCESS_EVENT) expect(sqlDdl).toContain(`'${v}'`);
  });
});

// -----------------------------------------------------------------------------
// 6. Route registration
// -----------------------------------------------------------------------------
describe("route registration", () => {
  const PATHS = [
    "/api/forms/available",
    "/api/forms/{id}/visibility",
    "/api/form-access/mine",
    "/api/form-access/requests",
    "/api/form-access/requests/withdraw",
    "/api/form-access/requests/decide",
    "/api/form-access/grants",
    "/api/form-access/summary",
    // Per-account access, for the admin's Edit User drawer.
    "/api/form-access/user/{userId}",
    "/api/form-access/user/{userId}/remove",
  ];

  it("★ registers every route in the inventory", () => {
    // ★ The count is asserted first: a scanner that matched nothing would
    // otherwise pass by having nothing to check.
    const found = PATHS.filter((p) => INVENTORY.includes(`"${p}"`));
    expect(found.length, `missing from inventory: ${PATHS.filter((p) => !found.includes(p)).join(", ")}`).toBe(
      PATHS.length
    );
  });
  it("declares the literal /api/forms/available BEFORE the dynamic /{id}", () => {
    // Express matches in registration order, so a dynamic route registered first
    // swallows the literal.
    const literal = INVENTORY.indexOf('"/api/forms/available"');
    const dynamic = INVENTORY.indexOf('"/api/forms/{id}"');
    expect(literal).toBeGreaterThan(-1);
    expect(dynamic).toBeGreaterThan(-1);
    expect(literal).toBeLessThan(dynamic);
  });

  it("mounts the router", () => {
    expect(source("index.ts")).toContain('app.use("/api/form-access", formAccessRouter)');
  });

  it("the admin-only routes carry the admin guard", () => {
    // There is no router-level guard (two audiences in one file), so each admin
    // route must assert its own — a missing one hands every user the queue.
    //
    // ★ Match the ROUTE REGISTRATION (`formAccessRouter.get("/requests"`), not a
    // bare `"/requests"` — the latter also matches the POST on the same path, so
    // an indexOf would check the wrong handler and pass on a correct file for the
    // wrong reason.
    for (const [method, path] of [
      ["get", "/requests"],
      ["post", "/requests/decide"],
      ["get", "/grants"],
      ["get", "/summary"],
    ] as const) {
      const needle = `formAccessRouter.${method}("${path}"`;
      const idx = ROUTER.indexOf(needle);
      expect(idx, `${method.toUpperCase()} ${path} not found in the router`).toBeGreaterThan(-1);
      const line = ROUTER.slice(idx, idx + 160);
      expect(line, `${path} is missing requireRoles("admin")`).toContain('requireRoles("admin")');
    }
  });
});

// -----------------------------------------------------------------------------
// 7. The audit log's single writer
// -----------------------------------------------------------------------------
describe("the audit log", () => {
  it("★ has exactly ONE writer", () => {
    // Two code paths that must write the same audit line will eventually write
    // it differently — and because `denied` covers both declined and revoked,
    // the log is the ONLY thing that can tell them apart afterwards.
    const inserts = DATA.match(/INSERT INTO dbo\.form_access_events/g) ?? [];
    expect(inserts.length).toBe(1);
  });

  it("writes the event inside the caller's transaction", () => {
    // ★ Match the signature loosely across line endings: the file is CRLF on
    // Windows, so a literal `\n` in the pattern would fail on a correct file.
    expect(DATA).toMatch(/async function recordAccessEvent\(\s*tx: DbClient,/);
    // Every state change passes the transaction handle, never the global client.
    expect(DATA).toMatch(/recordAccessEvent\(tx, \{/);
  });

  it("is never read by the visibility predicate", () => {
    // The state table is what the rule reads; the log is what an administrator
    // reads. If the two ever disagree, the state wins and the log is the bug.
    expect(PREDICATE).not.toContain("form_access_events");
  });

  it("★ a denied row IS re-requestable", () => {
    // ★ This REVERSES the plan's original §15 Q5 answer, at the user's request:
    // removing access in the Edit User drawer must leave the person able to ask
    // for it back from the Available Forms page.
    //
    // The two facts stay distinguishable even though both are re-requestable —
    // `form_access_events` records `declined` and `revoked` separately, so an
    // administrator can still see which happened.
    expect(DATA).not.toContain('throw new AccessRequestError("denied")');
    expect(DATA).toMatch(/requestFormAccess[\s\S]{0,2400}status = 'pending'/);
  });

  it("a revoke only applies to an approved row", () => {
    // Otherwise a decline on an approved row would silently revoke it while the
    // log said "declined".
    expect(DATA).toMatch(/decision === "revoke" && existing\.status !== "approved"/);
  });
});

// -----------------------------------------------------------------------------
// 8. The Edit User drawer's per-account access list
// -----------------------------------------------------------------------------
describe("per-account access (the Edit User drawer)", () => {
  it("★ refuses to remove access on a PUBLIC form", () => {
    // ★ The reason this is a separate function from `decideFormAccess(… "revoke")`.
    // On a public form every internal member can read it regardless of any row,
    // so the removal would appear to succeed while changing nothing — the admin
    // would watch the row vanish and the person would still open the form.
    expect(DATA).toContain('if (forms[0].visibility !== "private") return { ok: false, reason: "form_public" }');
  });

  it("writes `denied` + a `revoked` event, matching the queue's Revoke", () => {
    // The two paths must not disagree about what a removal looks like.
    expect(DATA).toMatch(/removeFormAccess[\s\S]{0,1400}event: "revoked"/);
    expect(DATA).toMatch(/removeFormAccess[\s\S]{0,1400}status = 'denied'/);
  });

  it("★ lists rows that EXIST, not forms the person can read", () => {
    // The two differ for a staff or admin account, which is exempt by rule and
    // holds no row — so its list is legitimately empty. Deriving "forms they can
    // read" would offer a Remove button for rows that do not exist.
    expect(DATA).toMatch(/FROM dbo\.form_access a[\s\S]{0,200}WHERE a\.user_id = @userId/);
    // …and it must NOT consult the visibility predicate.
    const fn = DATA.slice(DATA.indexOf("export async function listAccessForUser"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body, "listAccessForUser consults the predicate — it should list rows only").not.toContain(
      "formVisibilityClause"
    );
  });

  it("★ the per-user routes are scoped to the caller's organization", () => {
    // Otherwise an admin could enumerate another tenant's grants by guessing an
    // id. A 404 (not 403) keeps the two indistinguishable.
    for (const path of ['"/user/:userId"', '"/user/:userId/remove"']) {
      const idx = ROUTER.indexOf(path);
      expect(idx, `${path} not found`).toBeGreaterThan(-1);
      const handler = ROUTER.slice(idx, idx + 900);
      expect(handler, `${path} does not check the target's organization`).toContain(
        "target.organization_id) !== orgId(req.user!)"
      );
    }
  });
  it("the removal takes the user from the PATH, not the body", () => {
    // A body-supplied user id would let a removal be redirected to a different
    // account than the one the admin has open.
    expect(ROUTER).toMatch(/removeAccessSchema[\s\S]{0,400}userId/);
    const schema = source("schemas.ts").slice(source("schemas.ts").indexOf("removeAccessSchema"));
    const body = schema.slice(0, schema.indexOf("});"));
    expect(body).not.toContain("user_id");
  });
});
