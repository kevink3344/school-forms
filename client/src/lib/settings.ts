import type { Role } from "../types";

// The set of roles the app currently supports. Kept in sync with the server's
// `ROLES`. Extend both to add a future role; the toggle badges render from it.
export const ROLES: Role[] = ["admin", "staff", "cdm_contact"];

// Parse a stored documents_link value (a JSON role array) into a Role[]. A null
// / undefined / blank / unparsable value defaults to every current role so legacy
// rows behave as before. An explicitly empty array means "hidden for everyone"
// (master off). Mirrors the server's parseDocumentRoles in settings.ts.
export function parseDocumentRoles(raw: string | null | undefined): Role[] {
  if (raw === null || raw === undefined || raw.trim() === "") return [...ROLES];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (r): r is Role => typeof r === "string" && ROLES.includes(r as Role)
      );
    }
  } catch {
    // fall through to the default
  }
  return [...ROLES];
}

// Whether a given role currently sees the Documents link.
export function documentsEnabledFor(raw: string | null | undefined, role: Role): boolean {
  return parseDocumentRoles(raw).includes(role);
}

// ---------------------------------------------------------------------------
// Menu visibility — which sidebar items are shown, by role.
// Mirrors the server's MENU_ITEMS_KEY / parseMenuItems in routes/settings.ts.
// ---------------------------------------------------------------------------

// The menu items that can be toggled from Settings → Menu Settings. Keep in sync
// with the server's MENU_ITEM_KEYS.
export const MENU_ITEMS = ["documents", "forms", "schools", "reports"] as const;
export type MenuItemKey = (typeof MENU_ITEMS)[number];

// Human-facing label for a menu item.
export const MENU_ITEM_LABELS: Record<MenuItemKey, string> = {
  documents: "Documents",
  forms: "Forms",
  schools: "Schools",
  reports: "Reports",
};

// Every menu item visible to every role — the default when the setting is unset.
export function defaultMenuItems(): Record<MenuItemKey, Role[]> {
  const out = {} as Record<MenuItemKey, Role[]>;
  for (const k of MENU_ITEMS) out[k] = [...ROLES];
  return out;
}

// Parse a stored menu_items value (a JSON object of `{ item: Role[] }`) into a
// full map. A missing key, a null/blank/unparsable value, or a non-array entry
// falls back to "visible to every role" for that item, so legacy rows behave as
// before. An explicitly empty array is preserved (hidden for everyone).
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
  for (const k of MENU_ITEMS) {
    const v = obj[k];
    if (!Array.isArray(v)) continue;
    out[k] = ROLES.filter((r) => v.includes(r));
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
