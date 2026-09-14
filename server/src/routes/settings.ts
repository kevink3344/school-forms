import { Router } from "express";
import { getSetting, setSetting } from "../db/queries.js";
import { requireAuth, requireRoles } from "../auth.js";
import { ROLES, type Role } from "../db/schema.js";
import { env } from "../config/env.js";
import { notifySlack } from "../notify/slack.js";

export const settingsRouter = Router();

export const DOCUMENTS_LINK_KEY = "documents_link";

// Menu visibility — which sidebar items are shown, by role. Stored as a JSON
// object of `{ [menuKey]: Role[] }`, e.g. `{"documents":["admin","staff"]}`.
// A missing key (or a null/blank setting) means "visible to every role", so
// legacy rows keep working. An explicitly empty array hides that item for all.
export const MENU_ITEMS_KEY = "menu_items";

// The menu items that can be toggled from Settings. Kept in sync with the
// client's MENU_ITEMS in lib/settings.ts.
export const MENU_ITEM_KEYS = ["documents", "forms", "schools", "reports"] as const;
export type MenuItemKey = (typeof MENU_ITEM_KEYS)[number];

// Allow-list of keys that can be read/written. Never let an arbitrary key hit
// the store. `login_mode` and `maintenance_message` back the Login Mode feature;
// `documents_link` controls whether the Documents sidebar link is visible, by role.
export const ALLOWED_SETTING_KEYS = new Set([
  "login_mode",
  "maintenance_message",
  DOCUMENTS_LINK_KEY,
  MENU_ITEMS_KEY,
]);

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
  if (key === MENU_ITEMS_KEY) {
    // Every menu item visible to every role by default.
    return JSON.stringify(defaultMenuItems());
  }
  return "select"; // login_mode
}

// The default menu map: every toggleable item visible to every current role.
export function defaultMenuItems(): Record<MenuItemKey, Role[]> {
  const out = {} as Record<MenuItemKey, Role[]>;
  for (const k of MENU_ITEM_KEYS) out[k] = [...ROLES];
  return out;
}

// Parse a stored menu_items value into a full map. A missing key, a null/blank
// setting, or an unparsable value falls back to "visible to every role" for that
// item so legacy rows behave as before. An explicitly empty array is preserved
// (hidden for everyone). Unknown keys are ignored; unknown roles are dropped.
export function parseMenuItems(raw: string | null | undefined): Record<MenuItemKey, Role[]> {
  const out = defaultMenuItems();
  if (raw === null || raw === undefined || raw.trim() === "") return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  const obj = parsed as Record<string, unknown>;
  for (const k of MENU_ITEM_KEYS) {
    const v = obj[k];
    if (v === undefined) continue; // missing → default (all roles)
    if (!Array.isArray(v)) continue;
    out[k] = (ROLES as readonly Role[]).filter((r) => v.includes(r));
  }
  return out;
}

// Whether a given menu item is visible to a role.
export function menuItemVisibleFor(
  raw: string | null | undefined,
  item: MenuItemKey,
  role: Role
): boolean {
  return parseMenuItems(raw)[item].includes(role);
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
        res.status(400).json({ error: `value must be a JSON array of roles: ${JSON.stringify(ROLES)}` });
        return;
      }
      effective = JSON.stringify(ROLES.filter((r) => (roles as string[]).includes(r)));
    } else if (key === MENU_ITEMS_KEY) {
      // Validate + normalize the JSON menu map. Unknown keys are dropped and
      // unknown roles are filtered out; each value must be an array of roles.
      let parsed: unknown;
      try {
        parsed = JSON.parse(effective);
      } catch {
        res.status(400).json({ error: "value must be a JSON object of menu items" });
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        res.status(400).json({ error: "value must be a JSON object of menu items" });
        return;
      }
      const obj = parsed as Record<string, unknown>;
      const normalized: Record<string, Role[]> = {};
      for (const k of MENU_ITEM_KEYS) {
        const v = obj[k];
        if (v === undefined) continue;
        if (!Array.isArray(v) || v.some((r) => typeof r !== "string" || !(ROLES as readonly string[]).includes(r))) {
          res.status(400).json({ error: `menu item "${k}" must be an array of roles: ${JSON.stringify(ROLES)}` });
          return;
        }
        normalized[k] = ROLES.filter((r) => (v as string[]).includes(r));
      }
      effective = JSON.stringify(normalized);
    } else if (key === "login_mode") {
      effective = value.trim().toLowerCase();
    }

    const stored = await setSetting(key, effective);
    res.json({ key, value: stored });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// POST /api/settings/slack/test — send a test Slack message (admin only).
//
// Lets an admin verify the SLACK_WEBHOOK_URL and preview how a notification
// renders. Subject is sent bold; the optional body follows on a new line. Both
// support Slack mrkdwn formatting (*bold*, _italic_, `code`, >quote, links).
// -----------------------------------------------------------------------------
settingsRouter.post("/slack/test", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const subject = typeof req.body?.subject === "string" ? req.body.subject.trim() : "";
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!subject) {
      res.status(400).json({ error: "subject is required" });
      return;
    }

    const configured = !!env.slack.webhookUrl;
    const text = `*${subject}*${body ? `\n\n${body}` : ""}`;
    const sent = configured ? await notifySlack({ text }) : false;

    if (!configured) {
      res.status(400).json({ ok: false, error: "Slack webhook is not configured. Set SLACK_WEBHOOK_URL and restart the server." });
      return;
    }
    if (!sent) {
      res.status(400).json({ ok: false, error: "Slack send failed. Check the webhook URL and the server logs." });
      return;
    }
    res.json({ ok: true, message: "Test message sent to Slack." });
  } catch (err) {
    next(err);
  }
});
