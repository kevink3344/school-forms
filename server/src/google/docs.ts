import { google, docs_v1 } from "googleapis";
import { env } from "../config/env.js";
import {
  createDocument,
  getDocumentBySubmission,
  markDocumentCompleted,
  markDocumentFailed,
  markDocumentPending,
} from "../db/documents.js";
import type { Document } from "../db/schema.js";
import {
  getForm,
  getSchool,
  getSubmissionById,
  listSubmissionValues,
  listFormFields,
} from "../db/queries.js";
import type { SubmissionValueRow } from "../db/queries.js";

// -----------------------------------------------------------------------------
// Google Docs generation.
// Standard OAuth2 client + refresh-token grant (NOT a service account). Every
// Drive call passes `supportsAllDrives` because the target folder lives in a
// shared drive. The template uses inline `Label:` paragraphs (e.g. "Student
// Name:"); we copy it, then fill the value that follows each `Label:`.
//
// Documents are saved into a per-school subfolder of the configured Drive
// parent (e.g. "WCPSS/Documents/Broughton High School"); the folder is created
// on first use and reused thereafter. The file name follows the convention
// `<Submission ID>-<Student Name>-<Did Student meet criteria?>`, e.g.
// `CDM2-00001-Amy Anderson-Met`.
// -----------------------------------------------------------------------------

let authClient: InstanceType<typeof google.auth.OAuth2> | null = null;

function getAuth() {
  if (!authClient) {
    authClient = new google.auth.OAuth2(
      env.google.clientId,
      env.google.clientSecret
    );
    authClient.setCredentials({ refresh_token: env.google.refreshToken });
  }
  return authClient;
}

/**
 * Find a Drive folder by name directly under `parentId`. Returns its id, or
 * null when it doesn't exist. Only matches folders (mimeType
 * `application/vnd.google-apps.folder`) that are direct children so we never
 * mistake a same-named file for a folder.
 */
async function findFolderByName(
  drive: ReturnType<typeof google.drive>,
  name: string,
  parentId: string
): Promise<string | null> {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name = '${escapeDriveQuery(
      name
    )}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    supportsAllDrives: env.google.isSharedDrive,
    includeItemsFromAllDrives: env.google.isSharedDrive,
    spaces: "drive",
  });
  return res.data.files?.[0]?.id ?? null;
}

/** Escape a value for use inside a Drive query-string literal. */
function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Resolve the Google Drive parent folder for a generated document. The form's
 * own `doc_folder_id` is the primary source; when it's blank we fall back to the
 * global `env.google.docFolderId`. Returns null only when neither is set (items
 * then save to the Drive root).
 */
async function resolveParentFolderId(formId: number): Promise<string | null> {
  const form = await getForm(formId);
  const formFolder = form?.doc_folder_id?.trim();
  return formFolder || env.google.docFolderId || null;
}

/**
 * Validate that `folderId` is an existing, non-trashed Google Drive folder the
 * app's OAuth account can access. Returns `{ valid: boolean, name?: string }`.
 * Used by the form designer to show the green checkmark next to a configured
 * Drive Folder ID. When the id is blank the call is a no-op (invalid).
 */
export async function validateDriveFolder(
  folderId: string | null | undefined
): Promise<{ valid: boolean; name?: string }> {
  const id = folderId?.trim();
  if (!id) {
    return { valid: false };
  }
  const drive = google.drive({ version: "v3", auth: getAuth() });
  try {
    const res = await drive.files.get({
      fileId: id,
      fields: "id, name, mimeType, trashed",
      supportsAllDrives: env.google.isSharedDrive,
    });
    const folder = res.data;
    const valid =
      !!folder &&
      folder.mimeType === "application/vnd.google-apps.folder" &&
      folder.trashed !== true;
    return { valid, name: folder?.name ?? undefined };
  } catch {
    // Any Drive error (not found, permission, bad id) → invalid.
    return { valid: false };
  }
}

/**
 * Resolve (create if needed) a per-school folder under the configured Drive
 * parent. The folder name is the school's display name (e.g. "Broughton High
 * School"). Returns the folder id. When `parentFolderId` is null (or no school
 * is attached to the submission), the items are saved to the Drive root.
 */
