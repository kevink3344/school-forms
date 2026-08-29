import { google, docs_v1 } from "googleapis";
import { env } from "../config/env.js";
import {
  createDocument,
  getDocumentBySubmission,
  markDocumentCompleted,
  markDocumentFailed,
  markDocumentPending,
} from "../db/documents.js";
import {
  getSubmissionById,
  listSubmissionValues,
  listFormFields,
} from "../db/queries.js";

// -----------------------------------------------------------------------------
// Google Docs generation.
// Standard OAuth2 client + refresh-token grant (NOT a service account). Every
// Drive call passes `supportsAllDrives` because the target folder lives in a
// shared drive. The template uses inline `Label:` paragraphs (e.g. "Student
// Name:"); we copy it, then fill the value that follows each `Label:`.
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
 * Copy the document template into the target Drive folder, naming the new file
 * after the submission (its public_id). Returns the new Google Doc id.
 */
export async function copyTemplate(name: string): Promise<string> {
  const drive = google.drive({ version: "v3", auth: getAuth() });
  const res = await drive.files.copy({
    fileId: env.google.docTemplateId,
    requestBody: {
      name,
      ...(env.google.docFolderId ? { parents: [env.google.docFolderId] } : {}),
    },
    supportsAllDrives: env.google.isSharedDrive,
  });
  return res.data.id!;
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
      edits.push({ start, end, value: m.value });
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

  let dbId: number;
  if (existing) {
    // Reset a prior failure so the row shows Pending while this retry runs.
    await markDocumentPending(existing.id);
    dbId = existing.id;
  } else {
    const created = await createDocument(submissionId, createdBy);
    dbId = created.id;
  }

  try {
    const submission = await getSubmissionById(submissionId);
    if (!submission) throw new Error("Submission not found");

    const values = await listSubmissionValues(submission.id);
    const mappings = buildLabelMappings(submission, values);
    const docId = await copyTemplate(submission.public_id);
    await replacePlaceholders(docId, mappings);
    await markDocumentCompleted(dbId, docId);
  } catch (err) {
    await markDocumentFailed(dbId, (err as Error).message);
  }
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
