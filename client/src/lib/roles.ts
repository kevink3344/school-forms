// The role catalog, as the browser sees it.
//
// Roles are admin-managed DATA (`dbo.roles`), not a fixed list, so every screen
// that names a role needs the catalog to render it correctly. This module is the
// one place that:
//   * fetches it, once, and keeps it in a module-level store so twenty components
//     do not issue twenty requests;
//   * turns a stored role key into a display label and a badge;
//   * offers the badge choices the stylesheet can actually tell apart.
//
// ★ Why this exists rather than a `roleBadge()` function in the Settings page: the
// previous version was `if (role === "admin") … if (role === "cdm_contact") … else
// "Staff"`, so a role an administrator created was labelled "Staff" and wore
// staff's badge. That is not a cosmetic bug — the Users grid would show a custom
// role as Staff, beside a real Staff account, with no way to tell them apart. The
// fix is to read the row the administrator actually typed.
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { RoleRow } from "../types";

/**
 * The roles the boot ladder seeds, in the order they are seeded.
 *
 * This is used for TWO things only — display order for the built-ins, and a
 * fallback label/badge before the catalog has loaded. It is deliberately not an
 * authorization input: `user.role === "admin"` answers "no" for a role an
 * administrator created and granted administrator power, which is why authority
 * is read from `User.capabilities` instead. Keep this in step with the seed in
 * server/src/db/schema.ts; a mismatch costs only ordering, never access.
 */
export const BUILT_IN_ROLES: readonly string[] = ["admin", "staff", "cdm_contact", "reviewer"];

/**
 * Labels for the seeded roles, used only until the catalog arrives (and as a
 * fallback if the read fails). Once a row is in hand its own `label` wins — an
 * administrator may rename a built-in, and every screen must follow that rename.
 *
 * `reviewer` is a built-in, so its label is here rather than being left to fall
 * through to the raw key.
 */
const FALLBACK_LABEL: Record<string, string> = {
  admin: "Administrator",
  staff: "Staff",
  cdm_contact: "School Contact",
  reviewer: "Reviewer",
};

/**
 * Badge colours for the seeded roles, preserving exactly what the Settings page
 * rendered before badges moved into the catalog.
 *
 * Needed because the seed never writes `badge` — all four built-ins have a NULL
 * badge column — so without this the Administrator badge would silently become
 * the default colour. A NULL badge is not a gap to fill by an UPDATE at boot:
 * `label`/`description`/`badge` are deliberately not re-derived, precisely so an
 * administrator's choice survives a restart.
 */
const FALLBACK_BADGE: Record<string, string> = {
  admin: "orange",
  staff: "blue",
  cdm_contact: "teal",
  reviewer: "blue",
};

/**
 * The badge suffixes the stylesheet declares.
 *
 * An ALLOWLIST rather than a sanitiser. The server accepts any trimmed string up
 * to 40 characters for `badge`, so the value can be anything; interpolating an
 * arbitrary string into a class name cannot execute, but it can produce an
 * unstyled badge (or one that collides with some future `badge-*` rule), and the
 * failure is invisible. Anything not in this set falls back to a real class.
 */
const BADGE_CLASSES = new Set(["blue", "green", "teal", "amber", "red", "orange", "slate", "gray"]);

/**
 * The badge choices worth offering, and the reason there are only three.
 *
 * ★ The stylesheet declares EIGHT badge classes but only THREE distinct
 * declarations: `.badge-blue`, `.badge-green` and `.badge-teal` are all
 * `--filled-bg`, `.badge-amber`, `.badge-red` and `.badge-orange` are all
 * `--orange-tint`, and `.badge-slate` and `.badge-gray` are both `--panel-bg`. A
 * class name is a label, not a value. Offering all eight would let an
 * administrator pick "Green", see the pill turn blue, and conclude the picker is
 * broken — so the picker offers one entry per distinguishable colour and says so.
 * (`badgeClass` still accepts all eight, for a row written by something else.)
 *
 * This also means the seeded `staff` (blue) and `cdm_contact` (teal) badges have
 * always rendered identically. That predates this panel and is left alone; the
 * hue is decoration, and the label beside it is what identifies the role.
 */
export const BADGE_CHOICES: readonly { value: string; label: string; hint: string }[] = [
  { value: "blue", label: "Blue", hint: "The default. Reads as an ordinary role." },
  { value: "orange", label: "Orange", hint: "Draws the eye. What Administrator wears." },
  { value: "gray", label: "Grey", hint: "Low emphasis, for a role you rarely touch." },
];

