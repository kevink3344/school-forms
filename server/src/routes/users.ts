import { Router } from "express";
import bcrypt from "bcryptjs";
import {
  listUsers,
  getUserByEmail,
  getUserById,
  createUser,
  updateUser,
  updateUserPassword,
} from "../db/queries.js";
import { requireAuth, requireRoles } from "../auth.js";
import { createUserSchema, updateUserSchema } from "../schemas.js";
import { generateTemporaryPassword } from "../security/temp-password.js";
import { sendSlackAlert } from "../notify/slack.js";
import type { Role } from "../db/schema.js";

export const usersRouter = Router();

// -----------------------------------------------------------------------------
// GET /api/users — list users within the admin's org (admin). Returns each user
// with the school name and org name via LEFT JOINs.
// -----------------------------------------------------------------------------
usersRouter.get("/", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const users = await listUsers(req.user!.organization_id);
    // Strip the password hash before it ever reaches the client.
    res.json(
      users.map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        school_id: u.school_id,
        school_name: u.school_name,
        organization_id: u.organization_id,
        organization_name: u.organization_name,
        organization_slug: u.organization_slug,
        display_name: u.display_name,
        active: u.active,
        show_on_test_screen: u.show_on_test_screen,
        // Surfaced so Settings → Users can flag an account that is holding an
        // administrator-issued temporary password and has not replaced it yet.
        must_change_password: u.must_change_password,
        created_at: u.created_at,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// POST /api/users — create a user within the admin's org (admin). Supports
// staff/admins, optional school. Organization defaults to the admin's org.
// -----------------------------------------------------------------------------
usersRouter.post("/", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const { email, password, display_name, role, school_id, organization_id, show_on_test_screen } = parsed.data;

    const existing = await getUserByEmail(email);
    if (existing) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const targetOrgId = organization_id ?? req.user!.organization_id;
    const user = await createUser(
      email,
      passwordHash,
      role as Role,
      school_id ?? null,
      display_name,
      true,
      targetOrgId,
      show_on_test_screen ?? false
    );

    res.status(201).json({
      id: user.id,
      email: user.email,
      role: user.role,
      school_id: user.school_id,
      school_name: null,
      organization_id: user.organization_id,
      display_name: user.display_name,
      active: user.active,
      show_on_test_screen: user.show_on_test_screen,
      must_change_password: user.must_change_password,
      created_at: user.created_at,
    });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// PUT /api/users/:id — edit a user in the admin's org (admin). Updates
// name/email/role/school, and toggles the active flag. Attempting to deactivate
// your OWN account is blocked so an admin can't accidentally lock themselves out.
// -----------------------------------------------------------------------------
usersRouter.put("/:id", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }

    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const data = parsed.data;

    // Guard: an admin cannot deactivate their own account.
    if (req.user!.id === id && data.active === false) {
      res.status(400).json({ error: "You cannot deactivate your own account" });
      return;
    }

    // Guard: an admin cannot move a user OUT of their own org.
    if (data.organization_id !== undefined && data.organization_id !== null &&
        data.organization_id !== req.user!.organization_id) {
      res.status(403).json({ error: "You can only assign users within your own organization" });
      return;
    }

    // Email uniqueness check (only when changing it).
    if (data.email) {
      const existing = await getUserByEmail(data.email);
      if (existing && existing.id !== id) {
        res.status(409).json({ error: "Email already registered" });
        return;
      }
    }

    // Allow org assignment by passing it through (constrained to own org above).
    const user = await updateUser(id, { ...data, organization_id: req.user!.organization_id });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      school_id: user.school_id,
      organization_id: user.organization_id,
      display_name: user.display_name,
      active: user.active,
      show_on_test_screen: user.show_on_test_screen,
      must_change_password: user.must_change_password,
      created_at: user.created_at,
    });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// POST /api/users/:id/reset-password — issue a temporary password (admin).
//
// Why this endpoint exists: before it, an account whose password was forgotten
// was simply unreachable. `PUT /:id` above deliberately cannot write
// `password_hash`, POST /api/auth/change-password demands the CURRENT password,
// and there is no email flow — so the only recoveries were hand-editing the
// bcrypt hash in the database or abandoning the account. For the sole admin that
// meant losing the installation. See docs/plans/password-recovery.md.
//
// The generated password is returned ONCE and is never stored in recoverable form
// anywhere, so it cannot be displayed a second time. It is written together with
// `must_change_password = 1`, and the client refuses to render the app for that
// user until they have replaced it. That is what keeps the feature honest: an
// administrator has seen this credential, so it must not stay usable.
// -----------------------------------------------------------------------------
usersRouter.post("/:id/reset-password", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }

    // Guard: an admin cannot reset their OWN password through this endpoint.
    //
    // Not an oversight about self-service — routes/auth.ts states the invariant
    // that the bearer token alone must never be enough to set a password for the
    // account holding it, precisely because the token lives in localStorage.
    // Allowing self-reset here would hand anyone who obtained a token a permanent
    // account takeover, which is the exact scenario change-password's
    // current-password check exists to block. An admin who wants a new password
    // for themselves already has POST /api/auth/change-password, which knows
    // their current one. (Mirrors "You cannot deactivate your own account" above.)
    if (req.user!.id === id) {
      res.status(400).json({
        error: "You cannot reset your own password. Use Change Password instead.",
      });
      return;
    }

    const user = await getUserById(id);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Guard: same tenant only, mirroring the edit endpoint above. Without this an
    // admin in one organization could seize an account in another.
    if (user.organization_id !== req.user!.organization_id) {
      res.status(403).json({
        error: "You can only reset passwords for users in your own organization",
      });
      return;
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);

    // Hash + flag in one statement so the two can never disagree. `true` is the
    // flag write; the user's own change-password passes false to clear it.
    const updated = await updateUserPassword(id, passwordHash, true);
    if (!updated) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Admin Slack alert — fire-and-forget, never blocks or fails the response
    // (`sendSlackAlert` catches internally and resolves false). This is the
    // closest thing the app has to an audit record for a security-relevant
    // action, and the answer to "who reset this?" months later.
    //
    // The temporary password is deliberately NOT included. Putting a live
    // credential into a chat channel would create a worse problem than the one
    // this notification solves.
    await sendSlackAlert(
      `🔑 Password reset for *${user.display_name}*`,
      [
        { title: "Account", value: user.email, short: true },
        { title: "Role", value: user.role, short: true },
        { title: "Reset by", value: req.user!.email, short: true },
        { title: "Must change on next sign-in", value: "Yes", short: true },
      ],
      { color: "warning", fallback: `Password reset for ${user.email}` }
    );

    res.json({
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      temporary_password: temporaryPassword,
      must_change_password: true,
    });
  } catch (err) {
    next(err);
  }
});
