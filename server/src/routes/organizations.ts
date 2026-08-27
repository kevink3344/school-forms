import { Router } from "express";
import { listOrganizations, listUsers } from "../db/queries.js";
import { requireAuth, requireRoles } from "../auth.js";

export const organizationsRouter = Router();

// -----------------------------------------------------------------------------
// GET /api/organizations — list all organizations (admin). This is a read-only
// coordinator list so admins can see which orgs exist and how many members each
// has. Admirals are org-scoped, so this is informational only.
// -----------------------------------------------------------------------------
organizationsRouter.get("/", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const orgs = await listOrganizations();
    const out = [];
    for (const org of orgs) {
      const members = await listUsers(org.id);
      out.push({
        id: org.id,
        slug: org.slug,
        name: org.name,
        created_at: org.created_at,
        member_count: members.length,
      });
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
});
