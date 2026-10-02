// -----------------------------------------------------------------------------
// Google Document field type — registration gates.
//
// Adding a field type is not a one-file change. `FIELD_TYPES` in db/schema.ts is
// the source of truth, but the same list is written out by hand in SEVEN other
// places, and the URL template is written out twice. Nothing fails when one copy
// drifts: the type simply cannot be chosen, or the export emits a different URL
// from the one the grid links to.
//
// A comment saying "keep these in step" has never once worked in this repo, so
// each copy is diffed against its source here instead:
//
//   G1  FIELD_TYPES  <->  the designer's list          (client)
//   G2  FIELD_TYPES  <->  the Swagger enum literals    (5 sites)
//   G3  the URL template, client <-> server
//   G4  isAbsoluteHttpUrl allows https? only           (the XSS guard)
//   G5  the two `type` CHECK constraints accept the new value
//   G6  COLLECTION_FIELD_TYPES covers every collection-shaped type
//
// ★ Every scanner below asserts it FOUND something before comparing. A regex that
// matches nothing would otherwise "pass" by having nothing to check — the same
// trap as a reachability probe that only proves a path is routed.
// -----------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { FIELD_TYPES, COLLECTION_FIELD_TYPES } from "./schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, "..");
const CLIENT_SRC = join(HERE, "..", "..", "..", "client", "src");

function serverSource(relative: string): string {
  return readFileSync(join(SERVER_SRC, relative), "utf8");
}
function clientSource(relative: string): string {
  return readFileSync(join(CLIENT_SRC, relative), "utf8");
}

/** The new type this whole file guards. */
const NEW_TYPE = "google_doc";

