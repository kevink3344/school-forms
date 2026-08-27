import { Router } from "express";
import { getSetting, setSetting } from "../db/queries.js";
import { requireAuth, requireRoles } from "../auth.js";

export const settingsRouter = Router();

// Allow-list of keys that can be read/written. Never let an arbitrary key hit
// the store. `login_mode` and `maintenance_message` back the Login Mode feature.
export const ALLOWED_SETTING_KEYS = new Set(["login_mode", "maintenance_message"]);

// Valid login modes. Used both for the env override and to validate a PUT.
export const LOGIN_MODES = new Set(["select", "password", "maintenance"]);

// Resolve the effective login mode, honoring the LOGIN_MODE env var override.
// The override is read-only from the API's point of view — a PUT still writes to
// the DB, but reads keep returning the env value until the env var is removed.
export function resolveLoginMode(): string {
  const envOverride = process.env.LOGIN_MODE?.trim().toLowerCase();
  if (envOverride && LOGIN_MODES.has(envOverride)) return envOverride;
  return "select"; // default when no row and no override
}

function defaultValue(key: string): string {
  if (key === "maintenance_message") {
    return "We are performing scheduled maintenance. Please try again shortly.";
  }
  return "select"; // login_mode
}

// -----------------------------------------------------------------------------
// GET /api/settings/:key — public (no auth). The login page reads this to decide
// which form to render, before the user is authenticated.
// -----------------------------------------------------------------------------
settingsRouter.get("/:key", async (req, res, next) => {
  try {
    const key = req.params.key;
    if (!ALLOWED_SETTING_KEYS.has(key)) {
      res.status(400).json({ error: `Unknown setting: ${key}` });
      return;
    }

    // login_mode honors the env override when present.
    if (key === "login_mode") {
      const envOverride = process.env.LOGIN_MODE?.trim().toLowerCase();
      if (envOverride && LOGIN_MODES.has(envOverride)) {
        res.json({ key, value: envOverride });
        return;
      }
    }

    const stored = await getSetting(key);
    res.json({ key, value: stored ?? defaultValue(key) });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// PUT /api/settings/:key — admin-only upsert.
// -----------------------------------------------------------------------------
settingsRouter.put("/:key", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const key = req.params.key;
    if (!ALLOWED_SETTING_KEYS.has(key)) {
      res.status(400).json({ error: `Unknown setting: ${key}` });
      return;
    }
    const value = req.body?.value;
    if (typeof value !== "string" || value.trim() === "") {
      res.status(400).json({ error: "value must be a non-empty string" });
      return;
    }
    if (key === "login_mode" && !LOGIN_MODES.has(value.trim().toLowerCase())) {
      res.status(400).json({ error: `Invalid login mode: ${value}` });
      return;
    }

    const stored = await setSetting(key, key === "login_mode" ? value.trim().toLowerCase() : value.trim());
    res.json({ key, value: stored });
  } catch (err) {
    next(err);
  }
});
