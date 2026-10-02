/**
 * Repair `users.school_id` for accounts still carrying a LEGACY school id.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until ~2026-09-29 this app was pointed at
 * `wcpss-sql-serverless-freetier` / `school-form-data`. Every `school_id` written
 * in that period is an id from THAT database's `schools` table. The app then
 * moved to `wcpsssqlelasticpool` / `wcpss-google-forms`, which holds the same 235
 * school NAMES but numbers 128 of them differently: identical up to Centennial
 * Middle (49), then exactly one higher from Combs (50) onward, plus two schools
 * whose position in the list is swapped (M-18 @ Woods Creek, Parkside). The rows
 * and the accounts came across unchanged, so an id that meant "Lufkin Road
 * Middle" now names "Lockhart Elementary".
 *
 * WHAT IT DOES
 * ------------
 * Translates the id through the NAME, never through arithmetic:
 *
 *     legacy name  = legacy.schools.name WHERE id = users.school_id
 *     new id       = live.schools.id        WHERE name = legacy name
 *
 * Because the name is the key, the +1 shift AND both swapped pairs are handled by
 * the same rule and no offset is hard-coded anywhere.
 *
 * THE CONSEQUENCE THAT MAKES THIS URGENT
 * --------------------------------------
 * A School Contact is scoped by `canAccessSchool`, which compares `school_id`.
 * While both the accounts and the submissions were in the legacy id space the
 * mismatch was invisible — every contact saw their own rows. It stopped being
 * invisible the moment a submission was created against the LIVE id space: those
 * rows land on the corrected id, which no legacy-scoped contact can see. And an
 * admin editing any user's school (a name lookup, which resolves to a live id)
 * drops that user into the live space too.
 *
 * SAFETY
 * ------
 *  - Dry run by default. `--apply` writes, and writes only what the dry run listed.
 *  - Skips an account created after the switch (its id was resolved live already).
 *  - Reports an account as DONE when its current id already names, in the live
 *    table, the school its reading points at — exactly the state a previous run
 *    leaves behind. This test is consulted before the editing guard below.
 *  - Otherwise skips an account whose school_id differs from the 2026-09-24 role
 *    migration's reading of it, because that means a human has set it since and the
 *    human value wins. This is what protects an account an admin corrected by hand.
 *  - Never invents a school: a legacy id whose name is absent from the live table
 *    is reported as UNRESOLVED and left alone.
 *  - `<> @to` guard repeated on the write, so a row changed between the read and
 *    the write cannot be clobbered by the plan that was printed.
 *
 * USAGE
 *   cd server
 *   npm run backfill:user-school-id            # dry run: prints the plan, writes nothing
 *   npm run backfill:user-school-id -- --apply # applies exactly what the dry run listed
 *
 * The legacy server is only needed until this runs once. Override the target with
 * LEGACY_DB_SERVER / LEGACY_DB_DATABASE if the old database is ever moved.
 *
 * RUNNING IT TWICE
 * ----------------
 * This maps an ID SPACE, not an id, so it is NOT idempotent by construction: feed
 * it a translated id and it will happily produce the next school along the list.
 * Idempotence comes from an explicit test — see `intendedName` in main(). Measured
 * on 2026-10-01, after the first apply: the 16 accounts with a 2026-09-24 reading
 * stopped, but the one account without a reading still wanted to move (131 -> 132,
 * and 133 on the run after that). That account is now listed in
 * READING_PRE_REPAIR so it stops too.
 */
import "../config/env.js";
import sql from "mssql";
import { getClient, getDbKind } from "./pool.js";
import { getDialect } from "./dialect/index.js";

/** The database the app used before ~2026-09-29. Read-only; used for its school NAMES. */
const LEGACY = {
  server: process.env.LEGACY_DB_SERVER ?? "wcpss-sql-serverless-freetier.database.windows.net",
  database: process.env.LEGACY_DB_DATABASE ?? "school-form-data",
};

/**
 * The moment the app switched databases. A submission written at or after this
 * resolves its school against the live `schools` table, so anything created at or
 * after it is already in the live id space. The value is bracketed by measurement:
 * the last legacy-id submission is 2026-09-28 and the first live-id one is
 * 2026-09-30.
 */
const SWITCH_AT = Date.parse(process.env.SCHOOL_ID_SWITCH_AT ?? "2026-09-29T00:00:00Z");

