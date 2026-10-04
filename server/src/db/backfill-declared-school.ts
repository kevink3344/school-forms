/**
 * One-off: fill `submissions.declared_school_name` for rows that predate the
 * column (docs/plans/school-name-reconciliation.md §9.2).
 *
 * WHY IT EXISTS
 * -------------
 * `declared_school_name` records the school name a submission's OWN answers
 * declared — the parent's spelling. New submissions get it at intake, but rows
 * written before the column existed are NULL, so they are invisible to the
 * "School Name Matching" worklist. This script reconstructs the value for those
 * rows using the SAME rule intake used (`planSubmissionFields`), so the backfill
 * and the live path cannot disagree.
 *
 * It writes the parent's spelling (an INPUT), never an app school — `school_id`
 * already holds the resolved app school.
 *
 * Deliberately NOT part of the startup DDL ladder: booting the app must not
 * rewrite production rows (same rule as backfill-school-id.ts).
 *
 * USAGE
 *   cd server
 *   npm run backfill:declared-school              # dry run: prints the plan
 *   npm run backfill:declared-school -- --apply   # applies the plan
 *
 * Idempotent: it only touches rows whose `declared_school_name` IS NULL, so a
 * second run reports nothing to do.
 */
import { getClient, initDb } from "./pool.js";
import { SCHOOL_FIELD_LABELS } from "./dialect/shared.js";
import { planSubmissionFields, type IncomingAnswer } from "../webhook/field-mapping.js";

interface FieldRow {
  id: number;
  label: string;
  type: string;
}

async function main() {
  const apply = process.argv.includes("--apply");
  // initDb() ensures the schema (including `declared_school_name`) exists before
  // the SELECT below touches it.
  await initDb();
  const db = getClient();

  const subs = await db.query<{ id: number; public_id: string; form_id: number }>(
    `SELECT id, public_id, form_id
       FROM dbo.submissions
      WHERE declared_school_name IS NULL
      ORDER BY id`
  );

  // Cache each form's fields once — every submission of a form shares them.
  const fieldsByForm = new Map<number, FieldRow[]>();
  let planned = 0;
  let withSchool = 0;

  for (const s of subs) {
    const formId = Number(s.form_id);
    let fields = fieldsByForm.get(formId);
    if (!fields) {
      fields = await db.query<FieldRow>(
        `SELECT id, label, type FROM dbo.form_fields WHERE form_id = @formId ORDER BY sort_order`,
        { formId }
      );
      fieldsByForm.set(formId, fields);
    }

    // Defined answers, ordered by the field's sort_order to approximate the
    // Google Form's question order; then captured answers by their own order.
    const values = await db.query<{ field_id: number; value: string | null }>(
      `SELECT sv.field_id, sv.value
         FROM dbo.submission_values sv
         JOIN dbo.form_fields ff ON ff.id = sv.field_id
        WHERE sv.submission_id = @id
        ORDER BY ff.sort_order`,
      { id: s.id }
    );
    const adhoc = await db.query<{ label: string; value: string | null }>(
      `SELECT label, value
         FROM dbo.submission_adhoc_fields
        WHERE submission_id = @id
        ORDER BY sort_order`,
      { id: s.id }
    );

    const answers: IncomingAnswer[] = [
      ...values.map((v) => ({ field_id: Number(v.field_id), value: v.value })),
      ...adhoc.map((a) => ({ label: a.label, value: a.value })),
    ];
    const plan = planSubmissionFields(fields, answers, SCHOOL_FIELD_LABELS);
    planned++;
    if (!plan.schoolName) continue; // a form with no school question: leave NULL
    withSchool++;

    // eslint-disable-next-line no-console
    console.log(`[backfill] #${s.id} ${s.public_id} declared="${plan.schoolName}"`);
    if (apply) {
      await db.query(
        `UPDATE dbo.submissions SET declared_school_name = @name WHERE id = @id AND declared_school_name IS NULL`,
        { name: plan.schoolName, id: s.id }
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[backfill] mode: ${apply ? "APPLY" : "dry run"}; ${subs.length} row(s) missing a declared name; ` +
      `${withSchool} declare a school.`
  );
  if (!apply) {
    // eslint-disable-next-line no-console
    console.log("[backfill] dry run — nothing written. Re-run with `-- --apply` to apply.");
  }
  await db.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[backfill] Failed:", err);
  process.exit(1);
});
