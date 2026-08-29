import { execute } from "./queries.js";
import type { Document, ListDocumentRow } from "./schema.js";

// -----------------------------------------------------------------------------
// Generated Google Documents data layer.
// A row is created Pending when staff tick the "Generate document" field on
// save; the Google service then updates it to Completed (with document_id) or
// Failed (with error). This module is pure DB persistence — no Google calls.
// -----------------------------------------------------------------------------

/**
 * Look up the single documents row for a submission, if any. Used for the
 * generate-document idempotency check: skip if a Pending/Completed row exists,
 * re-run only when the previous attempt Failed.
 */
export async function getDocumentBySubmission(
  submissionId: number
): Promise<Document | null> {
  const rows = await execute<Document>(
    `SELECT id, submission_id, document_id, status, created_by, created_at, updated_at, error
     FROM dbo.documents
     WHERE submission_id = @submissionId
     ORDER BY id DESC`,
    { submissionId }
  );
  return rows[0] ?? null;
}

/**
 * Insert a Pending document row for a submission. Returns the new row so the
 * caller can hand its id to the background Google job.
 */
export async function createDocument(
  submissionId: number,
  createdBy: number
): Promise<Document> {
  const rows = await execute<Document>(
    `INSERT INTO dbo.documents (submission_id, status, created_by)
     OUTPUT INSERTED.id, INSERTED.submission_id, INSERTED.document_id,
            INSERTED.status, INSERTED.created_by, INSERTED.created_at,
            INSERTED.updated_at, INSERTED.error
     VALUES (@submissionId, 'Pending', @createdBy)`,
    { submissionId, createdBy }
  );
  return rows[0];
}

/**
 * Mark a document row Completed, storing the Google Doc id.
 */
export async function markDocumentCompleted(
  dbId: number,
  documentId: string
): Promise<void> {
  await execute(
    `UPDATE dbo.documents
     SET document_id = @documentId, status = 'Completed', error = NULL,
         updated_at = SYSUTCDATETIME()
     WHERE id = @dbId`,
    { dbId, documentId }
  );
}

/**
 * Mark a document row Failed, recording the error message for the card audit log.
 */
export async function markDocumentFailed(
  dbId: number,
  error: string
): Promise<void> {
  await execute(
    `UPDATE dbo.documents
     SET status = 'Failed', error = @error, updated_at = SYSUTCDATETIME()
     WHERE id = @dbId`,
    { dbId, error }
  );
}

/**
 * Reset a document row to Pending, clearing any prior error. Used when a retry
 * re-attempts a Failed document so the UI shows Pending while the job runs.
 */
export async function markDocumentPending(dbId: number): Promise<void> {
  await execute(
    `UPDATE dbo.documents
     SET status = 'Pending', error = NULL, updated_at = SYSUTCDATETIME()
     WHERE id = @dbId`,
    { dbId }
  );
}

/**
 * The documents list page. Enriched with the submission public id (for the
 * through-link) and the label-derived columns shown in the grid. `school_name`
 * comes from the schools table join (user decision: use the school name, not
 * the parent-typed "School" answer).
 *
 * Scoping: staff sees only rows for their school, admin sees only rows in their
 * organization (via the submission → form → school → organization chain).
 */
