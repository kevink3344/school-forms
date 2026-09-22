// -----------------------------------------------------------------------------
// Archive visibility gate.
//
// "Archived submissions are hidden from every view" is not a property of any one
// function — it is a claim about every statement that READS `dbo.submissions`,
// which is currently seven of them in `queries.ts` plus two in `documents.ts`
// (and, deliberately, none anywhere else: the export and report paths go through
// `listSubmissions` so they inherit the rule rather than restating it).
//
// A claim spread over nine statements cannot be kept by reading them, so this
// file keeps it mechanically:
//
//   1. DISCOVERY — every function in those two files whose SQL reads
//      `dbo.submissions` is found by scanning the source text.
//   2. DECLARATION — each discovered site must appear in READ_SITES with the
//      side of the archive line it means, and a reason. A new read site is a
//      test failure until somebody writes down which side it is on.
//   3. ENFORCEMENT — the declaration is checked against the code: a site that
//      says "views" must actually call `notArchived(`, one that says "boundary"
//      (the delete guard, the by-id lookups) must call NEITHER.
//
// Point 2 is the part that matters. A hand-written list of allowed read sites is
// a CLAIM, not a check — so the list here is diffed against the source, and both
// a MISSING entry (an undeclared read site) and a STALE entry (a declared site
// that no longer exists, or that was renamed) fail loudly. That is what keeps
// this file useful after the person who wrote it has moved on.
// -----------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TIMESTAMP_COLUMNS } from "./client.js";
import { archivedOnly, notArchived } from "./dialect/shared.js";
import { sqlserverDialect } from "./dialect/sqlserver.js";
import { tursoDialect } from "./dialect/turso.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(HERE, relative), "utf8");
}

/** The two files that own submission SQL. Everything else goes through them. */
const SQL_FILES = ["queries.ts", "documents.ts"] as const;

type Predicate = "notArchived" | "archivedOnly";

interface ReadSite {
  /**
   * The predicates this statement must call. `[]` means "deliberately reads both
   * sides" — the code is then checked to call NEITHER helper, so the comment's
   * claim and the statement cannot drift apart.
   */
  requires: Predicate[];
  /**
   * True for a statement that reads `dbo.submissions` directly. False for a
   * caller whose SQL lives in a shared statement builder — those are declared so
   * the rule at the CALL SITE is pinned too.
   */
  readsSubmissions: boolean;
  why: string;
}

/**
 * Every read of `dbo.submissions` in the app, with the side of the archive line
 * it means. Keyed `file.ts::functionName`.
 */
