import jwt, { type SignOptions } from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { env } from "./config/env.js";
import type { Role } from "./db/schema.js";

// -----------------------------------------------------------------------------
// Token payloads
// -----------------------------------------------------------------------------
export interface AccessPayload {
  sub: number; // user id
  email: string;
  role: Role;
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
  role: Role;
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
  role: Role;
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

export function requireRoles(...roles: Role[]) {
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
// School scoping
// -----------------------------------------------------------------------------
// The identity fields the scoping helpers need. `JwtUser` satisfies this.
export interface ScopedUser {
  role: Role | string;
  school_id: number | null;
  organization_id?: number | null;
}

// Roles restricted to a single school. Deliberately NOT staff: a staff member
// sees every submission in their organization regardless of the school they
// registered under. A School Contact stays scoped to their own school.
export function isSchoolScoped(role: string): boolean {
  return role === "cdm_contact";
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