export async function listDocuments(params: {
  schoolId?: number | null;
  organizationId?: number | null;
  submissionId?: number | null;
}): Promise<ListDocumentRow[]> {
  const clauses: string[] = [];
  const p: Record<string, unknown> = {};
  if (params.schoolId !== undefined && params.schoolId !== null) {
    clauses.push("s.school_id = @schoolId");
    p.schoolId = params.schoolId;
  }
  if (params.organizationId !== undefined && params.organizationId !== null) {
    clauses.push("s.organization_id = @organizationId");
    p.organizationId = params.organizationId;
  }
  if (params.submissionId !== undefined && params.submissionId !== null) {
    clauses.push("d.submission_id = @submissionId");
    p.submissionId = params.submissionId;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  return execute<ListDocumentRow>(
    `SELECT d.id, d.submission_id, d.document_id, d.status, d.created_by,
            d.created_at, d.updated_at, d.error,
            s.public_id, s.school_id,
            sc.name AS school_name,
            (SELECT TOP 1 sv.value FROM dbo.submission_values sv
             JOIN dbo.form_fields ff ON ff.id = sv.field_id
             WHERE sv.submission_id = s.id AND LOWER(ff.label) = 'student name'
               AND sv.value IS NOT NULL ORDER BY ff.sort_order) AS student_name,
            (SELECT TOP 1 sv.value FROM dbo.submission_values sv
             JOIN dbo.form_fields ff ON ff.id = sv.field_id
             WHERE sv.submission_id = s.id AND LOWER(ff.label) = 'next course in sequence'
               AND sv.value IS NOT NULL ORDER BY ff.sort_order) AS course_title,
            (SELECT TOP 1 sv.value FROM dbo.submission_values sv
             JOIN dbo.form_fields ff ON ff.id = sv.field_id
             WHERE sv.submission_id = s.id AND LOWER(ff.label) = 'did student meet criteria?'
               AND sv.value IS NOT NULL ORDER BY ff.sort_order) AS phase1_result
     FROM dbo.documents d
     JOIN dbo.submissions s ON s.id = d.submission_id
     LEFT JOIN dbo.schools sc ON sc.id = s.school_id
     ${where}
     ORDER BY d.created_at DESC`,
    p
  );
}

/**
 * Fetch a single document row by its DB id, along with the submission public id
 * (used by the retry endpoint to scope/report). Scoped the same way as
 * listDocuments so a user cannot touch a document outside their org/school.
 */
export async function getDocumentById(
  dbId: number,
  params: { schoolId?: number | null; organizationId?: number | null }
): Promise<(ListDocumentRow & { form_id: number }) | null> {
  const clauses: string[] = ["d.id = @dbId"];
  const p: Record<string, unknown> = { dbId };
  if (params.schoolId !== undefined && params.schoolId !== null) {
    clauses.push("s.school_id = @schoolId");
    p.schoolId = params.schoolId;
  } else if (params.organizationId !== undefined && params.organizationId !== null) {
    clauses.push("s.organization_id = @organizationId");
    p.organizationId = params.organizationId;
  }
  const rows = await execute<ListDocumentRow & { form_id: number }>(
    `SELECT d.id, d.submission_id, d.document_id, d.status, d.created_by,
            d.created_at, d.updated_at, d.error,
            s.public_id, s.school_id, s.form_id,
            sc.name AS school_name,
            (SELECT TOP 1 sv.value FROM dbo.submission_values sv
             JOIN dbo.form_fields ff ON ff.id = sv.field_id
             WHERE sv.submission_id = s.id AND LOWER(ff.label) = 'student name'
               AND sv.value IS NOT NULL ORDER BY ff.sort_order) AS student_name,
            (SELECT TOP 1 sv.value FROM dbo.submission_values sv
             JOIN dbo.form_fields ff ON ff.id = sv.field_id
             WHERE sv.submission_id = s.id AND LOWER(ff.label) = 'next course in sequence'
               AND sv.value IS NOT NULL ORDER BY ff.sort_order) AS course_title,
            (SELECT TOP 1 sv.value FROM dbo.submission_values sv
             JOIN dbo.form_fields ff ON ff.id = sv.field_id
             WHERE sv.submission_id = s.id AND LOWER(ff.label) = 'did student meet criteria?'
               AND sv.value IS NOT NULL ORDER BY ff.sort_order) AS phase1_result
     FROM dbo.documents d
     JOIN dbo.submissions s ON s.id = d.submission_id
     LEFT JOIN dbo.schools sc ON sc.id = s.school_id
     WHERE ${clauses.join(" AND ")}`,
    p
  );
  return rows[0] ?? null;
}

/**
 * Convenience for the detail page: one submission's documents. Delegates to
 * listDocuments with the submission filter.
 */
export async function listDocumentsBySubmission(
  submissionId: number
): Promise<ListDocumentRow[]> {
  return listDocuments({ submissionId });
}
