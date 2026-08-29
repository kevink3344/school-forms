import { Router } from "express";
import { requireAuth, requireRoles } from "../auth.js";
import { listDocuments, getDocumentById } from "../db/documents.js";
import { generateDocument } from "../google/docs.js";

export const documentsRouter = Router();

// -----------------------------------------------------------------------------
// STAFF: GET /api/documents — the Documents list page.
// Staff scoped to their school; admin scoped to their org. Returns the enriched
// ListDocumentRow[] (student/school/course/phase fields + document_id + status).
// -----------------------------------------------------------------------------
documentsRouter.get("/", requireAuth, requireRoles("staff", "admin"), async (req, res, next) => {
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
documentsRouter.post("/:id/retry", requireAuth, requireRoles("staff", "admin"), async (req, res, next) => {
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
