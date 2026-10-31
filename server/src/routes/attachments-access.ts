import { getForm } from "../db/queries.js";
import { canUseAttachments } from "../db/schema.js";
import { validateDriveFolder } from "../google/docs.js";

// -----------------------------------------------------------------------------
// Staff Attachments — THE access gate (docs/plans/staff-attachments.md §5.2).
//
// Mirrors `submissionAccessError`'s contract: returns the { status, error } body
// to send, or null to proceed. Written once because four routes need it, and a
// missing copy fails SILENTLY — the route simply works for everyone.
//
// ★ The order is deliberate: toggle -> folder configured -> role -> reachable.
// Checking the role before the toggle would answer "not available for your role"
// on a form where the feature is simply switched off, which sends the admin
// looking at the wrong control.
// -----------------------------------------------------------------------------

export interface AttachmentGateUser {
  role: string;
}

export interface AttachmentGateForm {
  id: number;
  doc_folder_id: string | null;
  attachments_enabled: boolean;
  attachments_roles: string[] | null;
}

export async function attachmentsAccessError(
  user: AttachmentGateUser,
  formId: number
): Promise<{ status: number; error: string } | null> {
  const form = await getForm(formId);
  if (!form) {
    return { status: 404, error: "Form not found" };
  }
  return attachmentsAccessErrorForForm(user, form);
}

/**
 * The same decision against a form row the caller already has, so a route that
 * has just loaded the form does not pay for a second read.
 */
export async function attachmentsAccessErrorForForm(
  user: AttachmentGateUser,
  form: AttachmentGateForm
): Promise<{ status: number; error: string } | null> {
  // The per-form switch comes FIRST: a form with attachments turned off must
  // refuse every non-admin even if it still carries a folder id and a role grant
  // from when it was on.
  if (user.role !== "admin" && !form.attachments_enabled) {
    return { status: 403, error: "Staff Attachments are not enabled for this form." };
  }
  if (!form.doc_folder_id?.trim()) {
    return {
      status: 409,
      error: "This form has no Drive Folder ID configured. Ask an administrator to set one.",
    };
  }
  if (!canUseAttachments(form, user.role)) {
    return { status: 403, error: "Attachments are not available for your role on this form." };
  }
  if (!(await validateDriveFolder(form.doc_folder_id)).valid) {
    return {
      status: 409,
      error: "The form's Google Drive folder is not reachable. Ask an administrator to check the Drive Folder ID.",
    };
  }
  return null;
}
