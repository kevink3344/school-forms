// -----------------------------------------------------------------------------
// Submission Detail Link — `forms.link_field_ids` and the grid's `link_label`.
//
// The admin picks which answers make up the Submissions grid link's TEXT
// (docs/plans/submission-link-label.md). Nothing about the link's target changes,
// which is exactly why a mistake here is quiet: a wrong label still opens the
// right submission, so nobody reports it — it just reads wrong forever.
//
// The assertions below are the copies that drift without failing anything at
// run time:
//
//   S1  the column exists on BOTH dialects         (a fresh DB must not 500)
//   S2  every form read SELECTs and PARSES it      (or the designer shows nothing)
//   S3  the two subqueries agree on "unset"        (or a configured form falls back)
//   S4  the fallback is INSIDE the CASE            (or "None" is unreachable)
//   S5  selection ORDER is read, not sort_order    (or the admin's order is ignored)
//   S6  the grid renders `link_label`, not the old field
//
// `queries.ts` imports the connection pool, so its source is read as TEXT — the
// same approach `form-field-source-item-id.test.ts` uses. ★ Each scanner asserts
// it FOUND something before judging it: a regex that matches nothing would
// otherwise pass by having nothing to check.
// -----------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { tursoDialect } from "./dialect/turso.js";
import { sqlserverDialect } from "./dialect/sqlserver.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, "..");
const REPO_ROOT = join(HERE, "..", "..", "..");

