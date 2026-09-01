/**
 * One-time backfill script: stamp the `school_year` column on existing rows.
 *
 * The school-year column was added to `dbo.submissions` in schema.ts. Rows
 * created before that migration have `school_year IS NULL`. This script walks
 * those rows and derives the correct school year from each row's `submitted_at`
 * using the same `schoolYearForDate()` helper used at insert time, so both code
 * paths agree.
 *
 * The school year runs Aug 1 -> Jul 31, so e.g. 9/1/2026 -> "2026-2027".
 *
 * Run from `server/`:  npm run backfill:school-year
 *
 * Idempotent: guarded by `school_year IS NULL OR school_year = ''`, so it is
 * safe to re-run — it only touches rows that don't already carry a value.
 */
import { getPool, initDb } from "./pool.js";
import { schoolYearForDate } from "./schema.js";

async function main(): Promise<void> {
  const dbReady = await initDb();
  if (!dbReady) {
    // eslint-disable-next-line no-console
    console.error("[backfill] Database is not ready (initDb returned false).");
    process.exit(1);
  }

  const db = await getPool();
  const rows = await db.request().query(
    `SELECT id, submitted_at
     FROM dbo.submissions
     WHERE school_year IS NULL OR school_year = ''
     ORDER BY submitted_at ASC, id ASC`
  );

  let updated = 0;
  for (const r of rows.recordset) {
    const schoolYear = schoolYearForDate(new Date(r.submitted_at));
    await db.request()
      .input("id", r.id)
      .input("schoolYear", schoolYear)
      .query(
        `UPDATE dbo.submissions
         SET school_year = @schoolYear
         WHERE id = @id`
      );
    updated += 1;
  }

  // eslint-disable-next-line no-console
  console.log(`[backfill] Updated ${updated} submission(s) with a school year.`);
  process.exit(updated > 0 ? 0 : 0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[backfill] Failed:", err);
  process.exit(1);
});