/**
 * The 2026-09-24 role migration's readings of `school_id`, transcribed from
 * `docs/plans/role-migration-2026-09-24.md`. Its undo statement only ever touched
 * `role`, so these are READINGS, not writes — which makes the document an
 * independent record of what each id was on that date and the only evidence of
 * which accounts a human has edited since.
 *
 * Keyed the way the document writes it (an email). Matching falls back to the
 * email's local part and then to the display name, because the document is not
 * consistent about which one it recorded. Accounts the document does not list are
 * covered by READING_PRE_REPAIR below; `readingFor` searches both.
 */
const READING_0924: Array<{ key: string; id: number }> = [
  { key: "swatkins", id: 38 },
  { key: "pwtest", id: 11 },
  { key: "mgainey", id: 16 },
  { key: "jmerry", id: 77 },
  { key: "kawalker", id: 19 },
  { key: "lkovalaske", id: 88 },
  { key: "tgillespie2", id: 124 },
  { key: "cchadwick", id: 47 },
  { key: "ttaylor5", id: 184 },
  { key: "aworley", id: 91 },
  { key: "kmoynihan", id: 55 },
  { key: "mdunning3", id: 58 },
  { key: "kbowling", id: 158 },
  { key: "gcherry1", id: 56 },
  { key: "jhowland", id: 164 },
  { key: "ekleimeyer", id: 206 },
  { key: "klarsen", id: 207 },
  { key: "mgreen2", id: 79 },
  { key: "plprice", id: 175 },
  { key: "ewilmoth", id: 49 },
  { key: "jcuccurullo", id: 105 },
  { key: "hoxendine", id: 120 },
  { key: "kganzel", id: 17 },
  { key: "mmaul", id: 42 },
  { key: "kmcilhargey", id: 64 },
  { key: "rhaymore", id: 185 },
  { key: "wwheeler3", id: 130 },
  { key: "lhetzell", id: 188 },
  { key: "rwest2", id: 122 },
  { key: "lmejeur", id: 89 },
  { key: "mcorey", id: 69 },
  { key: "jstern", id: 145 },
  { key: "mwalter", id: 135 },
  { key: "scmckay", id: 189 },
  { key: "hmilligan", id: 128 },
  { key: "jstallings2", id: 97 },
];

/**
 * The same kind of reading as READING_0924, but taken from the pre-repair state of
 * the live `users` table on 2026-10-01 rather than from the 2026-09-24 document,
 * for accounts that document does not list.
 *
 * An account needs a reading for two reasons: it is what tells a repaired account
 * from a hand-edited one, and without one the translation above walks forward one
 * school on every run (it maps an id space, not an id).
 */
const READING_PRE_REPAIR: Array<{ key: string; id: number }> = [
  { key: "key.kevin", id: 130 },
];

type Reading = { key: string; id: number };

interface UserRow {
  id: number;
  email: string;
  display_name: string | null;
  role: string;
  school_id: number | null;
  created_at: string | Date;
}

type Action =
  | "REMAP"
  | "skip: created after the switch"
  | "skip: school edited since 2026-09-24"
  | "no change: already in the live id space"
  | "no change: same school in both id spaces"
  | "UNRESOLVED: legacy name absent from the live schools table";

interface Plan {
  id: number;
  email: string;
  created: string;
  current: number;
  currentName: string;
  legacyName: string;
  to: number | null;
  toName: string;
  action: Action;
}

const day = (v: string | Date): string => new Date(v).toISOString().slice(0, 10);

