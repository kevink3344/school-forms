/**
 * System Messages — the audience rule, the close-out ledger, and the 3-row cap.
 *
 * A DURABLE VERSION OF A THROWAWAY PROBE. A scratch script — since deleted, as
 * scratch scripts are — proved every claim in this feature against a live
 * database once, and a probe dies with the session that ran it, so every claim
 * it made would have gone with it. What
 * makes the trip into a test is the part that is true of the SOURCE rather than
 * of one database: which statement carries the cap, which guard sits on which
 * route, how each dialect spells the row window. That is what this file gates.
 * The live behaviour (a strip that renders, a chip that excludes, a DELETE that
 * refills the strip) was verified in a browser and is not reproducible here.
 *
 * The mandate is not invented: `db/queries.ts` opens the System Messages section
 * with two rules stated in a COMMENT —
 *
 *   1. Every `system_messages` read is scoped by `organization_id`.
 *   2. Every `system_message_dismissals` read or write is scoped by `user_id`.
 *
 *   … and `system_message_dismissals` deliberately has NO foreign key, so the
 *   rows for a deleted message are removed explicitly in `deleteSystemMessage`.
 *
 * — and `toSystemMessage` is documented as "the ONLY place `audience` is parsed".
 * Those are four claims nothing checked. A comment saying "keep this in step"
 * does exactly nothing; this file is what checks them.
 *
 * Same three-step shape as `submissions-archive.test.ts`:
 *
 *   1. DISCOVERY   — scan the source text for the sites the rules apply to.
 *   2. DECLARATION — each discovered site must appear in a hand-written map with
 *                    a `why`.
 *   3. ENFORCEMENT — the declaration is checked against the code in BOTH
 *                    directions: an undeclared site fails, and a STALE
 *                    declaration fails too.
 *
 * A hand-written list of scoped queries is a CLAIM, not a check, so the list is
 * diffed against the source. That is the whole point of the file.
 *
 * -----------------------------------------------------------------------------
 * ⚠ AUTHORING CONSTRAINT — every SQL-shaped string below is DOUBLE-QUOTED.
 *
 * `driver/libsql.test.ts` scans every `.ts` file under `src/` (this one included)
 * for constructs libSQL cannot parse — `SELECT TOP n`, `OFFSET n ROWS`,
 * `MERGE x`, `IF EXISTS (` — and for a single-quoted literal carrying a table
 * prefix. Its `stripCommentsAndProse` BLANKS double-quoted strings and comments
 * but KEEPS single-quoted strings and template literals, so an expectation
 * written in backticks would be read as shared SQL and would fail an unrelated
 * test. Double quotes are invisible to both of its scanners.
 *
 * This is not decoration. A "tidy-up" that converts the double-quoted SQL below
 * into backticks breaks `libsql.test.ts`, not this file, and the failure will
 * point at the wrong feature.
 * -----------------------------------------------------------------------------
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROUTES } from "../routes/inventory.js";
import { BOOLEAN_COLUMNS, TIMESTAMP_COLUMNS } from "./client.js";
import { sqlserverDialect } from "./dialect/sqlserver.js";
import { tursoDialect } from "./dialect/turso.js";
import { audienceLikePattern } from "./queries.js";
import { ROLES, expectedIndexNames, messageAudienceRoles } from "./schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(HERE, relative), "utf8");
}

function readAt(absolute: string): string {
  return readFileSync(absolute, "utf8");
}

// -----------------------------------------------------------------------------
// Function slicing — copied in shape from submissions-archive.test.ts.
//
// Comments are stripped from each slice because the NEXT function's doc block
// falls inside the previous slice, and a doc block that merely MENTIONS a table
// or a token would otherwise satisfy the check for the function above it.
// -----------------------------------------------------------------------------
interface FunctionSlice {
  name: string;
  code: string;
}

const DECLARATION =
  /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(|(?:^|\n)(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*(?::[^=\n]+)?=\s*(?:async\s*)?\(/g;

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

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

const QUERIES = "queries.ts";
/** Tables this feature owns. `system_message_dismissals` does not contain the
 *  substring `system_messages` (the 16th character is `_`, not `s`), so the
 *  alternation cannot conflate the two. */
const NAMES_A_MESSAGE_TABLE = /system_messages|system_message_dismissals/;

function messageTableSites(): Map<string, FunctionSlice> {
  const found = new Map<string, FunctionSlice>();
  for (const fn of functionsIn(source(QUERIES))) {
    if (NAMES_A_MESSAGE_TABLE.test(fn.code)) found.set(fn.name, fn);
  }
  return found;
}

function functionNamed(file: string, name: string): FunctionSlice {
  const fn = functionsIn(source(file)).find((f) => f.name === name);
  expect(fn, `${name} not found in ${file} — it was renamed or removed`).toBeTruthy();
  return fn!;
}

