import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth, requireRoles, canAccessSchool } from "../auth.js";
import { canAccessForm } from "../access/formAccess.js";
import { getSubmissionByPublicId } from "../db/queries.js";
import { createAttachment, AttachmentLimitError, MAX_SUBMISSION_ATTACHMENTS } from "../db/attachments.js";
import { attachmentsAccessError } from "./attachments-access.js";
import {
  ensureSubmissionAttachmentFolder,
  uploadAttachmentToDrive,
  deleteDriveFile,
  attachmentDriveName,
} from "../google/drive-upload.js";

// -----------------------------------------------------------------------------
// Staff Attachments — the UPLOAD route (docs/plans/staff-attachments.md §5.1).
//
// ★ This router is mounted in index.ts ABOVE `app.use(express.json(...))`, and
// deliberately applies NO body parser. `express.json` and `express.raw` both
// buffer the whole body in memory, which with a video is a memory-exhaustion
// vector on an authenticated-but-still-abusable endpoint. Instead the request
// stream itself is handed to Google as `media.body`, so bytes flow
// browser -> this process -> Drive without ever being held.
//
// Consequences, all deliberate:
//   * every guard the ordinary submissions router would apply is applied HERE
//     (auth, role, school, form access, the attachment gate) — there is no
//     shared middleware chain to inherit;
//   * a dedicated rate limiter, because the global one is mounted after this;
//   * every other method/path falls straight through via next(), so the normal
//     router still serves GET/DELETE on the same prefix.
//
// ⚠ Streaming does NOT make the size unlimited. The platform in front of the app
// cuts any request at 230 seconds (plan §5.3); a file that outlives that arrives
// as a 502/504 from the proxy, and the client is told to try a smaller file.
// -----------------------------------------------------------------------------

export const attachmentsUploadRouter = Router();

const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many uploads. Please wait a few minutes and try again." },
});

/** The original file name, sent percent-encoded because non-ASCII is legal. */
function fileNameFrom(req: Request): string {
  const raw = req.header("x-file-name") ?? "";
  if (!raw) return "";
  try {
    return decodeURIComponent(raw).trim().slice(0, 255);
  } catch {
    // A malformed escape is not worth a 400: fall back to the raw header.
    return raw.trim().slice(0, 255);
  }
}

attachmentsUploadRouter.post(
  "/:publicId/attachments",
  uploadLimiter,
  requireAuth,
  requireRoles("staff", "cdm_contact", "admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    // Nothing has been read yet, so every early return must still drain the
    // request — otherwise the socket stays open and the client sees a hang
    // instead of the error we just wrote.
    const drain = () => {
      req.resume();
    };

    try {
      const submission = await getSubmissionByPublicId(req.params.publicId, req.user!.organization_id);
      if (!submission) {
        drain();
        res.status(404).json({ error: "Submission not found" });
        return;
      }
      // The two row-level guards, in the same order as submissionAccessError.
      if (!canAccessSchool(req.user!, submission.school_id)) {
        drain();
        res.status(403).json({ error: "Forbidden: submission belongs to another school" });
        return;
      }
      if (!(await canAccessForm(req.user!, submission.form_id))) {
        drain();
        res.status(403).json({ error: "Forbidden: no access to this form" });
        return;
      }
      const denied = await attachmentsAccessError(req.user!, submission.form_id);
      if (denied) {
        drain();
        res.status(denied.status).json({ error: denied.error });
        return;
      }

      const fileName = fileNameFrom(req);
      if (!fileName) {
        drain();
        res.status(400).json({ error: "No file was received." });
        return;
      }

      // The cap is checked BEFORE the upload starts, so an obviously-full
      // submission never spends minutes streaming a file that will be refused.
      // It is checked AGAIN inside the insert transaction, which is the copy
      // that actually holds under concurrency (db/attachments.ts).
      const folderId = await ensureSubmissionAttachmentFolder(submission.form_id, submission.public_id);
      if (!folderId) {
        drain();
        res.status(409).json({
          error: "This form has no Drive Folder ID configured. Ask an administrator to set one.",
        });
        return;
      }

      // If the client goes away mid-upload, destroy the stream so Google's
      // request fails instead of continuing to write a file nobody is waiting
      // for. `aborted` is the pre-Node-16 name kept for older proxies.
      req.on("aborted", () => {
        req.destroy();
      });

      const uploaded = await uploadAttachmentToDrive({
        folderId,
        name: attachmentDriveName(submission.public_id, fileName),
        mimeType: req.header("content-type") || "application/octet-stream",
        body: req,
      });

      let row;
      try {
        row = await createAttachment({
          submissionId: submission.id,
          driveFileId: uploaded.fileId,
          fileName,
          mimeType: req.header("content-type") || null,
          sizeBytes: uploaded.sizeBytes,
          webViewLink: uploaded.webViewLink,
          uploadedBy: req.user!.id,
        });
      } catch (err) {
        // The file is already in Drive and the row is not. Delete the file so
        // nothing is orphaned, then report the real reason.
        await deleteDriveFile(uploaded.fileId);
        if (err instanceof AttachmentLimitError) {
          res.status(409).json({ error: err.message });
          return;
        }
        throw err;
      }

      res.status(201).json({
        ...row,
        max: MAX_SUBMISSION_ATTACHMENTS,
      });
    } catch (err) {
      // A client disconnect surfaces here as an aborted stream. Answering is
      // pointless (nobody is listening) but the log line is what explains a
      // 502 in the proxy log.
      if (req.destroyed || req.aborted) {
        // eslint-disable-next-line no-console
        console.warn(`[attachments] upload aborted for ${req.params.publicId}`);
        return;
      }
      next(err);
    }
  }
);

// Everything else under /api/submissions falls through to the ordinary router.
attachmentsUploadRouter.use((_req, _res, next) => next());
