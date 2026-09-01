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
