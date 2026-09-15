import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import {
  getUserByEmail,
  getUserById,
  createUser,
  updateUserPassword,
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
import {
  loginSchema,
  registerSchema,
  selectLoginSchema,
  selectUsersQuerySchema,
  changePasswordSchema,
} from "../schemas.js";
import type { Role } from "../db/schema.js";

export const authRouter = Router();

// Tighter limiter for the one endpoint that verifies a password. The global
// limiter (300 req / 15 min) applies to this route too, but is far too loose for
// something a caller could otherwise use as a password-guessing oracle.
const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many password change attempts. Try again later." },
});

// Helper: build the client-facing user DTO, resolving the org slug so the
// frontend can construct org-scoped public URLs (e.g. /org/:slug/forms/:id)
// and the school's display name so the sidebar can show it under the user.
async function toUserDto(user: { id: number; email: string; role: Role; school_id: number | null; organization_id: number; display_name: string; must_change_password: boolean }) {
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
    // Set by POST /api/users/{id}/reset-password and cleared by change-password.
    // The client gates on this to decide between rendering the app and forcing
    // the change-password screen, which is the only thing stopping a temporary
    // password handed over by an administrator from being a permanent one.
    must_change_password: user.must_change_password,
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
    const { email, password, display_name, school_id } = parsed.data;

    const existing = await getUserByEmail(email);
    if (existing) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }

    // Registration is organization-scoped by deployment configuration, not by
    // the caller: the org is whatever DEFAULT_ORG_REGISTRATION names (falling
    // back to `academics`). No org slug is accepted from the request body, so a
    // client cannot choose the tenant it registers into.
    const targetOrg = await getDefaultOrganization();
    // Never register a new account into a deactivated organization.
    if (!targetOrg.active) {
      res.status(403).json({ error: "Organization is deactivated. Contact an administrator." });
      return;
    }
    // Role is fixed, never taken from the body: this endpoint is public, so
    // honouring a caller-supplied role would let anyone self-register as an
    // admin. Administrators are created through POST /api/auth/seed-admin.
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await createUser(email, passwordHash, "staff", school_id, display_name, true, targetOrg.id);

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
// POST /api/auth/change-password — change your OWN password (any role).
//
// Requires the current password as re-authentication: the bearer token alone
// must never be enough to set a new password, otherwise anyone holding a token
// (it lives in localStorage) could seize the account permanently. This is also
// why POST /api/users/{id}/reset-password refuses to reset the caller's OWN
// account, and why that endpoint exists at all — an account whose password is
// forgotten has no self-service way back in, so recovery is an administrator
// issuing a temporary password (docs/plans/password-recovery.md). This endpoint
// is the only thing that clears the resulting must_change_password flag.
//
// NOTE the 400 for a wrong current password, NOT 401. The client treats any 401
// on an authenticated call as "access token expired": it clears the stored token,
// tries /auth/refresh and replays. Returning 401 here would sign the user out
// every time they mistyped their password.
// -----------------------------------------------------------------------------
authRouter.post("/change-password", requireAuth, changePasswordLimiter, async (req, res, next) => {
  try {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const { current_password, new_password } = parsed.data;

    const user = await getUserById(req.user!.id);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const ok = await bcrypt.compare(current_password, user.password_hash);
    if (!ok) {
      res.status(400).json({ error: "Current password is incorrect" });
      return;
    }

    // `new === current` is already rejected by changePasswordSchema.
    const passwordHash = await bcrypt.hash(new_password, 12);
    // `false` clears the must_change_password flag this same statement, which is
    // what terminates the admin-reset flow: POST /api/users/{id}/reset-password
    // sets the flag and the client will not render the app while it is set, so
    // failing to clear it here would lock the user out permanently.
    const updated = await updateUserPassword(user.id, passwordHash, false);
    if (!updated) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Deliberately NOT re-issuing tokens. JWTs are stateless and there is no
    // token_version column, so the current session simply keeps working; other
    // sessions keep working until their tokens expire (see docs/plans/change-password.md §8).
    //
    // The fresh DTO is returned so the client does not have to ASSUME the flag
    // was cleared — it decides whether to render the app or the forced-change
    // screen from this value, so guessing wrong here means either a stuck screen
    // or an unenforced reset.
    res.json({
      message: "Password updated successfully.",
      user: await toUserDto(updated),
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
