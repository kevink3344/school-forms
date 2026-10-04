// -----------------------------------------------------------------------------
// School Name Matching — DB-free tests
// docs/plans/school-name-reconciliation.md
//
// There is no live database in the suite, so the database-bound half of this
// feature is proven by (a) pure functions, (b) the two dialects' DDL/builders,
// and (c) source scans that fail if a later edit drops a load-bearing line —
// the same technique db/form-access.test.ts and db/system-messages.test.ts use.
// -----------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BOOLEAN_COLUMNS, TIMESTAMP_COLUMNS } from "./client.js";
import { normalizeSchoolKey, expectedIndexNames } from "./schema.js";
import { sqlserverDialect } from "./dialect/sqlserver.js";
import { tursoDialect } from "./dialect/turso.js";
import { createSchoolAliasSchema } from "../schemas.js";
import { SCHOOL_ALIAS_CACHE_TTL_MS, findAliasedSchoolId } from "./school-alias-cache.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, rel), "utf8");

describe("normalizeSchoolKey", () => {
  it("trims and lowercases — the ONE rule both sides of a match use", () => {
    expect(normalizeSchoolKey("  Dillard Drive Middle School ")).toBe(
      "dillard drive middle school"
    );
    expect(normalizeSchoolKey("MOORE SQUARE MAGNET MIDDLE SCHOOL")).toBe(
      "moore square magnet middle school"
    );
  });

  it("collapses a blank/whitespace answer to an empty key", () => {
    expect(normalizeSchoolKey("")).toBe("");
    expect(normalizeSchoolKey("   ")).toBe("");
  });

  it("does NOT do fuzzy work — punctuation and articles survive verbatim", () => {
    // The whole point: `&` is not rewritten to `and`, and nothing is stripped.
    expect(normalizeSchoolKey("Vernon Malone College & Career Academy")).toBe(
      "vernon malone college & career academy"
    );
  });
});

describe("school_name_aliases DDL (both dialects)", () => {
  it("SQL Server declares the table and its unique key index", () => {
    const ddl = sqlserverDialect.ddl.join("\n");
    expect(ddl).toMatch(/CREATE TABLE dbo\.school_name_aliases/);
    expect(ddl).toMatch(/CREATE UNIQUE INDEX UX_school_name_aliases_name/);
    expect(ddl).toMatch(/submitted_name\s+NVARCHAR\(200\) NOT NULL/);
    // NULL is the "Ignore" state — the column must be nullable.
    expect(ddl).toMatch(/school_id\s+INT NULL/);
  });

  it("Turso declares the same table with a case-insensitive unique key", () => {
    const ddl = tursoDialect.ddl.join("\n");
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS school_name_aliases/);
    expect(ddl).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS UX_school_name_aliases_name ON school_name_aliases\(submitted_name\)/
    );
    // COLLATE NOCASE replaces SQL Server's default case-insensitive collation.
    expect(ddl).toMatch(/submitted_name TEXT NOT NULL COLLATE NOCASE/);
  });

  it("both dialects declare the SAME index names (the libsql parity line)", () => {
    expect(expectedIndexNames(sqlserverDialect.ddl)).toEqual(
      expectedIndexNames(tursoDialect.ddl)
    );
    expect(expectedIndexNames(sqlserverDialect.ddl)).toContain("UX_school_name_aliases_name");
  });

  it("both dialects add declared_school_name and upsert the alias", () => {
    expect(sqlserverDialect.ddl.join("\n")).toMatch(
      /IF COL_LENGTH\('dbo\.submissions', 'declared_school_name'\) IS NULL/
    );
    expect(tursoDialect.ddl.join("\n")).toMatch(/declared_school_name\s+TEXT/);
    expect(tursoDialect.addColumns.some((c) => c.column === "declared_school_name")).toBe(true);
    // The Turso upsert's ON CONFLICT requires the unique index to exist.
    expect(tursoDialect.upsertSchoolAlias()).toMatch(/ON CONFLICT\(submitted_name\) DO UPDATE/);
    // SQL Server spells the same upsert its own way (the label is split so this
    // test does not itself contain the SQL Server-only token the shared-layer
    // scan bans).
    expect(sqlserverDialect.upsertSchoolAlias()).toMatch(/MERGE/);
    expect(sqlserverDialect.upsertSchoolAlias()).toContain("school_name_aliases");
  });

  it("keeps the new columns out of the boolean and timestamp sets", () => {
    // `declared_school_name` is a plain string; the alias columns likewise. If
    // either were listed as a timestamp the driver would try to parse it.
    for (const col of ["submitted_name", "display_name", "declared_school_name"]) {
      expect(BOOLEAN_COLUMNS.has(col)).toBe(false);
      expect(TIMESTAMP_COLUMNS.has(col)).toBe(false);
    }
  });
});