async function ensureSchoolFolder(
  drive: ReturnType<typeof google.drive>,
  schoolName: string | null,
  parentFolderId: string | null
): Promise<string | null> {
  if (!parentFolderId) return null;
  if (!schoolName) return parentFolderId;

  const folderName = schoolName.trim();
  if (!folderName) return parentFolderId;

  const existing = await findFolderByName(drive, folderName, parentFolderId);
  if (existing) return existing;

  const res = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId],
    },
    supportsAllDrives: env.google.isSharedDrive,
    fields: "id, name",
  });
  return res.data.id ?? null;
}

/**
 * Copy the document template into the target Drive folder, naming the new file
 * `<Submission ID>-<Student Name>-<Did Student meet criteria?>`. Returns the
 * new Google Doc id.
 *
 * `parentId` is the pre-resolved per-school folder id (or the Drive root when
 * no school folder applies). File names are sanitized to strip any Drive-
 * reserved characters (`/`, `\`, `"`, etc.) and collapse whitespace.
 */
export async function copyTemplate(
  name: string,
  parentId: string | null
): Promise<string> {
  const drive = google.drive({ version: "v3", auth: getAuth() });
  const res = await drive.files.copy({
    fileId: env.google.docTemplateId,
    requestBody: {
      name: sanitizeFileName(name),
      ...(parentId ? { parents: [parentId] } : {}),
    },
    supportsAllDrives: env.google.isSharedDrive,
  });
  return res.data.id!;
}

/** Strip characters Google Drive disallows in file names and collapse spaces. */
function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\"<>:|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How the template label maps to the field label in the submission's answers.
 * Case-insensitive. `Student Name` and `School Name` etc. are the literal labels
 * stored on the form; `School` is the parent-side "School" answer label.
 */
const LABEL_TO_FIELD: Record<string, string> = {
  "Student Name": "Student Name",
  "School Name": "School",
  "Course Title": "Next Course in Sequence",
  "Phase 1 Result": "Did Student meet criteria?",
};

/** Coerce a stored answer value into display text for the doc. */
function toText(value: string | number | boolean | string[] | null): string {
  if (Array.isArray(value)) return value.join(", ");
  if (value === null || value === undefined) return "";
  return String(value);
}

