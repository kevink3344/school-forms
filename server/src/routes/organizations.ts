import { Router } from "express";
import {
  listOrganizations,
  listUsers,
  createOrganization,
  updateOrganization,
  getOrganizationById,
} from "../db/queries.js";
import { requireAuth, requireRoles } from "../auth.js";
import { createOrganizationSchema, updateOrganizationSchema } from "../schemas.js";

export const organizationsRouter = Router();

// Derive a URL-safe slug from a name (e.g. "Technology Services" => "technology-services").
// Lowercase, spaces/underscores to hyphens, strip anything else, collapse repeated
// hyphens, trim leading/trailing hyphens. The create route auto-derives when the
// client omits a slug; the UI shows the derived value on create but lets admins
// edit it on an existing org.
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "org"
  );
}

// Ensure a slug is unique among all orgs, excluding `excludeId`. Appends a
// numeric suffix on collision (academics, academics2, academics3, ...).
async function uniqueSlug(base: string, excludeId?: number): Promise<string> {
  const orgs = await listOrganizations();
  const taken = new Set(orgs.filter((o) => o.id !== excludeId).map((o) => o.slug));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

// -----------------------------------------------------------------------------
// GET /api/organizations — list all organizations (admin). This is a read-only
// coordinator list so admins can see which orgs exist and how many members each
// has. Admins are org-scoped, so this is informational only.
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
        active: org.active,
        created_at: org.created_at,
        member_count: members.length,
      });
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// POST /api/organizations — create an organization (admin).
// Slug is auto-derived from the name when omitted; duplicate slug/name returns 409.
// -----------------------------------------------------------------------------
organizationsRouter.post("/", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const parsed = createOrganizationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const name = parsed.data.name.trim();
    const slug = parsed.data.slug ? parsed.data.slug.trim() : await uniqueSlug(slugify(name));
    const active = parsed.data.active ?? true;

    // Guard against both a slug and an exact-name collision (both have unique indexes).
    const existing = await listOrganizations();
    if (existing.some((o) => o.slug === slug)) {
      res.status(409).json({ error: `Slug "${slug}" is already in use` });
      return;
    }
    if (existing.some((o) => o.name.toLowerCase() === name.toLowerCase())) {
      res.status(409).json({ error: `Organization "${name}" already exists` });
      return;
    }

    const org = await createOrganization(name, slug, active);
    res.status(201).json(org);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// PUT /api/organizations/:id — update an organization (admin): name / slug /
// active. 404 if not found; duplicate slug/name returns 409.
// -----------------------------------------------------------------------------
organizationsRouter.put("/:id", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const parsed = updateOrganizationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const existing = await getOrganizationById(id);
    if (!existing) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    let slug = parsed.data.slug?.trim() ?? existing.slug;
    if (parsed.data.slug) slug = await uniqueSlug(slug, id);
    const name = parsed.data.name?.trim() ?? existing.name;

    const orgs = await listOrganizations();
    if (orgs.some((o) => o.id !== id && o.slug === slug)) {
      res.status(409).json({ error: `Slug "${slug}" is already in use` });
      return;
    }
    if (orgs.some((o) => o.id !== id && o.name.toLowerCase() === name.toLowerCase())) {
      res.status(409).json({ error: `Organization "${name}" already exists` });
      return;
    }

    const updated = await updateOrganization(id, {
      name,
      slug,
      active: parsed.data.active,
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});
