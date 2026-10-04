// -----------------------------------------------------------------------------
// The school-name alias map, held in memory.
//
// WHY A CACHE EXISTS AT ALL
//
// `findSchoolIdByName` sits on the INTAKE path: it is called for every
// submission insert, and once per answer inside `resolveSubmissionSchoolId`. A
// per-call SELECT against `dbo.school_name_aliases` would put a database round
// trip in front of that hot path. The alias table is tiny — a handful of rows an
// administrator created — so it is loaded once and cached.
//
// WHY IT HAS A TTL
//
// The write that matters is an ADMIN'S MATCH: create one and intake must honour
// it promptly. An in-process map with no expiry works on one instance and is
// silently wrong on a second: App Service scale-out gives you two Node
// processes, the admin's POST lands on instance A, instance B never hears about
// it, and B keeps routing the old way — forever, because nothing else would ever
// invalidate it. The TTL bounds that to a 30-second window; the explicit
// `invalidateSchoolAliasCache()` on every write makes the admin's own instance
// instant.
//
// WHY NULL MEANS "NO SCHOOL"
//
// A row with `school_id IS NULL` is the "Ignore" state: the spelling is known
// NOT to be a school. It must resolve to NO school, so an ignored spelling keeps
// falling through to the form's fallback exactly as it did before — an Ignore is
// "stop asking me", not a mapping. This module therefore exposes ONLY the
// non-null ids for resolution and keeps the keys separate for the worklist.
//
// It reads the client directly (rather than importing `execute` from
// queries.ts) so there is NO import cycle with the module that uses it.
// -----------------------------------------------------------------------------
import { getClient } from "./pool.js";
import { normalizeSchoolKey } from "./schema.js";

/** How long a loaded map is trusted before the next read refreshes it. */
export const SCHOOL_ALIAS_CACHE_TTL_MS = 30_000;

let snapshot: Map<string, number | null> | null = null;
let loadedAt = 0;
let inflight: Promise<Map<string, number | null>> | null = null;

/**
 * Drop the cached map. Called by every alias write (create / update / delete) so
 * the change is visible on this instance without waiting for the TTL.
 */
export function invalidateSchoolAliasCache(): void {
  snapshot = null;
  loadedAt = 0;
}

/** Load the alias map (normalised key → school id or null) and replace the snapshot. */
async function load(): Promise<Map<string, number | null>> {
  const rows = await getClient().query<{ submitted_name: string; school_id: number | null }>(
    "SELECT submitted_name, school_id FROM dbo.school_name_aliases"
  );
  const map = new Map<string, number | null>();
  for (const r of rows) {
    const key = normalizeSchoolKey(String(r.submitted_name));
    // The driver returns numeric columns as strings on one dialect, so coerce.
    const id =
      r.school_id === null || r.school_id === undefined ? null : Number(r.school_id);
    map.set(key, id);
  }
  return map;
}

/** The loaded map, refreshing if stale, collapsing concurrent refreshes. */
async function getSchoolAliasCache(): Promise<Map<string, number | null>> {
  if (snapshot && Date.now() - loadedAt < SCHOOL_ALIAS_CACHE_TTL_MS) return snapshot;
  if (!inflight) {
    inflight = load()
      .then((map) => {
        snapshot = map;
        loadedAt = Date.now();
        return map;
      })
      .finally(() => {
        inflight = null;
      });
  }
  try {
    return await inflight;
  } catch (err) {
    // A failed refresh falls back to the last good snapshot. A cache miss must
    // never break intake: the caller then resolves to NO school, which is
    // exactly the pre-existing fallback behaviour.
    if (snapshot) return snapshot;
    throw err;
  }
}

/**
 * Resolve a submitted spelling to an app school id, or `null` when the spelling
 * has no alias, or its alias is the "Ignore" state.
 */
export async function findAliasedSchoolId(name: string): Promise<number | null> {
  const key = normalizeSchoolKey(name);
  if (!key) return null;
  const map = await getSchoolAliasCache();
  const id = map.get(key);
  return id === undefined || id === null ? null : id;
}
