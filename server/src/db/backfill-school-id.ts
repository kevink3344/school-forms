/**
 * Repair `submissions.school_id` where it holds a stale form-level fallback.
 *
 * WHY THIS EXISTS
 * ---------------
 * `school_id` is a DERIVED value: for a district-wide form the school comes from
 * the parent's "School" answer (see `resolveSubmissionSchoolId`), and
 * `form.school_id` is only the fallback for an answer that matches no school.
 * The derivation runs once, at insert. So a row keeps the fallback forever if
 * either of these happened afterwards:
 *
 *   - the schools were imported AFTER the submission arrived (the answer had
 *     nothing to match at the time), or
 *   - the answer was corrected later.
 *
 * The visible symptom is a School column printing the district's placeholder
 * school on rows that name a real one. The consequence that matters more is
 * access: `canAccessSchool` and every school-scoped listing compare `school_id`,
 * so a School Contact cannot open a submission that is demonstrably theirs.
 *
 * Deliberately NOT part of the startup DDL ladder: booting the app must not
 * rewrite production rows. Run it explicitly, and only after reading its plan.
 *
 * USAGE
 *   cd server
 *   npm run backfill:school-id              # dry run: prints the plan, writes nothing
 *   npm run backfill:school-id -- --apply   # applies exactly what the dry run listed
 *
 * Idempotent: it only updates a row whose declared school RESOLVES to a
 * different id than the one stored, so a second run reports no changes.
 *
 * It never invents a school. An answer that matches nothing ("Test School",
 * "Option 23") is left exactly as it is and listed under "unresolved" — those
 * rows are legitimately still on the form's fallback.
 */
import { getClient, getDbKind } from "./pool.js";
import { getDialect } from "./dialect/index.js";

interface DeclaredRow {
  id: number;
  public_id: string;
  form_id: number;
  school_id: number | null;
  declared_school: string | null;
}

interface Change {
  id: number;
  public_id: string;
  from: number | null;
  to: number;
  toName: string;
  declared: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = getClient();
  const dialect = getDialect(getDbKind());

  // The lookup the resolver itself uses: a school name (case-insensitively) to
  // its id. Lowest id wins a duplicate name, which is the tie-break the display
  // subquery applies too (`ORDER BY ff.sort_order, scs.id`).
  const schoolRows = await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM dbo.schools ORDER BY id`
  );
  const byName = new Map<string, { id: number; name: string }>();
  const duplicates: string[] = [];
  for (const s of schoolRows) {
    const key = String(s.name ?? "").trim().toLowerCase();
    if (!key) continue;
    if (byName.has(key)) duplicates.push(`${s.name} (ids ${byName.get(key)!.id}, ${s.id})`);
    else byName.set(key, { id: Number(s.id), name: String(s.name) });
  }

  // Every submission that declares a school at all. The derived-table wrapper is
  // needed because the declared value is a correlated subquery and neither
  // dialect lets a SELECT alias be referenced in the same level's WHERE.
  const rows = await db.query<DeclaredRow>(
    `SELECT t.id, t.public_id, t.form_id, t.school_id, t.declared_school
       FROM (
         SELECT s.id, s.public_id, s.form_id, s.school_id,
                ${dialect.submissionSchoolNameSubquery()} AS declared_school
           FROM dbo.submissions s
       ) t
      WHERE t.declared_school IS NOT NULL
      ORDER BY t.id`
  );

  const changes: Change[] = [];
  const unresolved: { id: number; public_id: string; declared: string }[] = [];
  let alreadyCorrect = 0;

  for (const r of rows) {
    const declared = String(r.declared_school ?? "").trim();
    const match = byName.get(declared.toLowerCase());
    if (!match) {
      unresolved.push({ id: Number(r.id), public_id: r.public_id, declared });
      continue;
    }
    const current = r.school_id === null || r.school_id === undefined ? null : Number(r.school_id);
    if (current === match.id) {
      alreadyCorrect += 1;
      continue;
    }
    changes.push({
      id: Number(r.id),
      public_id: r.public_id,
      from: current,
      to: match.id,
      toName: match.name,
      declared,
    });
  }

  // eslint-disable-next-line no-console
  console.log(`[backfill] mode: ${apply ? "APPLY" : "dry run"} (db kind: ${dialect.kind})`);
  // eslint-disable-next-line no-console
  console.log(`[backfill] ${schoolRows.length} school(s), ${rows.length} submission(s) declare a school`);
  if (duplicates.length) {
    // eslint-disable-next-line no-console
    console.log(`[backfill] WARNING ${duplicates.length} duplicated school name(s), lowest id used:`);
    for (const d of duplicates) console.log(`[backfill]   ${d}`);
  }

  // eslint-disable-next-line no-console
  console.log(`[backfill] ${changes.length} to change, ${alreadyCorrect} already correct, ${unresolved.length} unresolved:`);
  for (const c of changes) {
    // eslint-disable-next-line no-console
    console.log(`[backfill]   #${c.id} ${c.public_id} ${c.from ?? "null"} -> ${c.to} (${c.toName})  [answer: ${c.declared}]`);
  }
  for (const u of unresolved) {
    // eslint-disable-next-line no-console
    console.log(`[backfill]   #${u.id} ${u.public_id} KEPT (no school named "${u.declared}")`);
  }

  if (!apply) {
    // eslint-disable-next-line no-console
    console.log("[backfill] dry run — nothing written. Re-run with `-- --apply` to apply the list above.");
    process.exit(0);
  }

  let updated = 0;
  for (const c of changes) {
    // The `<>` guard is repeated here so a row changed between the read and the
    // write cannot be clobbered by the plan we printed.
    //
    // The count comes back as ROWS, not an affected-row figure: the driver's
    // `query()` resolves to `T[]` on both dialects, and libSQL reports 0
    // affected rows for an UPDATE that carries RETURNING. So the builder emits
    // `OUTPUT INSERTED.id` / `RETURNING id` and an empty result is "the guard
    // held, nothing was written".
    const res = await db.query<{ id: number }>(
      dialect.updateReturning({
        table: "submissions",
        set: "school_id = @to",
        where: "id = @id AND (school_id IS NULL OR school_id <> @to)",
        returning: ["id"],
      }),
      { id: c.id, to: c.to }
    );
    updated += res.length > 0 ? 1 : 0;
  }
  // eslint-disable-next-line no-console
  console.log(`[backfill] updated ${updated} submission(s).`);
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[backfill] Failed:", err);
  process.exit(1);
});
