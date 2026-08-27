import bcrypt from "bcryptjs";
import { initDb, getPool } from "./pool.js";
import { newPublicId } from "./schema.js";
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

  // 1. Default school
  const schoolResult = await req.query(
    `IF NOT EXISTS (SELECT 1 FROM dbo.schools WHERE name = N'Sample School')
       INSERT INTO dbo.schools (name, district) VALUES (N'Sample School', N'Sample District');
     SELECT id, name FROM dbo.schools WHERE name = N'Sample School';`
  );
  const school = schoolResult.recordset[0];

  // 2. Default admin
  const adminEmail = env.webhookAdminEmail || "admin@schoolforms.local";
  const adminPassword = env.webhookAdminPassword || "ChangeMe123!";
  const adminHash = await bcrypt.hash(adminPassword, 12);
  await pool.request()
    .input("email", adminEmail)
    .input("hash", adminHash)
    .input("id", school.id)
    .query(
      `IF NOT EXISTS (SELECT 1 FROM dbo.users WHERE email = @email)
         INSERT INTO dbo.users (email, password_hash, role, school_id, display_name)
         VALUES (@email, @hash, 'admin', @id, N'System Admin');`
    );

  // 3. CDM form
  // NOTE: `id` is IDENTITY, so we let SQL Server assign it and read it back, then
  // use the returned id for the fields + reference submission below.
  const formExists = await pool.request()
    .input("schoolId", school.id)
    .query(
      `IF NOT EXISTS (SELECT 1 FROM dbo.forms WHERE title = N'CDM')
         INSERT INTO dbo.forms (title, description, school_id, designer_id, status)
         VALUES (N'CDM', N'Child Development Monitor form (reference)', @schoolId, NULL, 'published');
       SELECT id FROM dbo.forms WHERE title = N'CDM';`
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
  const PUBLIC_ID = "7bea2443-a5bb-4e40-a5c2-95034718fdd3";
  const submissionExists = await pool.request()
    .input("publicId", PUBLIC_ID)
    .query(`SELECT id FROM dbo.submissions WHERE public_id = @publicId`);
  if (!submissionExists.recordset.length) {
    const sub = await pool.request()
      .input("publicId", PUBLIC_ID)
      .input("formId", FORM_ID)
      .input("schoolId", school.id)
      .query(
        `INSERT INTO dbo.submissions (public_id, form_id, school_id, status)
         OUTPUT INSERTED.id
         VALUES (@publicId, @formId, @schoolId, 'submitted');`
      );
    const submissionId = sub.recordset[0].id;

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
    `[seed] Done. Admin: ${adminEmail} (${adminPassword}). CDM form seeded. ` +
      `Reference submission ${PUBLIC_ID} present.`
  );
  await pool.close();
}

seed().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[seed] failed:", err);
  process.exit(1);
});