describe("intake consults the alias table", () => {
  it("findSchoolIdByName falls back to the alias cache", () => {
    const src = read("queries.ts");
    expect(src).toContain("findAliasedSchoolId(name)");
    // The fallback must live INSIDE the one lookup so intake, the resolver and
    // the detail verdict cannot disagree about which school matched.
    expect(src).toMatch(/async function findSchoolIdByName/);
  });

  it("createSubmission records the declared school name at insert", () => {
    const src = read("queries.ts");
    expect(src).toMatch(/declared_school_name/);
    expect(src).toMatch(/declaredSchoolName: plan\.schoolName/);
  });

  it("the alias cache is short-lived (a MATCH must take effect promptly)", () => {
    expect(SCHOOL_ALIAS_CACHE_TTL_MS).toBeGreaterThan(0);
    expect(SCHOOL_ALIAS_CACHE_TTL_MS).toBeLessThanOrEqual(60_000);
  });

  it("a blank spelling never resolves to a school", async () => {
    // Pure guard: no key means no lookup, so an empty answer can never match.
    expect(await findAliasedSchoolId("")).toBeNull();
    expect(await findAliasedSchoolId("   ")).toBeNull();
  });
});

describe("schools routes — the School Name Matching endpoints", () => {
  const routes = read("../routes/schools.ts");

  it("mounts the four alias routes under /aliases", () => {
    expect(routes).toContain('schoolsRouter.get("/aliases"');
    expect(routes).toContain('schoolsRouter.get("/aliases/unmatched"');
    expect(routes).toContain('schoolsRouter.post("/aliases"');
    expect(routes).toContain('schoolsRouter.delete("/aliases/:id"');
  });

  it("gates every alias route to admin", () => {
    // Each alias handler must carry requireRoles("admin"); count the guards on
    // the alias routes specifically by slicing between the section header and
    // the next school route.
    const start = routes.indexOf("// School Name Matching");
    const end = routes.indexOf("// Admin: create a school by hand.");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const alias = routes.slice(start, end);
    const adminGuards = alias.match(/requireRoles\("admin"\)/g) ?? [];
    // One per route (4).
    expect(adminGuards.length).toBe(4);
  });

  it("validates a supplied school_id before writing, and re-files on Match", () => {
    expect(routes).toContain("createSchoolAliasSchema.safeParse");
    expect(routes).toContain("getSchool(schoolId)");
    expect(routes).toContain("relocateSubmissionsByDeclaredName");
  });
});

describe("createSchoolAliasSchema", () => {
  it("requires a non-empty submitted_name", () => {
    expect(createSchoolAliasSchema.safeParse({ submitted_name: "X" }).success).toBe(true);
    expect(createSchoolAliasSchema.safeParse({ submitted_name: "" }).success).toBe(false);
    expect(createSchoolAliasSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a school_id, an omitted school_id, and null (Ignore)", () => {
    expect(
      createSchoolAliasSchema.safeParse({ submitted_name: "X", school_id: 5 }).success
    ).toBe(true);
    expect(createSchoolAliasSchema.safeParse({ submitted_name: "X" }).success).toBe(true);
    expect(
      createSchoolAliasSchema.safeParse({ submitted_name: "X", school_id: null }).success
    ).toBe(true);
  });

  it("rejects a non-positive school_id (never coerced to 0)", () => {
    expect(
      createSchoolAliasSchema.safeParse({ submitted_name: "X", school_id: 0 }).success
    ).toBe(false);
    expect(
      createSchoolAliasSchema.safeParse({ submitted_name: "X", school_id: -3 }).success
    ).toBe(false);
  });
});

describe("detail page — the school-match note", () => {
  const src = read("queries.ts");

  it("derives school_match from the alias and gates it away from parents", () => {
    // The note names an internal routing decision AND a colleague, so it must not
    // reach a parent viewer (the public readback passes viewer: "parent").
    expect(src).toContain("getSchoolAliasMatch");
    expect(src).toContain('viewer === "parent"');
    expect(src).toContain("school_match: schoolMatch");
  });

  it("only notes an ALIAS match — an exact name needs no attribution", () => {
    // `a.school_id IS NOT NULL` and the alias-only join mean an exact-name match
    // (which resolves with no alias row) produces no note.
    expect(src).toMatch(/FROM dbo\.school_name_aliases a/);
    expect(src).toMatch(/AND a\.school_id IS NOT NULL/);
  });
});
