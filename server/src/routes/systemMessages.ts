import { Router } from "express";
import { requireAuth, requireRoles, type JwtUser } from "../auth.js";
import {
  createSystemMessage,
  deleteSystemMessage,
  dismissSystemMessage,
  getSystemMessage,
  listActiveSystemMessagesForUser,
  listSystemMessages,
  updateSystemMessage,
} from "../db/queries.js";
import { systemMessageSchema, updateSystemMessageSchema } from "../schemas.js";

export const systemMessagesRouter = Router();

// -----------------------------------------------------------------------------
// System Messages (docs/plans/system-messages.md).
//
// An admin writes a notice that is stored per ORGANIZATION. Every signed-in user
// in that organization sees it at the top of the app until they personally close
// it out, so there are two very different audiences in this one file:
//
//   * four AUTHORING routes (list / create / update / delete) — admin only, and
//     mounted with `requireRoles("admin")`;
//   * two READER routes (`/active` and `/:id/dismiss`) — any signed-in role,
//     because the whole point is that everyone sees the message.
//
// The reader routes therefore cannot inherit a router-level guard, which is why
// every route below carries its own middleware instead of one `router.use(...)`
// at the top. Keep it that way: moving the guard up would either lock everyone
// out of their own notices or hand every user an authoring endpoint.
// -----------------------------------------------------------------------------

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * An id carried on the JWT, as the number the query layer says it takes.
 *
 * WHY THIS EXISTS: the driver returns `bigint` columns as STRINGS, so at runtime
 * `user.organization_id` is `"1"` — not `1` — while every query signature in
 * `db/queries.ts` declares `organizationId: number`. Binding the string worked
 * only because T-SQL implicitly converts it at `@organizationId`, so the declared
 * type was a lie that happened to be harmless. `auth.ts` explains why the claim
 * itself must stay VERBATIM (other modules compare it against values the same
 * driver produced, and `1 === "1"` is false); that reasoning applies to JS
 * comparisons, and there are none in this file — every use below is a bound SQL
 * parameter. So the conversion belongs here, at the boundary, and not in auth.
 *
 * This cannot fail for `organization_id`: `requireAuth` has already mapped that
 * claim through `Number()` and answered 401 unless it is finite and positive, so
 * the `null` branch below is unreachable for an authenticated request. It is kept
 * because `requireAuth` validates the organization claim and NOT `sub`, so a
 * hand-crafted token could still arrive with `id === undefined`; see the note on
 * `user.id` at the call sites.
 *
 * `null` and `undefined` become `null` before `Number()` is consulted, because
 * `Number(null)` is `0` — a real id-shaped value that would silently scope a
 * query to organization 0 instead of refusing the request.
 */