/** The class to render for a stored badge value, falling back to the default. */
export function badgeClass(value: string | null | undefined): string {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return `badge-${BADGE_CLASSES.has(key) ? key : "blue"}`;
}

// -----------------------------------------------------------------------------
// The store.
//
// Module-level rather than context, because the catalog is installation-wide and
// identical for every component — there is no per-subtree variant to provide, so a
// provider would only add a way for half the app to have a stale copy. It is a
// plain subscription list with `useState` in the subscriber, which keeps
// `getSnapshot` identity issues (and the render loops that come with them) out of
// the picture entirely.
// -----------------------------------------------------------------------------

interface CatalogState {
  roles: RoleRow[];
  loading: boolean;
  error: string | null;
}

let state: CatalogState = { roles: [], loading: false, error: null };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setState(patch: Partial<CatalogState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

/**
 * Display order: the built-ins first in their seeded order, then custom roles
 * alphabetically.
 *
 * Not the server's order, deliberately. A role added last would otherwise appear
 * at the bottom of a table whose top half is a fixed set, so the same
 * installation would show a different order depending on nothing the reader can
 * see. Sorting here also keeps the order stable across a rename.
 */
function sortRoles(rows: RoleRow[]): RoleRow[] {
  const rank = (row: RoleRow): number => {
    const i = BUILT_IN_ROLES.indexOf(row.role_key);
    return i === -1 ? BUILT_IN_ROLES.length : i;
  };
  return [...rows].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
}

/**
 * Fetch the catalog unless it is already held.
 *
 * Deduplicated through a single in-flight promise, so a page that mounts ten
 * components asking for it issues ONE request. A failed read is not cached as a
 * success: `roles` stays empty and the next caller retries, which is why the cache
 * check tests `error` as well as `roles.length`.
 */
export function loadRoleCatalog(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && state.roles.length > 0 && state.error === null) return Promise.resolve();
  setState({ loading: true, error: null });
  inflight = api
    .listRoles()
    .then((roles) => {
      setState({ roles: sortRoles(roles), loading: false, error: null });
    })
    .catch((err: unknown) => {
      setState({
        loading: false,
        error: err instanceof Error ? err.message : "Could not load the role catalog.",
      });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The catalog row for a key, if it is loaded. Used by the synchronous readers. */
export function roleRowFor(key: string): RoleRow | undefined {
  return state.roles.find((r) => r.role_key === key);
}

/**
 * The label to show for a role key.
 *
 * Falls back to a built-in's known name and then to the raw key, so a role
 * referenced by a stale JSON value (a grant written before the role existed, or
 * after it was deleted) still renders as SOMETHING — `provost` rather than a blank
 * cell. Every JSON store treats a dangling key as absent, so an unresolvable name
 * here is expected data, not an error.
 */
export function roleLabelFor(key: string): string {
  return roleRowFor(key)?.label ?? FALLBACK_LABEL[key] ?? key;
}

/**
 * The badge for a role key: the class and the label to render inside it.
 *
 * `cls` is the full class suffix (`badge-orange`) so call sites can write
 * `className={`badge ${cls}`}`, matching what this replaced.
 */
export function roleBadgeFor(key: string): { cls: string; label: string } {
  const row = roleRowFor(key);
  const stored = typeof row?.badge === "string" && row.badge.trim() !== "" ? row.badge : null;
  return {
    cls: badgeClass(stored ?? FALLBACK_BADGE[key] ?? "blue"),
    label: row?.label ?? FALLBACK_LABEL[key] ?? key,
  };
}

/**
 * The catalog, for a component that renders role controls.
 *
 * Subscribes to the store and asks for a load on mount, so any screen that renders
 * a role chip is sufficient to populate it — there is no "did something else
 * already fetch it" ordering to get wrong. `reload` bypasses the cache and is
 * called after a create, update or delete.
 */
export function useRoleCatalog(): {
  roles: RoleRow[];
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [snapshot, setSnapshot] = useState<CatalogState>(state);

  useEffect(() => {
    const sync = (): void => setSnapshot(state);
    listeners.add(sync);
    sync();
    void loadRoleCatalog();
    return () => {
      listeners.delete(sync);
    };
  }, []);

  const reload = useCallback((): void => {
    void loadRoleCatalog(true);
  }, []);

  return { roles: snapshot.roles, loading: snapshot.loading, error: snapshot.error, reload };
}