const READ_SITES: Record<string, ReadSite> = {
  // --- queries.ts ----------------------------------------------------------
  "queries.ts::getLoginStats": {
    requires: ["notArchived"],
    readsSubmissions: true,
    why:
      "the login page's stat box. A number that only ever goes up because things were put away " +
      "is a claim the data does not support, and it is the first thing a visitor reads.",
  },
  "queries.ts::listForms": {
    requires: [],
    readsSubmissions: true,
    why:
      "BOUNDARY: `submission_count` for each form. It renders beside a Delete button whose guard " +
      "refuses when a form has ANY submission history, because `submissions.form_id` CASCADES. " +
      "Filtering archived rows here would show 0 next to a Delete button that then fails with " +
      "'This form has submissions'.",
  },
  "queries.ts::countSubmissionsForForm": {
    requires: [],
    readsSubmissions: true,
    why:
      "BOUNDARY: the delete guard itself. Archiving is a view-level hiding, not a deletion — the " +
      "row is still here and the FK still cascades, so this count must include archived rows or " +
      "the guard would permit a delete that destroys them.",
  },
  "queries.ts::listSubmissions": {
    requires: ["notArchived", "archivedOnly"],
    readsSubmissions: true,
    why:
      "the grid, the staff queue, the export preview and the report preview. Excludes archived rows " +
      "by default and selects them only when the caller asks for the Archive view — one list at a " +
      "time, never both.",
  },
  "queries.ts::submissionArchiveCounts": {
    requires: ["notArchived", "archivedOnly"],
    readsSubmissions: true,
    why:
      "the one statement that must see BOTH sides: it reports `{ active, archived }` for the same " +
      "filter so the UI can say what it is hiding. If either predicate disappeared the pair would " +
      "silently under-report.",
  },
  "queries.ts::getSubmissionByPublicId": {
    requires: [],
    readsSubmissions: true,
    why:
      "BY IDENTITY: the detail page. Archiving hides a submission from views, it does not make its " +
      "own URL 404 — a bookmarked link, a Webhook Log link or browser Back must land somewhere " +
      "that renders the Archived banner and offers Restore.",
  },
  "queries.ts::getSubmissionById": {
    requires: [],
    readsSubmissions: true,
    why:
      "BY IDENTITY: the document generator's lookup. Archiving a submission must not make an " +
      "in-flight job fail to find the row it was started for.",
  },

  // --- documents.ts --------------------------------------------------------
  "documents.ts::queryDocuments": {
    requires: [],
    readsSubmissions: true,
    why:
      "SHARED SQL: the one document SELECT, whose WHERE clauses are built by its caller. The rule " +
      "is therefore enforced at the two call sites below, both of which are declared here.",
  },
  "documents.ts::listDocuments": {
    requires: ["notArchived"],
    readsSubmissions: false,
    why:
      "the Documents page and `GET /api/documents`. Supplies the archive clause to `queryDocuments`. " +
      "The endpoint's school/org filter is optional, so a bare call would otherwise list every " +
      "archived submission's documents.",
  },
  "documents.ts::listDocumentsBySubmission": {
    requires: [],
    readsSubmissions: false,
    why:
      "BOUNDARY: the detail page's document panel, and the re-read after a retry. Deliberately " +
      "unfiltered — the panel sits on a page that already says 'Archived', and an empty panel while " +
      "the documents exist would read as broken rather than as archived. The rule is 'hidden from " +
      "LISTS', not 'hidden from its own page'.",
  },
  "documents.ts::getDocumentById": {
    requires: [],
    readsSubmissions: true,
    why:
      "BY IDENTITY: retrying a failed document on an archived submission must still work.",
  },
};

interface FunctionSlice {
  name: string;
  code: string;
}

/**
 * Slice a file into top-level functions.
 *
 * Both declaration forms the codebase uses are matched; the body runs to the next
 * declaration. Comments are stripped from each slice because the NEXT function's
 * doc block falls inside the previous slice, and a doc block that merely mentions
 * `notArchived(` would otherwise satisfy the check for the function above it.
 */
