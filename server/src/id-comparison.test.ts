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
