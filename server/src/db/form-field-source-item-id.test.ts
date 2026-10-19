// -----------------------------------------------------------------------------
// `form_fields.source_item_id` — the guards that fail SILENTLY.
//
// Google assigns every question an id that survives retitling, and storing it is
// what makes a renamed question land on its mapped column instead of being
// captured ad-hoc (docs/plans/google-form-undefined-fields.md §15). The value is
// LEARNED from traffic rather than configured, which is the whole reason it needs
// structural tests: there is no backfill to re-run and no admin screen to inspect,
// so a mistake shows up as "answers quietly stopped matching" weeks later.
//
// Every assertion below is a copy that drifts without failing anything at run
// time:
//
//   S1  the column exists on BOTH dialects        (a fresh DB must not 500)
//   S2  `listFormFields` SELECTs it               (or every field re-binds forever)
//   S3  the binding UPDATE cannot overwrite       (or a rename misroutes answers)
//   S4  the designer's own writers do NOT touch it (or editing a field clobbers it)
//   S5  the Apps Script still SENDS it            (or nothing is ever learned)
//   S6  `createSubmission` writes it BEST-EFFORT  (or a saved submission 500s)
//
// `queries.ts` imports the connection pool, so its source is read as TEXT — the
// same approach `google-doc-field.test.ts` uses. ★ Each scanner asserts it FOUND
// something before judging it: a regex that matches nothing would otherwise pass
// by having nothing to check, which is exactly how a guard like this dies.
// -----------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

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

