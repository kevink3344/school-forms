import { getDbKind } from "./pool.js";
import { getDialect } from "./dialect/index.js";
import { execute } from "./queries.js";
import type { SubmissionLink } from "./schema.js";

/** Statement builders for the active dialect (see db/dialect/). */
function dialect() {
  return getDialect(getDbKind());
}

// -----------------------------------------------------------------------------
// Staff Attachments — Links data layer (docs/plans/staff-attachments.md §3.6).
//
// A link is a title + an external URL recorded against a submission and shown
// BELOW the attachments on the same card. Pure DB persistence: nothing here
// talks to the network, and there is no cap to enforce — links are not files and
// do not count against MAX_SUBMISSION_ATTACHMENTS, so unlike `createAttachment`
// this needs no transaction.
//
// `url` is validated by the ROUTE (`isHttpsUrl` in schemas.ts) before it reaches
// this module. The column deliberately carries no CHECK constraint: SQLite
// cannot add one via ALTER TABLE, so a constraint here would make the two
// dialects disagree about what the column accepts.
// -----------------------------------------------------------------------------

/**
 * Every link on one submission, oldest first, with the creator's display name
 * joined for the list.
 *
 * Like `listAttachmentsBySubmission`, this does NOT exclude archived
 * submissions: the detail page opens an archived submission on purpose.
 */
export async function listLinksBySubmission(submissionId: number): Promise<SubmissionLink[]> {
  return execute<SubmissionLink>(
    `SELECT l.id, l.submission_id, l.title, l.url, l.created_by, l.created_at,
            u.display_name AS created_by_name
     FROM dbo.submission_links l
     LEFT JOIN dbo.users u ON u.id = l.created_by
     WHERE l.submission_id = @submissionId
     ORDER BY l.id`,
    { submissionId }
  );
}

/** One link, scoped to its submission so an id from another row 404s. */
export async function getLink(
  submissionId: number,
  linkId: number
): Promise<SubmissionLink | null> {
  const rows = await execute<SubmissionLink>(
    `SELECT l.id, l.submission_id, l.title, l.url, l.created_by, l.created_at,
            u.display_name AS created_by_name
     FROM dbo.submission_links l
     LEFT JOIN dbo.users u ON u.id = l.created_by
     WHERE l.submission_id = @submissionId AND l.id = @linkId`,
    { submissionId, linkId }
  );
  return rows[0] ?? null;
}

/**
 * Record a link. `insertReturning`, not a hand-written RETURNING: SQL Server
 * needs `OUTPUT INSERTED.…` where libSQL needs `RETURNING …` (see
 * dialect/types.ts).
 */
export async function createLink(input: {
  submissionId: number;
  title: string;
  url: string;
  createdBy: number;
}): Promise<SubmissionLink> {
  const inserted = await execute<SubmissionLink>(
    dialect().insertReturning({
      table: "submission_links",
      columns: ["submission_id", "title", "url", "created_by"],
      returning: ["id", "submission_id", "title", "url", "created_by", "created_at"],
      values: "@submissionId, @title, @url, @createdBy",
    }),
    {
      submissionId: input.submissionId,
      title: input.title,
      url: input.url,
      createdBy: input.createdBy,
    }
  );
  // The creator's own name is not joined here; the route re-reads the row
  // through getLink so the list and the response agree.
  return { ...inserted[0], created_by_name: null };
}

/**
 * Remove a link row. Nothing external is deleted — the page it points at was
 * never ours — so unlike `deleteAttachmentRow` there is no ordering rule.
 */
export async function deleteLinkRow(submissionId: number, linkId: number): Promise<boolean> {
  const rows = await execute<{ id: number }>(
    dialect().deleteReturning({
      table: "submission_links",
      where: "submission_id = @submissionId AND id = @linkId",
      returning: ["id"],
    }),
    { submissionId, linkId }
  );
  return rows.length > 0;
}