// -----------------------------------------------------------------------------
// 1. Audience semantics — the pure rule, no database involved.
// -----------------------------------------------------------------------------
describe("messageAudienceRoles — what an audience means", () => {
  it("treats an unset audience as every role, as the NULL sentinel", () => {
    // ★ This expectation used to be `.toEqual([...ROLES])`, and it was WRONG the
    // moment an admin could create a role. `[...ROLES]` is a snapshot of the four
    // built-ins taken at module load, so "everyone" would have meant "everyone who
    // existed when this file was written" — a notice the admin addressed to all
    // roles would be invisible to a role created afterwards, and nothing anywhere
    // would report it. The contract is now `null` = UNRESTRICTED, resolved where
    // the viewer's role is known (see `canSeeField`), which is the only form of
    // "everyone" that stays true when the role set changes.
    //
    // The direction of the failure is what makes this worth a comment: narrowing a
    // pre-existing message to nobody is silent, and the first person to notice is a
    // user who never saw the notice.
    expect(messageAudienceRoles(null)).toBeNull();
    expect(messageAudienceRoles(undefined)).toBeNull();
  });

  it("treats an empty string as unset rather than as a role list", () => {
    // `${roles.join(",")}` on an empty list is "", and "" is not JSON — so this
    // is the shape a form that never got a selection can store. It has to mean
    // "unset", because the alternative (nobody) hides the message from everyone.
    expect(messageAudienceRoles("")).toBeNull();
    expect(messageAudienceRoles("   ")).toBeNull();
  });

  it("keeps an explicit empty array as NOBODY, and it is a different answer from unset", () => {
    // The single most dangerous coercion in this feature: folding [] back into
    // "unset" turns "delivered to nobody" into "delivered to everyone", which is
    // the exact opposite of what the admin asked for. The inequality assertion
    // below is the control — it proves the two branches can be told apart at all.
    expect(messageAudienceRoles([])).toEqual([]);
    expect(
      messageAudienceRoles([]),
      "If [] and null now agree, one of the two branches was collapsed. They are " +
        "deliberately different instructions: [] is 'nobody', null is 'everyone'."
    ).not.toEqual(messageAudienceRoles(null));
  });

  it("reads a stored JSON array back as those roles", () => {
    expect(messageAudienceRoles('["staff"]')).toEqual(["staff"]);
    expect(messageAudienceRoles('["admin","cdm_contact"]')).toEqual(["admin", "cdm_contact"]);
  });

  it("accepts an already-parsed array unchanged", () => {
    expect(messageAudienceRoles(["staff", "admin"])).toEqual(["staff", "admin"]);
  });

  it("degrades a corrupt blob to EVERYONE rather than to nobody", () => {
    // The failure has to be loud in the direction that does not hide a notice. A
    // corrupt audience that resolved to [] would be a message that provably
    // exists and is served to no one, with no error on any path.
    for (const corrupt of ["not json", "{", '{"admin":true}', '"staff"', "null", "12"]) {
      expect(
        messageAudienceRoles(corrupt),
        `the corrupt audience ${JSON.stringify(corrupt)} no longer degrades to every role. ` +
          "A parse failure must fail OPEN — see schema.ts; failing closed hides the notice " +
          "from everybody and nothing reports it."
      ).toBeNull();
    }
  });

  it("does NOT validate the role names it reads", () => {
    // Deliberate, and worth pinning so nobody adds validation here on the theory
    // that this is the boundary. The boundary is Zod (`audienceSchema`), which
    // runs before the write; this function only interprets what is stored. An
    // unknown role can therefore only arrive from a hand-edited row, and dropping
    // it here would silently rewrite an admin's selection into a different one.
    expect(messageAudienceRoles('["staff","provost"]')).toEqual(["staff", "provost"]);
  });
});

// -----------------------------------------------------------------------------
// 2. The LIKE pattern — matched with a real matcher, not asserted as a string.
// -----------------------------------------------------------------------------
/**
 * Interpret a LIKE pattern written with `ESCAPE '\'` the way a database would:
 * `%` is any run, `_` is exactly one character, and a backslash escapes the next
 * character. Matching against this — rather than asserting the pattern literally
 * — is what makes the lookalike cases below discriminating: they only fail if the
 * escape really is emitted.
 */
function likeMatches(value: string, pattern: string): boolean {
  const META = /[.*+?^${}()|[\]\\]/g;
  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i += 1;
      regex += (pattern[i] ?? "").replace(META, "\\$&");
      continue;
    }
    if (ch === "%") {
      regex += "[^]*";
      continue;
    }
    if (ch === "_") {
      regex += "[^]";
      continue;
    }
    regex += ch.replace(META, "\\$&");
  }
  return new RegExp(`^${regex}$`).test(value);
}

describe("audienceLikePattern — the stored JSON array, matched as a token", () => {
  it("bounds the role with quotes so a role that merely CONTAINS it does not match", () => {
    expect(likeMatches('["staff"]', audienceLikePattern("staff"))).toBe(true);
    expect(likeMatches('["admin","staff"]', audienceLikePattern("staff"))).toBe(true);
    expect(
      likeMatches('["superstaff"]', audienceLikePattern("staff")),
      "The pattern no longer requires the closing quote. Without it a LIKE match on " +
        "'staff' also matches every role whose name merely ends in it, which would " +
        "show a notice to a set of users the admin did not select."
    ).toBe(false);
  });

  it("escapes the underscore in cdm_contact, which LIKE would otherwise treat as any character", () => {
    // `cdm_contact` is a real role and its underscore is a real LIKE wildcard.
    // The positive case below is the control: escaping must not break the match
    // it is there to make.
    expect(likeMatches('["cdm_contact"]', audienceLikePattern("cdm_contact"))).toBe(true);
    expect(
      likeMatches('["cdmXcontact"]', audienceLikePattern("cdm_contact")),
      "The underscore in cdm_contact is no longer escaped, so the pattern uses it as a " +
        "single-character wildcard and matches roles that do not exist. Restore the escape " +
        "class in audienceLikePattern."
    ).toBe(false);
  });

  it("escapes the other two LIKE metacharacters too", () => {
    expect(audienceLikePattern("a%b")).toBe('%"a\\%b"%');
    expect(audienceLikePattern("a\\b")).toBe('%"a\\\\b"%');
  });

  it("matches nothing at all against a stored empty array", () => {
    // '[]' is what "delivered to nobody" is stored as, so no role may ever match
    // it — and the NULL arm in the query is the only thing that keeps a
    // never-set audience visible. This is the pattern's half of that claim.
    for (const role of ROLES) {
      expect(likeMatches("[]", audienceLikePattern(role))).toBe(false);
    }
  });
});

