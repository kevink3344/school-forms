import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toLibsql, TURSO_NOW } from "./libsql.js";
import { TIMESTAMP_COLUMNS, normalizeRow, parseTimestamp } from "../client.js";
import { tursoDialect } from "../dialect/turso.js";
import { sqlserverDialect } from "../dialect/sqlserver.js";

// -----------------------------------------------------------------------------
// toLibsql() is the only place SQL Server-flavoured shared SQL is allowed to be
// re-shaped, and it is a token rewrite — not a parser. These tests pin the three
// rewrites and, more importantly, prove the rewrite can never fire inside a
// single-quoted SQL literal (which would silently corrupt a string value).
//
// A second group scans the shared data layer for constructs the rewrite CANNOT
// fix (a structural `SELECT TOP n`, `OUTPUT INSERTED`, `MERGE`, `OFFSET …
// FETCH`). Those shipped once and broke 8 endpoints only under Turso — the
// statements parsed fine on SQL Server — so they are now pinned by a test.
// -----------------------------------------------------------------------------

describe("toLibsql — token rewrites", () => {
  it("strips the dbo. schema qualifier", () => {
    expect(toLibsql("SELECT id FROM dbo.schools")).toBe("SELECT id FROM schools");
    expect(toLibsql("INSERT INTO dbo.schools (name) VALUES (@name)")).toBe(
      "INSERT INTO schools (name) VALUES (@name)"
    );
  });

  it("rewrites SYSUTCDATETIME() to a UTC ISO-8601 strftime expression", () => {
    expect(toLibsql("updated_at = SYSUTCDATETIME()")).toBe(`updated_at = ${TURSO_NOW}`);
    expect(toLibsql("updated_at = sysutcdatetime ( )")).toBe(`updated_at = ${TURSO_NOW}`);
  });

  it("keeps the strftime expression fixed-width and lexicographically sortable", () => {
    // YYYY-MM-DDTHH:MM:SS.mmmZ — same shape as Date#toISOString().
    expect(TURSO_NOW).toBe("strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  });

  it("strips the SQL Server N'...' unicode literal prefix", () => {
    expect(toLibsql("VALUES (N'Sample School', N'Sample District')")).toBe(
      "VALUES ('Sample School', 'Sample District')"
    );
  });

  it("does NOT strip an N that is part of a longer identifier", () => {
    // The lookbehind is what makes this safe: `..._RUN'` is not a unicode
    // literal prefix and must survive untouched.
    expect(toLibsql("SELECT 'x' AS RN'")).toBe("SELECT 'x' AS RN'");
    expect(toLibsql("WHERE col = 'A'")).toBe("WHERE col = 'A'");
  });

  it("rewrites the NVARCHAR(MAX) cast length, which libSQL cannot parse", () => {
    // Verified live: `CAST('a' AS NVARCHAR(MAX))` raises
    // SQL_PARSE_ERROR near ID "MAX", while NVARCHAR and NVARCHAR(4) both parse.
    expect(toLibsql("AND CAST(svq.value AS NVARCHAR(MAX)) LIKE @q")).toBe(
      "AND CAST(svq.value AS NVARCHAR) LIKE @q"
    );
    expect(toLibsql("CAST(x AS nvarchar ( max ))")).toBe("CAST(x AS NVARCHAR)");
  });

  it("leaves a sized NVARCHAR alone, because libSQL accepts it", () => {
    expect(toLibsql("CAST(school_year AS NVARCHAR(4))")).toBe(
      "CAST(school_year AS NVARCHAR(4))"
    );
  });

  it("is idempotent", () => {
    const sql =
      "UPDATE dbo.forms SET updated_at = SYSUTCDATETIME(), title = N'CDM' WHERE id = @id";
    const once = toLibsql(sql);
    expect(toLibsql(once)).toBe(once);
  });

  it("leaves already-portable SQL untouched", () => {
    const sql = "SELECT id, name FROM schools WHERE name = @name ORDER BY name";
    expect(toLibsql(sql)).toBe(sql);
  });
});

// -----------------------------------------------------------------------------
// Literal-safety scan.
//
// `replaceAll("dbo.", "")` and the SYSUTCDATETIME regex have no notion of
// quoting: if a *string value* in any statement contained the text `dbo.` it
// would be mangled. Nothing in the codebase does — this test keeps it that way.
// -----------------------------------------------------------------------------

const SRC_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Files exempt from the literal-safety scan, and why.
 *
 * `db/driver/libsql.ts`  — defines the rewrite tokens themselves.
 * `db/schema.ts`         — the SQL Server DDL ladder. Its idempotency guards are
 *                          written as `OBJECT_ID(N'dbo.schools', N'U')`, so it
 *                          *does* hold `dbo.` inside literals. It is never sent
 *                          through `toLibsql`: the libSQL driver's schema comes
 *                          from `db/dialect/turso.ts`.
 * `db/dialect/sqlserver.ts` — the SQL Server-only statement builders, likewise
 *                          executed only through the mssql driver.
 */
const EXEMPT = new Set([
  "db/driver/libsql.ts",
  "db/driver/libsql.test.ts",
  "db/schema.ts",
  "db/dialect/sqlserver.ts",
]);

/** The DDL that *is* translated, because it boots the libSQL database. */
const TRANSLATED_DDL = tursoDialect.ddl;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Return the contents of every single-quoted SQL literal in a TypeScript source
 * file.
 *
 * A small state machine rather than a regex: it skips `//` and block comments
 * and skips double-quoted TypeScript strings (prose holds apostrophes), but
 * collects `'…'` from code and from inside template literals — which is where
 * every shared SQL statement lives. `''` is treated as a SQL-escaped quote.
 */
function singleQuotedLiterals(source: string): string[] {
  const literals: string[] = [];
  let i = 0;

  const skipEscaped = (from: number, quote: string): number => {
    let j = from + 1;
    while (j < source.length && source[j] !== quote) {
      j += source[j] === "\\" ? 2 : 1;
    }
    return j + 1;
  };

  while (i < source.length) {
    const c = source[i];

    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (c === '"') {
      i = skipEscaped(i, c);
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let value = "";
      while (j < source.length) {
        if (source[j] === "'" && source[j + 1] === "'") {
          value += "''"; // SQL-escaped quote
          j += 2;
          continue;
        }
        if (source[j] === "'") break;
        if (source[j] === "\\") {
          value += source[j] + (source[j + 1] ?? "");
          j += 2;
          continue;
        }
        value += source[j];
        j += 1;
      }
      literals.push(value);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return literals;
}

describe("singleQuotedLiterals scanner", () => {
  it("collects SQL literals and skips prose apostrophes", () => {
    const src = [
      'const note = "the school\'s name";',
      "const sql = `SELECT 'a' AS x, N'b' AS y FROM dbo.t -- 'c'`;",
      "// 'dbo.notreal'",
      "/* 'SYSUTCDATETIME()' */",
      "const other = 'plain';",
    ].join("\n");
    const found = singleQuotedLiterals(src);
    expect(found).toContain("a");
    expect(found).toContain("b");
    expect(found).toContain("plain");
    expect(found).not.toContain("dbo.notreal");
    expect(found).not.toContain("SYSUTCDATETIME()");
  });
});

/**
 * Blank out `//` and block comments (and double-quoted prose) while keeping
 * single-quoted strings and template literals — i.e. keep exactly where SQL
 * lives. Used to scan for SQL keywords without tripping over the prose that
 * explains them. Block comments are replaced by spaces rather than removed so
 * line numbers stay comparable to the original file.
 */
function stripCommentsAndProse(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') {
        j += source[j] === "\\" ? 2 : 1;
      }
      out += " ".repeat(j + 1 - i);
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

describe("stripCommentsAndProse scanner", () => {
  it("drops comments but keeps SQL in template literals", () => {
    const src = [
      "// SELECT TOP 1 a",
      "/* SELECT TOP 1 b */",
      "const s = `SELECT TOP 1 c FROM dbo.t`;",
      'const prose = "SELECT TOP 1 d";',
    ].join("\n");
    const code = stripCommentsAndProse(src);
    expect(code).toContain("SELECT TOP 1 c");
    expect(code).not.toContain("SELECT TOP 1 a");
    expect(code).not.toContain("SELECT TOP 1 b");
    expect(code).not.toContain("SELECT TOP 1 d");
  });
});

describe("shared SQL is safe to token-rewrite", () => {
  const files = walk(SRC_ROOT).filter((f) => {
    const rel = f.slice(SRC_ROOT.length).replaceAll("\\", "/");
    return !EXEMPT.has(rel);
  });

  it("found the source tree", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("never puts `dbo.` inside a single-quoted literal", () => {
    for (const file of files) {
      const hits = singleQuotedLiterals(readFileSync(file, "utf8")).filter((l) =>
        l.includes("dbo.")
      );
      expect(hits, `${file} has a literal containing "dbo."`).toEqual([]);
    }
  });

  it("never puts `SYSUTCDATETIME` inside a single-quoted literal", () => {
    for (const file of files) {
      const hits = singleQuotedLiterals(readFileSync(file, "utf8")).filter((l) =>
        /SYSUTCDATETIME/i.test(l)
      );
      expect(hits, `${file} has a literal containing "SYSUTCDATETIME"`).toEqual([]);
    }
  });

  it("never leaves an unresolved N' prefix or dbo. in a translated statement", () => {
    // Sample the statements the app actually emits and prove the rewrite
    // completes: no leftover tokens survive translation.
    const samples = [
      TRANSLATED_DDL.join("\n"),
      sqlserverDialect.insertReturning({
        table: "forms",
        columns: ["title", "status"],
        returning: ["id", "title"],
        values: "@title, N'published'",
      }),
      sqlserverDialect.updateReturning({
        table: "forms",
        set: "updated_at = SYSUTCDATETIME()",
        where: "id = @id",
        returning: ["id"],
      }),
      sqlserverDialect.deleteReturning({
        table: "report_views",
        where: "id = @id",
        returning: ["id"],
      }),
      sqlserverDialect.selectSchoolsPage({ where: "", orderBy: "name" }),
      sqlserverDialect.upsertSetting(),
      sqlserverDialect.upsertSchoolFromSource(),
      sqlserverDialect.upsertUserFormViewColumns(),
    ];
    for (const sql of samples) {
      const translated = toLibsql(sql);
      expect(translated).not.toMatch(/\bdbo\./);
      expect(translated).not.toMatch(/SYSUTCDATETIME/i);
      expect(translated).not.toMatch(/(?<![A-Za-z0-9_$])N'/);
      // Every literal must still be balanced after the rewrite.
      const quotes = (translated.match(/'/g) ?? []).length;
      expect(quotes % 2, "unbalanced single quotes").toBe(0);
    }
  });

  it("the live libSQL DDL is already dialect-clean", () => {
    const translated = toLibsql(TRANSLATED_DDL.join("\n"));
    expect(translated).not.toContain("dbo.");
    expect(translated).not.toContain("SYSUTCDATETIME");
    expect(translated).not.toContain("OUTPUT INSERTED");
    // Nothing to rewrite means translation is a no-op for the Turso schema.
    expect(translated).toBe(TRANSLATED_DDL.join("\n"));
  });

  it("keeps the schema.ts exemption honest", () => {
    // db/schema.ts is exempt above because it is the SQL Server-only DDL ladder.
    // If these guards ever disappear, the exemption can be dropped.
    const literals = singleQuotedLiterals(
      readFileSync(join(SRC_ROOT, "db", "schema.ts"), "utf8")
    );
    expect(literals.some((l) => l.startsWith("dbo."))).toBe(true);
    expect(literals.some((l) => l === "U")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Structural constructs the token rewriter CANNOT fix.
  //
  // `SELECT TOP 1 sv.value …` parses as `SELECT TOP` (an unknown type name)
  // followed by the literal `1`, so libSQL rejects the whole statement with
  // `SQL_PARSE_ERROR near INTEGER`. Eight of these shipped in queries.ts /
  // documents.ts and 500'd `/api/submissions`, `/api/documents`,
  // `/api/export/preview` and `/api/reports/preview` — ONLY under DB_MODE=turso,
  // because every statement parsed fine on SQL Server.
  //
  // The four constructs below move a whole clause (`TOP n` from the select list
  // to the tail, `OUTPUT` to `RETURNING`, `MERGE` to `ON CONFLICT`, `OFFSET …
  // FETCH` to `LIMIT … OFFSET`), so no token rewrite can express them. They
  // belong to db/dialect/.
  //
  // `IF EXISTS (…) UPDATE … ELSE INSERT …` is the same story for *control flow*:
  // libSQL has no `IF` statement at all, so it rejects the batch with
  // `SQL_PARSE_ERROR: near IF` at (1,3). It shipped in updateSubmissionValues and
  // 500'd every staff-only save on Turso — again only under DB_MODE=turso. There
  // is no portable single-statement upsert (no UNIQUE index on
  // submission_values(submission_id, field_id) on either dialect, so `ON CONFLICT`
  // is unavailable), so that path uses `INSERT … SELECT … WHERE NOT EXISTS`
  // instead, which both dialects parse identically.
  //
  // Deliberately NOT listed: `dbo.`, `SYSUTCDATETIME()`, `N'…'` and
  // `NVARCHAR(MAX)` — those ARE straight token substitutions and the driver
  // rewriter owns them, so they are expected to appear in shared SQL. The
  // translation tests above prove they never survive.
  //
  // `IF NOT EXISTS` must not be caught by the last pattern: it is legal SQLite
  // DDL (`CREATE TABLE IF NOT EXISTS …`) and is used throughout
  // db/dialect/turso.ts, which this scan includes. `IF\s+EXISTS` cannot match it
  // because of the intervening `NOT`.
  // ---------------------------------------------------------------------------
  const TSQL_ONLY: [string, RegExp][] = [
    ["SELECT TOP n", /\bTOP\s*(?:\(\s*@?\w+\s*\)|\d+)/i],
    ["OUTPUT INSERTED/DELETED", /\bOUTPUT\s+(?:INSERTED|DELETED)\b/i],
    ["MERGE", /\bMERGE\s+(?:dbo\.)?\w+/i],
    ["OFFSET n ROWS FETCH NEXT", /\bOFFSET\s+@?\w+\s+ROWS\b/i],
    ["IF EXISTS (…) conditional batch", /\bIF\s+EXISTS\s*\(/i],
  ];

  it("keeps SQL Server-only constructs out of the shared data layer", () => {
    for (const file of files) {
      const code = stripCommentsAndProse(readFileSync(file, "utf8"));
      for (const [label, pattern] of TSQL_ONLY) {
        const m = pattern.exec(code);
        expect(
          m,
          `${file} uses ${label}${m ? ` ("${m[0]}")` : ""} — libSQL cannot parse it; ` +
            `build it in db/dialect/ instead`
        ).toBeNull();
      }
    }
  });
});

// -----------------------------------------------------------------------------
// Schema parity — the two dialects must describe the same set of tables, or a
// DB_MODE flip silently loses a table at runtime.
// -----------------------------------------------------------------------------
describe("dialect schema parity", () => {
  function tablesFrom(sql: string[]): string[] {
    const names = new Set<string>();
    const text = sql.join("\n");
    for (const m of text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?dbo\.(\w+)/gi)) {
      names.add(m[1].toLowerCase());
    }
    for (const m of text.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/gi)) {
      names.add(m[1].toLowerCase());
    }
    return [...names].sort();
  }

  it("both dialects create the same tables", () => {
    expect(tablesFrom(tursoDialect.ddl)).toEqual(tablesFrom(sqlserverDialect.ddl));
  });

  it("sqlserver dialect is wired to the live DDL ladder", () => {
    expect(sqlserverDialect.kind).toBe("sqlserver");
    expect(tursoDialect.kind).toBe("turso");
    expect(sqlserverDialect.ddl.length).toBeGreaterThan(20);
  });
});

// -----------------------------------------------------------------------------
// submissionValueSubquery — the shape behind the 8 broken endpoints.
// -----------------------------------------------------------------------------
describe("dialect submissionValueSubquery", () => {
  /** Reduce both variants to what they have in common, for a drift check. */
  const canonical = (sql: string) =>
    sql
      .replace(/\s+/g, " ")
      .replaceAll("dbo.", "")
      .replace("TOP 1 ", "")
      .replace(" LIMIT 1", "")
      .trim();

  it("limits at the head on SQL Server and at the tail on Turso", () => {
    const sg = sqlserverDialect.submissionValueSubquery();
    const lite = tursoDialect.submissionValueSubquery();
    expect(sg).toMatch(/SELECT TOP 1 sv\.value/);
    expect(sg).not.toMatch(/\bLIMIT\b/);
    expect(lite).toMatch(/LIMIT 1\)/);
    expect(lite).not.toMatch(/\bTOP\b/);
  });

  it("cannot be fixed by the token rewriter — hence a dialect method", () => {
    expect(toLibsql(sqlserverDialect.submissionValueSubquery())).toMatch(/\bTOP\b/);
    expect(toLibsql(tursoDialect.submissionValueSubquery())).not.toMatch(/\bTOP\b/);
  });

  it("keeps a no-op translation for the Turso variant", () => {
    const lite = tursoDialect.submissionValueSubquery();
    expect(toLibsql(lite)).toBe(lite);
  });

  it("shares one predicate so the two variants cannot drift", () => {
    for (const label of [undefined, "student name", "did student meet criteria?"]) {
      expect(canonical(tursoDialect.submissionValueSubquery(label))).toBe(
        canonical(sqlserverDialect.submissionValueSubquery(label))
      );
    }
  });

  it("compares labels case-insensitively and escapes quotes", () => {
    expect(sqlserverDialect.submissionValueSubquery("Student Name")).toMatch(
      /LOWER\(ff\.label\) = 'student name'/
    );
    expect(tursoDialect.submissionValueSubquery("O'Brien")).toMatch(
      /LOWER\(ff\.label\) = 'o''brien'/
    );
  });

  it("defaults to the non-staff-only field when no label is given", () => {
    expect(sqlserverDialect.submissionValueSubquery()).toMatch(/ff\.staff_only = 0/);
    expect(tursoDialect.submissionValueSubquery()).toMatch(/ff\.staff_only = 0/);
  });

  it("returns the subquery without an alias, so no identifier is interpolated", () => {
    for (const label of [undefined, "student name"]) {
      expect(sqlserverDialect.submissionValueSubquery(label)).not.toMatch(/\bAS\b/i);
      expect(tursoDialect.submissionValueSubquery(label)).not.toMatch(/\bAS\b/i);
    }
  });
});

// -----------------------------------------------------------------------------
// Row normalisation — the other half of the parity fix.
//
// SQL Server hands back a `Date` and 0/1 for a `BIT`; libSQL hands back an
// ISO-8601 string and 0/1 for a `BOOLEAN`. Without normalisation the API layer
// sees different types per mode, and `Intl.DateTimeFormat.format(string)`
// throws `RangeError: Invalid time value` — which is how `/api/export/preview`
// and `/api/reports/preview` failed on Turso.
// -----------------------------------------------------------------------------
describe("normalizeRow — both drivers must hand the app the same shapes", () => {
  it("restores a real Date from the Turso ISO-8601 TEXT form", () => {
    const row = normalizeRow({ id: 1, submitted_at: "2026-09-15T02:33:35.273Z" });
    expect(row.submitted_at).toBeInstanceOf(Date);
    expect((row.submitted_at as Date).toISOString()).toBe("2026-09-15T02:33:35.273Z");
  });

  it("leaves a SQL Server DATETIME2 Date alone", () => {
    const original = new Date("2026-09-15T02:33:35.273Z");
    expect(normalizeRow({ submitted_at: original }).submitted_at).toBe(original);
  });

  it("leaves null and non-ISO strings alone", () => {
    expect(normalizeRow({ updated_at: null }).updated_at).toBeNull();
    expect(normalizeRow({ updated_at: "2026-2027" }).updated_at).toBe("2026-2027");
    // Second-precision or offset forms are NOT what the DDL writes — do not
    // guess at them rather than risk an Invalid Date.
    expect(normalizeRow({ updated_at: "2026-09-15T02:33:35Z" }).updated_at).toBe(
      "2026-09-15T02:33:35Z"
    );
  });

  it("never converts school_year, which merely looks dated", () => {
    expect(normalizeRow({ school_year: "2026-2027" }).school_year).toBe("2026-2027");
  });

  it("still normalises SQLite booleans from 0/1", () => {
    expect(normalizeRow({ staff_only: 0, required: 1 })).toMatchObject({
      staff_only: false,
      required: true,
    });
    expect(normalizeRow({ active: "0" }).active).toBe("0");
  });

  it("covers every timestamp column declared in the Turso DDL", () => {
    // Honesty guard: add a `…_at` column to dialect/turso.ts and this fails,
    // rather than the new column silently arriving as a string on Turso.
    const declared = new Set<string>();
    for (const m of tursoDialect.ddl
      .join("\n")
      .matchAll(/^\s*([a-z_]+)\s+TEXT\b/gim)) {
      if (m[1].toLowerCase().endsWith("_at")) declared.add(m[1].toLowerCase());
    }
    expect([...declared].sort()).toEqual([...TIMESTAMP_COLUMNS].sort());
  });

  it("restores a Date from the Z-LESS ISO form an earlier build wrote", () => {
    // Production serves rows stamped `2026-09-21T15:39:12.080` — the same
    // fixed-width form with the trailing `Z` missing, written by a build whose
    // SQLite default omitted it and preserved ever since. Requiring the `Z` left
    // that row as a string, and one string row was enough to 500 the whole
    // report. Neighbouring rows in the SAME response carried a `Z`, which is why
    // the shape is mixed and why the fix is here rather than in a driver.
    const row = normalizeRow({ submitted_at: "2026-09-21T15:39:12.080" });
    expect(row.submitted_at).toBeInstanceOf(Date);
    expect((row.submitted_at as Date).toISOString()).toBe("2026-09-21T15:39:12.080Z");
  });

  it("reads the Z-less form as UTC, not as server-local time", () => {
    // If a bare value were read as local time, the rendered hour would depend on
    // the machine that happened to run the query. Both spellings must land on
    // the same instant.
    const bare = normalizeRow({ submitted_at: "2026-09-21T15:39:12.080" }).submitted_at as Date;
    const suffixed = normalizeRow({ submitted_at: "2026-09-21T15:39:12.080Z" }).submitted_at as Date;
    expect(bare.getTime()).toBe(suffixed.getTime());
  });

  it("accepts epoch milliseconds and rejects values it cannot use", () => {
    expect(parseTimestamp(1789439615279)).toBeInstanceOf(Date);
    expect(parseTimestamp(Number.NaN)).toBeNull();
    expect(parseTimestamp(new Date("not a date"))).toBeNull();
    expect(parseTimestamp("nonsense")).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
  });
});
