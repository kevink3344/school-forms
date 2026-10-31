import { getClient, getDbKind } from "./pool.js";
import { getDialect } from "./dialect/index.js";
import { execute } from "./queries.js";
import type { SubmissionAttachment } from "./schema.js";

/** Statement builders for the active dialect (see db/dialect/). */
function dialect() {
  return getDialect(getDbKind());
}

// -----------------------------------------------------------------------------
// Staff Attachments data layer (docs/plans/staff-attachments.md).
//
// One row per file uploaded from a submission's Attachments card. The bytes live
// in Google Drive; this module is pure DB persistence and makes no Drive calls —
// the route uploads first and records the result here, so a failed upload never
// leaves a row pointing at a file that does not exist.
// -----------------------------------------------------------------------------

/**
 * The cap the brief sets. Enforced in `createAttachment` inside a transaction,
 * not by the UI, so two staff uploading at once cannot both pass a count check.
 */
export const MAX_SUBMISSION_ATTACHMENTS = 10;

/** Raised when the cap is already reached; the route maps it to a 409. */
export class AttachmentLimitError extends Error {
  constructor(public readonly limit: number) {
    super(`This submission already has ${limit} attachments, the maximum.`);
    this.name = "AttachmentLimitError";
  }
}

// `size_bytes` is BIGINT on SQL Server and the driver serves SQL numerics as
// STRINGS (see resolveSubmissionSchoolId in queries.ts). Convert explicitly so
// the declared `number | null` is a fact rather than a claim; anything that does
// not parse is reported as unknown rather than as NaN.
function toSize(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalize(row: SubmissionAttachment): SubmissionAttachment {
  return { ...row, size_bytes: toSize(row.size_bytes) };
}

/**
 * Every attachment on one submission, oldest first, with the uploader's
 * display name joined for the list.
 *
 * Deliberately does NOT exclude archived submissions: the detail page opens an
 * archived submission on purpose, and a card that silently showed nothing while
 * the files exist would read as broken rather than as archived. Same rule as
 * `listDocumentsBySubmission`.
 */
export async function listAttachmentsBySubmission(
  submissionId: number
): Promise<SubmissionAttachment[]> {
  const rows = await execute<SubmissionAttachment>(
    `SELECT a.id, a.submission_id, a.drive_file_id, a.file_name, a.mime_type,
            a.size_bytes, a.web_view_link, a.uploaded_by, a.uploaded_at,
            u.display_name AS uploaded_by_name
     FROM dbo.submission_attachments a
     LEFT JOIN dbo.users u ON u.id = a.uploaded_by
     WHERE a.submission_id = @submissionId
     ORDER BY a.id`,
    { submissionId }
  );
  return rows.map(normalize);
}

/** One attachment, scoped to its submission so an id from another row 404s. */
export async function getAttachment(
  submissionId: number,
  attachmentId: number
): Promise<SubmissionAttachment | null> {
  const rows = await execute<SubmissionAttachment>(
    `SELECT a.id, a.submission_id, a.drive_file_id, a.file_name, a.mime_type,
            a.size_bytes, a.web_view_link, a.uploaded_by, a.uploaded_at,
            u.display_name AS uploaded_by_name
     FROM dbo.submission_attachments a
     LEFT JOIN dbo.users u ON u.id = a.uploaded_by
     WHERE a.submission_id = @submissionId AND a.id = @attachmentId`,
    { submissionId, attachmentId }
  );
  return rows[0] ? normalize(rows[0]) : null;
}

/**
 * Record an attachment that has ALREADY been uploaded to Drive.
 *
 * ★ The cap is enforced here, inside a transaction that first touches the
 * submission row. Counting and then inserting without a lock is a race: two
 * staff uploading the 10th file at the same moment would both read 9 and both
 * insert. The lock serialises them so the second one sees 10 and throws
 * `AttachmentLimitError` — and the caller then deletes the file it just uploaded
 * from Drive, so nothing is orphaned.
 *
 * The caller must have uploaded the file first: a row that cannot be written is
 * recoverable (delete the file), but a row written for a file that failed to
 * upload is not.
 */
export async function createAttachment(input: {
  submissionId: number;
  driveFileId: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  webViewLink: string | null;
  uploadedBy: number;
}): Promise<SubmissionAttachment> {
  return getClient().transaction(async (tx) => {
    // Lock the parent row. SQL Server takes an exclusive row lock with this
    // UPDATE; libSQL serialises writers, so the same statement is a no-op that
    // still orders the two transactions. It writes the value it already had, so
    // the row is unchanged.
    await tx.query(
      `UPDATE dbo.submissions SET updated_at = updated_at WHERE id = @submissionId`,
      { submissionId: input.submissionId }
    );

    const counted = await tx.query<{ n: unknown }>(
      `SELECT COUNT(*) AS n FROM dbo.submission_attachments WHERE submission_id = @submissionId`,
      { submissionId: input.submissionId }
    );
    const existing = Number(counted[0]?.n ?? 0);
    if (!Number.isFinite(existing)) {
      // A COUNT(*) always returns exactly one row. A missing or non-numeric one
      // means the query shape changed, and this number gates a write — fail
      // loudly rather than admitting an unbounded number of files.
      throw new Error("attachment count returned no usable row");
    }
    if (existing >= MAX_SUBMISSION_ATTACHMENTS) {
      throw new AttachmentLimitError(MAX_SUBMISSION_ATTACHMENTS);
    }

    // `insertReturning`, not a hand-written RETURNING: SQL Server needs
    // `OUTPUT INSERTED.…` where libSQL needs `RETURNING …`, and the driver's
    // token rewriter deliberately does not handle that structural difference
    // (see dialect/types.ts).
    const inserted = await tx.query<SubmissionAttachment>(
      dialect().insertReturning({
        table: "submission_attachments",
        columns: [
          "submission_id",
          "drive_file_id",
          "file_name",
          "mime_type",
          "size_bytes",
          "web_view_link",
          "uploaded_by",
        ],
        returning: [
          "id",
          "submission_id",
          "drive_file_id",
          "file_name",
          "mime_type",
          "size_bytes",
          "web_view_link",
          "uploaded_by",
          "uploaded_at",
        ],
        values:
          "@submissionId, @driveFileId, @fileName, @mimeType, @sizeBytes, @webViewLink, @uploadedBy",
      }),
      {
        submissionId: input.submissionId,
        driveFileId: input.driveFileId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        webViewLink: input.webViewLink,
        uploadedBy: input.uploadedBy,
      }
    );
    // The uploader's own name is not joined here; the route re-reads the row
    // through getAttachment so the list and the response agree.
    return { ...inserted[0], uploaded_by_name: null, size_bytes: toSize(inserted[0].size_bytes) };
  });
}

/**
 * Remove an attachment row. The Drive file is deleted by the CALLER first — this
 * module never talks to Google — so a failure here leaves a file with no row
 * (recoverable by hand) rather than a row pointing at a deleted file.
 */
export async function deleteAttachmentRow(
  submissionId: number,
  attachmentId: number
): Promise<boolean> {
  const rows = await execute<{ id: number }>(
    dialect().deleteReturning({
      table: "submission_attachments",
      where: "submission_id = @submissionId AND id = @attachmentId",
      returning: ["id"],
    }),
    { submissionId, attachmentId }
  );
  return rows.length > 0;
}
