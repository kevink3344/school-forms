import jwt, { type SignOptions } from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { env } from "./config/env.js";
import type { Role } from "./db/schema.js";
import {
  roleHasCapability,
  schoolScopedFromCache,
  findRoleByKey,
  type RoleCapability,
} from "./db/roles-cache.js";

// -----------------------------------------------------------------------------
// Token payloads
// -----------------------------------------------------------------------------
//
// ⚠ `role` is a plain `string`, not the `Role` union, and that is a deliberate
// consequence of roles becoming admin-managed data (Settings → Roles). The union
// still names the BUILT-INS (it is what the boot seed writes and what a UI
// labels), but a token can carry any key an admin has created, and a claim is
// unvalidated text until something checks it against the catalog. Typing it as
// the union would have been a claim the compiler could not keep — it would have
// silently rejected every custom role at the first function boundary that used
// `Role`, with a type error rather than a permission decision.
//
// Validation happens once, at the authorization boundary: an unknown key holds
// NO capability (see `requireCapability` and roles-cache.ts).
export interface AccessPayload {
  sub: number; // user id
  email: string;
  role: string;
  school_id: number | null;
  organization_id: number | null; // the user's single org (tenant boundary)
  type: "access";
}

export interface RefreshPayload {
  sub: number;
  type: "refresh";
}

interface JwtUser {
  id: number;
  email: string;
  role: string;
  school_id: number | null;
  organization_id: number | null;
}

export type { JwtUser };

declare global {
  namespace Express {
    interface Request {
      user?: JwtUser;
    }
  }
}

export function signAccessToken(user: {
  id: number;
  email: string;
  role: string;
  school_id: number | null;
  organization_id: number | null;
}): string {
  const payload: AccessPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    school_id: user.school_id,
    organization_id: user.organization_id,
    type: "access",
  };
  return jwt.sign(payload, env.auth.accessSecret, {
    expiresIn: env.auth.accessExpiresIn,
  } as SignOptions);
}

export function signRefreshToken(userId: number): string {
  const payload: RefreshPayload = { sub: userId, type: "refresh" };
  return jwt.sign(payload, env.auth.refreshSecret, {
    expiresIn: env.auth.refreshExpiresIn,
  } as SignOptions);
}

export function verifyAccessToken(token: string): AccessPayload {
  return jwt.verify(token, env.auth.accessSecret) as unknown as AccessPayload;
}

export function verifyRefreshToken(token: string): RefreshPayload {
  return jwt.verify(token, env.auth.refreshSecret) as unknown as RefreshPayload;
}

// -----------------------------------------------------------------------------
// Express middleware
// -----------------------------------------------------------------------------
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }
  const token = header.slice("Bearer ".length);
  try {
    const payload = verifyAccessToken(token);
    // A token carrying no tenant cannot be authorized, so it must not be allowed
    // to pass silently. Every scoped read and every guard in the app takes its
    // organization from this claim (34 sites), and a missing one is not neutral:
    // `listUsers(undefined)` drops its WHERE clause and lists EVERY
    // organization's users, while each `!== req.user!.organization_id`
    // comparison then fails against `undefined` — so a same-org edit answers 403
    // with a message about organizations that says nothing about the session
    // (e.g. "You can only assign users within your own organization", for a user
    // who is in the caller's own organization).
    //
    // 401 rather than 403 because it is truthful and self-healing: the client
    // refreshes once on a 401 and replays the request, and /refresh re-derives
    // the organization from the user's row — so a token minted before the
    // multi-tenancy change (or one whose claim was dropped) recovers on the next
    // request instead of failing with a misleading message.
    //
    // This detects the ABSENCE of a tenant; it must not assert its TYPE.
    // `Number.isInteger` was wrong here and took the whole deployment down: the
    // SQL Server driver returns these id columns as STRINGS, so this deployment
    // issues `organization_id: "1"` and `Number.isInteger("1")` is false — every
    // authenticated request answered 401. It passed verification because the
    // check ran under DB_MODE=turso, where libSQL returns real numbers, so the
    // two dialects disagree about the type of the same column. Any type-strict
    // numeric check on a value that came out of the database carries this hazard.
    //
    // The claim is kept VERBATIM rather than coerced to a number. Every
    // downstream use compares it against a value read back from the same
    // database (`target.organization_id !== req.user!.organization_id` in
    // routes/users.ts, plus ~33 scoping sites), and those agree only while both
    // sides keep the type the driver produced. Coercing this side alone would
    // make `"1" !== 1` true and reinstate the very 403 this guard was added
    // alongside — so preserving the type IS the fix, not an oversight.
    const orgClaim = payload.organization_id;
    const orgId = orgClaim === null || orgClaim === undefined ? NaN : Number(orgClaim);
    if (!Number.isFinite(orgId) || orgId <= 0) {
      res.status(401).json({ error: "Session is missing an organization. Sign in again." });
      return;
    }
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      school_id: payload.school_id,
      organization_id: orgClaim,
    };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Named-role guard. Kept for the routes whose membership genuinely is a fixed