// -----------------------------------------------------------------------------
// 3. Scoping — the two rules the queries file states in a comment, now checked.
// -----------------------------------------------------------------------------
interface ScopedSite {
  /** Must name the organization in the statement it reads or writes. */
  org: boolean;
  /** Must ALSO bound the statement to one user, not just one organization. */
  user: boolean;
  why: string;
}

const SCOPE_SITES: Record<string, ScopedSite> = {
  listSystemMessages: {
    org: true,
    user: false,
    why:
      "The admin grid: `organization_id` in its WHERE. Deliberately NOT user-scoped and NOT " +
      "filtered by `active` — the panel has to show an inactive message in order to switch it " +
      "back on, and it must show another admin's message in order for anyone to fix it.",
  },
  listActiveSystemMessagesForUser: {
    org: true,
    user: true,
    why:
      "Both scopes live in the ONE WHERE the cap applies to: `m.organization_id` and `d.user_id`. " +
      "Splitting them — filtering in the client, or after the page — is the `slice(0,N).filter()` " +
      "correctness bug, which shows a user fewer notices than they are entitled to while the " +
      "rest sit unreturned behind the cap.",
  },
  getSystemMessage: {
    org: true,
    user: false,
    why:
      "By id AND organization. A message in another organization has to be indistinguishable " +
      "from one that does not exist — 'that id exists but is not yours' is itself a disclosure.",
  },
  createSystemMessage: {
    org: true,
    user: false,
    why:
      "`organization_id` is in the INSERT column list, so a row cannot be created without an " +
      "owner. `created_by` records the author but deliberately does not scope the row.",
  },
  updateSystemMessage: {
    org: true,
    user: false,
    why:
      "The UPDATE carries `organization_id` in its WHERE, so a cross-organization id matches " +
      "nothing even though the read that precedes it already refused.",
  },
  deleteSystemMessage: {
    org: true,
    user: false,
    why:
      "The organization-scoped deleteReturning runs FIRST. A refused delete therefore returns " +
      "false having touched no dismissal row at all, so the two tables cannot end up half-changed.",
  },
  dismissSystemMessage: {
    org: true,
    user: true,
    why:
      "The `EXISTS` on the message's organization and the `NOT EXISTS` on (message, user) are " +
      "both inside the one INSERT ... SELECT, so there is no window between checking and acting, " +
      "and a double-clicked close is a no-op rather than a duplicate-key error.",
  },
  // ★ The ONE deliberate exception, and it is not a System Messages statement at
  // all — it is the role-delete census, which reaches this table because
  // `system_messages.audience` is one of the five places a role key can be
  // referenced. It is declared HERE rather than exempted, because the discovery
  // scan is deliberately dumb ("does this function's SQL name either table") and an
  // exemption list would be the thing that goes stale.
  //
  // org: false is the point. Counted installation-wide ON PURPOSE: the FK that
  // makes `DELETE FROM dbo.roles` fail is global, so an organization-scoped count
  // would under-report and offer a delete that then cannot succeed — and the panel
  // reads this same function to decide whether to offer the button at all. A
  // count scoped to one tenant would make the button and the 409 disagree.
  //
  // It returns a COUNT, never a row: no message body, title or author crosses the
  // tenant line, and the only routes that call it are `requireAdmin()`.
  roleUsage: {
    org: false,
    user: false,
    why:
      "Deliberately installation-wide: it counts references to a role key across five stores " +
      "to decide whether the role may be deleted, and the constraint that refuses the delete " +
      "(FK_users_role) is installation-wide too. Scoping this to one organization would " +
      "under-report, permit the button, and then fail with a 409 — the mismatch this census " +
      "exists to remove. Returns an integer count, never a row.",
  },
  // The next two are NOT statement scopes — neither function contains a single
  // SQL character. They are artifacts of the SLICER, declared so the pinned set
  // stays exact rather than exempted, for the same reason as `roleUsage` above.
  //
  // `DECLARATION` recognises `function` and `const x = (` at column 0, and
  // nothing else — so `export interface RoleUsage { … }` is invisible to it and
  // the interface lands inside the slice of the function BEFORE it (`deleteRole`,
  // whose slice then runs on to `roleUsageTotal`). The interface's field list
  // spells `system_messages: number`, and `roleUsageTotal` adds those same fields
  // up, so the dumb scan sees the table name in both.
  //
  // Pinned `org: false, user: false` because there is nothing to scope: the SQL
  // that actually touches the table is `roleUsage` above, and that is where the
  // scope decision is stated and checked.
  deleteRole: {
    org: false,
    user: false,
    why:
      "Slicer artifact, not a statement: its slice absorbs the `RoleUsage` interface declared " +
      "after it, whose field list names `system_messages`. The statement it really contains — " +
      "the deleteReturning — touches `roles` only.",
  },
  roleUsageTotal: {
    org: false,
    user: false,
    why:
      "Slicer artifact, not a statement: a pure sum of the `RoleUsage` fields, so it names " +
      "`system_messages` as a property rather than as a table. No SQL, no scope to declare.",
  },
};

