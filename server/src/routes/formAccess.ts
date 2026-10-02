import { Router } from "express";
import { requireAuth, requireRoles } from "../auth.js";
import {
  AccessRequestError,
  countPendingAccessRequests,
  decideFormAccess,
  listAccessForUser,
  listAccessGrantsFor,
  listAccessRequests,
  listLockedFormsFor,
  removeFormAccess,
  requestFormAccess,
  withdrawAccessRequest,
} from "../db/formAccess.js";
import { getUserById } from "../db/queries.js";
import { decideAccessSchema, removeAccessSchema, requestAccessSchema, withdrawAccessSchema } from "../schemas.js";

export const formAccessRouter = Router();

// -----------------------------------------------------------------------------
// Form access — requests, decisions and grants
// (docs/plans/public-private-forms.md §8).
//
// Two audiences in one file, so no route inherits a router-level guard:
//
//   * three SELF-SERVICE routes (`/mine`, `/requests`, `/requests/withdraw`) —
//     any signed-in role, because the whole point is that a restricted person can
//     ask for what they cannot read;
//   * two ADMIN routes (`GET /requests`, `POST /requests/decide`) and one more
//     (`GET /grants`) — admin only.
//
// ★ `POST /requests/decide` is ONE endpoint carrying a `decision` field, not
// three routes, so the state change and its audit row cannot be written
// differently by different handlers. `revoke` lives here too: a revocation is a
// decision on an approved row, not a different kind of operation.
// -----------------------------------------------------------------------------

function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The org claim, as the number the query layer declares. See the note in
 *  routes/systemMessages.ts — the driver returns `bigint` as a string. */
function orgId(user: { organization_id?: unknown }): number {
  const n = Number(user.organization_id);
  return Number.isFinite(n) ? n : 0;
}

// Any signed-in role: the private forms I cannot read, with my status.
//
// ★ Returns [] for an admin or a staff account WITHOUT a special case — the set
// difference is genuinely empty, because the predicate passes for every form.
// That is the honest answer rather than a branch.
formAccessRouter.get("/mine", requireAuth, requireRoles("staff", "cdm_contact", "admin"), async (req, res, next) => {
  try {
    res.json(await listLockedFormsFor(req.user!, orgId(req.user!)));
  } catch (err) {
    next(err);
  }
});

// Any signed-in role: ask for access to a private form.
formAccessRouter.post("/requests", requireAuth, requireRoles("staff", "cdm_contact", "admin"), async (req, res, next) => {
  try {
    const parsed = requestAccessSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    await requestFormAccess(req.user!, parsed.data.form_id, orgId(req.user!));
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err instanceof AccessRequestError) {
      // ★ A `denied` row is NO LONGER refused — it is reset to `pending`, so a
      // person whose access was removed can ask for it back from the Available
      // Forms page. See the note on `requestFormAccess`.
      const map: Record<string, { status: number; error: string }> = {
        already_readable: { status: 400, error: "You can already read this form." },
        not_private: { status: 400, error: "This form is not private, so there is nothing to request." },
        not_found: { status: 404, error: "Form not found" },
      };
      const m = map[err.reason] ?? { status: 400, error: "Request refused" };
      res.status(m.status).json({ error: m.error });
      return;
    }
    next(err);
  }
});

// Any signed-in role: withdraw my OWN pending request.
//
// Cannot change anyone's access — it deletes an unanswered question — which is
// why it is the one self-service action that survives §15 Q5's "no way back".
formAccessRouter.post("/requests/withdraw", requireAuth, requireRoles("staff", "cdm_contact", "admin"), async (req, res, next) => {
  try {
    const parsed = withdrawAccessSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const ok = await withdrawAccessRequest(req.user!, parsed.data.form_id);
    if (!ok) {
      res.status(409).json({ error: "There is no pending request to withdraw." });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Admin: the queue. Defaults to pending, oldest first.
formAccessRouter.get("/requests", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const status = req.query.status === "approved" || req.query.status === "denied" ? req.query.status : "pending";
    res.json(await listAccessRequests(orgId(req.user!), status));
  } catch (err) {
    next(err);
  }
});

// Admin: approve, decline or revoke.
formAccessRouter.post("/requests/decide", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const parsed = decideAccessSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const { user_id, form_id, decision, note } = parsed.data;
    const ok = await decideFormAccess({
      userId: user_id,
      formId: form_id,
      decision,
      actorId: req.user!.id,
      note: note ?? null,
    });
    if (!ok) {
      // 409 rather than 404: the row may exist but not be in a state this
      // decision applies to (a revoke on a non-approved row, a decline on a
      // non-pending one). "Nothing changed, and not because you are seeing a
      // stale page" is the same answer archive/restore give.
      res.status(409).json({ error: "No request in a state this decision applies to." });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Admin: who has a relationship to this form, each with its event history.
//
// ★ INCLUDES people with no row and people with a `denied` row — a grants-only
// list hides exactly the account an administrator opened this screen to find,
// and a revoke control needs a list to revoke from (§15 Q6).
formAccessRouter.get("/grants", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const formId = parseId(req.query.form_id);
    if (formId === null) {
      res.status(400).json({ error: "form_id is required" });
      return;
    }
    res.json(await listAccessGrantsFor(formId));
  } catch (err) {
    next(err);
  }
});

// Admin: the pending count, for the Settings section title.
//
// ★ This is NOT described as an "administrator alert" — §15 Q3 answered in-app
// only, so the count IS the notification. It is rendered on the CLOSED section
// title, because a count inside a closed section is a count nobody sees.
formAccessRouter.get("/summary", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    res.json({ pending: await countPendingAccessRequests(orgId(req.user!)) });
  } catch (err) {
    next(err);
  }
});

// Admin: one ACCOUNT's access rows, for the Edit User drawer.
//
// ★ Scoped to the organization: the target must be a user in the caller's org, or
// an admin could enumerate another tenant's grants by guessing an id. The 404 is
// deliberate rather than 403 — a user in another organization should not be
// distinguishable from one that does not exist.
formAccessRouter.get("/user/:userId", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const userId = parseId(req.params.userId);
    if (userId === null) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
    const target = await getUserById(userId);
    if (!target || Number(target.organization_id) !== orgId(req.user!)) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(await listAccessForUser(userId));
  } catch (err) {
    next(err);
  }
});

// Admin: remove one account's access to one form.
//
// ★ Refuses a PUBLIC form with 409 and a message naming the reason. Removing a
// grant on a public form would look like it worked while changing nothing — the
// person still reads the form, because everyone does.
formAccessRouter.post("/user/:userId/remove", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const userId = parseId(req.params.userId);
    if (userId === null) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
    const parsed = removeAccessSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const target = await getUserById(userId);
    if (!target || Number(target.organization_id) !== orgId(req.user!)) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const result = await removeFormAccess({
      userId,
      formId: parsed.data.form_id,
      actorId: req.user!.id,
    });
    if (result.ok) {
      res.json({ ok: true });
      return;
    }
    const map: Record<string, { status: number; error: string }> = {
      form_public: {
        status: 409,
        error:
          "This form is public, so everyone in the organization can read it. Make the form private first.",
      },
      no_row: { status: 409, error: "This account has no access row for that form." },
      not_found: { status: 404, error: "Form not found" },
    };
    const m = map[result.reason];
    res.status(m.status).json({ error: m.error });
  } catch (err) {
    next(err);
  }
});
