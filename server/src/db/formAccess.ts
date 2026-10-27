// -----------------------------------------------------------------------------
// Form access — requests, grants, decisions, and the append-only audit log.
//
// Docs: docs/plans/public-private-forms.md (§5, §6, §9).
//
// Two tables, and the split is the design:
//   dbo.form_access         the CURRENT state — one row per (user, form). This is
//                           what the visibility predicate reads.
//   dbo.form_access_events  the HISTORY — append-only, never read by the
//                           predicate. It answers "who changed this, when, and
//                           on whose authority?" (the §15 Q7 answer).
//
// ★ Every state change and its audit row are written in ONE transaction, via
// `recordAccessEvent` taking the caller's transaction handle. An event written
// after the state update leaves a window where the state has changed and the
// audit line does not exist — and because `denied` covers both *declined* and
// *revoked*, the log is the ONLY thing that can tell those two apart afterwards.
// -----------------------------------------------------------------------------
import { getClient } from "./pool.js";
import { execute } from "./queries.js";
import { getDialect } from "./dialect/index.js";
import { getDbKind } from "./driver/index.js";
import { parseTimestamp, type DbClient } from "./client.js";
import { isUnrestrictedRole, viewerId, type FormViewer } from "../access/formAccess.js";
import type { FormAccessStatus, FormAccessEvent, FormVisibility } from "./schema.js";

function dialect() {
  return getDialect(getDbKind());
}

/** A row of dbo.form_access. */
export interface FormAccessRow {
  user_id: number;
  form_id: number;
  status: FormAccessStatus;
  source: string;
  requested_at: Date | string;
  decided_at: Date | string | null;
  decided_by: number | null;
  note: string | null;
}

/** A form plus the caller's relationship to it (the Available Forms payload). */
export interface AvailableForm {
  id: number;
  title: string;
  description: string | null;
  code: string | null;
  visibility: FormVisibility;
  access: "granted" | "none" | "pending" | "denied";
  /** Only on a granted row: why it is readable. */
  reason?: "public" | "grant" | "role";
  requested_at?: Date | string;
  decided_at?: Date | string | null;
  note?: string | null;
  /** The latest audit event, so the UI can say "declined" vs "access removed". */
  last_event?: FormAccessEvent | null;
}