describe("system messages — every statement declares its scope", () => {
  const discovered = messageTableSites();
  const declared = Object.entries(SCOPE_SITES);

  it("finds the statements it is meant to be guarding", () => {
    // A control that cannot fail is not a control. If the discovery regex or the
    // function slicer stops working, every assertion below would pass on an empty
    // set — so the set is pinned by name and by size.
    expect(
      discovered.size,
      "The System Messages statement set changed size. If a function was added, declare it " +
        "in SCOPE_SITES with its reason; if one was removed, delete its entry."
    ).toBe(Object.keys(SCOPE_SITES).length);
    expect([...discovered.keys()].sort()).toEqual(Object.keys(SCOPE_SITES).sort());
  });

  it("has no undeclared statement touching either table", () => {
    const undeclared = [...discovered.keys()].filter((name) => !(name in SCOPE_SITES));
    expect(
      undeclared,
      "A statement that reads or writes dbo.system_messages / system_message_dismissals was " +
        "added without declaring its scope. Add it to SCOPE_SITES: `org: true` means the SQL " +
        "names `organization_id`, `user: true` means it also names `user_id`."
    ).toEqual([]);
  });

  it("has no stale declaration", () => {
    const stale = declared.map(([name]) => name).filter((name) => !discovered.has(name));
    expect(
      stale,
      "A declared statement no longer exists — renamed, moved or deleted. Update SCOPE_SITES " +
        "rather than deleting the entry silently: the entry is what pinned the statement's scope."
    ).toEqual([]);
  });

  it("enforces the declared scope against the SQL", () => {
    const wrong: string[] = [];
    for (const [name, site] of declared) {
      const fn = discovered.get(name);
      if (!fn) continue;
      const hasOrg = fn.code.includes("organization_id");
      const hasUser = fn.code.includes("user_id");
      if (site.org !== hasOrg) {
        wrong.push(`${name}: declares org: ${site.org} but ${hasOrg ? "does" : "does not"} name organization_id`);
      }
      if (site.user !== hasUser) {
        wrong.push(`${name}: declares user: ${site.user} but ${hasUser ? "does" : "does not"} name user_id`);
      }
    }
    expect(
      wrong,
      "A statement's scope disagrees with what it declares. `user_id` missing where it is " +
        "declared means a dismissal can be written against the wrong person — which silently " +
        "hides a notice somebody has not read, with no error anywhere. `organization_id` " +
        "missing means one tenant can read or write another's notice."
    ).toEqual([]);
  });

  it("CONTROL: the scope checker actually discriminates", () => {
    // The enforcement above is a substring search, so prove it can FAIL before
    // trusting it to pass. Both fragments are shaped like the real statement and
    // differ from it only in the token whose absence is the bug.
    // ⚠ These fixtures are SINGLE-quoted on purpose — they stand in for the
    // shape of real statement text — so they must not contain a table prefix.
    // `driver/libsql.test.ts` scans this file for exactly that and would fail,
    // pointing at a feature that has nothing to do with this control.
    const orgless = stripComments(
      'await execute("SELECT id FROM messages WHERE id = @id", { id });'
    );
    const userless = stripComments(
      'await execute("INSERT INTO dismissals (message_id) VALUES (@messageId)", {});'
    );
    expect(orgless.includes("organization_id")).toBe(false);
    expect(userless.includes("user_id")).toBe(false);
    // …and the same shape WITH the token passes, so the control is not failing
    // for an unrelated reason (a broken stripComments, an empty string).
    const scoped = stripComments(
      'await execute("SELECT id FROM messages WHERE id = @id AND organization_id = @org", { id });'
    );
    expect(scoped.includes("organization_id")).toBe(true);
  });

  it("removes dismissals explicitly, because there is no foreign key to cascade", () => {
    // The schema deliberately declares no FK (a deleted message must not be
    // blocked by its dismissals), so the cleanup is application code and can be
    // dropped by accident with nothing to notice.
    const del = functionNamed(QUERIES, "deleteSystemMessage");
    expect(
      del.code.includes("DELETE FROM dbo.system_message_dismissals"),
      "deleteSystemMessage no longer deletes the dismissal rows. There is no foreign key and " +
        "no cascade, so dropping this leaves rows keyed by a message id that no longer exists — " +
        "invisible until the id is reused and a user's notice is already closed for them."
    ).toBe(true);
    // Order matters, and it is the reason the missing org clause on the second
    // statement is safe: the guarded delete has already proved the id is ours.
    const messageDelete = del.code.indexOf("deleteReturning");
    const dismissalDelete = del.code.indexOf("DELETE FROM dbo.system_message_dismissals");
    expect(messageDelete).toBeGreaterThanOrEqual(0);
    expect(
      messageDelete < dismissalDelete,
      "The dismissal cleanup now runs BEFORE the organization-scoped message delete. It is " +
        "only safe because the guarded delete runs first and returns false without touching " +
        "anything; reversed, a refused cross-organization delete wipes that message's close-outs."
    ).toBe(true);
  });

  it("parses `audience` in exactly one place", () => {
    const callers = functionsIn(source(QUERIES))
      .filter((fn) => fn.code.includes("messageAudienceRoles("))
      .map((fn) => fn.name);
    expect(
      callers,
      "More than one function now parses `audience`. The row's audience is a JSON string and " +
        "the API's is a string[]; a second parser is a second chance to disagree — and the " +
        "disagreement shows up as one endpoint serving roles and another serving raw JSON."
    ).toEqual(["toSystemMessage"]);
  });

  it("keeps `[]` and NULL distinguishable on the way IN as well as out", () => {
    // The read path is covered above. This is the write path: collapsing '[]' to
    // NULL here makes "delivered to nobody" unreachable through the API, and the
    // admin sees a saved selection that is quietly the opposite of what they chose.
    const ser = functionNamed(QUERIES, "serializeAudience");
    expect(ser.code).toContain("audience === null ? null : JSON.stringify(audience)");
  });

  it("uses `??` for the non-nullable fields and value-presence for the nullable one", () => {
    // Pins a real 500. An earlier revision used a `hasOwnProperty` presence check
    // for `body`, on the theory that `??` would mistake "" for "absent". The route
    // (like updateForm) passes `body: parsed.data.body`, so a title-only request
    // carries the key with the value `undefined`; hasOwnProperty answered
    // "present" and the driver was handed `undefined` to bind. `??` handles
    // exactly that. `audience`, being nullable, genuinely needs the opposite test:
    // absent ("change only the title") and explicit null ("show this to everyone
    // again") are two different instructions.
    const upd = functionNamed(QUERIES, "updateSystemMessage");
    expect(upd.code).toContain("data.title ?? existing.title");
    expect(upd.code).toContain("data.body ?? existing.body");
    expect(upd.code).toContain("data.active ?? existing.active");
    expect(upd.code).toContain("data.audience === undefined");
    expect(
      upd.code.includes("hasOwnProperty"),
      "updateSystemMessage is back to a hasOwnProperty presence check, which is what 500'd the " +
        "PUT route: the route always supplies the key, so 'present' is answered for a value of " +
        "`undefined` and the driver is asked to bind it. Comments are stripped before this " +
        "check, so a MENTION of hasOwnProperty is fine — a call is not."
    ).toBe(false);
  });

  it("projects every reader through the one shared column list", () => {
    // "Kept in one place so a new column cannot be added to the table and missed
    // by one of the four readers." That is the comment's claim; this is the check.
    for (const name of [
      "listSystemMessages",
      "listActiveSystemMessagesForUser",
      "getSystemMessage",
      "createSystemMessage",
    ]) {
      expect(
        functionNamed(QUERIES, name).code.includes("SYSTEM_MESSAGE_COLUMNS"),
        `${name} no longer projects through SYSTEM_MESSAGE_COLUMNS. A hand-written column list ` +
          "here is how a newly added column reaches three endpoints and not the fourth."
      ).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// 4. The cap — 3, in SQL, once, applied to the row set the filters produced.
// -----------------------------------------------------------------------------
describe("the active list — capped at three, in the query", () => {
  const active = functionNamed(QUERIES, "listActiveSystemMessagesForUser");

  it("caps at 3 through the dialect's row window, not with TOP", () => {
    expect(active.code).toContain("pageSize: 3");
    // `SELECT TOP n` is SQL Server-only; the shared driver test bans it from any
    // file under src/. Asserting the absence locally keeps the failure in the
    // file that caused it.
    expect(
      /\bTOP\s*\d/.test(active.code),
      "The active list is spelling its row window with TOP. It is SQL Server-only and libSQL " +
        "rejects the statement with SQL_PARSE_ERROR, so the strip would 500 under DB_MODE=turso " +
        "and work everywhere else — the hardest shape of bug to notice."
    ).toBe(false);
  });

  it("applies the audience filter and the close-out filter in the SAME statement as the cap", () => {
    // The most valuable mechanical claim in this file. Filtering after the page
    // is `list.slice(0, N).filter(pred)` — a correctness bug, not a layout
    // choice: the API says "here are your notices" and the caller quietly denies
    // the existence of the ones past the third. Verified live: deleting the
    // newest of four messages back-filled the strip with a message that had been
    // invisible, which a slice-then-filter implementation cannot do.
    // ⚠ The slice MUST be bounded by the next property, not run to the end of the
    // function. Slicing from `where:` to the end includes the argument object and
    // the return statement, so a mutation that moves the audience test OUT of the
    // WHERE into a trailing `.audience.includes(...)` still contains the word
    // `audience` and this assertion passes while describing the bug as correct.
    // (Measured: it did exactly that before the bound was added.)
    const whereStart = active.code.indexOf("where:");
    const orderStart = active.code.indexOf("orderBy:");
    expect(whereStart, "no `where:` property in the selectPage call").toBeGreaterThanOrEqual(0);
    expect(orderStart, "no `orderBy:` property in the selectPage call").toBeGreaterThan(whereStart);
    const where = active.code.slice(whereStart, orderStart);
    expect(
      where.includes("orderBy"),
      "CONTROL: the where-slice is not bounded — it ran past the property it was reading, " +
        "which makes the assertion below satisfiable by anything later in the function."
    ).toBe(false);
    expect(
      where.includes("audience"),
      "The audience predicate has drifted out of the WHERE the cap applies to. If it is being " +
        "applied to the returned rows instead, a user entitled to three notices can be shown " +
        "one — the rest sit unreturned behind the cap. Re-applying it in a trailing `.filter()` " +
        "looks equivalent on a small table and is the bug."
    ).toBe(true);
    expect(
      active.code.includes("NOT EXISTS"),
      "The close-out exclusion is no longer a NOT EXISTS in the same statement. `NOT IN` over a " +
        "column that could ever hold NULL evaluates to UNKNOWN and returns no rows at all — a " +
        "user with no dismissals would see an empty strip."
    ).toBe(true);
    expect(
      active.code.includes("NOT IN"),
      "The active-list query is using NOT IN. Over a nullable column it evaluates to UNKNOWN " +
        "and the whole query returns nothing. NOT EXISTS is the form that is safe here."
    ).toBe(false);
  });

  it("does not filter or slice the result a second time", () => {
    expect(
      /\.(filter|slice|splice)\(/.test(active.code),
      "The capped result is being filtered or sliced after the query. The cap has already been " +
        "applied, so anything done to the returned rows can only REMOVE notices the user is " +
        "entitled to — never back-fill the ones the cap excluded."
    ).toBe(false);
  });

  it("orders by a total order, so the cap picks a deterministic three", () => {
    expect(
      active.code.includes("m.created_at DESC, m.id DESC"),
      "The active list's ORDER BY lost its id tie-breaker. Two messages added inside the same " +
        "millisecond would then be ordered arbitrarily, and the database is free to return them " +
        "in a different sequence for the page than it would for a count."
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 5. The row window — both dialects, and they must not agree by accident.
// -----------------------------------------------------------------------------
describe("selectPage — the two spellings of the row window", () => {
  const request = { select: "id", from: "things", where: "", orderBy: "id" };

  it("spells the window per dialect", () => {
    const onSqlServer = sqlserverDialect.selectPage(request);
    const onTurso = tursoDialect.selectPage(request);
    expect(onSqlServer).toContain("OFFSET @offset ROWS");
    expect(onSqlServer).toContain("FETCH NEXT @pageSize ROWS ONLY");
    expect(onTurso).toContain("LIMIT @pageSize OFFSET @offset");
  });

  it("CONTROL: the two dialects do not produce the same statement", () => {
    // If selectPage silently fell back to one implementation, both assertions
    // above could pass on the same string and the Turso path would be untested.
    expect(sqlserverDialect.selectPage(request)).not.toBe(tursoDialect.selectPage(request));
  });
});

// -----------------------------------------------------------------------------
// 6. Schema — both dialects, and the driver's column sets.
// -----------------------------------------------------------------------------
const SQLSERVER_DDL = sqlserverDialect.ddl.join("\n");
const TURSO_DDL = tursoDialect.ddl.join("\n");

/** The text of one CREATE TABLE, up to the next CREATE. */
function tableBody(ddl: string, table: string): string {
  const pattern = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:dbo\\.)?${table}\\b([\\s\\S]*?)(?=CREATE\\s+(?:TABLE|INDEX)|CREATE\\s+UNIQUE\\s+INDEX|$)`,
    "i"
  );
  const match = pattern.exec(ddl);
  expect(match, `no CREATE TABLE for ${table}`).toBeTruthy();
  return match![1];
}

describe("schema — the same two tables on both engines", () => {
  for (const [engine, ddl] of [
    ["sqlserver", SQLSERVER_DDL],
    ["turso", TURSO_DDL],
  ] as const) {
    it(`declares both tables on ${engine}`, () => {
      expect(tableBody(ddl, "system_messages")).toContain("audience");
      expect(tableBody(ddl, "system_messages")).toContain("organization_id");
      expect(tableBody(ddl, "system_messages")).toContain("active");
      // The composite key is the idempotency mechanism for a double-clicked
      // close. Without it the portable INSERT ... SELECT ... WHERE NOT EXISTS is
      // the only thing standing between a user and a duplicate-key error.
      expect(
        tableBody(ddl, "system_message_dismissals"),
        "the (message_id, user_id) primary key is gone. It is both the idempotency mechanism " +
          "for a double-clicked close and the index the active-list query reads by."
      ).toMatch(/PRIMARY KEY\s*\(\s*message_id\s*,\s*user_id\s*\)/i);
    });
  }

  it("declares the covering index on both engines, through indexGuard", () => {
    // Declared via indexGuard so expectedIndexNames() sees it and the boot-time
    // "N indexes MISSING" warning stays honest — a bare name check would be
    // satisfied by an index on the wrong columns.
    expect(expectedIndexNames(sqlserverDialect.ddl)).toContain("IX_system_messages_org_active");
    expect(expectedIndexNames(tursoDialect.ddl)).toContain("IX_system_messages_org_active");
  });

  it("self-heals `audience` on both engines for a database that booted an earlier revision", () => {
    // initDb() runs this ladder at every boot. A database that already has the
    // table (so the CREATE is skipped) but not the column would otherwise fail at
    // runtime with "Invalid column name 'audience'" — on the developer's own
    // machine and nowhere else.
    expect(SQLSERVER_DDL).toContain("ALTER TABLE dbo.system_messages ADD audience");
    const tursoAdds = tursoDialect.addColumns.map((c) => `${c.table}.${c.column}`);
    expect(
      tursoAdds,
      "the Turso self-heal for system_messages.audience is gone. SQLite has no " +
        "ADD COLUMN IF NOT EXISTS, so this list is the only thing that repairs a database " +
        "created by an earlier revision of this branch."
    ).toContain("system_messages.audience");
  });

  it("keeps `audience` out of the driver's coercion sets", () => {
    // `audience` holds a JSON array of roles, the same storage form as
    // form_fields.roles. Coercing it to a boolean or to a Date would corrupt it
    // on the way out of SQLite, and the API would serve `false` or a RangeError.
    expect(BOOLEAN_COLUMNS.has("audience")).toBe(false);
    expect(TIMESTAMP_COLUMNS.has("audience")).toBe(false);
    // `active` IS in BOOLEAN_COLUMNS (shared with several other tables) — the
    // control that this check is reading a real set and not an empty one.
    expect(BOOLEAN_COLUMNS.has("active")).toBe(true);
    // dismissed_at reads back as a string on SQLite and a Date on SQL Server;
    // this set is what unifies them.
    expect(TIMESTAMP_COLUMNS.has("dismissed_at")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 7. Routes — the reader/authoring split, and where the guard sits.
// -----------------------------------------------------------------------------
const ROUTER_FILE = "../routes/systemMessages.ts";

/**
 * One route registration's full text — from its own `systemMessagesRouter.x(`
 * up to the next registration. It runs to the NEXT REGISTRATION rather than to
 * the first `;`, because a handler body contains semicolons: slicing on one
 * returns a fragment of the prologue and makes a correct handler look like it
 * never called its reader.
 */
function registration(method: string, path: string): string {
  const routes = source(ROUTER_FILE);
  const marker = `systemMessagesRouter.${method}("${path}",`;
  const at = routes.indexOf(marker);
  expect(at, `no ${method.toUpperCase()} ${path} registration found`).toBeGreaterThanOrEqual(0);
  const next = routes.indexOf("systemMessagesRouter.", at + marker.length);
  return stripComments(routes.slice(at, next === -1 ? routes.length : next));
}

const READERS: Array<[string, string]> = [
  ["get", "/active"],
  ["post", "/:id/dismiss"],
];
const AUTHORS: Array<[string, string]> = [
  ["get", "/"],
  ["post", "/"],
  ["put", "/:id"],
  ["delete", "/:id"],
];

describe("system messages — route guards", () => {
  it("lets any signed-in user read and close, and only admins author", () => {
    for (const [method, path] of READERS) {
      const line = registration(method, path);
      expect(line, `${method} ${path} lost its auth guard`).toContain("requireAuth");
      expect(
        line.includes('requireRoles("admin")'),
        `${method} ${path} is ${method.toUpperCase()} ${path}. It is a READER: every signed-in ` +
          "user has to be able to see their own notices and close them out, so an admin-only " +
          "guard makes the feature invisible to the people it is for."
      ).toBe(false);
    }
    for (const [method, path] of AUTHORS) {
      const line = registration(method, path);
      expect(line).toContain("requireAuth");
      expect(
        line,
        `${method.toUpperCase()} ${path} is an authoring route and must stay admin-only. The ` +
          "list is asserted whole rather than with toContain('admin') so that a guard quietly " +
          "widened to a second role cannot pass."
      ).toContain('requireRoles("admin")');
    }
  });

  it("puts the guard in middleware position, so it answers BEFORE the body schema", () => {
    // Load-bearing, and it is an ordering fact rather than a stylistic one. The
    // body is validated with an inline safeParse INSIDE the handler, so a guard
    // written as a call in the handler body would run after validation — and a
    // malformed anonymous request to an admin-only route would then be answered
    // 400 "Validation failed" instead of 401, which is a probeable oracle for the
    // schema of a route nobody is allowed to call.
    for (const [method, path] of [...READERS, ...AUTHORS]) {
      const line = registration(method, path);
      const handlerStart = line.indexOf("async (req, res");
      expect(handlerStart, `${method} ${path} is not an async handler`).toBeGreaterThanOrEqual(0);
      expect(
        line.slice(0, handlerStart),
        `${method.toUpperCase()} ${path} no longer carries its guard as a middleware argument. ` +
          "Moved into the handler body it runs AFTER safeParse, which answers 400 rather than " +
          "401 for an anonymous caller and leaks the body shape of an admin-only route."
      ).toContain("requireAuth");
    }
  });

  it("keeps every guard on its own route rather than at the router", () => {
    // The readers and the authors need DIFFERENT guards, so a router-level
    // requireRoles would either lock the readers or open the authors. This is a
    // check rather than a comment because a `router.use` added at the top reads
    // like a tidy-up.
    expect(
      source(ROUTER_FILE).includes("systemMessagesRouter.use("),
      "a router-level guard was added. The two readers must be reachable by every signed-in " +
        "role and the four authoring routes by admins only, which one router-wide guard cannot " +
        "express — it either locks users out of their own notices or opens POST/PUT/DELETE."
    ).toBe(false);
  });

  it("registers the literal /active before the parameterised /:id routes", () => {
    const routes = source(ROUTER_FILE);
    const literal = routes.indexOf('systemMessagesRouter.get("/active"');
    const param = routes.indexOf('systemMessagesRouter.put("/:id"');
    expect(literal).toBeGreaterThanOrEqual(0);
    expect(param).toBeGreaterThanOrEqual(0);
    expect(
      literal < param,
      "/active is now declared after a /:id route. Express matches in registration order, so a " +
        "later GET /:id — or any single-segment route added above it — captures 'active' as an " +
        "id and the strip 404s on every page load."
    ).toBe(true);
  });

  it("lets a user close a notice that has since been switched off", () => {
    // Deliberate. The notice was rendered while it was active; an admin who
    // deactivates it between the render and the click must not turn the user's
    // click into a 404 they cannot act on.
    const dismiss = registration("post", "/:id/dismiss");
    expect(
      dismiss.includes("active"),
      "the dismiss route now checks `active`. A user looking at a notice an admin switched off " +
        "mid-session would get an error for clicking the X they were shown. The only thing the " +
        "route needs to resolve is the organization and the id."
    ).toBe(false);
  });

  it("records the author from the session, not from the request body", () => {
    const create = registration("post", "/");
    expect(
      create.includes("createdBy: req.user"),
      "POST no longer takes created_by from the session. A body-supplied author is an audit " +
        "field the caller controls, and audit fields the caller controls are not audit fields."
    ).toBe(true);
  });

  it("agrees with the route inventory about which routes are admin-only", () => {
    const listed = ROUTES.filter((r) => r.path.startsWith("/api/system-messages"));
    expect(
      listed.map((r) => `${r.method.toUpperCase()} ${r.path}:${r.auth}`).sort(),
      "The route inventory disagrees with the router. It drives the boot-time auth self-check " +
        "and swagger.test.ts, so a reader marked `admin` here documents an admin-only strip that " +
        "every role is supposed to see — and the reverse under-states an authoring route."
    ).toEqual(
      [
        "GET /api/system-messages/active:staff",
        "POST /api/system-messages/{id}/dismiss:staff",
        "GET /api/system-messages:admin",
        "POST /api/system-messages:admin",
        "PUT /api/system-messages/{id}:admin",
        "DELETE /api/system-messages/{id}:admin",
      ].sort()
    );
    // `staff` here is the PERMISSIVE value — a valid bearer token of ANY role —
    // and it is the right one for a reader: there is no "any signed-in user"
    // value, and `none` would be wrong in the dangerous direction.
    expect(
      listed
        .filter((r) => r.auth === "staff")
        // `ROUTES` records methods in lower case — the assertion above upper-cases them
        // because it is describing the HTTP method to a reader.
        .map((r) => `${r.method.toUpperCase()} ${r.path}`)
        .sort(),
      "The two reader routes are no longer the permissive ones. If a reader was changed to " +
        "`admin`, the strip stops being served to the people it is for; if an authoring route " +
        "was changed to `staff`, every signed-in user can post notices."
    ).toEqual(["GET /api/system-messages/active", "POST /api/system-messages/{id}/dismiss"].sort());
    for (const route of listed) {
      expect(route.tags, `${route.method} ${route.path} lost its swagger tag`).toBe(
        "System Messages"
      );
    }
  });
});

// -----------------------------------------------------------------------------
// 8. Wiring — the router is mounted, and the cap is not re-applied downstream.
// -----------------------------------------------------------------------------
describe("system messages — wiring", () => {
  it("mounts the router in the API entry point", () => {
    expect(source("../index.ts")).toContain('app.use("/api/system-messages", systemMessagesRouter)');
  });

  it("does not re-apply the cap in the component that renders the strip", () => {
    // The cap is a query constant. A `slice(0, 3)` in the component would look
    // like the same rule stated twice and would in fact be a second, weaker
    // statement of it — the API would keep answering with rows the UI discards,
    // and any other consumer would show a different number of notices.
    //
    // Cross-package on purpose: the claim is that the rule lives in ONE place,
    // and the only way to check that is to read both places.
    const strip = readAt(join(HERE, "..", "..", "..", "client", "src", "components", "SystemMessageBar.tsx"));
    // CONTROL, and it is doing two jobs. (a) It proves the file was really read —
    // an empty string would satisfy the assertion below. (b) It proves
    // stripComments DOES something: the file is documented with a `rows.slice(0, 3)`
    // in a block comment, and that is the only reason the call vanishes. Without
    // this control a broken stripper turns the assertion into a no-op.
    expect(
      strip.includes("rows.slice(0, 3)"),
      "CONTROL: the component no longer carries its `rows.slice(0, 3)` warning comment, so this " +
        "assertion can no longer distinguish 'the stripper works' from 'the file was not read'."
    ).toBe(true);
    expect(
      /\.(slice|splice)\(/.test(stripComments(strip)),
      "SystemMessageBar is slicing the array it was served. The three-row cap belongs to the " +
        "query (see listActiveSystemMessagesForUser); slicing here re-applies a weaker version " +
        "of it in the one place that can see neither the user's dismissals nor their audiences."
    ).toBe(false);
    // `.filter()` is deliberately NOT forbidden here: the component removes a
    // just-dismissed message from local state, which is the optimistic update for
    // the X and has nothing to do with the cap.
  });
});