// set — `admin` is not a capability (it is the `is_admin` flag), and the public
// self-registration route hard-codes its own list.
//
// ⚠ Do NOT reach for this to gate a new feature. A list of role keys is a
// snapshot of the roles that existed when the line was written, so a custom role
// can never be granted access by it and — worse — nothing fails when that
// happens; the new role simply sees a 403 nobody can explain. Use
// `requireCapability("view" | "edit" | "export" | "report")` instead, which asks
// what the role MAY DO and therefore covers roles that did not exist yet.
//
// `role` is read as a string so a catalog key flows through without a cast.
export function requireRoles(...roles: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "Forbidden: insufficient role" });
      return;
    }
    next();
  };
}

// -----------------------------------------------------------------------------
// Capability guards
// -----------------------------------------------------------------------------
//
// Capabilities are what a role MAY DO, resolved from the catalog in
// `dbo.roles` and cached in memory (see db/roles-cache.ts for the TTL and the
// invalidation story). These are the guards a new route should use.
//
// `async` on purpose: the middleware awaits the catalog rather than reading a
// stale snapshot, and Express accepts an async middleware happily. Any error
// from the catalog load goes to `next(err)` so it becomes the app's normal 500
// rather than a silently-allowed request.
//
// ⚠️ An UNKNOWN role holds NO capability. This is the opposite of the old
// named-role guard in one important way: there, a role nobody listed was denied
// by omission; here it would be denied by an explicit `false`. Either way the
// answer is "no" — the point of writing it down is that a typo in a role key, a
// half-finished delete, or a token minted before a role was removed must not
// become a working account.
export function requireCapability(capability: RoleCapability) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    try {
      const row = await findRoleByKey(req.user.role);
      if (!roleHasCapability(row, capability)) {
        res.status(403).json({
          error: `Forbidden: your role does not have the "${capability}" capability`,
        });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Administrator-only. Reads the catalog's `is_admin` flag rather than the string
// "admin", so granting administrator power to a second role (an operations
// account, say) is a settings change and not a code change.
//
// The built-in `admin` role always carries `is_admin = 1` and the boot ladder
// re-derives that flag on every start, so this cannot be locked out by an edit.
export function requireAdmin() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    try {
      const row = await findRoleByKey(req.user.role);
      if (!row?.is_admin) {
        res.status(403).json({ error: "Forbidden: administrator access required" });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// -----------------------------------------------------------------------------
// School scoping
// -----------------------------------------------------------------------------
// The identity fields the scoping helpers need. `JwtUser` satisfies this.
export interface ScopedUser {
  role: Role | string;
  school_id: number | null;
  organization_id?: number | null;
}

// Roles restricted to a single school.
//
// ★ Read from the role CATALOG (`school_scoped`), not from the role's name. This
// used to be `role === "cdm_contact"`, which meant a custom role an admin
// created as a School Contact could not be school-scoped — the setting existed,
// was settable in the panel, and did nothing. Falls back to the historical
// answer when the catalog has not loaded yet, so the boot window behaves exactly
// as the app did before roles were data. See roles-cache.ts.
//
// Deliberately NOT staff: a staff member sees every submission in their
// organization regardless of the school they registered under.
export function isSchoolScoped(role: string): boolean {
  return schoolScopedFromCache(role);
}

// The school filter a listing endpoint should apply for this user. Returns the
// user's school only when they are school-scoped AND actually have one;
// otherwise `undefined`, meaning "no school filter" (the caller's organization
// filter still applies). Every listing query treats a NULL school as "all".
export function scopedSchoolId(user: ScopedUser): number | undefined {
  return isSchoolScoped(user.role) ? user.school_id ?? undefined : undefined;
}

// Whether the caller may read or act on a record belonging to `schoolId`.
//
// This deliberately mirrors `scopedSchoolId`: whatever school filter applies to
// a user's lists also governs the rows they can open, so a row that appears in
// the list can never 403 on open. A school-scoped role with no school assigned
// is therefore unrestricted (district-wide), exactly as its lists are.
export function canAccessSchool(user: ScopedUser, schoolId: number | null): boolean {
  const scope = scopedSchoolId(user);
  return scope === undefined || schoolId === scope;
}

// Attach req.user when a *valid* token is supplied, but never reject anonymous
// callers. Used by the public `/api/auth/schools` route so a logged-in non-admin
// gets scoped to their own school while the register screen stays open.
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    try {
      const token = header.slice("Bearer ".length);
      const payload = verifyAccessToken(token);
      req.user = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
        school_id: payload.school_id,
        organization_id: payload.organization_id,
      };
    } catch {
      // Invalid/expired token — treat as anonymous rather than rejecting.
    }
  }
  next();
}

// -----------------------------------------------------------------------------
// Cookie helpers for refresh token (httpOnly)
// -----------------------------------------------------------------------------
export function setRefreshCookie(res: Response, token: string): void {
  const secure = env.isProd;
  res.cookie("refreshToken", token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie("refreshToken", { path: "/" });
}