const DECLARATION =
  /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(|(?:^|\n)(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*(?::[^=\n]+)?=\s*(?:async\s*)?\(/g;

function functionsIn(text: string): FunctionSlice[] {
  const starts: Array<{ name: string; at: number }> = [];
  DECLARATION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DECLARATION.exec(text)) !== null) {
    starts.push({ name: match[1] ?? match[2], at: match.index });
  }
  return starts.map((start, i) => ({
    name: start.name,
    code: stripComments(
      text.slice(start.at, i + 1 < starts.length ? starts[i + 1].at : text.length)
    ),
  }));
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const READS_SUBMISSIONS = /(?:FROM|JOIN)\s+dbo\.submissions\b/i;

/** `file.ts::functionName` for every discovered read of `dbo.submissions`. */
function discoverReadSites(): Map<string, FunctionSlice> {
  const found = new Map<string, FunctionSlice>();
  for (const file of SQL_FILES) {
    for (const fn of functionsIn(source(file))) {
      if (READS_SUBMISSIONS.test(fn.code)) found.set(`${file}::${fn.name}`, fn);
    }
  }
  return found;
}

function called(code: string, predicate: Predicate): boolean {
  return code.includes(`${predicate}(`);
}

describe("archive visibility — every read of dbo.submissions declares its side", () => {
  const discovered = discoverReadSites();
  const declared = Object.entries(READ_SITES);

  it("finds the read sites it is meant to be guarding", () => {
    // A control that cannot fail is not a control: if the discovery regex or the
    // file list stops working, every assertion below would pass on an empty set.
    expect(discovered.size).toBeGreaterThanOrEqual(9);
    expect([...discovered.keys()]).toContain("queries.ts::listSubmissions");
    expect([...discovered.keys()]).toContain("documents.ts::queryDocuments");
  });

  it("has no undeclared read site", () => {
    const undeclared = [...discovered.keys()].filter((key) => !(key in READ_SITES));
    expect(
      undeclared,
      "A statement that reads dbo.submissions was added without saying which side of the archive " +
        "line it means. Add it to READ_SITES with the predicates it must call — `notArchived` to " +
        "exclude archived rows, `archivedOnly` for the Archive view, or [] with a reason if it " +
        "must see every row (the delete guard, a by-id lookup)."
    ).toEqual([]);
  });

  it("has no stale declaration", () => {
    const stale = declared
      .filter(([, site]) => site.readsSubmissions)
      .map(([key]) => key)
      .filter((key) => !discovered.has(key));
    expect(
      stale,
      "A declared read site no longer exists — it was renamed, moved or deleted. Update " +
        "READ_SITES rather than deleting the entry silently: the entry is what pinned the " +
        "statement's archive rule."
    ).toEqual([]);
  });

  it("resolves every declaration to a real function", () => {
    const byFile = new Map<string, Set<string>>();
    for (const file of SQL_FILES) {
      byFile.set(file, new Set(functionsIn(source(file)).map((fn) => fn.name)));
    }
    const missing = declared
      .filter(([key]) => {
        const [file, name] = key.split("::");
        return !byFile.get(file)?.has(name);
      })
      .map(([key]) => key);
    expect(missing, "READ_SITES names a function that does not exist in that file.").toEqual([]);
  });

  it("agrees with itself about which sites read submissions directly", () => {
    // Without this, an entry could be declared `readsSubmissions: false` — which
    // is how a call-site-only function is described — and thereby skip the
    // predicate check below, leaving the one function that leaked archived rows
    // as the one function nothing enforced.
    const mislabelled = declared
      .filter(([key, site]) => site.readsSubmissions !== discovered.has(key))
      .map(([key, site]) =>
        site.readsSubmissions
          ? `${key}: declares readsSubmissions: true but its SQL does not read dbo.submissions`
          : `${key}: declares readsSubmissions: false but it DOES read dbo.submissions directly`
      );
    expect(
      mislabelled,
      "`readsSubmissions` is not decoration — it decides whether this file checks the entry's " +
        "predicates. A real read site marked false is unchecked; a shared-SQL caller marked true " +
        "is checked against a statement it does not own."
    ).toEqual([]);
  });

  it("enforces the declared predicates against the code", () => {
    const wrong: string[] = [];
    for (const [key, site] of declared) {
      const fn = discovered.get(key);
      // Caller-only entries (readsSubmissions: false) have no SQL of their own;
      // their call-site rule is checked in the test below.
      if (!fn) continue;
      const present = (["notArchived", "archivedOnly"] as Predicate[]).filter((p) =>
        called(fn.code, p)
      );
      if (present.length !== site.requires.length || !site.requires.every((p) => present.includes(p))) {
        wrong.push(
          `${key}: declares [${site.requires.join(", ")}] but calls [${present.join(", ") || "neither"}]`
        );
      }
    }
    expect(
      wrong,
      "A read site's archive rule disagrees with what it says it does. Calling NEITHER is what " +
        "leaks archived rows into a list; calling one where [] is declared means a boundary " +
        "statement (the delete guard, a by-id lookup) has started hiding rows."
    ).toEqual([]);
  });

  it("can actually detect a violation (harness self-test)", () => {
    // Every assertion above is a negative — "nothing is wrong" — and a harness
    // that scanned nothing, or whose comment-stripping removed the code along with
    // the prose, would report exactly the same result. This feeds it a file with a
    // known leak and a known-good sibling, and asserts it tells them apart.
    // The table name is ASSEMBLED rather than written into the fixture strings,
    // and it has to stay that way: `db/driver/libsql.test.ts` scans every file
    // under src for a SINGLE-QUOTED literal containing "dbo." — because
    // `toLibsql()` rewrites `dbo.` by token, with no notion of quoting, so such a
    // literal would be mangled wherever the statement is shared with Turso.
    // Building the fixture this way keeps this file's single-quoted literals
    // clean while the fixture's VALUE still holds the real SQL text.
    const table = ["dbo", "submissions"].join(".");
    const fixture =
      "export async function listX() {\n" +
      `  return execute("SELECT 1 FROM ${table} s WHERE 1 = 1");\n` +
      "}\n" +
      "export async function listY() {\n" +
      `  return execute("SELECT 1 FROM ${table} s WHERE " + notArchived("s"));\n` +
      "}\n" +
      "export async function listZ() {\n" +
      '  // notArchived("s") belongs here but is not in the CODE\n' +
      "  return 1;\n" +
      "}\n";
    const fns = functionsIn(fixture);
    expect(fns.map((f) => f.name)).toEqual(["listX", "listY", "listZ"]);
    expect(
      fns.filter((f) => READS_SUBMISSIONS.test(f.code)).map((f) => f.name),
      "discovery must find listX and listY (they read the table) and not listZ (it does not)"
    ).toEqual(["listX", "listY"]);
    expect(called(fns[0].code, "notArchived")).toBe(false);
    expect(called(fns[1].code, "notArchived")).toBe(true);
    expect(
      called(fns[2].code, "notArchived"),
      "a comment must never satisfy the check — otherwise a doc block that describes the rule " +
        "reads as the rule being applied"
    ).toBe(false);
  });

  it("keeps the shared document SELECT honest at both call sites", () => {
    const documents = functionsIn(source("documents.ts"));
    const list = documents.find((fn) => fn.name === "listDocuments");
    const bySubmission = documents.find((fn) => fn.name === "listDocumentsBySubmission");
    expect(list?.code).toContain("notArchived(");
    expect(bySubmission?.code).not.toContain("notArchived(");
    expect(bySubmission?.code).not.toContain("archivedOnly(");
    // Both must still route through the one shared STATEMENT, not grow their own
    // copy of the document SELECT — the shared statement is what keeps the three
    // projected answer columns (student / course / phase 1 result) from drifting.
    expect(list?.code).toContain("queryDocuments(");
    expect(bySubmission?.code).toContain("queryDocuments(");
  });

  it("does not let the export or report path grow its own submissions SQL", () => {
    const offenders = ["../routes/export.ts", "../routes/reports.ts", "../routes/documents.ts"]
      .map((rel) => ({ rel, text: source(rel) }))
      .filter(({ text }) => READS_SUBMISSIONS.test(text))
      .map(({ rel }) => rel);
    expect(
      offenders,
      "These endpoints must read submissions through `listSubmissions` / `listDocuments`, which " +
        "apply the archive rule. A direct SELECT here would return archived rows to a CSV, a report " +
        "preview or the Documents page — and nothing else would notice."
    ).toEqual([]);
  });
});

describe("archive visibility — the predicate helpers", () => {
  it("threads the alias through instead of hard-coding one", () => {
    expect(notArchived("s")).toBe("s.archived_at IS NULL");
    expect(notArchived("dbo.submissions")).toBe("dbo.submissions.archived_at IS NULL");
    expect(archivedOnly("t")).toBe("t.archived_at IS NOT NULL");
  });

  it("lists archived_at as a timestamp column", () => {
    expect(
      TIMESTAMP_COLUMNS.has("archived_at"),
      "`archived_at` is DATETIME2 on SQL Server and TEXT on Turso. If it is missing from " +
        "TIMESTAMP_COLUMNS the Turso driver hands the raw string to the API layer, so the Archived " +
        "banner and any date rendering around it fail with `RangeError: Invalid time value` — the " +
        "same fault that broke the export and report preview endpoints on Turso."
    ).toBe(true);
  });
});

describe("archive visibility — schema", () => {
  const NO_ARCHIVE = sqlserverDialect.ddl.join("\n");
  const NO_ARCHIVE_TURSO = tursoDialect.ddl.join("\n");

  /** The values of `<table>`'s `CHECK (status IN (…))`, read from the DDL text. */
  function tableStatusValues(ddl: string, table: string): string[] {
    const create = new RegExp(
      `CREATE TABLE (?:IF NOT EXISTS )?(?:dbo\\.)?${table}\\b([\\s\\S]*?)(?=CREATE TABLE|$)`,
      "i"
    );
    const body = create.exec(ddl)?.[1] ?? "";
    const check = /CHECK \(status IN \(([^)]*)\)\)/i.exec(body);
    return (check?.[1] ?? "")
      .split(",")
      .map((v) => v.trim().replace(/^'|'$/g, ""))
      .filter(Boolean);
  }

  it("declares the columns in both dialects", () => {
    for (const [label, ddl] of [
      ["sqlserver", NO_ARCHIVE],
      ["turso", NO_ARCHIVE_TURSO],
    ] as const) {
      expect(ddl, `${label} DDL is missing submissions.archived_at`).toMatch(
        /archived_at\s+(DATETIME2|TEXT)\b/i
      );
      expect(ddl, `${label} DDL is missing submissions.archived_by`).toMatch(
        /archived_by\s+(INT|INTEGER)\b/i
      );
    }
  });

  it("adds both columns idempotently for databases created before the feature", () => {
    // Production receives this feature through the startup ladder, not by being
    // recreated: without the guard the ALTER never runs and every archive write
    // fails with "Invalid column name 'archived_at'".
    expect(NO_ARCHIVE).toMatch(
      /IF COL_LENGTH\('dbo\.submissions',\s*'archived_at'\)\s*IS NULL[\s\S]{0,80}ADD archived_at/
    );
    expect(NO_ARCHIVE).toMatch(
      /IF COL_LENGTH\('dbo\.submissions',\s*'archived_by'\)\s*IS NULL[\s\S]{0,80}ADD archived_by/
    );
  });

  it("declares both columns as Turso addColumns entries too", () => {
    const added = tursoDialect.addColumns
      .filter((c) => c.table === "submissions")
      .map((c) => c.column);
    expect(added, "Turso databases migrated in place need the addColumns entries.").toEqual(
      expect.arrayContaining(["archived_at", "archived_by"])
    );
  });

  it("does NOT fold archiving into submissions.status", () => {
    // The design decision, pinned. Reusing `status` would make every status
    // filter, saved report view and export learn a value meaning "not work", and
    // PATCH /status would become an archive endpoint by accident — and Restore
    // would need a remembered prior status to stay in step.
    //
    // Scoped to the SUBMISSIONS table's own CHECK. `forms.status` legitimately
    // carries 'archived' (the earlier feature this one follows), so a file-wide
    // search for the word would report that as a violation.
    const tsubmissions = tableStatusValues(NO_ARCHIVE, "submissions");
    const forms = tableStatusValues(NO_ARCHIVE, "forms");
    expect(
      forms,
      "CONTROL: the parser must find a `CHECK (status IN …)` and read its values back. " +
        "`forms.status` is the archive feature's precedent and legitimately includes 'archived' — " +
        "if this control fails, the assertion below is passing because nothing was parsed."
    ).toContain("archived");
    expect(tsubmissions).toEqual(["submitted", "in_review", "flagged", "completed"]);
    expect(
      tsubmissions,
      "The submissions status CHECK gained an 'archived' value. Archiving is a dedicated " +
        "archived_at column; if this assertion is failing because status really did absorb it, " +
        "every status filter, saved report view and export has to be taught the new value — and " +
        "the two implementations now overlap. Invert this assertion only with that work done."
    ).not.toContain("archived");
  });
});

describe("archive visibility — the permanent delete's child set", () => {
  // `deleteSubmission` cannot lean on ON DELETE CASCADE, and that is a
  // measurement rather than a preference. schema.ts declares all three child
  // foreign keys CASCADE, but the LIVE Azure database was created by an earlier
  // revision of that DDL whose constraints carry different names and NO ACTION —
  // and every CREATE TABLE here is guarded by `IF OBJECT_ID(…) IS NULL`, so
  // correcting the declaration never reaches a table that already exists. The
  // delete therefore names its children explicitly, which makes
  // SUBMISSION_CHILD_TABLES a hand-copy of a set the schema states in full.
  //
  // A comment asking the next author to keep the two in step does nothing (it was
  // already written once, in the routing table, and was wrong for a year), so the
  // copy is diffed against the DDL here — in BOTH directions, so a child added to
  // the schema and an entry left behind both fail.
  const DDL_SQL = sqlserverDialect.ddl.join("\n");
  const DDL_TURSO = tursoDialect.ddl.join("\n");

  /**
   * The tables whose CREATE TABLE body declares a foreign key on `submission_id`
   * pointing at `submissions`, read out of one dialect's DDL text.
   *
   * Matching on the reference rather than on a constraint-name prefix is
   * deliberate: the constraint names are exactly what drifted between the
   * authored DDL and the live database.
   */
  function childrenOfSubmissions(ddl: string): string[] {
    const starts = [
      ...ddl.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(?:dbo\.)?([A-Za-z0-9_]+)\s*\(/gi),
    ];
    const out: string[] = [];
    starts.forEach((m, i) => {
      const from = m.index ?? 0;
      const to = i + 1 < starts.length ? (starts[i + 1].index ?? ddl.length) : ddl.length;
      if (/REFERENCES\s+(?:dbo\.)?submissions\s*\(\s*id\s*\)/i.test(ddl.slice(from, to))) {
        out.push(m[1]);
      }
    });
    return out.sort();
  }

  it("reads the same three children out of both dialects' DDL", () => {
    const expected = ["documents", "submission_adhoc_fields", "submission_values"];
    expect(
      childrenOfSubmissions(DDL_SQL),
      "CONTROL: the parser must find foreign keys at all. If this fails, every assertion below " +
        "is satisfied by an empty list. `webhook_events` is deliberately absent — it keeps its " +
        "`submission_id` with no foreign key, because the intake log is evidence of what arrived."
    ).toEqual(expected);
    expect(
      childrenOfSubmissions(DDL_TURSO),
      "The two dialects disagree about which tables point at `submissions`. Turso is the secondary " +
        "store, so a table that cascades there and not on SQL Server (or the reverse) means a " +
        "fixture that behaves one way in tests and another in production."
    ).toEqual(expected);
  });

  it("deletes exactly the children the schema points at submissions", () => {
    const expected = childrenOfSubmissions(DDL_SQL);
    const queries = source("queries.ts");

    const list = /const SUBMISSION_CHILD_TABLES\s*=\s*\[([^\]]*)\]/.exec(queries);
    expect(list, "SUBMISSION_CHILD_TABLES not found in queries.ts").toBeTruthy();
    const named = [...list![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(
      named,
      "SUBMISSION_CHILD_TABLES has drifted from the foreign keys that point at `dbo.submissions`. " +
        "A child the schema names and this list does not leaves rows behind (the DELETE fails with " +
        "SQL Server 547 on the live database, where the constraints are NO ACTION); an entry the " +
        "schema does not name deletes from a table for no reason. Fix the list, not this assertion."
    ).toEqual(expected);

    const fn = functionsIn(queries).find((f) => f.name === "deleteSubmission");
    expect(fn, "deleteSubmission not found in queries.ts").toBeTruthy();
    expect(
      fn!.code,
      "deleteSubmission no longer walks that list — an inline child delete is a second, " +
        "easily-incomplete copy of the rule and is invisible to the diff above."
    ).toContain("SUBMISSION_CHILD_TABLES");
    expect(
      fn!.code,
      "The child delete must be parameterised and scoped to the one submission."
    ).toMatch(/DELETE FROM dbo\.\$\{table\} WHERE submission_id = @id/);
    expect(
      fn!.code,
      "The delete now touches `webhook_events`. That table's `submission_id` has no foreign key " +
        "on purpose: the intake log records what arrived, and it keeps its row after the " +
        "submission is gone."
    ).not.toContain("webhook_events");
  });
});

describe("archive visibility — routes", () => {
  const routes = source("../routes/submissions.ts");

  /**
   * One route registration's full text — from its own `submissionsRouter.x(` up
   * to the next registration. It runs to the NEXT REGISTRATION rather than to the
   * first `;`, because a handler body contains semicolons: slicing on one returned
   * a fragment of the prologue and made a correct handler look like it never
   * called its filter reader.
   */
  function registration(method: string, path: string): string {
    const marker = `submissionsRouter.${method}("${path}"`;
    const at = routes.indexOf(marker);
    expect(at, `no ${method.toUpperCase()} ${path} registration found`).toBeGreaterThanOrEqual(0);
    const next = routes.indexOf("submissionsRouter.", at + marker.length);
    return routes.slice(at, next === -1 ? routes.length : next);
  }

  it("lets the staff roles archive and restore, and only the staff roles", () => {
    // Reversible actions belong to whoever is looking at the queue. The reach is
    // the same either way — the row is resolved by public id (organization-scoped)
    // then gated on the actor's school — so an admin-only guard bought no extra
    // safety and left the person actually working the queue unable to put anything
    // away. The list is asserted in full rather than with `toContain('"staff"')`
    // because that would also pass on a guard that had quietly dropped `admin`.
    for (const path of ["/:publicId/archive", "/:publicId/restore"]) {
      const line = registration("post", path);
      expect(
        line,
        `${path} changed role list. Archive/restore are deliberately available to staff and school ` +
          "contacts as well as admins; if a role was removed here, the action became impossible for " +
          "the person who uses it, and if one was added, a role that should not see other schools' " +
          "rows gained a write path. Re-narrow this assertion to the intended list."
      ).toContain('requireRoles("staff", "cdm_contact", "admin")');
      expect(line).toContain("requireAuth");
    }
  });

  it("keeps permanent delete admin-only and archive-first", () => {
    const line = registration("delete", "/:publicId");
    expect(line).toContain("requireAuth");
    expect(
      line,
      "Permanent delete is no longer admin-only. It is the one irreversible submission action — no " +
        "restore, no undo, no audit trail of the removed answers — so unlike archive and restore it " +
        "must not be reachable by a school-scoped role."
    ).toContain('requireRoles("admin")');
    expect(
      line,
      "CONTROL: the delete route's guard must NOT be the archive/restore role list. If this fails, " +
        "the assertion above is passing on a copied guard rather than on an admin-only one — the two " +
        "strings are adjacent in the file and easy to paste over each other."
    ).not.toContain('requireRoles("staff", "cdm_contact", "admin")');

    // Archive-first is enforced by the DELETE's own WHERE, not by a TypeScript
    // read-then-delete: a caller that checked `archived_at` and then issued an
    // unconditional DELETE would lose the race against a concurrent Restore and
    // destroy a row it had just seen restored.
    const queries = source("queries.ts");
    const fn = functionsIn(queries).find((f) => f.name === "deleteSubmission");
    expect(fn, "deleteSubmission not found in queries.ts").toBeTruthy();
    expect(
      fn!.code,
      "deleteSubmission's SQL no longer requires the row to be archived. Without that predicate the " +
        "route's 409 becomes advisory and a non-archived submission can be destroyed by a call that " +
        "races a Restore."
    ).toMatch(/where:\s*"id = @id AND archived_at IS NOT NULL"/);
    expect(
      fn!.code,
      "deleteSubmission must issue a DELETE. It has been changed into an update, which would leave " +
        "the row (and its children) in place while the route answers 204."
    ).toMatch(/deleteReturning\(/);
  });

  it("guards the archive transition and reports a real conflict", () => {
    expect(routes).toContain('"This submission is already archived."');
    expect(routes).toContain('"This submission is not archived."');
    // The guard belongs in the UPDATE's WHERE clause (see archiveSubmission), not
    // in a TypeScript read-then-write: two concurrent clicks must not both report
    // success.
    const queries = source("queries.ts");
    expect(queries).toMatch(/where:\s*"id = @id AND archived_at IS NULL"/);
    expect(queries).toMatch(/where:\s*"id = @id AND archived_at IS NOT NULL"/);
  });

  it("computes the badge from the same filter reader as the list", () => {
    // The count is only meaningful if it describes the rows the grid was actually
    // handed, so both endpoints must build their filters the same way.
    const list = registration("get", "/");
    const counts = registration("get", "/archive/counts");
    expect(list).toContain("submissionFiltersFrom(req)");
    expect(counts).toContain("submissionFiltersFrom(req)");
  });

  it("accepts both spellings of the archive flag", () => {
    // The client builds this from a boolean, and `String(true)` is "true" — a URL
    // that says ?archived=true and silently returns the unarchived list would be a
    // lie no type checker can see.
    expect(routes).toMatch(/req\.query\.archived === "1"/);
    expect(routes).toMatch(/req\.query\.archived === "true"/);
  });
});
