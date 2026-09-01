import bcrypt from "bcryptjs";
import { initDb, getPool } from "./pool.js";
import { formatSubmissionPublicId, schoolYearForDate } from "./schema.js";
import { env } from "../config/env.js";

/**
 * Seed data:
 *  - A default school
 *  - An admin user (from env or fallback)
 *  - The reference "CDM" form (from the plan) with its fields
 *  - The reference submission (Johnny Smith, Submission ID from the plan)
 */
async function seed() {
  await initDb();
  const pool = await getPool();
  const req = pool.request();

  // 0. Resolve the Academics organization (the tenant that owns all seeded data).
  //    initDb() guarantees the two default orgs exist (see DDL seed block).
  const orgResult = await pool.request()
    .input("slug", "academics")
    .query(`SELECT id FROM dbo.organizations WHERE slug = @slug`);
  const orgId = orgResult.recordset[0].id as number;

  // 1. Default school
  const schoolResult = await req.query(
    `IF NOT EXISTS (SELECT 1 FROM dbo.schools WHERE name = N'Sample School')
       INSERT INTO dbo.schools (name, district) VALUES (N'Sample School', N'Sample District');
     SELECT id, name FROM dbo.schools WHERE name = N'Sample School';`
  );
  const school = schoolResult.recordset[0];

  // 2. Default admin (belongs to Academics org)
  const adminEmail = env.webhookAdminEmail || "admin@schoolforms.local";
  const adminPassword = env.webhookAdminPassword || "ChangeMe123!";
  const adminHash = await bcrypt.hash(adminPassword, 12);
  await pool.request()
    .input("email", adminEmail)
    .input("hash", adminHash)
    .input("id", school.id)
    .input("orgId", orgId)
    .query(
      `IF NOT EXISTS (SELECT 1 FROM dbo.users WHERE email = @email)
         INSERT INTO dbo.users (email, password_hash, role, school_id, display_name, organization_id)
         VALUES (@email, @hash, 'admin', @id, N'System Admin', @orgId);`
    );

  // 3. CDM form
  // NOTE: `id` is IDENTITY, so we let SQL Server assign it and read it back, then
  // use the returned id for the fields + reference submission below.
  const formExists = await pool.request()
    .input("schoolId", school.id)
    .input("orgId", orgId)
    .query(
      `IF NOT EXISTS (SELECT 1 FROM dbo.forms WHERE title = N'CDM')
         INSERT INTO dbo.forms (title, description, school_id, designer_id, organization_id, status, code)
         VALUES (N'CDM', N'Child Development Monitor form (reference)', @schoolId, NULL, @orgId, 'published', 'CDM');
       SELECT id, code FROM dbo.forms WHERE title = N'CDM';`
    );
  const FORM_ID = formExists.recordset[0].id as number;

  // 4. CDM fields (order matters; staff_only on "All others")
  const fields = [
    { label: "Student Name", type: "text", required: true, staff_only: false, sort_order: 0 },
    { label: "Student ID", type: "text", required: true, staff_only: false, sort_order: 1 },
    { label: "Grade", type: "select", required: true, staff_only: false, options: ["K", "1", "2", "3", "4", "5"], sort_order: 2 },
    { label: "Does the student attend school regularly?", type: "radio", required: true, staff_only: false, options: ["Yes", "No"], sort_order: 3 },
    { label: "Is there a concern with attendance?", type: "radio", required: true, staff_only: false, options: ["Yes", "No"], sort_order: 4 },
    { label: "Is the student progressing academically?", type: "radio", required: true, staff_only: false, options: ["Yes", "No"], sort_order: 5 },
    { label: "Behavioral concerns?", type: "radio", required: true, staff_only: false, options: ["Yes", "No"], sort_order: 6 },
    { label: "Notes", type: "textarea", required: false, staff_only: true, sort_order: 7 },
  ];
  for (const f of fields) {
    await pool.request()
      .input("formId", FORM_ID)
      .input("label", f.label)
      .input("type", f.type)
      .input("options", f.options ? JSON.stringify(f.options) : null)
      .input("required", f.required)
      .input("staffOnly", f.staff_only)
      .input("sortOrder", f.sort_order)
      .query(
        `IF NOT EXISTS (SELECT 1 FROM dbo.form_fields WHERE form_id = @formId AND label = @label)
           INSERT INTO dbo.form_fields (form_id, label, type, options, required, staff_only, sort_order, placeholder)
           VALUES (@formId, @label, @type, @options, @required, @staffOnly, @sortOrder, NULL);`
      );
  }

  // 5. Reference submission (from plan) — Johnny Smith
  // The reference row uses the new incremental id format `CDM-00001`, with the
  // numeric portion stored in submission_seq so the per-form counter continues
  // from the correct value for subsequent (real) submissions.
  const PUBLIC_ID = "CDM-00001";
  const submissionExists = await pool.request()
    .input("publicId", PUBLIC_ID)
    .query(`SELECT id FROM dbo.submissions WHERE public_id = @publicId`);
  if (!submissionExists.recordset.length) {
    const schoolYear = schoolYearForDate(new Date());
    const sub = await pool.request()
      .input("publicId", PUBLIC_ID)
      .input("formId", FORM_ID)
      .input("schoolId", school.id)
      .input("orgId", orgId)
      .input("schoolYear", schoolYear)
      .query(
        `INSERT INTO dbo.submissions (public_id, form_id, school_id, organization_id, status, submission_seq, school_year)
         OUTPUT INSERTED.id
         VALUES (@publicId, @formId, @schoolId, @orgId, 'submitted', 1, @schoolYear);`
      );
    const submissionId = sub.recordset[0].id;
    // Ensure the form counter accounts for the seeded reference submission so the
    // next real submission for this form allocates `CDM-00002`.
    await pool.request()
      .input("formId", FORM_ID)
      .query(
        `UPDATE dbo.forms SET submission_seq = submission_seq + 1 WHERE id = @formId AND submission_seq < 1;`
      );

    // Map field labels to their ids
    const fieldRows = await pool.request()
      .input("formId", FORM_ID)
      .query(`SELECT id, label FROM dbo.form_fields WHERE form_id = @formId`);
    const fieldIdByLabel = new Map(fieldRows.recordset.map((r: { label: string; id: number }) => [r.label, r.id]));

    const answers = [
      { label: "Student Name", value: "Johnny Smith" },
      { label: "Student ID", value: "12345" },
      { label: "Grade", value: "3" },
      { label: "Does the student attend school regularly?", value: "No" },
      { label: "Is there a concern with attendance?", value: "Yes" },
      { label: "Is the student progressing academically?", value: "No" },
      { label: "Behavioral concerns?", value: "No" },
    ];
    for (const a of answers) {
      const fieldId = fieldIdByLabel.get(a.label);
      if (fieldId) {
        await pool.request()
          .input("subId", submissionId)
          .input("fieldId", fieldId)
          .input("value", a.value)
          .query(
            `INSERT INTO dbo.submission_values (submission_id, field_id, value)
             VALUES (@subId, @fieldId, @value);`
          );
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[seed] Done. Admin: ${adminEmail} (${adminPassword}). CDM form seeded (code=CDM). ` +
      `Reference submission ${PUBLIC_ID} present.`
  );
  await pool.close();
}

seed().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[seed] failed:", err);
  process.exit(1);
});