function serverSource(relative: string): string {
  return readFileSync(join(SERVER_SRC, relative), "utf8");
}
function repoSource(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

const SCHEMA = serverSource("db/schema.ts");
const TURSO = serverSource("db/dialect/turso.ts");
const QUERIES = serverSource("db/queries.ts");
const CLIENT = serverSource("db/client.ts");
const ROUTES = serverSource("routes/forms.ts");
const SCHEMAS = serverSource("schemas.ts");
const GRID = repoSource("client/src/components/SubmissionsGrid.tsx");

/**
 * Slice one function out of a module, up to the next top-level export.
 * Handles both exported and module-private declarations, because a search for
 * only `export async function` silently returns nothing for a private helper
 * and every assertion on it then passes vacuously.
 */
function bodyOf(fnName: string, src = QUERIES): string {
  const found = new RegExp(`(?:export )?async function ${fnName}\\(`).exec(src);
  expect(found, `${fnName} not found in queries.ts — was it renamed?`).not.toBeNull();
  const start = found!.index;
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

// -----------------------------------------------------------------------------
// S1 — the column must exist on both dialects, or a fresh deployment 500s on
// every form read.
// -----------------------------------------------------------------------------
describe("S1: forms.link_field_ids exists on both dialects", () => {
  it("SQL Server ALTERs it in idempotently", () => {
    const alter =
      /IF COL_LENGTH\('dbo\.forms', 'link_field_ids'\) IS NULL[\s\S]{0,200}?ADD link_field_ids NVARCHAR\(MAX\) NULL/.exec(
        SCHEMA
      );
    expect(alter, "no idempotent link_field_ids migration in db/schema.ts").not.toBeNull();
  });

  it("Turso declares it in BOTH the final DDL and the addColumns ladder", () => {
    // `ddl` is the final schema for a fresh database; `addColumns` only runs for
    // databases that predate the column. Declaring one without the other leaves
    // either new or existing Turso deployments broken, and SQLite has no
    // `ALTER TABLE ADD COLUMN IF NOT EXISTS` to fall back on.
    const inDdl = /CREATE TABLE IF NOT EXISTS forms \([\s\S]*?link_field_ids\s+TEXT/.exec(TURSO);
    expect(inDdl, "link_field_ids missing from the Turso forms CREATE").not.toBeNull();

    const inAddColumns = /table:\s*"forms",\s*column:\s*"link_field_ids"/.exec(TURSO);
    expect(inAddColumns, "link_field_ids missing from addColumns").not.toBeNull();
  });

  it("is NOT listed in BOOLEAN_COLUMNS / TIMESTAMP_COLUMNS", () => {
    // It holds a JSON array. Claiming it is a boolean or a timestamp would make
    // the driver rewrite every value — and libsql.test.ts enforces the pairing,
    // so getting this wrong breaks two suites for one typo.
    expect(/link_field_ids/.test(CLIENT)).toBe(false);
  });

  it("is declared on the Form interface as a nullable id array", () => {
    expect(/link_field_ids:\s*number\[\] \| null/.exec(SCHEMA)).not.toBeNull();
  });
});

// -----------------------------------------------------------------------------
// S2 — every form read must select AND parse it. A read that selects the raw
// JSON string hands the client `"[4,5]"`, and the designer renders no chips.
// -----------------------------------------------------------------------------
describe("S2: every form read selects and parses link_field_ids", () => {
  it("listForms, getForm, createForm and updateForm all mention the column", () => {
    for (const fn of ["listForms", "getForm", "createForm", "updateForm"]) {
      const body = bodyOf(fn);
      expect(body, `${fn} does not touch link_field_ids`).toMatch(/link_field_ids|linkFieldIds/);
    }
  });

  it("the two row-returning reads go through the parser", () => {
    expect(bodyOf("listForms")).toMatch(/parseFormRowList/);
    expect(bodyOf("getForm")).toMatch(/parseFormRow\(/);
  });

  it("updateForm reads an absent key as 'leave it alone'", () => {
    // The designer always sends the key, but a partial PUT from any other caller
    // must not silently clear the admin's selection.
    const body = bodyOf("updateForm");
    expect(body).toMatch(
      /hasOwnProperty\.call\(data, "link_field_ids"\)[\s\S]{0,120}\?\s*data\.link_field_ids\s*:\s*existing\.link_field_ids/
    );
  });

  it("the parser preserves order and drops unusable ids", () => {
    const body = /export function parseLinkFieldIds[\s\S]*?\n}/.exec(QUERIES);
    expect(body, "parseLinkFieldIds not found").not.toBeNull();
    const src = body![0];
    // No sort() / Set(): either would reorder or collapse the admin's choice.
    expect(src).not.toMatch(/\.sort\(/);
    expect(src).toMatch(/Number\.isInteger\(id\) && id > 0/);
  });
});

// -----------------------------------------------------------------------------
// S3/S4/S5 — the two subqueries. These are the parts that cannot be seen from
// the UI: a form that "has" a selection but falls back, or joins in the wrong
// order, looks like it was never configured.
// -----------------------------------------------------------------------------
describe("S3: both dialects agree on what 'unset' means", () => {
  it("each dialect's link subquery tests the shared unset predicate", () => {
    for (const [name, dialect] of [
      ["sqlserver", sqlserverDialect],
      ["turso", tursoDialect],
    ] as const) {
      const sql = dialect.submissionLinkLabelSubquery();
      // The shared helper expands to a NULL-or-blank test; assert its effect
      // rather than its import name so the helper can be refactored.
      expect(sql, `${name} does not treat NULL as unset`).toMatch(/link_field_ids IS NULL/);
      expect(sql, `${name} does not treat a blank string as unset`).toMatch(/LTRIM\(RTRIM\(f\.link_field_ids\)\)/);
    }
  });
});

describe("S4: the fallback is INSIDE the CASE, so a configured form can yield NULL", () => {
  it("both dialects guard the fallback with CASE … THEN", () => {
    for (const [name, dialect] of [
      ["sqlserver", sqlserverDialect],
      ["turso", tursoDialect],
    ] as const) {
      const sql = dialect.submissionLinkLabelSubquery();
      expect(sql, `${name} has no CASE`).toMatch(/CASE WHEN/);
      // A COALESCE outside the CASE would substitute the first field for a
      // configured form whose chosen answers are all blank — making "None"
      // unreachable, which is the one behaviour the admin asked for.
      expect(sql, `${name} COALESCEs the whole expression`).not.toMatch(/^\(COALESCE/);
      expect(sql).toMatch(/END\)$/);
    }
  });

  it("the fallback is the legacy first-non-staff-answer subquery", () => {
    for (const dialect of [sqlserverDialect, tursoDialect]) {
      const sql = dialect.submissionLinkLabelSubquery();
      expect(sql).toMatch(/ff\.staff_only = 0/);
    }
  });
});

describe("S5: selection ORDER is read, not the form's sort_order", () => {
  it("SQL Server orders by the OPENJSON element key", () => {
    const sql = sqlserverDialect.submissionLinkLabelSubquery();
    expect(sql).toMatch(/OPENJSON\(f\.link_field_ids\)/);
    expect(sql).toMatch(/WITHIN GROUP \(ORDER BY je\.\[key\]\)/);
  });

  it("Turso orders the inner rows by the json_each key", () => {
    const sql = tursoDialect.submissionLinkLabelSubquery();
    expect(sql).toMatch(/json_each\(f\.link_field_ids\)/);
    expect(sql).toMatch(/ORDER BY je\.key/);
    // GROUP_CONCAT has no ORDER BY of its own on SQLite, so the ordering has to
    // be inside the subquery it aggregates.
    expect(sql).toMatch(/GROUP_CONCAT\(t\.v, ' '\)/);
  });

  it("neither dialect orders by ff.sort_order inside the configured branch", () => {
    for (const dialect of [sqlserverDialect, tursoDialect]) {
      const sql = dialect.submissionLinkLabelSubquery();
      const configured = sql.slice(sql.indexOf("ELSE"));
      expect(configured).not.toMatch(/ORDER BY ff\.sort_order/);
    }
  });

  it("both dialects scope the ids to the submission's own form", () => {
    for (const dialect of [sqlserverDialect, tursoDialect]) {
      expect(dialect.submissionLinkLabelSubquery()).toMatch(/ff\.form_id = s\.form_id/);
    }
  });

  it("both dialects skip blank answers so the label has no double space", () => {
    for (const dialect of [sqlserverDialect, tursoDialect]) {
      const sql = dialect.submissionLinkLabelSubquery();
      expect(sql).toMatch(/sv\.value IS NOT NULL/);
      expect(sql).toMatch(/LTRIM\(RTRIM\(sv\.value\)\) <> ''/);
    }
  });
});

// -----------------------------------------------------------------------------
// S6 — the wiring. The column can be perfect and still never reach the screen.
// -----------------------------------------------------------------------------
describe("S6: the submission reads and the grid are wired to link_label", () => {
  it("both submission reads select the subquery", () => {
    for (const fn of ["listSubmissions", "getSubmissionByPublicId"]) {
      const body = bodyOf(fn);
      expect(body, `${fn} does not select link_label`).toMatch(
        /submissionLinkLabelSubquery\(\)\} AS link_label/
      );
    }
  });

  it("the grid renders link_label and no longer reads student_name", () => {
    expect(GRID, "grid does not render link_label").toMatch(/\{s\.link_label \|\| "None"\}/);
    expect(GRID, "grid still renders student_name").not.toMatch(/s\.student_name/);
  });

  it("the route validates the ids against the form before writing", () => {
    expect(ROUTES).toMatch(/function validateLinkFieldIds/);
    // Validation must happen BEFORE updateForm, or a bad selection leaves the
    // rest of the edit already written.
    const validateAt = ROUTES.indexOf("validateLinkFieldIds(");
    const updateAt = ROUTES.indexOf("await updateForm(id, {");
    expect(validateAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(-1);
    expect(validateAt).toBeLessThan(updateAt);
  });

  it("the schema accepts an id array or null, and nothing else", () => {
    expect(SCHEMAS).toMatch(
      /link_field_ids:\s*z\.array\(z\.coerce\.number\(\)\.int\(\)\.positive\(\)\)[\s\S]{0,60}optional\(\)\.nullable\(\)/
    );
  });
});