// -----------------------------------------------------------------------------
// G1 — the designer's list must name the same set as FIELD_TYPES
// -----------------------------------------------------------------------------
describe("G1: the Form Designer offers exactly the server's field types", () => {
  const src = clientSource("pages/admin/AdminFormDesigner.tsx");

  // `{ value: "text", label: "Text" },` inside the FIELD_TYPES array.
  const found = [...src.matchAll(/\{\s*value:\s*"([a-z_]+)"\s*,\s*label:/g)].map((m) => m[1]);

  it("finds the designer's type list at all", () => {
    // The control. If the array is renamed or reformatted, this fails rather
    // than the comparison below silently passing on an empty list.
    expect(found.length).toBeGreaterThanOrEqual(FIELD_TYPES.length);
  });

  it("names every server type", () => {
    const missing = FIELD_TYPES.filter((t) => !found.includes(t));
    expect(missing, `missing from the designer: ${missing.join(", ")}`).toEqual([]);
  });

  it("names nothing the server does not know", () => {
    const extra = found.filter((t) => !(FIELD_TYPES as readonly string[]).includes(t));
    expect(extra, `unknown to the server: ${extra.join(", ")}`).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// G2 — every hand-written Swagger enum must name the same set
// -----------------------------------------------------------------------------
describe("G2: the Swagger FieldType enums match FIELD_TYPES", () => {
  const src = serverSource("swagger.ts");

  // The literal is written out five times by hand. Match each occurrence.
  const enums = [...src.matchAll(/enum:\s*\[((?:"[a-z_]+"\s*,?\s*)+)\]/g)]
    .map((m) => [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]))
    // Only the field-type enums — other enums (statuses, formats) are unrelated.
    .filter((list) => list.includes("textarea"));

  it("finds at least the five known field-type enums", () => {
    // ★ The control. A pattern that matched nothing would make the loop below a
    // no-op, and "no mismatches found" would be indistinguishable from "nothing
    // was examined". Measured: five sites (L127, L238, L329, L1887, L1923).
    expect(enums.length).toBeGreaterThanOrEqual(5);
  });

  it("names every server type in every site", () => {
    for (const list of enums) {
      const missing = FIELD_TYPES.filter((t) => !list.includes(t));
      expect(missing, `a Swagger enum is missing: ${missing.join(", ")}`).toEqual([]);
    }
  });
});

// -----------------------------------------------------------------------------
// G3 — the URL template is duplicated across the client/server boundary
// -----------------------------------------------------------------------------
describe("G3: the Google Doc URL template is identical on both sides", () => {
  const extract = (src: string, label: string): { prefix: string; suffix: string } => {
    const prefix = src.match(/GOOGLE_DOC_URL_PREFIX\s*=\s*"([^"]+)"/)?.[1];
    const suffix = src.match(/GOOGLE_DOC_URL_SUFFIX\s*=\s*"([^"]+)"/)?.[1];
    expect(prefix, `${label}: no GOOGLE_DOC_URL_PREFIX found`).toBeTruthy();
    expect(suffix, `${label}: no GOOGLE_DOC_URL_SUFFIX found`).toBeTruthy();
    return { prefix: prefix!, suffix: suffix! };
  };

  const client = extract(clientSource("lib/googleDoc.ts"), "client");
  const server = extract(serverSource("export/table.ts"), "server");

  it("uses the same prefix", () => {
    expect(client.prefix).toBe(server.prefix);
  });

  it("uses the same suffix", () => {
    expect(client.suffix).toBe(server.suffix);
  });

  it("builds the URL the feature was specified with", () => {
    // The literal from the request: https://drive.google.com/file/d/[id]/view
    // ★ `drive`, not `docs`: a Google Forms file upload stores a binary file in
    // Drive, not a Google Doc. Verified against the Drive API's own webViewLink
    // for an application/pdf (drive.google.com/file/d/…) versus a Google Doc
    // (docs.google.com/document/d/…).
    expect(`${client.prefix}DOCID${client.suffix}`).toBe(
      "https://drive.google.com/file/d/DOCID/view"
    );
  });
});

// -----------------------------------------------------------------------------
// G4 — the link renderer must not accept a dangerous scheme
// -----------------------------------------------------------------------------
describe("G4: only http(s) URLs are treated as links", () => {
  // Re-implemented here rather than imported: the client lib is outside the
  // server's tsconfig project, so importing it would not type-check. The regex
  // is asserted to be the SAME TEXT as the client's, which is the real gate.
  const clientSrc = clientSource("lib/googleDoc.ts");
  // The client writes `return /^https?:\/\//i.test(v);` — capture the literal
  // between `return` and `.test`, which is the whole allowlist.
  const pattern = clientSrc.match(/return\s+(\/\^https\?:\\\/\\\/\/i)\.test/)?.[1];

  it("finds the allowlist pattern in the client source", () => {
    expect(pattern, "isAbsoluteHttpUrl's pattern was not found").toBeTruthy();
  });

  it("the client's pattern is the same text as this gate's", () => {
    expect(pattern).toBe("/^https?:\\/\\//i");
  });

  it("matches http and https only", () => {
    const re = /^https?:\/\//i;
    expect(re.test("https://docs.google.com/document/d/x/view")).toBe(true);
    expect(re.test("http://example.com")).toBe(true);
  });

  it("rejects javascript:, data: and protocol-relative values", () => {
    const re = /^https?:\/\//i;
    expect(re.test("javascript:alert(1)")).toBe(false);
    expect(re.test("data:text/html,<script>")).toBe(false);
    expect(re.test("//evil.example.com")).toBe(false);
    // ★ The negative control: a value that merely CONTAINS a colon must not be
    // linked, which is what rules out a "contains a colon" implementation.
    expect(re.test("mailto:x@y.com")).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// G5 — both `type` CHECK constraints accept the new value
// -----------------------------------------------------------------------------
describe("G5: the type CHECK constraints accept the new field type", () => {
  const src = serverSource("db/schema.ts");

  // Every `CHECK (type IN (…))` in the DDL, whether inline in a CREATE TABLE or
  // in a widening batch.
  const checks = [...src.matchAll(/CHECK\s*\(\s*type\s+IN\s*\(([^)]*)\)\s*\)/gi)].map((m) =>
    [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
  );

  it("finds every type CHECK in the DDL", () => {
    // ★ The control. Measured: two CREATE TABLE declarations plus two widening
    // batches = four occurrences of the literal. If the DDL is reformatted this
    // fails rather than the assertions below passing vacuously.
    expect(checks.length).toBeGreaterThanOrEqual(4);
  });

  it("every type CHECK accepts the new value", () => {
    for (const list of checks) {
      expect(list, "a type CHECK rejects google_doc").toContain(NEW_TYPE);
    }
  });

  it("the widening batches guard on the new value, so they are idempotent", () => {
    // The drop-and-recreate must look for a constraint that does NOT yet mention
    // google_doc, or it would drop the replacement on every boot.
    const guards = [...src.matchAll(/definition NOT LIKE '%google_doc%'/g)];
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });
});

// -----------------------------------------------------------------------------
// G6 — the collection rule covers every collection-shaped type
// -----------------------------------------------------------------------------
describe("G6: COLLECTION_FIELD_TYPES covers the collection-shaped types", () => {
  it("includes the new type", () => {
    // A google_doc answer is stored as a JSON array by the write path, so it MUST
    // be decoded on read or the raw '["id"]' text is served with its brackets.
    expect(COLLECTION_FIELD_TYPES.has(NEW_TYPE)).toBe(true);
  });

  it("still includes checkbox and the historical multiselect spelling", () => {
    expect(COLLECTION_FIELD_TYPES.has("checkbox")).toBe(true);
    expect(COLLECTION_FIELD_TYPES.has("multiselect")).toBe(true);
  });

  it("names only types that exist (plus the historical spelling)", () => {
    for (const t of COLLECTION_FIELD_TYPES) {
      if (t === "multiselect") continue; // historical, not in FIELD_TYPES
      expect(FIELD_TYPES as readonly string[], `${t} is not a known field type`).toContain(t);
    }
  });

  it("parseSubmissionValue reads the shared set rather than an inline literal", () => {
    // ★ The defect this guards: the rule used to be an inline
    // `fieldType === "checkbox" || fieldType === "multiselect"`, so a new
    // collection type was silently not decoded. Assert the shared set is used.
    const src = serverSource("db/queries.ts");
    const body = src.slice(src.indexOf("function parseSubmissionValue"));
    const end = body.indexOf("\n}");
    const fn = body.slice(0, end);
    expect(fn).toContain("COLLECTION_FIELD_TYPES.has(");
    expect(fn, "an inline checkbox/multiselect literal is back").not.toContain(
      'fieldType === "checkbox"'
    );
  });
});
