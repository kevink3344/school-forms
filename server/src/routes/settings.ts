import { Router } from "express";
import { getSetting, setSetting } from "../db/queries.js";
import { requireAuth, requireRoles } from "../auth.js";
import { ROLES, type Role } from "../db/schema.js";

export const settingsRouter = Router();

export const DOCUMENTS_LINK_KEY = "documents_link";

// Allow-list of keys that can be read/written. Never let an arbitrary key hit
// the store. `login_mode` and `maintenance_message` back the Login Mode feature;
// `documents_link` controls whether the Documents sidebar link is visible, by role.
export const ALLOWED_SETTING_KEYS = new Set(["login_mode", "maintenance_message", DOCUMENTS_LINK_KEY]);

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
  if (key === DOCUMENTS_LINK_KEY) {
    return JSON.stringify([...ROLES]); // visible to every current role by default
  }
  return "select"; // login_mode
}

// Parse a stored documents_link value (a JSON role array) into a Role[]. A null,
// undefined, or blank value defaults to every current role so legacy rows behave
// as before. An explicitly empty array means "hidden for everyone" (master off).
export function parseDocumentRoles(raw: string | null | undefined): Role[] {
  if (raw === null || raw === undefined || raw.trim() === "") return [...ROLES];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (r): r is Role => typeof r === "string" && (ROLES as readonly string[]).includes(r)
      );
    }
  } catch {
    // fall through to the default
  }
  return [...ROLES];
}

// Decide whether a given role currently sees the Documents link.
export function documentsEnabledFor(raw: string | null | undefined, role: Role): boolean {
  return parseDocumentRoles(raw).includes(role);
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

    let effective = value.trim();
    if (key === DOCUMENTS_LINK_KEY) {
      // Validate + normalize the JSON role array (dedupe, canonical role order).
      let roles: unknown;
      try {
        roles = JSON.parse(effective);
      } catch {
        res.status(400).json({ error: "value must be a JSON array of roles" });
        return;
      }
      if (!Array.isArray(roles) || roles.some((r) => typeof r !== "string" || !(ROLES as readonly string[]).includes(r))) {
        res.status(400).json({ error: "value must be a JSON array of roles: [\"admin\",\"staff\"]" });
        return;
      }
      effective = JSON.stringify(ROLES.filter((r) => (roles as string[]).includes(r)));
    } else if (key === "login_mode") {
      effective = value.trim().toLowerCase();
    }

    const stored = await setSetting(key, effective);
    res.json({ key, value: stored });
  } catch (err) {
    next(err);
  }
});
