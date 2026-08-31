import { Router } from "express";
import type { Request, Response } from "express";
import { isDbReady } from "../db/pool.js";
import { getDefaultOrganization, getLoginStats, getOrganizationBySlug } from "../db/queries.js";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.json({
    ok: true,
    dbReady: isDbReady(),
    uptime: process.uptime(),
  });
});

// INFO handler (mounted directly at /api/info in index.ts). The login page uses
// `loginModeOverride` to show an amber banner + disable the Setting when the
// operator locked the mode via the LOGIN_MODE env var.
export function infoHandler(_req: Request, res: Response) {
  const envOverride = process.env.LOGIN_MODE?.trim().toLowerCase();
  const loginModeOverride = envOverride &&
    ["select", "password", "maintenance"].includes(envOverride)
      ? envOverride
      : null;
  res.json({
    version: process.env.npm_package_version ?? "dev",
    loginModeOverride,
  });
}

healthRouter.get("/info", infoHandler);

// Public login stats for the login-page brand panel. Pre-auth, so no token.
// Resolves an optional `?org=<slug>` to an organization_id, defaulting to the
// first active org when none is supplied. Returns zeros if the org can't be
// resolved (cold/fresh DB never throws).
healthRouter.get("/stats", async (req, res, next) => {
  try {
    const orgSlug =
      typeof req.query.org === "string" && req.query.org.trim()
        ? req.query.org.trim()
        : undefined;

    let organizationId: number | null = null;
    if (orgSlug) {
      const org = await getOrganizationBySlug(orgSlug);
      organizationId = org?.id ?? null;
    } else {
      try {
        const org = await getDefaultOrganization();
        organizationId = org.id;
      } catch {
        organizationId = null;
      }
    }

    if (organizationId == null) {
      res.json({ users: 0, schools: 0, submissions: 0 });
      return;
    }
    res.json(await getLoginStats(organizationId));
  } catch (err) {
    next(err);
  }
});