/**
 * Slice one function out of a module, up to the next top-level export.
 * Handles both exported and module-private declarations — `reconcileFormFields`
 * is deliberately not exported, so searching only for `export async function`
 * silently returns nothing and every assertion on it passes vacuously.
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
// every form read. `schema.ts` is the live path; the Turso DDL is the fallback.
// -----------------------------------------------------------------------------
describe("S1: source_item_id exists on both dialects", () => {
  it("SQL Server ALTERs it in idempotently", () => {
    const alter = /IF COL_LENGTH\('dbo\.form_fields', 'source_item_id'\) IS NULL[\s\S]{0,200}?ADD source_item_id NVARCHAR\(64\) NULL/.exec(
      SCHEMA
    );
    expect(alter, "no idempotent source_item_id migration in db/schema.ts").not.toBeNull();
  });

  it("Turso declares it in BOTH the final DDL and the addColumns ladder", () => {
    // `ddl` is the final schema for a fresh database; `addColumns` only runs for
    // databases that predate the column. Declaring one without the other leaves
    // either new or existing Turso deployments broken, and SQLite has no
    // `ALTER TABLE ADD COLUMN IF NOT EXISTS` to fall back on.
    const inDdl = /form_fields[\s\S]{0,600}?source_item_id TEXT/.exec(TURSO);
    expect(inDdl, "source_item_id missing from the Turso form_fields CREATE").not.toBeNull();

    const inAddColumns = /table:\s*"form_fields",\s*column:\s*"source_item_id"/.exec(TURSO);
    expect(inAddColumns, "source_item_id missing from addColumns").not.toBeNull();
  });

  it("is NOT listed in BOOLEAN_COLUMNS / TIMESTAMP_COLUMNS", () => {
    // It is an opaque Google string. Claiming it is a boolean would serve `1`
    // where every signature says `string` — and libsql.test.ts enforces that
    // pairing, so getting this wrong breaks two suites for one typo.
    const client = serverSource("db/client.ts");
    expect(/source_item_id/.test(client)).toBe(false);
  });

  it("is declared on the FormField interface as nullable", () => {
    const it1 = /source_item_id:\s*string \| null/.exec(SCHEMA);
    expect(it1, "FormField.source_item_id must be `string | null` — it starts unset").not.toBeNull();
  });
});

// -----------------------------------------------------------------------------
// S2 — `listFormFields` must SELECT the column.
//
// ★ The highest-value guard here. `planSubmissionFields` reads `source_item_id`
// off every field it is handed; if the SELECT omits it, each field looks unbound
// and the mapper proposes the SAME binding on EVERY submission forever. Nothing
// errors — the app just issues a pointless UPDATE per field per submission, and
// the guard that is supposed to make this a one-time write never engages.
// -----------------------------------------------------------------------------
describe("S2: listFormFields hands the column to the mapper", () => {
  it("includes source_item_id in the form_fields projection", () => {
    const select = /SELECT id, form_id[\s\S]{0,400}?FROM dbo\.form_fields WHERE form_id = @formId/.exec(
      QUERIES
    );
    expect(select, "the listFormFields SELECT was not found").not.toBeNull();
    expect(select![0]).toContain("source_item_id");
  });
});

// -----------------------------------------------------------------------------
// S3 — the binding UPDATE must never overwrite.
//
// The column is populated by a heuristic (label matching), so the one thing it
// must never do is move. If a designer retitled a form field to match a different
// Google question, an unguarded write would repoint the stored id at that
// question and turn a cosmetic edit into a permanent silent misroute.
// -----------------------------------------------------------------------------
describe("S3: bindFormFieldSourceItemIds cannot redirect an existing binding", () => {
  const body = bodyOf("bindFormFieldSourceItemIds");

  it("re-states `source_item_id IS NULL` in the UPDATE's WHERE clause", () => {
    // In the WHERE clause, not merely in TypeScript: that is what makes the write
    // safe against a concurrent submission binding the same field between the
    // form-wide read and the UPDATE.
    expect(body).toContain("source_item_id IS NULL");
    expect(body).toMatch(/where:[\s\S]{0,200}?source_item_id IS NULL/);
  });

  it("scopes every write to its own form", () => {
    expect(body).toContain("form_id = @formId");
  });

  it("skips an item id a sibling field already claims", () => {
    // Two fields holding one Google question would make a retitle ambiguous,
    // with no rule for which of them the answer belongs to.
    expect(body).toMatch(/claimed\.get\(itemId\)/);
  });

  it("detects whether the row actually changed, rather than assuming it did", () => {
    // `db.query()` returns a bare row array with no affected-row count on either
    // driver, so `execute()` alone cannot tell a no-op from a write — the same
    // reason archiveSubmission/resubmit use `updateReturning`.
    expect(body).toMatch(/updateReturning\(/);
  });

  it("does not touch updated_at (form_fields has no such column)", () => {
    // `submissions` has one, `form_fields` does not. Copying the pattern from a
    // neighbouring function produces a runtime error on every first binding.
    expect(body).not.toContain("updated_at");
  });
});

// -----------------------------------------------------------------------------
// S4 — the field writers must not touch the column.
//
// Both use explicit column lists, so they simply omit it — which is the correct
// behaviour and must stay that way. If either ever copied `source_item_id`
// through from a caller, an ordinary designer edit would clobber a learned
// binding, and promotion would bind a field to whatever the admin's browser
// happened to send.
// -----------------------------------------------------------------------------
describe("S4: the designer's writers leave the column alone", () => {
  for (const fn of ["reconcileFormFields", "promoteAdhocFieldToFormField"]) {
    it(`${fn} does not write source_item_id`, () => {
      const body = bodyOf(fn);
      expect(body.length, `${fn} body came back empty — the scanner broke`).toBeGreaterThan(200);
      expect(body).not.toContain("source_item_id");
    });
  }
});

// -----------------------------------------------------------------------------
// S5 — the Apps Script must still send Google's item id.
//
// Deleting it is invisible: the webhook keeps working exactly as before, answers
// still match by title, and the ONLY symptom is that a future retitle silently
// captures answers again. That is the original incident, and it cost 68 rows.
// -----------------------------------------------------------------------------
describe("S5: the Apps Script sends item_id with every answer", () => {
  const SCRIPTS = [
    "docs/scripts/form-2.md", // the deployed script
    "docs/plans/apps-script.md",
    "docs/plans/google-script.md",
    "docs/plans/webhook.md",
    "docs/plans/google-form-undefined-fields.md",
  ];

  for (const path of SCRIPTS) {
    it(`${path} sends item.getId() on every answer`, () => {
      const src = repoSource(path);
      // Control first: a path typo would otherwise pass by reading nothing.
      expect(src.length, `${path} read empty`).toBeGreaterThan(500);
      expect(src, `${path} never calls getId()`).toMatch(/\.getId\(\)/);

      const pushes = [...src.matchAll(/answers\.push\(([\s\S]{0,300}?)\);/g)].map((m) => m[1]);
      expect(pushes.length, `${path}: no answers.push() calls found`).toBeGreaterThan(0);
      for (const push of pushes) {
        expect(push, `${path}: an answers.push() omits item_id`).toContain("item_id");
      }
    });
  }
});

// -----------------------------------------------------------------------------
// S6 — the binding write must be best-effort.
//
// It runs AFTER the submission row is committed. If it could throw, a submission
// that genuinely succeeded would be reported to the Apps Script as a failure —
// which both lies in the webhook log and invites a retry that duplicates it. A
// lost binding is free by design: the next submission proposes it again.
// -----------------------------------------------------------------------------
describe("S6: createSubmission records bindings without risking the submission", () => {
  const body = bodyOf("createSubmission");

  it("calls the binder", () => {
    expect(body).toContain("bindFormFieldSourceItemIds(");
  });

  it("wraps it in try/catch and skips the call when there is nothing to write", () => {
    // The `length > 0` check is what keeps the steady state free: a bound form
    // takes no branch, no statement and no connection.
    expect(body).toMatch(/if \(plan\.learned\.length > 0\) \{[\s\S]{0,400}?try \{[\s\S]{0,400}?bindFormFieldSourceItemIds\(/);
  });
});
