import { Router } from "express";
import type { Request, Response } from "express";
import { isDbReady } from "../db/pool.js";

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