/** One newly approved access grant the user has not dismissed yet. */
export interface FormAccessNotice {
  event_id: number;
  form_id: number;
  form_title: string;
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/**
 * The latest active grant event for each form the user can currently access.
 * Looking at the latest grant event means a re-approval creates a fresh notice,
 * while a revoked grant cannot produce a notice.
 */
export async function listFormAccessNotices(
  userId: number,
  organizationId: number
): Promise<FormAccessNotice[]> {
  // ★ `event_id`/`form_id` coerced on the way OUT: the notice bar posts
  // `event_id` into `/notices/:eventId/dismiss`, which parses it with `parseId`.
  // A TEXT id would 400 "Invalid access notice id" on the deployments whose
  // driver returns numeric columns as strings.
  const rows = await execute<FormAccessNotice>(
    `SELECT e.id AS event_id, e.form_id, f.title AS form_title
       FROM dbo.form_access_events e
       JOIN dbo.form_access a ON a.user_id = e.user_id AND a.form_id = e.form_id
       JOIN dbo.forms f ON f.id = e.form_id
      WHERE e.user_id = @userId
        AND f.organization_id = @organizationId
        AND a.status = 'approved'
        AND e.event IN ('approved', 'backfilled')
        AND e.id = (
          SELECT MAX(latest.id)
            FROM dbo.form_access_events latest
           WHERE latest.user_id = e.user_id
             AND latest.form_id = e.form_id
             AND latest.event IN ('approved', 'backfilled')
        )
        AND NOT EXISTS (
          SELECT 1 FROM dbo.form_access_notice_dismissals d
           WHERE d.event_id = e.id AND d.user_id = e.user_id
        )
      ORDER BY e.created_at DESC, e.id DESC`,
    { userId, organizationId }
  );
  return rows.map((r) => ({
    ...r,
    event_id: Number(r.event_id),
    form_id: Number(r.form_id),
  }));
}

/**
 * Dismiss a grant notice for its owner. Event ids are validated against the
 * user's own approval history before the idempotent dismissal is inserted.
 */
export async function dismissFormAccessNotice(
  eventId: number,
  userId: number
): Promise<boolean> {
  const events = await execute<{ id: number }>(
    `SELECT id
       FROM dbo.form_access_events
      WHERE id = @eventId AND user_id = @userId
        AND event IN ('approved', 'backfilled')`,
    { eventId, userId }
  );
  if (events.length === 0) return false;

  await execute(
    `INSERT INTO dbo.form_access_notice_dismissals (event_id, user_id)
     SELECT @eventId, @userId
      WHERE NOT EXISTS (
        SELECT 1 FROM dbo.form_access_notice_dismissals
         WHERE event_id = @eventId AND user_id = @userId
      )`,
    { eventId, userId }
  );
  return true;
}

/**
 * Every PUBLISHED form in the organization, each with the caller's relationship.
 *
 * ★ `status = 'published'` is load-bearing and is the trap this query exists to
 * avoid: the naive `WHERE organization_id = @org` puts DRAFTS and ARCHIVED forms
 * on a page every internal role can open. Those are unpublished — the anonymous
 * `GET /api/forms/public` does not serve them, and `selectableForms` exists to
 * keep them out of every picker. A private draft is doubly hidden.
 *
 * ★ The org filter is AND-ed with the visibility predicate, never replaced by it.
 *
 * ★ ONE query rather than a visible-list plus a locked-list. Two calls could
 * disagree about a form that changed state between them, and the page would then
 * render it in two groups at once.
 */
export async function listAvailableFormsFor(
  viewer: FormViewer,
  organizationId: number
): Promise<AvailableForm[]> {
  const forms = await execute<{
    id: number;
    title: string;
    description: string | null;
    code: string | null;
    visibility: FormVisibility;
  }>(
    `SELECT f.id, f.title, f.description, f.code, f.visibility
       FROM dbo.forms f
      WHERE f.organization_id = @organizationId AND f.status = 'published'
      ORDER BY f.title`,
    { organizationId }
  );
  if (forms.length === 0) return [];

  // The caller's rows for these forms, in one read. A `cdm_contact` has at most a
  // handful; an admin or staff account normally has none.
  const id = viewerId(viewer);
  const rows = id === null ? [] : await execute<FormAccessRow>(
    `SELECT user_id, form_id, status, source, requested_at, decided_at, decided_by, note
       FROM dbo.form_access WHERE user_id = @userId`,
    { userId: id }
  );
  const byForm = new Map<number, FormAccessRow>();
  for (const r of rows) byForm.set(Number(r.form_id), r);

  // The latest event per form, so the page can distinguish "declined" from
  // "access removed" — both are `denied` in the state table.
  const lastEvent = new Map<number, FormAccessEvent>();
  if (id !== null && rows.length > 0) {
    const events = await execute<{ form_id: number; event: FormAccessEvent; id: number }>(
      `SELECT e.form_id, e.event, e.id
         FROM dbo.form_access_events e
        WHERE e.user_id = @userId
        ORDER BY e.id`,
      { userId: id }
    );
    // Ascending id, so the last write for each form wins.
    for (const e of events) lastEvent.set(Number(e.form_id), e.event);
  }

  const unrestricted = isUnrestrictedRole(viewer.role);

  return forms.map((f) => {
    // ★ `Number()` on the way OUT, not just on the way in. `id` is declared
    // `number` here but the driver can hand back a numeric column as TEXT (see
    // `access/formAccess.ts`'s `viewerId`, and `id-comparison.test.ts`), and this
    // payload is what the client echoes straight back as `form_id` when the
    // person clicks "Request access". Uncoerced, the browser posted
    // `{"form_id":"3"}`, `requestAccessSchema` rejected it, and the page answered
    // "Validation failed — form id: Expected number, received string" for every
    // request — measured on production. The map's own lookups above coerce
    // because they compare; this coerces because the value LEAVES the process.
    const formId = Number(f.id);
    const row = byForm.get(formId);
    if (unrestricted) {
      // ★ The exemption is BY RULE. An admin or staff account reads every form
      // and normally holds no row at all — which is exactly what the test suite
      // asserts, because it is what proves the rule is doing the work rather
      // than a grant.
      return {
        id: formId,
        title: f.title,
        description: f.description,
        code: f.code,
        visibility: f.visibility,
        access: "granted" as const,
        reason: "role" as const,
      };
    }
    if (f.visibility === "public") {
      return {
        id: formId,
        title: f.title,
        description: f.description,
        code: f.code,
        visibility: f.visibility,
        access: "granted" as const,
        reason: "public" as const,
      };
    }
    if (row?.status === "approved") {
      return {
        id: formId,
        title: f.title,
        description: f.description,
        code: f.code,
        visibility: f.visibility,
        access: "granted" as const,
        reason: "grant" as const,
      };
    }
    if (row?.status === "pending") {
      return {
        id: formId,
        title: f.title,
        description: f.description,
        code: f.code,
        visibility: f.visibility,
        access: "pending" as const,
        requested_at: row.requested_at,
      };
    }
    if (row?.status === "denied") {
      return {
        id: formId,
        title: f.title,
        description: f.description,
        code: f.code,
        visibility: f.visibility,
        access: "denied" as const,
        decided_at: row.decided_at,
        note: row.note,
        last_event: lastEvent.get(formId) ?? null,
      };
    }
    return {
      id: formId,
      title: f.title,
      description: f.description,
      code: f.code,
      visibility: f.visibility,
      access: "none" as const,
    };
  });
}

/**
 * The private forms in the organization the caller CANNOT read, with their status.
 *
 * Feeds `GET /api/form-access/mine`, which is what makes "request access" possible
 * from the locked panel: without it a restricted user cannot even name what they
 * are asking for.
 *
 * ★ Returns `[]` for an exempt role WITHOUT a special case — the set difference is
 * genuinely empty, because the predicate passes for every form.
 */
export async function listLockedFormsFor(
  viewer: FormViewer,
  organizationId: number
): Promise<AvailableForm[]> {
  const all = await listAvailableFormsFor(viewer, organizationId);
  return all.filter((f) => f.access !== "granted");
}

/** The caller's own row for one form, or null. */
export async function getFormAccessRow(
  userId: number,
  formId: number
): Promise<FormAccessRow | null> {
  const rows = await execute<FormAccessRow>(
    `SELECT user_id, form_id, status, source, requested_at, decided_at, decided_by, note
       FROM dbo.form_access WHERE user_id = @userId AND form_id = @formId`,
    { userId, formId }
  );
  return rows[0] ?? null;
}

/** The admin queue. `status` defaults to `pending`. */
export interface AccessRequestRow {
  user_id: number;
  form_id: number;
  status: FormAccessStatus;
  source: string;
  requested_at: Date | string;
  decided_at: Date | string | null;
  decided_by: number | null;
  note: string | null;
  user_name: string | null;
  user_email: string | null;
  form_title: string | null;
  form_code: string | null;
  school_name: string | null;
}

/**
 * The queue's projection and its joins, written ONCE.
 *
 * The triage queue and the administrator's bell (§7.3) are two orders and two
 * caps over the SAME question, so they must not carry two SELECT lists: a column
 * added to one and not the other is a field that is present on the page and
 * `undefined` in the bell, with nothing to error and point at it.
 *
 * `user_name`/`school_name` are LEFT JOINs rather than inner ones on purpose — a
 * request whose account was deleted must still be visible to the administrator,
 * and an inner join would drop it out of the queue that exists to answer it.
 */
const ACCESS_REQUEST_COLUMNS = `a.user_id, a.form_id, a.status, a.source, a.requested_at,
            a.decided_at, a.decided_by, a.note,
            u.display_name AS user_name, u.email AS user_email,
            f.title AS form_title, f.code AS form_code,
            s.name AS school_name`;

const ACCESS_REQUEST_JOINS = `dbo.form_access a
       JOIN dbo.forms f ON f.id = a.form_id
       LEFT JOIN dbo.users u ON u.id = a.user_id
       LEFT JOIN dbo.schools s ON s.id = u.school_id`;

export async function listAccessRequests(
  organizationId: number,
  status: FormAccessStatus = "pending"
): Promise<AccessRequestRow[]> {
  return normalizeAccessRequestRows(
    await execute<AccessRequestRow>(
      `SELECT ${ACCESS_REQUEST_COLUMNS}
         FROM ${ACCESS_REQUEST_JOINS}
        WHERE f.organization_id = @organizationId AND a.status = @status
        ORDER BY a.requested_at`,
      { organizationId, status }
    )
  );
}

/**
 * ★ Coerce the ids a caller SENDS BACK. `user_id` and `form_id` are declared
 * `number` but a numeric column can arrive as TEXT (see `viewerId` and
 * `id-comparison.test.ts`), and the queue's own buttons post both straight into
 * `POST /requests/decide` (`decideAccessSchema`). Uncoerced, deciding a request
 * failed with "Validation failed — user id: Expected number, received string"
 * on exactly the deployments where the driver returns text.
 */
function normalizeAccessRequestRows(rows: AccessRequestRow[]): AccessRequestRow[] {
  return rows.map((r) => ({
    ...r,
    user_id: Number(r.user_id),
    form_id: Number(r.form_id),
  }));
}

/**
 * The NEWEST pending requests, capped — what the administrator's bell lists
 * (docs/plans/access-requests.md §5.2, §7.3).
 *
 * ★ The cap is applied in SQL, never by the caller and never in the component. A
 * client-side `rows.slice(0, limit)` is the `slice(0, N).filter(pred)` pattern
 * this repo bans: the bell would fetch the whole queue to render five rows, and
 * its "View all" footer would be a lie about how many are hidden.
 *
 * ★ NEWEST first, where the queue is OLDEST first. Those are two different
 * questions rather than two styles: triage wants the request that has waited
 * longest, and a bell wants the arrival that just happened.
 *
 * `requested_at DESC` with `user_id DESC, form_id DESC` is a TOTAL order. A
 * backfill or a batch grant writes several rows inside the same millisecond,
 * and without a tie-breaker the database is free to return them in a different
 * sequence for two identical calls — so the bell could show five rows and then
 * five different ones.
 */
export async function listRecentAccessRequests(
  organizationId: number,
  limit: number
): Promise<AccessRequestRow[]> {
  return normalizeAccessRequestRows(
    await execute<AccessRequestRow>(
      // `pageSize` carries the cap. It is a parameter here rather than a constant
      // because the route owns the default and the maximum (see the route's
      // `bellLimit`), and `selectPage` is what keeps the two dialects' paging
      // syntax (`OFFSET/FETCH` vs `LIMIT/OFFSET`) out of this file.
      dialect().selectPage({
        select: ACCESS_REQUEST_COLUMNS,
        from: ACCESS_REQUEST_JOINS,
        where: "WHERE f.organization_id = @organizationId AND a.status = 'pending'",
        orderBy: "a.requested_at DESC, a.user_id DESC, a.form_id DESC",
      }),
      { organizationId, pageSize: limit, offset: 0 }
    )
  );
}

/** How many requests are waiting — the bell's badge, and the page's Pending tab. */
export async function countPendingAccessRequests(organizationId: number): Promise<number> {
  const rows = await execute<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM dbo.form_access a
       JOIN dbo.forms f ON f.id = a.form_id
      WHERE f.organization_id = @organizationId AND a.status = 'pending'`,
    { organizationId }
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * One ACCOUNT's form-access rows, for the admin's Edit User drawer.
 *
 * ★ This lists the rows that EXIST for this user — it is "grants you have made",
 * not "forms this person can read". The two differ for a `staff` or admin
 * account, which is exempt BY RULE and normally holds no row at all, so its list
 * is legitimately empty. Deriving "forms they can read" would mean re-running the
 * predicate per form and would offer a Remove button for rows that do not exist.
 *
 * ★ Only PRIVATE forms are listed. A grant on a public form is inert — the form
 * is readable by everyone regardless — so showing it would imply the Remove
 * button does something when it cannot.
 *
 * Returns the form's title/code/visibility alongside the row, so the drawer can
 * explain WHY a removal is or is not possible without a second request.
 */
export interface UserAccessRow {
  form_id: number;
  form_title: string | null;
  form_code: string | null;
  form_visibility: FormVisibility | null;
  status: FormAccessStatus;
  source: string;
  requested_at: Date | string;
  decided_at: Date | string | null;
  decided_by: number | null;
  note: string | null;
  last_event: FormAccessEvent | null;
}

export async function listAccessForUser(userId: number): Promise<UserAccessRow[]> {
  const rows = await execute<Omit<UserAccessRow, "last_event">>(
    `SELECT a.form_id, f.title AS form_title, f.code AS form_code,
            f.visibility AS form_visibility,
            a.status, a.source, a.requested_at, a.decided_at, a.decided_by, a.note
       FROM dbo.form_access a
       LEFT JOIN dbo.forms f ON f.id = a.form_id
      WHERE a.user_id = @userId
      ORDER BY f.title`,
    { userId }
  );
  // The latest event per form, so the drawer can say "declined" vs "access
  // removed" — both are `denied` in the state table.
  const events = await execute<{ form_id: number; event: FormAccessEvent; id: number }>(
    `SELECT form_id, event, id FROM dbo.form_access_events WHERE user_id = @userId ORDER BY id`,
    { userId }
  );
  const last = new Map<number, FormAccessEvent>();
  for (const e of events) last.set(Number(e.form_id), e.event);

  // ★ `form_id` coerced on the way OUT, for the same reason as
  // `listAvailableFormsFor`'s `id`: the Edit User drawer posts these ids straight
  // back to `POST /user/:id/remove` and `/grant`, where a TEXT id fails
  // `removeAccessSchema` with "Expected number, received string".
  return rows.map((r) => ({
    ...r,
    form_id: Number(r.form_id),
    last_event: last.get(Number(r.form_id)) ?? null,
  }));
}

/**
 * One account's history for one form, oldest first. */
export interface AccessEventRow {
  id: number;
  event: FormAccessEvent;
  actor_id: number | null;
  actor_name: string | null;
  note: string | null;
  created_at: Date | string;
}

export async function listAccessEvents(
  userId: number,
  formId: number
): Promise<AccessEventRow[]> {
  return execute<AccessEventRow>(
    `SELECT e.id, e.event, e.actor_id, e.note, e.created_at,
            u.display_name AS actor_name
       FROM dbo.form_access_events e
       LEFT JOIN dbo.users u ON u.id = e.actor_id
      WHERE e.user_id = @userId AND e.form_id = @formId
      ORDER BY e.id`,
    { userId, formId }
  );
}

/**
 * When this form was last flipped **public → private** — the boundary an
 * administrator needs in order to state the consequence of the flag.
 *
 * ★ DERIVED FROM THE AUDIT LOG, not from a `forms.visibility_changed_at` column,
 * because §6.5 already decided where the moment lives: "binding the grandfather
 * to the privatisation event instead makes it a row with a timestamp and an
 * actor". Those `backfilled` rows ARE that timestamp, and they are written in the
 * same transaction as the flip. A second copy on `dbo.forms` would be a second
 * answer to "when did this happen" and could disagree with the first.
 *
 * ★ `forms.updated_at` must NOT be used for this, which is the trap: it moves on
 * every title edit and every field reorder. Reading it here would name a date
 * later than the flip and claim that accounts which were in fact grandfathered
 * will have to ask.
 *
 * ★ `MAX`, not `MIN`. A form can be flipped private, back to public, and private
 * again, and only the LAST flip sets the boundary for accounts that do not exist
 * yet — anyone who registered during the public window was itself grandfathered
 * by it. An earlier date would understate who has to request access.
 *
 * Returns `null` when no flip ever grandfathered anybody: a form created already
 * private (§6.4), or one marked private while the organization had no School
 * Contacts. There is genuinely no boundary date in that case, and the caller must
 * say so rather than invent one.
 */
export async function getPrivateSince(formId: number): Promise<string | null> {
  const rows = await execute<{ last_flip: unknown }>(
    `SELECT MAX(created_at) AS last_flip
       FROM dbo.form_access_events
      WHERE form_id = @formId AND event = 'backfilled'`,
    { formId }
  );
  // ★ The alias is deliberately not `created_at`. `normalizeRow` restores a real
  // `Date` by column NAME (db/client.ts), so a name that is not in
  // TIMESTAMP_COLUMNS would be served as a `Date` by SQL Server and as a raw
  // string by Turso. Parse explicitly instead, and the two engines agree.
  const at = parseTimestamp(rows[0]?.last_flip);
  return at ? at.toISOString() : null;
}

/**
 * Everyone with a relationship to this form, each with their event history.
 *
 * ★ INCLUDES the people with NO row and the people with a `denied` row. A
 * grants-only list is the shape that hides exactly the account an administrator
 * opened this screen to find — and a revoke control needs a list to revoke from
 * (the §15 Q6 answer).
 */
export interface AccessGrantRow {
  user_id: number;
  user_name: string | null;
  user_email: string | null;
  school_name: string | null;
  status: FormAccessStatus | null;
  source: string | null;
  decided_at: Date | string | null;
  note: string | null;
  events: AccessEventRow[];
}

export async function listAccessGrantsFor(formId: number): Promise<AccessGrantRow[]> {
  const rows = await execute<Omit<AccessGrantRow, "events">>(
    `SELECT u.id AS user_id, u.display_name AS user_name, u.email AS user_email,
            s.name AS school_name,
            a.status, a.source, a.decided_at, a.note
       FROM dbo.form_access a
       JOIN dbo.users u ON u.id = a.user_id
       LEFT JOIN dbo.schools s ON s.id = u.school_id
      WHERE a.form_id = @formId
      ORDER BY u.display_name, u.email`,
    { formId }
  );
  const out: AccessGrantRow[] = [];
  for (const r of rows) {
    // ★ `user_id` coerced on the way OUT: the "Who has access?" list posts it
    // straight into `POST /requests/decide` to revoke, which validates with
    // `decideAccessSchema` and rejects a TEXT id.
    const userId = Number(r.user_id);
    out.push({ ...r, user_id: userId, events: await listAccessEvents(userId, formId) });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

/**
 * THE ONLY WRITER of dbo.form_access_events.
 *
 * Takes the caller's transaction handle so the state change and its audit row
 * commit or fail together. `actorId` is null when the requester acted on their
 * own behalf, which is the honest record: nobody decided anything.
 */
async function recordAccessEvent(
  tx: DbClient,
  args: { userId: number; formId: number; event: FormAccessEvent; actorId: number | null; note?: string | null }
): Promise<void> {
  await tx.query(
    `INSERT INTO dbo.form_access_events (user_id, form_id, event, actor_id, note)
     VALUES (@userId, @formId, @event, @actorId, @note)`,
    {
      userId: args.userId,
      formId: args.formId,
      event: args.event,
      actorId: args.actorId,
      note: args.note ?? null,
    }
  );
}

/** Why a request was refused, so the route can say which fact applies. */
export type RequestRefusal = "already_readable" | "not_private" | "not_found";

export class AccessRequestError extends Error {
  constructor(public readonly reason: RequestRefusal) {
    super(reason);
  }
}

/**
 * Ask for access to a private form.
 *
 * ★ A `denied` row IS re-requestable — it becomes `pending` again and a fresh
 * `requested` event is written. This REVERSES the plan's original §15 Q5 answer
 * ("a decline is final from the requester's side"), at the user's request, so
 * that removing access in the Edit User drawer leaves the person able to ask for
 * it back from the Available Forms page.
 *
 * ★ The two facts stay DISTINGUISHABLE even though both are now re-requestable:
 * `form_access_events` records `declined` and `revoked` separately, so an
 * administrator can still see whether the person was refused or had access
 * removed. Only the STATE (`denied`) is shared, and re-requesting clears it.
 *
 * Idempotent for a row already `pending` — it writes nothing and reports success,
 * so a double-click is not an error.
 */
export async function requestFormAccess(
  viewer: FormViewer,
  formId: number,
  organizationId: number
): Promise<void> {
  const userId = viewerId(viewer);
  if (userId === null) throw new AccessRequestError("not_found");

  // Read the form first: it must exist, be published, be in the caller's org, and
  // be private. A public form has nothing to request.
  const forms = await execute<{ id: number; visibility: FormVisibility }>(
    `SELECT id, visibility FROM dbo.forms
      WHERE id = @formId AND organization_id = @organizationId AND status = 'published'`,
    { formId, organizationId }
  );
  const form = forms[0];
  if (!form) throw new AccessRequestError("not_found");
  if (form.visibility !== "private") throw new AccessRequestError("not_private");

  // An exempt role can already read it, so there is nothing to ask for. Checked
  // through the role test rather than the predicate, so this cannot drift.
  if (isUnrestrictedRole(viewer.role)) throw new AccessRequestError("already_readable");

  const existing = await getFormAccessRow(userId, formId);
  if (existing?.status === "approved") throw new AccessRequestError("already_readable");
  if (existing?.status === "pending") return; // idempotent

  await getClient().transaction(async (tx) => {
    // UPDATE-then-INSERT-if-absent: the one shape that parses on BOTH dialects
    // without a dialect-specific upsert spelling. A `denied` row is reset to
    // `pending` here, which is what makes a removal re-requestable.
    await tx.query(
      `UPDATE dbo.form_access SET status = 'pending', source = 'request',
              requested_at = SYSUTCDATETIME(), decided_at = NULL, decided_by = NULL, note = NULL
        WHERE user_id = @userId AND form_id = @formId`,
      { userId, formId }
    );
    await tx.query(
      `INSERT INTO dbo.form_access (user_id, form_id, status, source)
       SELECT @userId, @formId, 'pending', 'request'
        WHERE NOT EXISTS (SELECT 1 FROM dbo.form_access
                           WHERE user_id = @userId AND form_id = @formId)`,
      { userId, formId }
    );
    await recordAccessEvent(tx, { userId, formId, event: "requested", actorId: null });
  });
}

/**
 * Withdraw the caller's OWN pending request.
 *
 * ★ The `user_id` comes from the session, never from the body, and the guard is
 * `status = 'pending'` inside the statement — so this can only ever delete an
 * unanswered question. It cannot change anyone's access, which is why it is the
 * one self-service action that survives §15 Q5.
 */
export async function withdrawAccessRequest(viewer: FormViewer, formId: number): Promise<boolean> {
  const userId = viewerId(viewer);
  if (userId === null) return false;

  const existing = await getFormAccessRow(userId, formId);
  if (existing?.status !== "pending") return false;

  return getClient().transaction(async (tx) => {
    const removed = await tx.query<{ user_id: number }>(
      dialect().deleteReturning({
        table: "form_access",
        where: "user_id = @userId AND form_id = @formId AND status = 'pending'",
        returning: ["user_id"],
      }),
      { userId, formId }
    );
    if (removed.length === 0) return false;
    await recordAccessEvent(tx, { userId, formId, event: "withdrawn", actorId: null });
    return true;
  });
}

export type AccessDecision = "approve" | "decline" | "revoke";/**
 * Approve, decline or revoke.
 *
 * ★ ONE function for all three, so the state change and its audit row cannot be
 * written differently by different handlers. `revoke` reaches `denied` from
 * `approved` — the same state a decline produces — and the LOG is what tells the
 * two apart afterwards (§5.2).
 *
 * Returns false when there is no row to decide (or, for a revoke, no APPROVED row
 * — revoking something never granted is a no-op, not a silent grant of `denied`).
 */
export async function decideFormAccess(args: {
  userId: number;
  formId: number;
  decision: AccessDecision;
  actorId: number | null;
  note?: string | null;
}): Promise<boolean> {
  const { userId, formId, decision, actorId, note } = args;
  const status: FormAccessStatus = decision === "approve" ? "approved" : "denied";
  const event: FormAccessEvent =
    decision === "approve" ? "approved" : decision === "decline" ? "declined" : "revoked";

  const existing = await getFormAccessRow(userId, formId);
  if (!existing) return false;
  // A revoke acts on an APPROVED row only; a decline acts on a PENDING row only.
  // Without this, a decline on an approved row would silently revoke it and the
  // log would say "declined" for something that had been granted.
  if (decision === "revoke" && existing.status !== "approved") return false;
  if (decision === "decline" && existing.status !== "pending") return false;

  return getClient().transaction(async (tx) => {
    const updated = await tx.query<{ user_id: number }>(
      dialect().updateReturning({
        table: "form_access",
        set: "status = @status, decided_at = SYSUTCDATETIME(), decided_by = @actorId, note = @note",
        where: "user_id = @userId AND form_id = @formId",
        returning: ["user_id"],
      }),
      { userId, formId, status, actorId, note: note ?? null }
    );
    if (updated.length === 0) return false;
    await recordAccessEvent(tx, { userId, formId, event, actorId, note: note ?? null });
    return true;
  });
}

/**
 * Remove one account's access to one form, from the admin's Edit User drawer.
 *
 * ★ REFUSES when the form is PUBLIC, and that is the whole point of it being a
 * separate function from `decideFormAccess(… "revoke")`. On a public form every
 * internal member can read it regardless of any row, so removing a grant would
 * appear to succeed while changing nothing — the admin would see the row vanish
 * and the person would still open the form. A refusal that says why is the honest
 * answer.
 *
 * ★ Writes `denied` + a `revoked` event, exactly as the queue's Revoke does, so
 * the two paths cannot disagree about what a removal looks like. `denied` also
 * means the grandfather will NOT re-grant this account on a later flip (§6.4) —
 * which is what makes the removal stick.
 *
 * Returns the refusal reason rather than throwing, so the route can name it.
 */
export type RemoveAccessRefusal = "not_found" | "form_public" | "no_row";

export async function removeFormAccess(args: {
  userId: number;
  formId: number;
  actorId: number | null;
}): Promise<{ ok: true } | { ok: false; reason: RemoveAccessRefusal }> {
  const { userId, formId, actorId } = args;

  const forms = await execute<{ visibility: FormVisibility }>(
    `SELECT visibility FROM dbo.forms WHERE id = @formId`,
    { formId }
  );
  if (forms.length === 0) return { ok: false, reason: "not_found" };
  if (forms[0].visibility !== "private") return { ok: false, reason: "form_public" };

  const existing = await getFormAccessRow(userId, formId);
  if (!existing) return { ok: false, reason: "no_row" };

  const done = await getClient().transaction(async (tx) => {
    const updated = await tx.query<{ user_id: number }>(
      dialect().updateReturning({
        table: "form_access",
        set: "status = 'denied', decided_at = SYSUTCDATETIME(), decided_by = @actorId, note = @note",
        where: "user_id = @userId AND form_id = @formId",
        returning: ["user_id"],
      }),
      { userId, formId, actorId, note: "Access removed by an administrator" }
    );
    if (updated.length === 0) return false;
    await recordAccessEvent(tx, {
      userId,
      formId,
      event: "revoked",
      actorId,
      note: "Access removed by an administrator",
    });
    return true;
  });
  return done ? { ok: true } : { ok: false, reason: "no_row" };
}

/**
 * GRANT one account access to one form, from the admin's Add/Edit User drawer.
 *
 * The counterpart of `removeFormAccess`, and the same shape: it writes `approved`
 * + an `approved` event, so a grant made here is indistinguishable in the audit
 * log from one made by approving a request.
 *
 * ★ REFUSES a PUBLIC form, for the same reason the removal does. A public form is
 * readable by everyone regardless of any row, so a grant on it would appear to
 * work while changing nothing — and the checkbox would then be re-read as
 * "checked" from a row that has no effect.
 *
 * ★ A `pending` row is UPGRADED rather than duplicated. The PK is (user_id,
 * form_id), so a second INSERT would be a key violation; more importantly, an
 * admin granting access IS the answer to a pending request, and the `approved`
 * event records who answered it.
 *
 * ★ An already-approved row is idempotent: it writes nothing and reports success,
 * so re-saving a user whose checkboxes did not change is not an error.
 *
 * Returns the refusal reason rather than throwing, so the route can name it.
 */
export type GrantAccessRefusal = "not_found" | "form_public" | "wrong_organization";

export async function grantFormAccess(args: {
  userId: number;
  formId: number;
  organizationId: number;
  actorId: number | null;
}): Promise<{ ok: true; already: boolean } | { ok: false; reason: GrantAccessRefusal }> {
  const { userId, formId, organizationId, actorId } = args;

  // ★ The form must be in the caller's organization. Without this an admin could
  // grant — and thereby leak the existence of — another tenant's form by id.
  const forms = await execute<{ visibility: FormVisibility; organization_id: number }>(
    `SELECT visibility, organization_id FROM dbo.forms WHERE id = @formId`,
    { formId }
  );
  if (forms.length === 0) return { ok: false, reason: "not_found" };
  if (Number(forms[0].organization_id) !== Number(organizationId)) {
    return { ok: false, reason: "wrong_organization" };
  }
  if (forms[0].visibility !== "private") return { ok: false, reason: "form_public" };

  const existing = await getFormAccessRow(userId, formId);
  if (existing?.status === "approved") return { ok: true, already: true };

  await getClient().transaction(async (tx) => {
    // UPDATE-then-INSERT-if-absent, the same shape `requestFormAccess` uses: it
    // parses on both dialects and covers the `pending`/`denied`/no-row cases
    // without a dialect-specific upsert.
    await tx.query(
      `UPDATE dbo.form_access
          SET status = 'approved', source = 'direct',
              requested_at = SYSUTCDATETIME(), decided_at = SYSUTCDATETIME(),
              decided_by = @actorId, note = NULL
        WHERE user_id = @userId AND form_id = @formId`,
      { userId, formId, actorId }
    );
    await tx.query(
      `INSERT INTO dbo.form_access (user_id, form_id, status, source, requested_at, decided_at, decided_by)
       SELECT @userId, @formId, 'approved', 'direct', SYSUTCDATETIME(), SYSUTCDATETIME(), @actorId
        WHERE NOT EXISTS (SELECT 1 FROM dbo.form_access
                           WHERE user_id = @userId AND form_id = @formId)`,
      { userId, formId, actorId }
    );
    await recordAccessEvent(tx, { userId, formId, event: "approved", actorId });
  });
  return { ok: true, already: false };
}

/**
 * Set a form's visibility, and GRANDFATHER the accounts that could read it.
 *
 * ★ The backfill runs on `public -> private` ONLY, and it covers exactly the
 * accounts that could see the form one instant before — the organization's
 * `cdm_contact` accounts. Administrators and `staff` are exempt BY RULE and need
 * no row, so writing one for them would create rows the predicate never reads.
 *
 * ★ The grant set is written as the COMPLEMENT of the predicate's exemption
 * (`role = 'cdm_contact'` against `role <> 'cdm_contact'`). Those are one rule
 * written twice, so they must change together — see the plan's trap 12.
 *
 * ★ `NOT EXISTS` is what makes it idempotent AND what protects a decision: an
 * account with a `denied` row (declined, or revoked) is never re-granted by a
 * later flip, so an administrator's answer is not silently reversed.
 *
 * Returns the number of accounts newly granted, so the admin's confirmation can
 * say how many were grandfathered — a number that is otherwise guessed at.
 */
export async function setFormVisibility(args: {
  formId: number;
  organizationId: number;
  visibility: FormVisibility;
  actorId: number | null;
}): Promise<{ found: boolean; granted: number }> {
  const { formId, organizationId, visibility, actorId } = args;

  return getClient().transaction(async (tx) => {
    // Read the PREVIOUS value first: the backfill depends on the transition, not
    // on the new value. A form created already-private must grant nobody —
    // there is nobody who "currently sees it".
    const before = await tx.query<{ visibility: FormVisibility }>(
      `SELECT visibility FROM dbo.forms WHERE id = @formId AND organization_id = @organizationId`,
      { formId, organizationId }
    );
    if (before.length === 0) return { found: false, granted: 0 };
    const wasPublic = before[0].visibility !== "private";

    await tx.query(
      `UPDATE dbo.forms SET visibility = @visibility, updated_at = SYSUTCDATETIME()
        WHERE id = @formId AND organization_id = @organizationId`,
      { formId, organizationId, visibility }
    );

    if (visibility !== "private" || !wasPublic) return { found: true, granted: 0 };

    // The grandfather. `u.role = 'cdm_contact'` is the complement of the
    // predicate's exemption — see the note above.
    //
    // ★ `INSERT … SELECT` with a RETURNING clause has no portable spelling: SQL
    // Server wants `OUTPUT INSERTED.<col>`, SQLite wants `RETURNING`, and neither
    // parses on the other. So the candidate set is read FIRST, then inserted —
    // which also gives the caller an exact count of what this call created,
    // rather than a number recomputed from the table afterwards (where a
    // pre-existing backfill row would inflate it).
    const candidates = await tx.query<{ user_id: number }>(
      `SELECT u.id AS user_id
         FROM dbo.users u
        WHERE u.organization_id = @organizationId
          AND u.role = 'cdm_contact'
          AND NOT EXISTS (SELECT 1 FROM dbo.form_access a
                           WHERE a.user_id = u.id AND a.form_id = @formId)`,
      { formId, organizationId }
    );

    for (const row of candidates) {
      // One INSERT per candidate rather than a set-based INSERT … SELECT: the
      // set is a handful of rows (the organization's School Contacts), and this
      // is the shape that needs no dialect-specific RETURNING spelling.
      await tx.query(
        `INSERT INTO dbo.form_access (user_id, form_id, status, source, requested_at, decided_at, decided_by)
         VALUES (@userId, @formId, 'approved', 'backfill', SYSUTCDATETIME(), SYSUTCDATETIME(), @actorId)`,
        { userId: Number(row.user_id), formId, actorId }
      );
    }
    const inserted = candidates;

    // One `backfilled` event per inserted user, so a grandfathered grant and the
    // reason for it arrive together and neither can exist without the other.
    for (const row of inserted) {
      await recordAccessEvent(tx, {
        userId: Number(row.user_id),
        formId,
        event: "backfilled",
        actorId,
      });
    }
    return { found: true, granted: inserted.length };
  });
}
