import { Router } from "express";
import {
  listRoles,
  getRoleByKey,
  createRole,
  updateRole,
  deleteRole,
  roleUsage,
  roleUsageTotal,
  type RoleUsage,
} from "../db/queries.js";
import { requireAuth, requireAdmin } from "../auth.js";
import { invalidateRolesCache } from "../db/roles-cache.js";
import { createRoleSchema, updateRoleSchema } from "../schemas.js";
import type { RoleRow } from "../db/schema.js";

export const rolesRouter = Router();

// -----------------------------------------------------------------------------
// Roles (admin Settings → Roles panel)
//
// A role is a row, not a compile-time constant: it carries the four capabilities
// (view / edit / export / report), whether the account is scoped to one school,
// and whether it is an administrator. Everything else in the app now asks the
// catalog instead of comparing a role string — see `requireCapability`,
// `requireAdmin` and `schoolScopedFromCache`.
//
// INSTALLATION-WIDE, deliberately. A role key is what `users.role` stores, so the
// FK makes it globally unique; a per-organization role would have to be
// referenced by id, which would change the access token, every guard and every
// client comparison. The panel's copy says so.
// -----------------------------------------------------------------------------

// The reference census, keyed by store so a 409 can name what is blocking it.
// Ordered by how likely each is to be the answer, with `users` first because it is
// the only one the database itself enforces.
const USAGE_LABELS: Record<keyof RoleUsage, string> = {
  users: "user account",
  form_fields: "form field access list",
  system_messages: "system message audience",
  menu_items: "menu item",
  documents_link: "Documents Link setting",
};

