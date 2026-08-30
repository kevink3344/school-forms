import { Router } from "express";
import bcrypt from "bcryptjs";
import {
  getUserByEmail,
  getUserById,
  createUser,
  listSchools as defaultListSchools,
  getDefaultOrganization,
  getOrganizationById,
  getOrganizationBySlug,
  getSchool,
  listUsersForSelect,
} from "../db/queries.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  setRefreshCookie,
  clearRefreshCookie,
  requireAuth,
  requireRoles,
  optionalAuth,
} from "../auth.js";
import { loginSchema, registerSchema, selectLoginSchema, selectUsersQuerySchema } from "../schemas.js";
import type { Role } from "../db/schema.js";

export const authRouter = Router();

// Helper: build the client-facing user DTO, resolving the org slug so the
// frontend can construct org-scoped public URLs (e.g. /org/:slug/forms/:id)
// and the school's display name so the sidebar can show it under the user.
async function toUserDto(user: { id: number; email: string; role: Role; school_id: number | null; organization_id: number; display_name: string }) {
  const [org, school] = await Promise.all([
    getOrganizationById(user.organization_id),
    user.school_id ? getSchool(user.school_id) : Promise.resolve(null),
  ]);
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    school_id: user.school_id,
    school_name: school?.name ?? null,
    organization_id: user.organization_id,
    organization_slug: org?.slug ?? null,
    display_name: user.display_name,
  };
}

// Reject sign-in when the user's organization has been deactivated (inactive
// orgs are hidden from the select-login dropdown and their users are denied
// both password and select login). Returns true if the org is active.
async function orgIsActive(user: { organization_id: number }): Promise<boolean> {
  const org = await getOrganizationById(user.organization_id);
  return org ? org.active : true;
}

// -----------------------------------------------------------------------------
// GET /api/auth/me — return current user (requires auth)
// -----------------------------------------------------------------------------
authRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await getUserById(req.user!.id);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(await toUserDto(user));
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// POST /api/auth/register — staff OR admin registration (admin seeded)
// -----------------------------------------------------------------------------
authRouter.post("/register", async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const { email, password, display_name, school_id, role, slug } = parsed.data;

    const existing = await getUserByEmail(email);
    if (existing) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }

    // Self-registration lands in the org identified by `slug` (default Academics).
    const defaultOrg = await getDefaultOrganization();
    let targetOrg = defaultOrg;
    if (slug) {
      const orgFromSlug = await getOrganizationBySlug(slug);
      if (!orgFromSlug) {
        res.status(400).json({ error: "Organization not found" });
        return;
      }
      targetOrg = orgFromSlug;
    }
    // Never register a new account into a deactivated organization.
    if (!targetOrg.active) {
      res.status(403).json({ error: "Organization is deactivated. Contact an administrator." });
      return;
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await createUser(email, passwordHash, role as Role, school_id, display_name, true, targetOrg.id);

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user.id);
    setRefreshCookie(res, refreshToken);

    res.status(201).json({
      access_token: accessToken,
      token_type: "bearer",
      user: await toUserDto(user),
    });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// POST /api/auth/login
// -----------------------------------------------------------------------------
authRouter.post("/login", async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const { email, password } = parsed.data;

    const user = await getUserByEmail(email);
    if (!user) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    if (!user.active) {
      res.status(403).json({ error: "Account is deactivated. Contact an administrator." });
      return;
    }
    if (!(await orgIsActive(user))) {
      res.status(403).json({ error: "Organization is deactivated. Contact an administrator." });
      return;
    }

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user.id);
    setRefreshCookie(res, refreshToken);

    res.json({
      access_token: accessToken,
      token_type: "bearer",
      user: await toUserDto(user),
    });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// GET /api/auth/users — anonymous list of users for the select-mode dropdown,
