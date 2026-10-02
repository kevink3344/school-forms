// -----------------------------------------------------------------------------
// The role catalog, held in memory.
//
// WHY A CACHE EXISTS AT ALL
//
// A role's capabilities have to be answerable on the AUTHORIZATION path, and the
// authorization path is `requireAuth, requireCapability(...)` on ~48 routes. A
// per-request SELECT against `dbo.roles` would put a database round trip in front
// of every single API call — including the ones that are already a single query —
// and would make the whole API fail when the catalog read fails, which is a much
// worse failure than serving a 30-second-stale capability flag.
//
// WHY IT HAS A TTL
//
// The toggle that matters is an ADMIN'S EDIT: revoke `can_edit` from a role and
// that must take effect promptly. An in-process map with no expiry would work on
// one instance and be silently wrong on a second one: App Service scale-out gives
// you two Node processes, the admin's PUT lands on instance A, instance B never
// hears about it, and B keeps granting a capability that was revoked — forever,
// because nothing else would ever invalidate it. The TTL is what makes that a
// 30-second window instead of a permanent hole.
//
// Two invalidation paths, deliberately both present:
//   * `invalidateRolesCache()` on every catalog write — same-instance, instant.
//   * the TTL — cross-instance, bounded at 30 s.
//
// WHY SYNC AND ASYNC ACCESSORS BOTH EXIST
//
// `isSchoolScoped(role)` is called from synchronous code (`scopedSchoolId`) that
// runs inside every listing query, so it cannot await. It reads the SNAPSHOT —
// whatever is currently loaded — and falls back to today's hard-coded answer when
// nothing is loaded yet. The authorization middleware can await, so it goes
// through `getRolesCache()` and gets a guaranteed-fresh map.
//
// ⚠️ An unknown role key resolves to NO capabilities, never to a default. A role
// that is missing from the catalog is a role whose permissions nobody has
// described; granting it the mildest capability would mean a typo in a token
// claim or a half-finished delete becomes a working account.
// -----------------------------------------------------------------------------
import { execute } from "./queries.js";
import { ROLES, type RoleRow } from "./schema.js";

/** The four capabilities a role can hold. Deliberately a closed set. */
export type RoleCapability = "view" | "edit" | "export" | "report";

/** How long a loaded catalog is trusted before the next read refreshes it. */
export const ROLES_CACHE_TTL_MS = 30_000;

const ROLE_COLUMNS =
  "id, role_key, label, description, badge, can_view, can_edit, can_export, " +
  "can_report, school_scoped, is_admin, built_in, created_at, updated_at";

let snapshot: Map<string, RoleRow> | null = null;
let loadedAt = 0;
let inflight: Promise<Map<string, RoleRow>> | null = null;

/** Key a row by its role_key, lower-cased — the column is COLLATE NOCASE on
 *  libSQL but case-SENSITIVE on SQL Server, so the in-memory lookup normalises
 *  rather than relying on the database's collation. */
function keyOf(key: string): string {
  return key.trim().toLowerCase();
}

/**
 * Drop the cached catalog. Called by every catalog write (create / update /
 * delete) so the change is visible on this instance without waiting for the TTL.
 */
export function invalidateRolesCache(): void {
  snapshot = null;
  loadedAt = 0;
}

/** Load the catalog from the database and replace the snapshot. */
export async function loadRolesCache(): Promise<Map<string, RoleRow>> {
  // Collapse concurrent loads: a burst of requests arriving on a cold cache must
  // issue ONE query, not one per request.
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const rows = await execute<RoleRow>(
        `SELECT ${ROLE_COLUMNS} FROM dbo.roles ORDER BY id`
      );
      const map = new Map<string, RoleRow>();
      for (const row of rows) map.set(keyOf(row.role_key), row);
      snapshot = map;
      loadedAt = Date.now();
      return map;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * The catalog, refreshed when the snapshot is missing or older than the TTL.
 *
 * On a refresh FAILURE the previous snapshot is kept rather than cleared: a
 * transient database blip must not strip every capability in the system. The
 * `loadedAt` stamp is not advanced, so the next request tries again.
 */
export async function getRolesCache(): Promise<Map<string, RoleRow>> {
  if (snapshot && Date.now() - loadedAt < ROLES_CACHE_TTL_MS) return snapshot;
  try {
    return await loadRolesCache();
  } catch (err) {
    if (snapshot) return snapshot;
    throw err;
  }
}

/**
 * The loaded catalog with NO refresh — for synchronous callers, and for code that
 * must not turn a cache miss into an await.
 *
 * Returns `null` when nothing has been loaded yet. Callers must handle that; see
 * `schoolScopedFromCache` for the shape the sync path takes.
 */
export function rolesCacheSnapshot(): Map<string, RoleRow> | null {
  return snapshot;
}

/** Look one role up, refreshing if needed. `null` when the key is unknown. */
export async function findRoleByKey(key: string): Promise<RoleRow | null> {
  const map = await getRolesCache();
  return map.get(keyOf(key)) ?? null;
}

/**
 * Whether a role holds a capability.
 *
 * `is_admin` implies all four — that is what makes it a superuser flag rather
 * than a fifth capability. An unknown/missing row holds NOTHING (see the header
 * note on defaults).
 */
export function roleHasCapability(
  role: RoleRow | null | undefined,
  capability: RoleCapability
): boolean {
  if (!role) return false;
  if (role.is_admin) return true;
  switch (capability) {
    case "view":
      return role.can_view;
    case "edit":
      return role.can_edit;
    case "export":
      return role.can_export;
    case "report":
      return role.can_report;
  }
}

/**
 * Synchronous capability check against the SNAPSHOT only — never refreshes, never
 * throws.
 *
 * Returns `null` for "cannot answer" (no catalog loaded), which is deliberately
 * NOT `false`: a caller that treats an unanswered question as a denial would lock
 * every user out during the boot window, and one that treats it as a grant would
 * open a hole. The two callers here resolve it explicitly — see
 * `schoolScopedFromCache` and `requireCapability` in auth.ts.
 */
export function capabilityFromSnapshot(
  roleKey: string,
  capability: RoleCapability
): boolean | null {
  const map = snapshot;
  if (!map) return null;
  return roleHasCapability(map.get(keyOf(roleKey)), capability);
}

/**
 * School scoping, read from the catalog.
 *
 * Falls back to the historical hard-coded answer (`cdm_contact`) when the catalog
 * has not been loaded. That fallback is not a guess: it is exactly what the app
 * did before roles were data, so a request that arrives during the boot window
 * gets the pre-existing behaviour rather than a new one. An unknown role in a
 * LOADED catalog is not school-scoped, because nobody said it was.
 */
export function schoolScopedFromCache(roleKey: string): boolean {
  const answered = capabilityFromSnapshot(roleKey, "view");
  if (answered === null) return roleKey === "cdm_contact";
  const row = snapshot?.get(keyOf(roleKey));
  if (!row) return roleKey === "cdm_contact";
  return row.school_scoped;
}

/** The role keys currently in the catalog, lower-cased. Falls back to the
 *  built-ins when nothing is loaded, so a settings write is never rejected
 *  merely because the cache is cold. */
export function knownRoleKeys(): Set<string> {
  const map = snapshot;
  if (!map) return new Set(ROLES.map((r) => keyOf(r)));
  return new Set(map.keys());
}

/** Every role row, ordered by id — for the catalog endpoints when a cache read
 *  is preferable to a fresh query. */
export async function listCachedRoles(): Promise<RoleRow[]> {
  const map = await getRolesCache();
  return [...map.values()].sort((a, b) => a.id - b.id);
}
