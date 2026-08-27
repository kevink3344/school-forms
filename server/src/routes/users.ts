import { Router } from "express";
import bcrypt from "bcryptjs";
import {
  listUsers,
  getUserByEmail,
  getUserById,
  createUser,
  updateUser,
} from "../db/queries.js";
import { requireAuth, requireRoles } from "../auth.js";
import { createUserSchema, updateUserSchema } from "../schemas.js";
import type { Role } from "../db/schema.js";

export const usersRouter = Router();

// -----------------------------------------------------------------------------
// GET /api/users — list all users (admin). Returns each user with the school
// name via a LEFT JOIN (admins with no school show null school_name).
// -----------------------------------------------------------------------------
usersRouter.get("/", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const users = await listUsers();
    // Strip the password hash before it ever reaches the client.
    res.json(
      users.map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        school_id: u.school_id,
        school_name: u.school_name,
        display_name: u.display_name,
        active: u.active,
        created_at: u.created_at,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// POST /api/users — create a user (admin). Supports staff/admins, optional school.
// -----------------------------------------------------------------------------
usersRouter.post("/", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const { email, password, display_name, role, school_id } = parsed.data;

    const existing = await getUserByEmail(email);
    if (existing) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await createUser(email, passwordHash, role as Role, school_id ?? null, display_name);

    res.status(201).json({
      id: user.id,
      email: user.email,
      role: user.role,
      school_id: user.school_id,
      school_name: null,
      display_name: user.display_name,
      active: user.active,
      created_at: user.created_at,
    });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// PUT /api/users/:id — edit a user (admin). Updates name/email/role/school, and
// toggles the active flag. Attempting to deactivate your OWN account is blocked
// so an admin can't accidentally lock themselves out.
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

    // Email uniqueness check (only when changing it).
    if (data.email) {
      const existing = await getUserByEmail(data.email);
      if (existing && existing.id !== id) {
        res.status(409).json({ error: "Email already registered" });
        return;
      }
    }

    const user = await updateUser(id, data);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      school_id: user.school_id,
      display_name: user.display_name,
      active: user.active,
      created_at: user.created_at,
    });
  } catch (err) {
    next(err);
  }
});