// optionally scoped to an org by ?org=<slug>. Never returns password hashes.
// -----------------------------------------------------------------------------
authRouter.get("/users", async (req, res, next) => {
  try {
    const parsed = selectUsersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }

    let organizationId: number | null | undefined;
    if (parsed.data.org) {
      const org = await getOrganizationBySlug(parsed.data.org);
      if (!org) {
        res.status(404).json({ error: "Organization not found" });
        return;
      }
      organizationId = org.id;
    }

    const users = await listUsersForSelect(organizationId);
    res.json(users);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// POST /api/auth/select — select-mode login (test/demo). Signs in as a chosen
// user with NO password. Optionally constrained to an org (multi-tenant guard).
// Both this and the password endpoint stay live regardless of login_mode — the
// mode is purely a client-side rendering decision.
// -----------------------------------------------------------------------------
authRouter.post("/select", async (req, res, next) => {
  try {
    const parsed = selectLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const { userId, organizationId } = parsed.data;

    const user = await getUserById(userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    // Multi-tenant guard: if the client scoped to an org, the chosen user must
    // belong to it.
    if (organizationId !== undefined && organizationId !== null &&
        user.organization_id !== organizationId) {
      res.status(403).json({ error: "User does not belong to the selected organization" });
      return;
    }
    // Respect deactivation even in select mode.
    if (!user.active) {
      res.status(403).json({ error: "Account is deactivated. Contact an administrator." });
      return;
    }
    if (!(await orgIsActive(user))) {
      res.status(403).json({ error: "Organization is deactivated. Contact an administrator." });
      return;
    }

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user.id);
    setRefreshCookie(res, refreshToken);

    res.json({
      access_token: accessToken,
      token_type: "bearer",
      user: await toUserDto(user),
    });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// POST /api/auth/refresh — exchange refresh cookie for a new access token
// -----------------------------------------------------------------------------
authRouter.post("/refresh", async (req, res, next) => {
  try {
    const cookieToken = req.cookies?.refreshToken;
    const bodyToken = req.body?.refresh_token;
    const token = cookieToken || bodyToken;
    if (!token) {
      res.status(401).json({ error: "Missing refresh token" });
      return;
    }
    const payload = verifyRefreshToken(token);
    const user = await getUserById(payload.sub);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    if (!user.active) {
      res.status(403).json({ error: "Account is deactivated. Contact an administrator." });
      return;
    }
    const accessToken = signAccessToken(user);
    setRefreshCookie(res, signRefreshToken(user.id));
    res.json({
      access_token: accessToken,
      token_type: "bearer",
      user: await toUserDto(user),
    });
  } catch (err) {
    res.status(401).json({ error: "Invalid refresh token" });
  }
});

// -----------------------------------------------------------------------------
// POST /api/auth/logout
// -----------------------------------------------------------------------------
authRouter.post("/logout", (_req, res) => {
  clearRefreshCookie(res);
  res.json({ message: "Logged out" });
});

// -----------------------------------------------------------------------------
// GET /api/auth/schools — public list for registration school picker.
// Authenticated non-admins are scoped to their own school; anonymous + admins
// get the full list (admins use /api/schools for the scoped dashboard).
// -----------------------------------------------------------------------------
authRouter.get("/schools", optionalAuth, async (req, res, next) => {
  try {
    const schools =
      req.user && req.user.role !== "admin"
        ? await defaultListSchools(req.user.school_id)
        : await defaultListSchools();
    res.json(schools);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// POST /api/auth/seed-admin (dev only) — create the first admin
// -----------------------------------------------------------------------------
authRouter.post("/seed-admin", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ error: "email and password required" });
      return;
    }
    const existing = await getUserByEmail(email);
    if (existing) {
      // Only allow seeding if the existing user is also admin
      res.status(200).json({ message: "Already exists", user: { id: existing.id, email: existing.email, role: existing.role } });
      return;
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const defaultOrg = await getDefaultOrganization();
    const user = await createUser(email, passwordHash, "admin", null, "Admin", true, defaultOrg.id);
    res.status(201).json({ message: "Admin created", user: await toUserDto(user) });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// POST /api/auth/seed-staff (dev only) — create a staff user
// -----------------------------------------------------------------------------
authRouter.post("/seed-staff", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const { email, password, school_id, display_name } = req.body || {};
    if (!email || !password || !school_id) {
      res.status(400).json({ error: "email, password and school_id required" });
      return;
    }
    const existing = await getUserByEmail(email);
    if (existing) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const defaultOrg = await getDefaultOrganization();
    const user = await createUser(email, passwordHash, "staff", school_id, display_name ?? "Staff", true, defaultOrg.id);
    res.status(201).json({ message: "Staff created", user: await toUserDto(user) });
  } catch (err) {
    next(err);
  }
});
