import { Readable } from "node:stream";
import { google } from "googleapis";
import { env } from "../config/env.js";
import { driveAuth, resolveFormFolderId, sanitizeFileName } from "./docs.js";

// -----------------------------------------------------------------------------
// Staff Attachments — Google Drive writes (docs/plans/staff-attachments.md §3.3).
//
// Layout under the form's Drive folder, so 10 files × N submissions stay
// navigable:
//
//   <form folder>/
//     Attachments/
//       <public_id>/            e.g. "CDM-00123"
//         CDM-00123 - Report Card.pdf
//
// The `Attachments` folder is deliberately separate from the per-school folder
// the document generator uses: mixing attachments into it would make the
// generated-document folder unreadable.
//
// ★ The upload body is STREAMED from the request straight to Google. Nothing is
// buffered, which is what keeps a large file from exhausting the instance's
// memory. It does NOT make the size unlimited — the platform in front of the app
// cuts every request at 230 seconds (plan §5.3).
// -----------------------------------------------------------------------------

function driveClient() {
  return google.drive({ version: "v3", auth: driveAuth() });
}

/** Escape a value for use inside a Drive query-string literal. */
function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Find a Drive folder by name directly under `parentId`, or create it.
 *
 * Only matches folders (not same-named files), and only direct children, so a
 * file called "Attachments" can never be mistaken for the folder.
 */
async function ensureFolder(
  drive: ReturnType<typeof google.drive>,
  name: string,
  parentId: string
): Promise<string> {
  const found = await drive.files.list({
    q:
      `'${parentId}' in parents and name = '${escapeDriveQuery(name)}' ` +
      `and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    supportsAllDrives: env.google.isSharedDrive,
    includeItemsFromAllDrives: env.google.isSharedDrive,
    spaces: "drive",
  });
  const existing = found.data.files?.[0]?.id;
  if (existing) return existing;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    supportsAllDrives: env.google.isSharedDrive,
    fields: "id",
  });
  const id = created.data.id;
  if (!id) throw new Error(`Google Drive did not return an id for folder "${name}"`);
  return id;
}

/**
 * The folder a submission's attachments live in:
 * `<form folder>/Attachments/<public_id>`.
 *
 * Returns null when the form has no Drive folder configured — the caller treats
 * that as "attachments unavailable", not as "save to the Drive root".
 */
export async function ensureSubmissionAttachmentFolder(
  formId: number,
  submissionPublicId: string
): Promise<string | null> {
  const parent = await resolveFormFolderId(formId);
  if (!parent) return null;
  const drive = driveClient();
  const attachmentsRoot = await ensureFolder(drive, "Attachments", parent);
  return ensureFolder(drive, sanitizeFileName(submissionPublicId), attachmentsRoot);
}

/**
 * The Drive file name for an attachment: `<public_id> - <original name>`.
 *
 * Files in a shared drive are found by NAME search by real people, so a bare
 * `scan001.pdf` × 10 submissions is unusable. The original name is kept verbatim
 * in the DB column `file_name`; only the Drive copy carries the prefix.
 */
export function attachmentDriveName(submissionPublicId: string, originalName: string): string {
  const cleaned = sanitizeFileName(originalName) || "attachment";
  const prefix = `${sanitizeFileName(submissionPublicId)} - `;
  // Drive rejects names over 255 bytes; trim the ORIGINAL, keeping the prefix.
  const maxOriginal = 255 - prefix.length;
  return prefix + cleaned.slice(0, Math.max(1, maxOriginal));
}

export interface UploadedDriveFile {
  fileId: string;
  webViewLink: string | null;
  sizeBytes: number | null;
}

/**
 * Stream one file into `folderId`.
 *
 * `body` is the request stream itself. The caller MUST abort it when the client
 * disconnects (see routes/attachments-upload.ts): a destroyed stream makes the
 * Google request fail, so no partial file is left behind.
 */
export async function uploadAttachmentToDrive(input: {
  folderId: string;
  name: string;
  mimeType: string;
  body: Readable;
}): Promise<UploadedDriveFile> {
  const drive = driveClient();
  const res = await drive.files.create({
    requestBody: {
      name: input.name,
      parents: [input.folderId],
    },
    media: {
      mimeType: input.mimeType,
      body: input.body,
    },
    fields: "id, webViewLink, size",
    supportsAllDrives: env.google.isSharedDrive,
  });
  const fileId = res.data.id;
  if (!fileId) throw new Error("Google Drive did not return a file id");
  const size = res.data.size === null || res.data.size === undefined ? null : Number(res.data.size);
  return {
    fileId,
    webViewLink: res.data.webViewLink ?? null,
    sizeBytes: size !== null && Number.isFinite(size) ? size : null,
  };
}

/**
 * Delete a Drive file. Used when an upload succeeded but the row could not be
 * written (over the cap, or a DB failure), so nothing is orphaned.
 *
 * Never throws: the caller is already reporting an error, and a failed cleanup
 * must not replace it. It is logged instead.
 */
export async function deleteDriveFile(fileId: string): Promise<boolean> {
  try {
    const drive = driveClient();
    await drive.files.delete({
      fileId,
      supportsAllDrives: env.google.isSharedDrive,
    });
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[attachments] could not delete Drive file ${fileId}: ${err instanceof Error ? err.message : err}`
    );
    return false;
  }
}

/**
 * A link that opens the file in Drive. Prefers the stored `webViewLink`; falls
 * back to a constructed URL so a row written before the link was captured still
 * opens.
 *
 * ⚠ Only useful to a Google account that can already see the file. The app's
 * OAuth account owns every uploaded file, so a signed-in staff member following
 * this URL gets Google's sign-in page. `downloadAttachmentFromDrive` is what the
 * app actually serves (see routes/submissions.ts).
 */
export function attachmentOpenUrl(fileId: string, webViewLink: string | null): string {
  return webViewLink || `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
}

/**
 * Stream one attachment's bytes back through the app.
 *
 * ★ This is why the open route does not simply redirect to Drive. Every file is
 * uploaded by the app's own OAuth account, so it is PRIVATE to that account — a
 * staff member following a `webViewLink` lands on Google's sign-in page even
 * though they are signed in here. The generated-document PDF route solves the
 * same problem the same way (see `getDocumentPdf` in docs.ts): the app proves
 * access with its own credentials and relays the bytes.
 *
 * The body is returned as a Node stream and piped to the response, so a large
 * video is never held in memory. The caller must handle backpressure — piping
 * does.
 */
export async function downloadAttachmentFromDrive(fileId: string): Promise<{
  stream: Readable;
  mimeType: string;
  sizeBytes: number | null;
  name: string | null;
}> {
  const drive = driveClient();

  // Metadata first: the response needs the real content type (Drive stores
  // whatever was uploaded) and a size for Content-Length when it is known.
  const meta = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, size",
    supportsAllDrives: env.google.isSharedDrive,
  });

  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: env.google.isSharedDrive },
    { responseType: "stream" }
  );

  const size = meta.data.size === null || meta.data.size === undefined ? null : Number(meta.data.size);
  return {
    stream: res.data as unknown as Readable,
    mimeType: meta.data.mimeType ?? "application/octet-stream",
    sizeBytes: size !== null && Number.isFinite(size) ? size : null,
    name: meta.data.name ?? null,
  };
}
