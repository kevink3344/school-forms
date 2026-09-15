import { execute } from "./queries.js";
import { getDbKind } from "./pool.js";
import { getDialect } from "./dialect/index.js";
import type { Document, ListDocumentRow } from "./schema.js";

/** Statement builders for the active dialect (see db/dialect/). */
function dialect() {
  return getDialect(getDbKind());
}

// -----------------------------------------------------------------------------
// Generated Google Documents data layer.
// A row is created Pending when staff tick the "Generate document" field on
// save; the Google service then updates it to Completed (with document_id) or
// Failed (with error). This module is pure DB persistence — no Google calls.
// -----------------------------------------------------------------------------

/**
 * Form-designer field labels the document list and detail views project as
 * columns. Stored as constants because the same three labels appear in two
 * projections, and the dialect builder matches them case-insensitively.
 */
const STUDENT_NAME_LABEL = "student name";
const COURSE_TITLE_LABEL = "next course in sequence";
const PHASE1_RESULT_LABEL = "did student meet criteria?";

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
    dialect().insertReturning({
      table: "documents",
      columns: ["submission_id", "status", "created_by"],
      returning: [
        "id",
        "submission_id",
        "document_id",
        "status",
        "created_by",
        "created_at",
        "updated_at",
        "error",
      ],
      values: "@submissionId, 'Pending', @createdBy",
    }),
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
 * Scoping: every caller is bounded by their organization; a school-scoped role
 * (School Contact) is narrowed further to their own school. Admin and staff see
 * the whole organization. See `documentScope()` in routes/documents.ts.
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
            ${dialect().submissionValueSubquery(STUDENT_NAME_LABEL)} AS student_name,
            ${dialect().submissionValueSubquery(COURSE_TITLE_LABEL)} AS course_title,
            ${dialect().submissionValueSubquery(PHASE1_RESULT_LABEL)} AS phase1_result
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
  // Both filters are ANDed, matching listDocuments. A school implies its
  // organization, so the org clause is redundant for a school-scoped caller —
  // but ANDing means a caller that passes both can never have one silently
  // ignored, which is exactly the kind of divergence that lets a row appear in a
  // list yet 404 on open.
  if (params.schoolId !== undefined && params.schoolId !== null) {
    clauses.push("s.school_id = @schoolId");
    p.schoolId = params.schoolId;
  }
  if (params.organizationId !== undefined && params.organizationId !== null) {
    clauses.push("s.organization_id = @organizationId");
    p.organizationId = params.organizationId;
  }
  const rows = await execute<ListDocumentRow & { form_id: number }>(
    `SELECT d.id, d.submission_id, d.document_id, d.status, d.created_by,
            d.created_at, d.updated_at, d.error,
            s.public_id, s.school_id, s.form_id,
            sc.name AS school_name,
            ${dialect().submissionValueSubquery(STUDENT_NAME_LABEL)} AS student_name,
            ${dialect().submissionValueSubquery(COURSE_TITLE_LABEL)} AS course_title,
            ${dialect().submissionValueSubquery(PHASE1_RESULT_LABEL)} AS phase1_result
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
