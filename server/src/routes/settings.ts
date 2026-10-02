import { Router } from "express";
import { getSetting, setSetting } from "../db/queries.js";
import { requireAuth, requireRoles } from "../auth.js";
import { getRolesCache } from "../db/roles-cache.js";
import { env } from "../config/env.js";
import { notifySlack } from "../notify/slack.js";

export const settingsRouter = Router();

export const DOCUMENTS_LINK_KEY = "documents_link";

// Menu visibility — which sidebar items are shown, by role. Stored as a JSON
// object of `{ [menuKey]: string[] | null }`, e.g. `{"forms":["admin","staff"]}`.
// A missing key (or a null/blank setting, or an explicit null) means "visible to
// every role", so legacy rows keep working and a role created later is included
// rather than silently excluded. An explicitly empty array hides that item for
// all. Unknown keys are ignored, which is what lets a row written by an earlier
// version — still carrying the retired `documents` and `schools` keys — keep
// parsing cleanly instead of needing a migration.
export const MENU_ITEMS_KEY = "menu_items";

// The menu items that can be toggled from Settings. Kept in sync with the
// client's MENU_ITEMS in lib/settings.ts.
//
// Documents is deliberately NOT here — it is governed by `documents_link` (the
// Documents Link panel), which also gates the /api/documents endpoints. Having it
// in both places meant a hidden `menu_items.documents` silently overrode a visible
// `documents_link`, so the admin's Documents Link toggles appeared to do nothing.
export const MENU_ITEM_KEYS = ["forms", "reports", "available_forms"] as const;
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
    // NULL means UNRESTRICTED (see parseDocumentRoles), which is the historical
    // "visible to every role" default. Materialising [...ROLES] here instead
    // would freeze the default at the roles that exist today, so an admin-created
    // role would not see the Documents link in an untouched installation.
    return JSON.stringify(null);
  }
  if (key === MENU_ITEMS_KEY) {
    // Every menu item visible to everyone by default (null = unrestricted).
    return JSON.stringify(defaultMenuItems());
  }
  return "select"; // login_mode
}

// The default menu map. `null` per item means "visible to everyone", including
// roles created later — NOT `[...ROLES]`, which would bake in today's list.
export function defaultMenuItems(): Record<MenuItemKey, string[] | null> {
  const out = {} as Record<MenuItemKey, string[] | null>;
  for (const k of MENU_ITEM_KEYS) out[k] = null;
  return out;
}

// Parse a stored menu_items value into a full map.
//
// A missing key, a null/blank setting, or an unparsable value falls back to
// "visible to every role" for that item so legacy rows behave as before. An
// explicitly empty array is preserved (hidden for everyone).
//
// ★ Unknown roles are now PRESERVED rather than dropped. The old
// `ROLES.filter((r) => v.includes(r))` meant a stored row written before a role
// existed silently dropped that role, while a *missing* key defaulted to
// "everyone" and included it — so the same configuration behaved differently
// depending on whether anyone had ever opened the Menu Settings panel. The write
// path is validated; this normalisation was a second, weaker copy of that
// validation, and removing it removes the asymmetry.
export function parseMenuItems(
  raw: string | null | undefined
): Record<MenuItemKey, string[] | null> {
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
    if (v === undefined) continue; // missing → default (everyone)
    if (!Array.isArray(v)) continue;
    out[k] = v.map(String).filter(Boolean);
  }
  return out;
}

// Whether a given menu item is visible to a role. `null` (unrestricted) means
// every role sees it, including a role an admin creates later.
export function menuItemVisibleFor(
  raw: string | null | undefined,
  item: MenuItemKey,
  role: string
): boolean {
  const allowed = parseMenuItems(raw)[item];
  return allowed === null || allowed.includes(role);
}