function idOf(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The organization a request may touch, or `null` when the user has none.
 *
 * Deliberately NOT the `scopeOf` idiom used by the webhook log. There, `undefined`
 * means "not scoped" and the query is widened to every organization, because a
 * webhook row legitimately can belong to nobody. Here every row has a NOT NULL
 * `organization_id`, so `undefined` would have to become "all organizations" —
 * the opposite of what is wanted, and a cross-tenant read. A user with no
 * organization is refused outright instead.
 */
function orgIdOf(user: JwtUser): number | null {
  return idOf(user.organization_id);
}

// -----------------------------------------------------------------------------
// READER: GET /api/system-messages/active — the notices THIS user still has open,
// newest first, at most three.
//
// DECLARED BEFORE `/:id`. Both are one segment deep, so Express would match
// `/active` against `/:id` if the order were reversed and `parseId("active")`
// would answer 400 — the same trap `/summary` documents in webhookEvents.ts.
//
// The role is passed down rather than filtered here: the cap of three is applied
// in the query, so filtering after the query would hide messages from a viewer
// who is entitled to them while a fourth sits unreturned behind the cap.
// -----------------------------------------------------------------------------
systemMessagesRouter.get("/active", requireAuth, async (req, res, next) => {
  try {
    const user = req.user!;
    const organizationId = orgIdOf(user);
    if (organizationId === null) {
      res.status(403).json({ error: "This account is not a member of an organization" });
      return;
    }
    // `user.id` is passed through UNCONVERTED, unlike the organization above.
    // It carries the same driver-returns-strings discrepancy, but `requireAuth`
    // validates the organization claim and not `sub`, so there is no invariant
    // to lean on and no way to convert it without inventing a guard here. It is
    // bound as a SQL parameter either way, so nothing depends on its JS type.
    const messages = await listActiveSystemMessagesForUser(organizationId, user.id, user.role);
    res.json(messages);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// READER: POST /api/system-messages/:id/dismiss — "I have read this, close it".
//
// Idempotent, and 200 on every repeat: the X button is small and users double
// click it. The row is confirmed to exist in the caller's organization first so a
// cross-organization id answers 404 instead of a 200 that did nothing — a silent
// success there is exactly the kind of "looks like it worked" the app avoids.
//
// Deliberately no `active` check: a notice that was switched off between the page
// rendering and the click is still something the user was shown and closed.
// -----------------------------------------------------------------------------
systemMessagesRouter.post("/:id/dismiss", requireAuth, async (req, res, next) => {
  try {
    const user = req.user!;
    const organizationId = orgIdOf(user);
    if (organizationId === null) {
      res.status(403).json({ error: "This account is not a member of an organization" });
      return;
    }
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid message id" });
      return;
    }
    const existing = await getSystemMessage(id, organizationId);
    if (!existing) {
      res.status(404).json({ error: "System message not found" });
      return;
    }
    // See the note on `user.id` at the /active route for why it is not converted.
    await dismissSystemMessage(id, user.id, organizationId);
    res.json({ dismissed: true });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// ADMIN: GET /api/system-messages — every message in the caller's organization,
// newest first, active and inactive alike.
//
// Unfiltered on purpose: the admin grid has to show a switched-off message in
// order to switch it back on, and "everything that exists" is the only list that
// can be reconciled against the table.
// -----------------------------------------------------------------------------
systemMessagesRouter.get("/", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const organizationId = orgIdOf(req.user!);
    if (organizationId === null) {
      res.status(403).json({ error: "This account is not a member of an organization" });
      return;
    }
    res.json(await listSystemMessages(organizationId));
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// ADMIN: POST /api/system-messages — create. 201 with the created row.
//
// `created_by` is taken from the session, never from the body: Zod strips unknown
// keys, so a body carrying `created_by` is discarded rather than honoured.
// -----------------------------------------------------------------------------
systemMessagesRouter.post("/", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const organizationId = orgIdOf(req.user!);
    if (organizationId === null) {
      res.status(403).json({ error: "This account is not a member of an organization" });
      return;
    }
    const parsed = systemMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const created = await createSystemMessage({
      organizationId,
      title: parsed.data.title,
      body: parsed.data.body,
      active: parsed.data.active,
      // `undefined` and an explicit null both mean "every role"; the storage layer
      // keeps that as NULL rather than an empty string. An empty ARRAY stays an
      // empty array and means nobody.
      audience: parsed.data.audience ?? null,
      createdBy: req.user!.id,
    });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// ADMIN: PUT /api/system-messages/:id — partial update. 404 when the id is not in
// the caller's organization (indistinguishable from "does not exist", which is
// itself not a disclosure to make).
// -----------------------------------------------------------------------------
systemMessagesRouter.put("/:id", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const organizationId = orgIdOf(req.user!);
    if (organizationId === null) {
      res.status(403).json({ error: "This account is not a member of an organization" });
      return;
    }
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid message id" });
      return;
    }
    const parsed = updateSystemMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const updated = await updateSystemMessage(id, organizationId, {
      title: parsed.data.title,
      body: parsed.data.body,
      active: parsed.data.active,
      // Only forwarded when the key was actually SENT. `?? null` here would turn
      // "the admin edited the title" into "show this to everyone again", because
      // an omitted key and an explicit null look identical once `??` has run —
      // the same absent-vs-null distinction `body` needs.
      ...(Object.prototype.hasOwnProperty.call(parsed.data, "audience")
        ? { audience: parsed.data.audience ?? null }
        : {}),
    });
    if (!updated) {
      res.status(404).json({ error: "System message not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// ADMIN: DELETE /api/system-messages/:id — deletes the message and everyone's
// close-outs for it. 404 when the id is not in the caller's organization.
// -----------------------------------------------------------------------------
systemMessagesRouter.delete("/:id", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const organizationId = orgIdOf(req.user!);
    if (organizationId === null) {
      res.status(403).json({ error: "This account is not a member of an organization" });
      return;
    }
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid message id" });
      return;
    }
    const deleted = await deleteSystemMessage(id, organizationId);
    if (!deleted) {
      res.status(404).json({ error: "System message not found" });
      return;
    }
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});
