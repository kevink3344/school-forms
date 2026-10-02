import { roleLabelFor } from "./roles";

/**
 * How a role reads when it is one of several an audience is addressed to.
 *
 * Deliberately NOT the label a role badge shows. A badge names the role ONE
 * ACCOUNT holds ("Administrator"), while an audience names a SET OF PEOPLE the
 * notice is addressed to ("Administrators"). Same role, two sentences — which is
 * why this is a separate map rather than a reuse of the catalog's `label`.
 *
 * ★ `Record<string, string>` and not `Record<Role, string>`. That type was doing
 * real work: it made the map a compile-time gate, so adding a role meant fixing
 * this file. But roles are admin-managed data now, so a `Record` keyed on a finite
 * union would be a gate on a set that no longer exists — and it would fail
 * CLOSED, in the one direction that matters: a new role would have no plural and
 * its chips would read as the bare key. Now the map carries the plural for the
 * roles whose plural is not just the label plus an "s", and everything else falls
 * through to `roleLabelFor`.
 */
export const ROLE_AUDIENCE_LABELS: Record<string, string> = {
  admin: "Administrators",
  staff: "Staff",
  cdm_contact: "School Contacts",
  reviewer: "Reviewers",
};

/**
 * How a message's audience reads wherever it is summarised — the Settings table's
 * Audience column, the drawer's "Visible to …" hint and the badge on the notice
 * card itself. One function so those three can never disagree about the same
 * message.
 *
 * The three states mirror `SystemMessage.audience` exactly, and the distinction
 * has to survive the wording:
 *   - `null` is "Everyone", INCLUDING roles created later. It is what a NULL
 *     column reads back as, so it must not be flattened into the built-in roster:
 *     the server used to expand an unset audience to the roles that existed at
 *     that moment, which froze it, so a role created afterwards could not see a
 *     message nobody had narrowed. Checking `null` is the only correct test; a
 *     LENGTH check cannot tell "everyone" from "nobody" now that null exists.
 *   - an empty array is a real, deliverable-nothing state, and it has to SAY so.
 *     An empty label would look like missing data rather than a choice.
 *   - anything else is the roles it names, with unknown keys passed through
 *     rather than dropped: a grant written before a role existed (or after it was
 *     deleted) is real stored data, and rendering it as `undefined` or as a blank
 *     would hide it.
 */
export function audienceLabel(audience: string[] | null): string {
  if (audience === null) return "Everyone";
  if (audience.length === 0) return "No one";
  return audience.map((r) => ROLE_AUDIENCE_LABELS[r] ?? roleLabelFor(r)).join(", ");
}

/**
 * Parse a stored `documents_link` value (a JSON role array).
 *
 * Mirrors `parseDocumentRoles` in server/src/routes/settings.ts EXACTLY. It did
 * not, before: the client returned `[...ROLES]` for an unset value while the
 * server returned `null`, and the two disagreed in the one direction that
 * matters — the client's expanded list is frozen at the roles that existed when
 * it ran, so a role created afterwards saw no Documents link on a screen whose
 * setting said "unrestricted".
 *
 * `null` = unrestricted (everyone, including roles created later); `[]` = hidden
 * for everyone; a list = exactly those. Unknown keys are PRESERVED rather than
 * filtered against a known-roles list, and the only strings dropped are empties.
 */
export function parseDocumentRoles(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null) return null;
    if (Array.isArray(parsed)) {
      return parsed.filter((r): r is string => typeof r === "string" && r !== "");
    }
  } catch {
    // A corrupt blob degrades to "unrestricted" rather than to "nobody".
  }
  return null;
}

/** Whether a given role currently sees the Documents link. */
export function documentsEnabledFor(raw: string | null | undefined, role: string): boolean {
  const allowed = parseDocumentRoles(raw);
  return allowed === null || allowed.includes(role);
}

// ---------------------------------------------------------------------------
// Menu visibility — which sidebar items are shown, by role.
// Mirrors the server's MENU_ITEMS_KEY / parseMenuItems in routes/settings.ts.
// ---------------------------------------------------------------------------

// The menu items that can be toggled from Settings → Menu Settings. Keep in sync
// with the server's MENU_ITEM_KEYS.
//
// Documents is deliberately NOT in this list. It already has its own per-role
// control — `documents_link`, the Documents Link panel — which additionally gates
// the /api/documents endpoints. Listing it here too gave one link two per-role
// switches, and the generic one silently overrode the specific one: an admin
// could switch Documents on in the Documents Link panel and still see no link,
// with nothing on screen explaining why. Forms and Reports have no dedicated
// control of their own, so they belong here.
export const MENU_ITEMS = ["forms", "reports", "available_forms"] as const;
export type MenuItemKey = (typeof MENU_ITEMS)[number];

// Human-facing label for a menu item.
export const MENU_ITEM_LABELS: Record<MenuItemKey, string> = {
  forms: "Forms",
  reports: "Reports",
  // ★ Added for the Available Forms page (docs/plans/public-private-forms.md
  // §16.5). Unlike `documents`, this link has NO dedicated per-role setting of
  // its own — it is available to every internal role — so a `menu_items` key is
  // the right and only gate. (Ask "is there already a gate?" before adding a key:
  // `documents` was deliberately REMOVED from both lists for exactly that reason.)
  available_forms: "Available Forms",
};

// Every menu item visible to everyone — the default when the setting, or one key
// of it, is unset. `null` per item means "visible to every role", INCLUDING roles
// created later; it is NOT the built-in roster, which would bake in today's list
// and hide a new role from a menu nobody had narrowed. Mirrors
// `defaultMenuItems` in server/src/routes/settings.ts.
export function defaultMenuItems(): Record<MenuItemKey, string[] | null> {
  const out = {} as Record<MenuItemKey, string[] | null>;
  for (const k of MENU_ITEMS) out[k] = null;
  return out;
}

/**
 * Parse a stored `menu_items` value (a JSON object of `{ item: Role[] }`) into a
 * full map. Mirrors `parseMenuItems` in server/src/routes/settings.ts.
 *
 * A missing key, a null/blank/unparsable value, or a non-array entry is `null`
 * for that item, i.e. "everyone". An explicitly empty array is preserved (hidden
 * for everyone). Unknown keys inside an array are PRESERVED rather than filtered
 * against a known-roles list — the previous version ran
 * `ROLES.filter((r) => v.includes(r))`, which meant a stored row written before a
 * role existed silently dropped that role, while a MISSING key defaulted to
 * "everyone". So the same configuration behaved differently depending on whether
 * anyone had ever opened the panel.
 */
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
  for (const k of MENU_ITEMS) {
    const v = obj[k];
    if (!Array.isArray(v)) continue;
    out[k] = v.filter((r): r is string => typeof r === "string" && r !== "");
  }
  return out;
}

/** Whether a given menu item is visible to a role. */
export function menuItemVisibleFor(
  raw: string | null | undefined,
  item: MenuItemKey,
  role: string
): boolean {
  const allowed = parseMenuItems(raw)[item];
  return allowed === null || allowed.includes(role);
}
