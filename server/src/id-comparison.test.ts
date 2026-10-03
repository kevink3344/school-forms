import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// -----------------------------------------------------------------------------
// "Convert at the COMPARISON" — the boundary rule `routes/users.ts` states and
// `routes/systemMessages.ts` already follows ("idOf()").
//
// A numeric column comes back from the database as TEXT. That is not a theory:
// `routes/users.ts` records the measurement (`SELECT TOP 1 id, email FROM
// dbo.users` → `{"id":"1",…}`, `typeof row.id === "string"`), and it is why every
// other id comparison in the server carries a `Number(...)`.
//
// The ad-hoc routes did not. `fieldId` is parsed out of the URL, so comparing it
// with a raw row id is `"5" === 5` — false — and the lookup missed a row the page
// had just rendered from the same table:
//
//     404 Ad-hoc field not found on this submission
//
// The reason this survived review is worth stating: it depends on the DRIVER. One
// deployment hands back numbers and works; another hands back text and 404s, with
// the same commit on both. So a fix that is verified by hand in one environment
// is not verified at all — only the coercion is environment-independent.
//
// A SOURCE guard rather than a behavioural one: these are handler closures inside
// a router with no seam to call, and the defect is the SHAPE of one expression.
// -----------------------------------------------------------------------------

const ROUTES = readFileSync(join(HERE, "routes", "submissions.ts"), "utf8");
const GOOGLE_DOCS = readFileSync(join(HERE, "google", "docs.ts"), "utf8");
const QUERIES = readFileSync(join(HERE, "db", "queries.ts"), "utf8");

describe("ad-hoc route id comparisons (routes/submissions.ts)", () => {
  it("never compares a raw row id with a url-parsed one using ===", () => {
    // If this fails, a route will 404 on whichever deployment returns text ids.
    const offenders = ROUTES.match(/\.find\(\(f\) => f\.id ===/g) ?? [];
    expect(offenders, "use `Number(f.id) === fieldId`").toEqual([]);
  });

  it("does convert at every ad-hoc comparison", () => {
    const coerced = ROUTES.match(/\.find\(\(f\) => Number\(f\.id\) === fieldId\)/g) ?? [];
    expect(coerced.length).toBe(3);
  });
});

// The same rule in a path with no error to show for it. The document-generation
// hook compares a submitted `field_id` (a real number, courtesy of `z.coerce`)
// with a form field's id read from the database (TEXT on one driver). Uncoerced,
// the "Generate document" checkbox read as UNTICKED and nothing was generated —
// and the hook returns `void` inside a try/catch, so there was nothing to see.
// This is why the rule is a guard and not a convention.
describe("google/docs.ts id comparison", () => {
  it("converts BOTH sides before comparing", () => {
    expect(GOOGLE_DOCS).toContain("Number(a.field_id) === Number(gen.id)");
  });

  it("has no uncoerced field_id comparison left", () => {
    expect(/a\.field_id === gen\.id/.test(GOOGLE_DOCS)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// The same rule inside a SET — the one place the trap is silent to TypeScript.
// `Set<string>.has(5)` is a compile error, but a `Set<number>` built from rows
// that are really strings type-checks perfectly and matches nothing.
//
// `reconcileFormFields` is where that would hurt most. It decides UPDATE-vs-INSERT
// for every field of a form, and its delete loop then removes "the fields that
// went away". Uncoerced, EVERY field takes the INSERT branch and every existing
// field is treated as removed: the form is renumbered — which breaks the
// persisted `field_N` keys that user view columns, reports and exports are keyed
// by — or, where the FK guard blocks the delete, every column is duplicated.
//
// A source guard, because reaching this needs a live database and the defect is
// the shape of one expression. It was UNREACHABLE while `fieldSchema.id` was
// strict (the request 400'd first), which is exactly why it had to be fixed in
// the same commit as the schema: repairing the validation alone would have traded
// a loud 400 for silent duplication.
// -----------------------------------------------------------------------------
describe("db/queries.ts field reconciliation id set", () => {
  it("builds the existing-id set from NUMBERS", () => {
    expect(QUERIES).toContain("new Set(existingRows.map((r) => Number(r.id)))");
    expect(/new Set\(existingRows\.map\(\(r\) => r\.id\)\)/.test(QUERIES)).toBe(false);
  });

  it("compares the incoming field id after coercing it", () => {
    expect(QUERIES).toContain("const fieldId = Number(f.id);");
    expect(QUERIES).toContain("existingIds.has(fieldId)");
    // Negative control. This comment deliberately does NOT quote the forbidden
    // expression: the assertions above and below grep the raw source, so writing
    // it here would fail the very test that documents it. (Learned by doing it.)
    expect(/existingIds\.has\(f\.id\)/.test(QUERIES)).toBe(false);
  });
});
