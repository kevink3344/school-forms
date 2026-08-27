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
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtUser;
    }
  }
}

export function signAccessToken(user: { id: number; email: string; role: Role; school_id: number | null }): string {
  const payload: AccessPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    school_id: user.school_id,
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
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      school_id: payload.school_id,
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
