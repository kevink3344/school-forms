import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth, requireRoles } from "../auth.js";
import { listDocuments, getDocumentById, listDocumentsBySubmission } from "../db/documents.js";
import { generateDocument, regenerateDocument } from "../google/docs.js";
import { getSetting } from "../db/queries.js";
import { documentsEnabledFor } from "./settings.js";

export const documentsRouter = Router();

// Gate the Documents feature per-role via the documents_link setting. If the
// caller's role is not enabled, refuse the request (the sidebar link is also
// hidden client-side; this is the defensive server-side gate).
export async function documentsEnabled(req: Request, res: Response, next: NextFunction) {
  try {
    const raw = await getSetting("documents_link");
    if (!documentsEnabledFor(raw, req.user!.role)) {
      res.status(403).json({ error: "Documents is disabled for your role" });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

// -----------------------------------------------------------------------------
// STAFF: GET /api/documents — the Documents list page.
// Staff scoped to their school; admin scoped to their org. Returns the enriched
// ListDocumentRow[] (student/school/course/phase fields + document_id + status).
// -----------------------------------------------------------------------------
documentsRouter.get("/", requireAuth, requireRoles("staff", "admin"), documentsEnabled, async (req, res, next) => {
  try {
    const rows = await listDocuments(
      req.user!.role === "staff"
        ? { schoolId: req.user!.school_id }
        : { organizationId: req.user!.organization_id }
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: POST /api/documents/:id/retry — re-attempt a Failed (or Pending) doc.
// Sets the row back to Pending and runs the Google generator in the background
// (fire-and-forget, the retry responds immediately). Ownership scoped like the
// list: staff → their school, admin → their org.
// -----------------------------------------------------------------------------
documentsRouter.post("/:id/retry", requireAuth, requireRoles("staff", "admin"), documentsEnabled, async (req, res, next) => {
  try {
    const dbId = Number(req.params.id);
    if (!Number.isInteger(dbId) || dbId <= 0) {
      res.status(400).json({ error: "Invalid document id" });
      return;
    }

    const doc = await getDocumentById(
      dbId,
      req.user!.role === "staff"
        ? { schoolId: req.user!.school_id }
        : { organizationId: req.user!.organization_id }
    );
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    // Only allow retrying a Failed (or stale Pending) row.
    if (doc.status === "Completed") {
      res.status(400).json({ error: "Document already completed" });
      return;
    }

    // Fire-and-forget; don't block the 200. Reuses idempotent generateDocument.
    void generateDocument(doc.submission_id, req.user!.id).catch(() => undefined);

    // Return the row as it stands (now Pending once the generator resets it).
    const refreshed = await getDocumentById(
      dbId,
      req.user!.role === "staff"
        ? { schoolId: req.user!.school_id }
        : { organizationId: req.user!.organization_id }
    );
    res.json(refreshed ?? doc);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: POST /api/documents/:id/regenerate — force a fresh document from the
// submission's CURRENT values. Unlike retry, this is allowed even for a
// Completed doc and even if none exists yet: it creates a brand-new Google Doc
// (copying the template again) using whatever the submission answer values are
// now. This lets a staff member correct a mistake on the submission and
// regenerate a corrected document. Ownership scoped like the list. Creates a
// fresh Pending row synchronously and returns it; the Google work runs in the
// background.
// -----------------------------------------------------------------------------
documentsRouter.post("/:id/regenerate", requireAuth, requireRoles("staff", "admin"), documentsEnabled, async (req, res, next) => {
  try {
    const dbId = Number(req.params.id);
    if (!Number.isInteger(dbId) || dbId <= 0) {
      res.status(400).json({ error: "Invalid document id" });
      return;
    }

    const doc = await getDocumentById(
      dbId,
      req.user!.role === "staff"
        ? { schoolId: req.user!.school_id }
        : { organizationId: req.user!.organization_id }
    );
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    // Create a fresh Pending row synchronously and kick off the background
    // regeneration from the submission's current values.
    await regenerateDocument(doc.submission_id, req.user!.id);

    // Return the newest document rows for the submission (the new one is Pending).
    const rows = await listDocumentsBySubmission(doc.submission_id);
    res.json(rows[0] ?? doc);
  } catch (err) {
    next(err);
  }
});