// Parse a stored documents_link value (a JSON role array) into `string[] | null`.
//
// ★ `null` means UNRESTRICTED — every role, including ones that do not exist
// yet. A null, undefined or blank value returns the sentinel rather than
// `[...ROLES]`; the latter froze the default at the roles present when the value
// was written. An explicitly empty array means "hidden for everyone" and is kept
// distinct. Unknown role keys are preserved so a stored row is never silently
// rewritten.
export function parseDocumentRoles(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw);
    // An explicit `null` in the stored JSON is the same sentinel.
    if (parsed === null) return null;
    if (Array.isArray(parsed)) {
      return parsed.filter((r): r is string => typeof r === "string" && r !== "");
    }
  } catch {
    // fall through to the default
  }
  return null;
}

// Decide whether a given role currently sees the Documents link.
export function documentsEnabledFor(raw: string | null | undefined, role: string): boolean {
  const allowed = parseDocumentRoles(raw);
  return allowed === null || allowed.includes(role);
}

// Validate a submitted array of role keys against the live catalog.
//
// ★ This asks the DATABASE, not a constant. The old check was
// `(ROLES as readonly string[]).includes(r)` — membership in the three built-in
// keys — so the moment an admin could create a role, the write path rejected it.
// A custom role existed in the catalog, could be assigned to a user, and could
// not be added to the Documents Link or Menu settings: the panel's own control
// would 400 with a message listing three keys the admin had never created one of.
//
// Unknown keys are REFUSED rather than stored. The alternative — accept anything,
// on the grounds that a dangling key fails safe (every reader treats an unknown
// key as absent, so it narrows access) — trades an immediate, actionable error for
// a silent no-op the admin discovers later as "the toggle does nothing". Deletion
// is where a dangling key becomes a real hazard (see `roleUsage`), and refusing it
// here is what keeps that census meaningful.
//
// Lookup is case-insensitive and the SUBMITTED spelling is preserved, because
// that is the spelling every other store holds; normalising here would silently
// rename an existing grant.
async function validateRoleKeys(
  values: unknown[]
): Promise<{ ok: true; keys: string[] } | { ok: false; error: string }> {
  const catalog = await getRolesCache();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.trim() === "") {
      return { ok: false, error: "roles must be an array of non-empty strings" };
    }
    const key = value.trim();
    if (!catalog.has(key.toLowerCase())) {
      const known = [...catalog.keys()].sort().join(", ");
      return { ok: false, error: `unknown role "${key}". Known roles: ${known}` };
    }
    if (!out.includes(key)) out.push(key);
  }
  return { ok: true, keys: out };
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
      // Two accepted shapes:
      //   `null`            → UNRESTRICTED (every role, including future ones)
      //   ["admin","staff"] → exactly those roles
      // An empty array is a third, distinct meaning: hidden for everyone.
      let roles: unknown;
      try {
        roles = JSON.parse(effective);
      } catch {
        res.status(400).json({ error: "value must be a JSON array of roles, or null" });
        return;
      }
      if (roles === null) {
        effective = JSON.stringify(null);
      } else if (!Array.isArray(roles)) {
        res.status(400).json({ error: "value must be a JSON array of roles, or null" });
        return;
      } else {
        const checked = await validateRoleKeys(roles);
        if (!checked.ok) {
          res.status(400).json({ error: checked.error });
          return;
        }
        effective = JSON.stringify(checked.keys);
      }
    } else if (key === MENU_ITEMS_KEY) {
      // A JSON object of `{ [menuKey]: string[] | null }`. Unknown menu KEYS are
      // dropped (MENU_ITEM_KEYS is the schema); unknown ROLES are rejected with a
      // message naming the ones that exist.
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
      const normalized: Record<string, string[] | null> = {};
      for (const k of MENU_ITEM_KEYS) {
        const v = obj[k];
        if (v === undefined) continue;
        // `null` is the unrestricted sentinel — stored explicitly so the intent
        // is recorded, rather than omitted and re-derived from a default.
        if (v === null) {
          normalized[k] = null;
          continue;
        }
        if (!Array.isArray(v)) {
          res.status(400).json({ error: `menu item "${k}" must be an array of roles, or null` });
          return;
        }
        const checked = await validateRoleKeys(v);
        if (!checked.ok) {
          res.status(400).json({ error: `menu item "${k}": ${checked.error}` });
          return;
        }
        normalized[k] = checked.keys;
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