function describeUsage(usage: RoleUsage): string {
  const parts: string[] = [];
  for (const key of Object.keys(USAGE_LABELS) as (keyof RoleUsage)[]) {
    const n = usage[key];
    if (n > 0) parts.push(`${n} ${USAGE_LABELS[key]}${n === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

// ★ Every refusal says WHERE the references were counted, because the numbers do
// not line up with anything the admin can see. A role is installation-wide (its
// key is what `users.role` stores and the FK makes it globally unique), so the
// census is installation-wide too — and the Users grid shows only the admin's own
// organization. Without this clause, "3 user accounts" beside a grid holding one
// is a figure the reader has to assume is wrong; with it, the instruction (reassign
// them) is achievable, because the count is what tells them the work is bigger
// than their own org.
const CENSUS_SCOPE = " (counted across all organizations, because a role key is installation-wide)";

// ★ The census sentence, built in ONE place. It is returned by GET /:key/usage as
// `usage_message` and interpolated into both DELETE refusals, so the panel's
// disabled-button tooltip and the error it would otherwise get are the same string
// by construction rather than by two people writing it twice. The client cannot
// import this module (separate workspace package; it would drag mssql into the
// bundle), and a sentence hand-copied into the browser is a hand-copied allowlist:
// it drifts silently in the direction that matters, which here is telling an admin
// a delete is safe when it is not.
function describeUsageScoped(usage: RoleUsage): string {
  return `${describeUsage(usage)}${CENSUS_SCOPE}`;
}

// SQL Server signals an FK violation with error 547; libSQL raises a plain Error
// whose message names the constraint. Both mean the same thing here: something
// still references the key. Caught so the route can answer 409 instead of letting
// the shared error handler turn it into a 500 — an error the admin can act on
// reading as a server fault is the worst outcome for a guard this reachable.
function isForeignKeyViolation(err: unknown): boolean {
  const e = err as { number?: unknown; message?: unknown };
  if (typeof e?.number === "number" && e.number === 547) return true;
  const message = typeof e?.message === "string" ? e.message : "";
  return /FOREIGN KEY constraint failed/i.test(message) || /conflicted with the FOREIGN KEY/i.test(message);
}

// A role row as the client sees it. `built_in` and `updated_at` are included
// because the panel renders built-ins differently (capabilities locked) and shows
// when a custom role was last changed.
function toRoleDto(row: RoleRow) {
  return {
    id: row.id,
    role_key: row.role_key,
    label: row.label,
    description: row.description,
    badge: row.badge,
    can_view: row.can_view,
    can_edit: row.can_edit,
    can_export: row.can_export,
    can_report: row.can_report,
    school_scoped: row.school_scoped,
    is_admin: row.is_admin,
    built_in: row.built_in,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// -----------------------------------------------------------------------------
// GET /api/roles — the catalog (any authenticated user).
//
// Readable by any signed-in account on purpose. The capability flags are the
// installation's permission model rather than personal data, every signed-in user
// is already subject to it, and the three built-in roles are named in the UI
// anyway — so hiding the list would add a failure mode (screens that cannot render
// a role's name) without withholding anything. What IS admin-only is everything
// that touches PEOPLE: see GET /:key/usage, which aggregates over accounts.
// -----------------------------------------------------------------------------
rolesRouter.get("/", requireAuth, async (_req, res, next) => {
  try {
    const roles = await listRoles();
    res.json({ roles: roles.map(toRoleDto) });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// GET /api/roles/:key/usage — where a role is referenced (admin).
//
// This is what lets the panel DISABLE a Delete button with a reason, instead of
// offering it and answering 409. Both paths run the same census, so the tooltip
// and the error agree by construction.
//
// Note the count is over `dbo.users` filtered only by role, not by organization.
// It has to be: the FK that makes a delete fail is global, so a count scoped to
// the admin's own org would under-report and the button would be offered for a
// delete that cannot succeed.
// -----------------------------------------------------------------------------
rolesRouter.get("/:key/usage", requireAuth, requireAdmin(), async (req, res, next) => {
  try {
    const role = await getRoleByKey(req.params.key);
    if (!role) {
      res.status(404).json({ error: "Role not found" });
      return;
    }
    const usage = await roleUsage(role.role_key);
    const total = roleUsageTotal(usage);
    res.json({
      role_key: role.role_key,
      built_in: role.built_in,
      usage,
      total,
      // The sentence a DELETE would refuse with, or null when nothing references
      // the role. Sent so the panel can disable its button WITH A REASON instead of
      // offering it and answering 409 — and so the reason it shows and the error it
      // would otherwise receive are the same words.
      usage_message: total > 0 ? describeUsageScoped(usage) : null,
    });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// POST /api/roles — create a custom role (admin).
//
// `built_in` is never settable: only the boot seed creates built-ins, so an admin
// cannot mint a role that is then undeletable. The key is derived from the label
// when not supplied, and normalised to lowercase by the schema BEFORE the
// uniqueness check — asking "is this key taken?" about a spelling that will not be
// stored is how a check passes and the INSERT then fails.
// -----------------------------------------------------------------------------
rolesRouter.post("/", requireAuth, requireAdmin(), async (req, res, next) => {
  try {
    const parsed = createRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const data = parsed.data;

    const key = (data.role_key ?? data.label.toLowerCase().replace(/[^a-z0-9]+/g, "_"))
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      res.status(400).json({
        error:
          "role_key must start with a letter and contain only a-z, 0-9 and _ " +
          `(derived from the label as "${key}")`,
      });
      return;
    }

    // A pre-check rather than relying on UX_roles_key: the unique index is one of
    // the objects this database has been unable to create (see the boot warning),
    // so an index violation is not guaranteed to happen. The pre-check is the
    // check; the index, where it exists, is the backstop.
    const existing = await getRoleByKey(key);
    if (existing) {
      res.status(409).json({ error: `A role with the key "${existing.role_key}" already exists` });
      return;
    }

    const role = await createRole({
      role_key: key,
      label: data.label,
      description: data.description || null,
      badge: data.badge || null,
      can_view: data.can_view,
      can_edit: data.can_edit,
      can_export: data.can_export,
      can_report: data.can_report,
      school_scoped: data.school_scoped,
      is_admin: data.is_admin,
    });

    // Same-instance visibility immediately; the 30s TTL covers any other instance.
    invalidateRolesCache();

    res.status(201).json(toRoleDto(role));
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// PUT /api/roles/:key — edit a role (admin).
//
// Two refusals worth stating:
//
//   * `role_key` cannot be changed. Renaming would orphan every reference to the
//     old key — the FK on `users.role` would fail, but the four JSON stores have no
//     constraint, so field-access lists, message audiences and menu entries would
//     silently stop matching. The body may repeat the existing key; a different one
//     is a 400 rather than an ignore, because a caller that believes it renamed
//     something must not be told "ok".
//
//   * A built-in's CAPABILITIES cannot be changed. The boot ladder re-derives the
//     four security flags on all four built-ins at every start (so a hand-run
//     UPDATE cannot escalate) — which means an edit here would appear to save and
//     then revert on the next deploy. Refusing with that reason is honest; saving
//     and reverting is not. `label`, `description` and `badge` are deliberately
//     excluded from the re-derivation and remain editable.
// -----------------------------------------------------------------------------
rolesRouter.put("/:key", requireAuth, requireAdmin(), async (req, res, next) => {
  try {
    const existing = await getRoleByKey(req.params.key);
    if (!existing) {
      res.status(404).json({ error: "Role not found" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    if (body?.role_key !== undefined && String(body.role_key).trim().toLowerCase() !== existing.role_key) {
      res.status(400).json({
        error: `role_key is immutable: this role is "${existing.role_key}" and cannot be renamed`,
      });
      return;
    }
    if (body?.built_in !== undefined) {
      res.status(400).json({ error: "built_in is set by the installation and cannot be edited" });
      return;
    }

    const parsed = updateRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const data = parsed.data;

    if (existing.built_in) {
      const caps = ["can_view", "can_edit", "can_export", "can_report", "school_scoped", "is_admin"] as const;
      const attempted = caps.filter((c) => data[c] !== undefined);
      if (attempted.length > 0) {
        res.status(400).json({
          error:
            `"${existing.role_key}" is a built-in role: ${attempted.join(", ")} ` +
            "cannot be edited because this installation re-derives them at every start",
        });
        return;
      }
    }

    // ★ Granting administrator power is a CREATE-time decision, so a role can be
    // DEMOTED by an edit but not PROMOTED. Promotion through a PUT would let a role
    // that anything already references — a form-field access list, a message
    // audience, a menu setting — quietly become a superuser, and those stores hold
    // role keys inside JSON with no foreign key that would notice. Demotion stays
    // allowed so a mistake is reversible. `schemas.ts` has documented this refusal
    // since the feature was written; the branch is what makes that documentation
    // true.
    if (data.is_admin === true && !existing.is_admin) {
      res.status(400).json({
        error:
          "is_admin can only be granted when a role is created — this installation " +
          "does not promote an existing role to administrator through an edit",
      });
      return;
    }

    const role = await updateRole(existing.role_key, data);
    if (!role) {
      res.status(404).json({ error: "Role not found" });
      return;
    }

    invalidateRolesCache();
    res.json(toRoleDto(role));
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// DELETE /api/roles/:key — delete a custom role (admin).
//
// ★ This is the endpoint where the user's own rule and "full CRUD" meet. The rule
// is "once they are assigned, they cannot be deleted" — so an ASSIGNED role is
// refused, and the answer names every store that references it rather than saying
// "in use". Five stores can reference a role and the database constrains exactly
// one of them (`users.role`); the other four are JSON arrays with no FK, so
// deleting a role that only a form field or a message audience names would
// SUCCEED and leave a dangling key behind. Each reader treats an unknown key as
// absent, so that fails safe (it narrows access) — but it fails silently, and
// re-creating the key later would silently restore every grant that had been taken
// away. The census is therefore run BEFORE the delete, not after a failure.
//
// Built-ins are refused first: an installation whose only admin had been
// reassigned would otherwise be able to delete `admin`, and nothing could grant it
// back.
// -----------------------------------------------------------------------------
rolesRouter.delete("/:key", requireAuth, requireAdmin(), async (req, res, next) => {
  try {
    const existing = await getRoleByKey(req.params.key);
    if (!existing) {
      res.status(404).json({ error: "Role not found" });
      return;
    }
    if (existing.built_in) {
      res.status(409).json({
        error: `"${existing.role_key}" is a built-in role and cannot be deleted`,
      });
      return;
    }

    const usage = await roleUsage(existing.role_key);
    if (roleUsageTotal(usage) > 0) {
      res.status(409).json({
        error:
          `"${existing.role_key}" is in use and cannot be deleted: ${describeUsageScoped(
            usage
          )}. Reassign those before deleting it.`,
        usage,
      });
      return;
    }

    try {
      const deleted = await deleteRole(existing.role_key);
      if (!deleted) {
        // Either a built-in (impossible here — checked above) or a concurrent
        // delete that won the race between the census and this statement.
        res.status(409).json({ error: `"${existing.role_key}" could not be deleted` });
        return;
      }

      invalidateRolesCache();
      res.json({ deleted: toRoleDto(deleted) });
    } catch (err) {
      // The FK is the backstop for the race the census cannot cover: a user
      // assigned to this role between the count and the delete.
      if (isForeignKeyViolation(err)) {
        const raced = await roleUsage(existing.role_key);
        res.status(409).json({
          error:
            `"${existing.role_key}" is in use and cannot be deleted: ${describeUsageScoped(
              raced
            )}. Reassign those before deleting it.`,
          usage: raced,
        });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});