/** Open the legacy database. Deliberately NOT `sql.connect()`. */
async function openLegacy(): Promise<sql.ConnectionPool> {
  // `sql.connect()` hands back the EXISTING global pool when one is already open
  // and silently ignores the second config — which once made a two-database probe
  // compare a database against itself and report perfect agreement. A private
  // pool per target is the only safe way to read two servers at once.
  const pool = new sql.ConnectionPool({
    server: LEGACY.server,
    database: LEGACY.database,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: { encrypt: true, trustServerCertificate: true },
    connectionTimeout: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 60000),
    requestTimeout: Number(process.env.DB_REQUEST_TIMEOUT_MS ?? 120000),
  });
  await pool.connect();
  return pool;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = getClient();
  const dialect = getDialect(getDbKind());

  if (dialect.kind !== "sqlserver") {
    // eslint-disable-next-line no-console
    console.error(
      `[user-school] ABORT: this repair translates between the two Azure SQL school id spaces. ` +
        `The active database is "${dialect.kind}", which has no such history. Nothing written.`
    );
    process.exit(1);
  }

  const liveSchools = await db.query<{ id: number; name: string }>(
    "SELECT id, name FROM dbo.schools ORDER BY id"
  );
  const liveById = new Map(liveSchools.map((s) => [Number(s.id), String(s.name)]));

  // name -> live id. Lowest id wins a duplicate name, matching the tie-break the
  // display subquery uses. A duplicate is reported, because it would make this
  // mapping ambiguous and the whole repair rests on the name being a key.
  const liveIdByName = new Map<string, number>();
  const duplicates: string[] = [];
  for (const s of liveSchools) {
    const key = String(s.name ?? "").trim().toLowerCase();
    if (!key) continue;
    if (liveIdByName.has(key)) duplicates.push(`${s.name} (ids ${liveIdByName.get(key)}, ${s.id})`);
    else liveIdByName.set(key, Number(s.id));
  }

  let legacy: sql.ConnectionPool;
  try {
    legacy = await openLegacy();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[user-school] Could not read the legacy school list from ${LEGACY.server}/${LEGACY.database}: ` +
        `${err instanceof Error ? err.message : err}\n` +
        `[user-school] The legacy NAMES are the only sound key for this translation, so rather than guess at ` +
        `an offset the repair stops here. Nothing written.`
    );
    process.exit(1);
  }

  let legacyById: Map<number, string>;
  try {
    const rows = (await legacy.request().query("SELECT id, name FROM dbo.schools ORDER BY id")).recordset as Array<{
      id: number;
      name: string;
    }>;
    legacyById = new Map(rows.map((s) => [Number(s.id), String(s.name)]));
  } finally {
    await legacy.close();
  }

  const users = await db.query<UserRow>(
    "SELECT id, email, display_name, role, school_id, created_at FROM dbo.users ORDER BY id"
  );

  const readings: Reading[] = [...READING_0924, ...READING_PRE_REPAIR];
  const readingFor = (u: UserRow): number | null => {
    const email = String(u.email ?? "").toLowerCase();
    const local = email.split("@")[0];
    const exact = readings.find((r) => r.key.toLowerCase() === email || r.key.toLowerCase() === local);
    if (exact) return exact.id;
    const name = String(u.display_name ?? "").toLowerCase();
    if (!name) return null;
    const byName = readings.find((r) => name.includes(r.key.toLowerCase()));
    return byName ? byName.id : null;
  };

  const plan: Plan[] = [];
  for (const u of users) {
    if (u.school_id === null || u.school_id === undefined) continue;
    const current = Number(u.school_id);
    const currentName = liveById.get(current) ?? "(no such school)";
    const legacyName = legacyById.get(current) ?? "(no such school)";
    const reading = readingFor(u);

    const base = { id: Number(u.id), email: String(u.email), created: day(u.created_at), current, currentName, legacyName };

    let to: number | null = null;
    let toName = "-";
    let action: Action;

    if (currentName === "(no such school)" && legacyName === "(no such school)") {
      // Nothing to translate from. Leave it for a human rather than guess.
      action = "UNRESOLVED: legacy name absent from the live schools table";
    } else if (currentName === legacyName) {
      action = "no change: same school in both id spaces";
    } else {
      const target = liveIdByName.get(legacyName.trim().toLowerCase());
      if (target !== undefined) {
        to = target;
        toName = liveById.get(target) ?? "-";
      }

      // The school this account is SUPPOSED to be on, derived from its reading:
      // a reading is a legacy id, so its NAME comes from the legacy table and its
      // live id from the live table. An account already sitting there has been
      // repaired (or was always right) and needs nothing. This must be tested
      // BEFORE the editing guard, because a repaired account and a hand-edited one
      // are otherwise indistinguishable, and an account with no reading would walk
      // forward one school on every run.
      const intendedId =
        reading === null ? null : liveIdByName.get((legacyById.get(reading) ?? "").trim().toLowerCase()) ?? null;
      const intendedName = intendedId === null ? null : liveById.get(intendedId) ?? null;

      if (Date.parse(String(u.created_at)) >= SWITCH_AT) {
        action = "skip: created after the switch";
      } else if (intendedName !== null && currentName === intendedName) {
        action = "no change: already in the live id space";
      } else if (reading !== null && reading !== current) {
        // A human changed this after the migration snapshot; their value wins.
        action = "skip: school edited since 2026-09-24";
      } else if (target === undefined) {
        action = "UNRESOLVED: legacy name absent from the live schools table";
      } else if (target === current) {
        action = "no change: same school in both id spaces";
      } else {
        action = "REMAP";
      }
    }

    plan.push({ ...base, to, toName, action });
  }

  // eslint-disable-next-line no-console
  console.log(`[user-school] mode: ${apply ? "APPLY" : "dry run"} (db kind: ${dialect.kind})`);
  // eslint-disable-next-line no-console
  console.log(`[user-school] legacy list: ${LEGACY.server}/${LEGACY.database}`);
  // eslint-disable-next-line no-console
  console.log(`[user-school] ${liveSchools.length} live school(s), ${users.length} user(s), ${plan.length} with a school_id`);
  if (duplicates.length) {
    // eslint-disable-next-line no-console
    console.log(`[user-school] WARNING ${duplicates.length} duplicated live school name(s) — lowest id used:`);
    for (const d of duplicates) {
      // eslint-disable-next-line no-console
      console.log(`[user-school]   ${d}`);
    }
  }

  const rank = (a: Action): number => (a === "REMAP" ? 0 : a.startsWith("skip") ? 1 : a.startsWith("UNRESOLVED") ? 2 : 3);
  const counts = new Map<Action, number>();
  for (const p of plan) counts.set(p.action, (counts.get(p.action) ?? 0) + 1);

  const remaps = plan.filter((p) => p.action === "REMAP");
  for (const [action, n] of [...counts.entries()].sort((a, b) => rank(a[0]) - rank(b[0]))) {
    // eslint-disable-next-line no-console
    console.log(`[user-school]   ${String(n).padStart(3)}  ${action}`);
  }

  // eslint-disable-next-line no-console
  console.log("");
  for (const p of [...plan].sort((a, b) => rank(a.action) - rank(b.action) || a.current - b.current)) {
    // eslint-disable-next-line no-console
    console.log(
      `[user-school]   #${p.id} ${p.email} ${p.current} (${p.currentName}) -> ${p.to ?? "-"} (${p.toName})  [legacy: ${p.legacyName}]  ${p.action}`
    );
  }

  // The distinct school_id moves, so the blast radius of the write is readable.
  const moves = new Map<string, { name: string; users: string[] }>();
  for (const p of remaps) {
    const key = `${p.current} -> ${p.to}`;
    const entry = moves.get(key) ?? { name: p.legacyName, users: [] };
    entry.users.push(p.email);
    moves.set(key, entry);
  }
  if (moves.size) {
    // eslint-disable-next-line no-console
    console.log(`\n[user-school] ${moves.size} distinct school_id move(s):`);
    for (const [key, v] of [...moves.entries()].sort((a, b) => Number(a[0].split(" ")[0]) - Number(b[0].split(" ")[0]))) {
      // eslint-disable-next-line no-console
      console.log(`[user-school]   ${key.padEnd(12)} ${v.name.padEnd(38)} ${v.users.length} user(s): ${v.users.join(", ")}`);
    }
  }

  if (!apply) {
    // eslint-disable-next-line no-console
    console.log("[user-school] dry run — nothing written. Re-run with `-- --apply` to apply the list above.");
    process.exit(0);
  }

  let updated = 0;
  let guarded = 0;
  for (const p of remaps) {
    if (p.to === null) continue;
    // The `<>` guard is repeated on the write, so a concurrent change holds.
    // The count comes back as ROWS, not an affected-row figure: the driver's
    // `query()` resolves to `T[]`, so an empty result means the guard held.
    const res = await db.query<{ id: number }>(
      dialect.updateReturning({
        table: "users",
        set: "school_id = @to",
        where: "id = @id AND (school_id IS NULL OR school_id <> @to)",
        returning: ["id"],
      }),
      { id: p.id, to: p.to }
    );
    if (res.length > 0) updated += 1;
    else guarded += 1;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[user-school] updated ${updated} user(s).` +
      (guarded > 0 ? ` ${guarded} skipped by the guard (changed between read and write).` : "")
  );
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[user-school] Failed:", err);
  process.exit(1);
});