/** Format `Date:` label as `M/D/YY h:MMAM` (e.g. `8/29/26 3:00PM`). */
function formatShortDate(d: Date): string {
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const year = String(d.getFullYear()).slice(2);
  let hours = d.getHours();
  const minutes = d.getMinutes();
  const meridiem = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${month}/${day}/${year} ${hours}:${String(minutes).padStart(2, "0")}${meridiem}`;
}

/**
 * Build the label→value mappings for `replacePlaceholders`. `Date:` is the
 * generation time (not the submission timestamp). All other labels read the
 * submission's field answers case-insensitively.
 */
export function buildLabelMappings(
  submission: { public_id: string },
  values: {
    field_id: number;
    field_label: string;
    value: string | number | boolean | string[] | null;
  }[]
): { label: string; value: string }[] {
  const byLabel = new Map(
    values.map((v) => [v.field_label.trim().toLowerCase(), v.value])
  );
  const mappings: { label: string; value: string }[] = [];

  for (const [label, field] of Object.entries(LABEL_TO_FIELD)) {
    const value = byLabel.get(field.trim().toLowerCase());
    mappings.push({ label, value: toText(value ?? null) });
  }

  mappings.push({ label: "Date", value: formatShortDate(new Date()) });
  return mappings;
}

/**
 * Fill the inline `Label:` placeholders. For every paragraph whose text contains
 * a known `label:`, delete the content after the colon and insert the value.
 * Preserves the trailing paragraph newline.
 */
export async function replacePlaceholders(
  docId: string,
  mappings: { label: string; value: string }[]
): Promise<void> {
  const docs = google.docs({ version: "v1", auth: getAuth() });
  const doc = await docs.documents.get({ documentId: docId });

  // Collect one edit per matching paragraph. In the template each placeholder
  // lives on its own line as `Label:` (plus, for some, a trailing space) with
  // the value to be emitted right after the colon. The label text is preserved.
  const edits: { start: number; end: number; value: string }[] = [];
  for (const el of doc.data.body?.content ?? []) {
    const para = el.paragraph;
    if (!para) continue;
    const text = (para.elements ?? [])
      .map((e) => e.textRun?.content ?? "")
      .join("");

    for (const m of mappings) {
      const idx = text.toLowerCase().indexOf(`${m.label.toLowerCase()}:`);
      if (idx === -1) continue;

      // Value position is just after "Label:".
      const start = el.startIndex! + idx + m.label.length + 1;
      // Keep the trailing paragraph newline; delete any existing content
      // between the colon and the newline (e.g. a leftover space or sample
      // value). Skip the delete when that range is empty — Google Docs
      // rejects a zero-length deleteContentRange.
      const end = el.endIndex! - 1;
      // Add a single space after the colon so labels render as
      // "Student Name: Mary Johnson" rather than "Student Name:Mary Johnson".
      // Empty values get no trailing space.
      const value = m.value === "" ? "" : ` ${m.value}`;
      edits.push({ start, end, value });
      break; // one replacement per paragraph
    }
  }

  // Sort by descending start index. The API applies batch requests in order,
  // and an insert/delete at a higher index never shifts a lower-index position,
  // so computing all indices against the original document stays valid.
  edits.sort((a, b) => b.start - a.start);
  const requests: docs_v1.Schema$Request[] = [];
  for (const e of edits) {
    if (e.end > e.start) {
      requests.push({
        deleteContentRange: { range: { startIndex: e.start, endIndex: e.end } },
      });
    }
    requests.push({
      insertText: { location: { index: e.start }, text: e.value },
    });
  }

  if (requests.length > 0) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests },
    });
  }
}

/**
 * Run the Google-side generation for a specific document row: read the
 * submission's CURRENT values, resolve the per-school folder (under the form's
 * Drive parent), copy the template, fill the placeholders, and mark the row
 * Completed (or Failed on error). Shared by both the idempotent
 * `generateDocument` and the forced `regenerateDocument`.
 */
async function runGeneration(submissionId: number, dbId: number): Promise<void> {
  try {
    const submission = await getSubmissionById(submissionId);
    if (!submission) throw new Error("Submission not found");

    const values = await listSubmissionValues(submission.id);
    const mappings = buildLabelMappings(submission, values);

    // Resolve the per-school folder (under the org's Drive parent) and build the
    // file name.
    const school = submission.school_id ? await getSchool(submission.school_id) : null;
    const schoolName = school?.name ?? null;
    const drive = google.drive({ version: "v3", auth: getAuth() });
    const formParentId = await resolveParentFolderId(submission.form_id);
    const parentId = await ensureSchoolFolder(drive, schoolName, formParentId);
    const docName = buildDocumentName(submission.public_id, values);

    const docId = await copyTemplate(docName, parentId);
    await replacePlaceholders(docId, mappings);
    await markDocumentCompleted(dbId, docId);
  } catch (err) {
    await markDocumentFailed(dbId, (err as Error).message);
  }
}

/**
 * Core orchestrator: create/copy/fill the doc for a submission, then record the
 * outcome. Idempotent — if a Pending/Completed row already exists, it returns
 * without doing anything; a Failed row is retried. Errors are caught and written
 * to the row as `Failed` rather than rethrown (the staff save already returned).
 */
export async function generateDocument(
  submissionId: number,
  createdBy: number
): Promise<void> {
  // Idempotent: skip if a Pending/Completed row already exists; re-run if Failed.
  const existing = await getDocumentBySubmission(submissionId);
  if (existing && existing.status !== "Failed") return;

  if (existing) {
    // Reset a prior failure so the row shows Pending while this retry runs.
    await markDocumentPending(existing.id);
    await runGeneration(submissionId, existing.id);
    return;
  }

  const created = await createDocument(submissionId, createdBy);
  await runGeneration(submissionId, created.id);
}

/**
 * Force a brand-new document from the submission's CURRENT values. Unlike
 * `generateDocument` this is allowed even when a Completed row already exists:
 * it inserts a fresh Pending row (returned to the caller so the UI can show it
 * immediately), then runs the Google generation in the background. This powers
 * the "Regenerate" action, so a staff member can correct a submission and
 * produce an updated document reflecting those changes.
 *
 * Returns the newly-created Pending row.
 */
export async function regenerateDocument(
  submissionId: number,
  createdBy: number
): Promise<Document> {
  const created = await createDocument(submissionId, createdBy);
  // Fire-and-forget: the caller already has the new Pending row to render.
  void runGeneration(submissionId, created.id).catch(() => undefined);
  return created;
}

/**
 * Build the Google Doc file name: `<Submission ID>-<Student Name>-<Did Student
 * meet criteria?>`, e.g. `CDM2-00001-Amy Anderson-Met`. Values are read from the
 * submission's answers case-insensitively; missing/invalid components fall back
 * to empty-string segments so the name stays well-formed.
 */
function buildDocumentName(
  submissionId: string,
  values: SubmissionValueRow[]
): string {
  const byLabel = new Map(
    values.map((v) => [v.field_label.trim().toLowerCase(), toText(v.value)])
  );
  const student = byLabel.get("student name") ?? "";
  const criteria = byLabel.get("did student meet criteria?") ?? "";
  return [submissionId, student, criteria]
    .map((part) => sanitizeFileName(part))
    .filter(Boolean)
    .join("-");
}

/**
 * Idempotent guard used by the staff-save route. Locates a staff-only "Generate
 * document" checkbox in the submission's form and, if it's checked, triggers
 * generation after the values are saved. Fire-and-forget: never throws.
 */
export async function maybeGenerateDocument(
  submissionId: number,
  createdBy: number,
  answers: { field_id: number; value: string | number | boolean | string[] | null }[]
): Promise<void> {
  try {
    const submission = await getSubmissionById(submissionId);
    if (!submission) return;

    const fields = await listFormFields(submission.form_id);
    const gen = fields.find(
      (f) =>
        f.staff_only &&
        f.type === "checkbox" &&
        f.label.trim().toLowerCase() === "generate document"
    );
    if (!gen) return;

    const saved = answers.find((a) => a.field_id === gen.id);
    if (!saved || !readCheckbox(saved.value)) return;

    // Fire-and-forget generation; do not block the save response.
    void generateDocument(submissionId, createdBy).catch(() => undefined);
  } catch {
    // Never let the generation hook break the staff save.
  }
}

function readCheckbox(value: string | number | boolean | string[] | null): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value === null || value === undefined) return false;
  const s = String(value);
  return s !== "" && s !== "0" && s !== "false";
}

/**
 * Export a Drive document to PDF and return the raw binary buffer. This is the
 * "snapshot" the app serves for inline preview (View PDF) and download. The
 * doc is owned by the app's OAuth account, so rendering it through the app —
 * rather than handing staff a shareable Drive link — is what lets anyone with
 * a valid account (who passed the row-level scope check in the route) view it
 * without needing a Google login or shared-drive membership.
 *
 * @param documentId The Drive file id stored in `documents.document_id`.
 * @returns The PDF bytes (Buffer, `application/pdf`).
 */
export async function getDocumentPdf(documentId: string): Promise<Buffer> {
  const drive = google.drive({ version: "v3", auth: getAuth() });
  const res = await drive.files.export({
    fileId: documentId,
    mimeType: "application/pdf",
  });
  // googleapis returns the binary body as `.data`. Depending on the installed
  // version it may be a Buffer, a Blob (with arrayBuffer()), or a Node Readable
  // stream. Handle all three so we always return a Buffer.
  const data = res.data as unknown;
  if (Buffer.isBuffer(data)) {
    return data;
  }
  // Blob (Node >=18 / browsers expose `arrayBuffer()`).
  if (data && typeof (data as { arrayBuffer?: unknown }).arrayBuffer === "function") {
    const buf = await (data as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
    return Buffer.from(buf);
  }
  // Node / web Readable stream.
  if (data && typeof (data as { on?: unknown }).on === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of data as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }
  if (typeof data === "string") {
    return Buffer.from(data, "binary");
  }
  throw new Error("Google Drive did not return PDF bytes");
}
