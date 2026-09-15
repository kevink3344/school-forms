import { Router } from "express";
import { requireAuth, requireRoles, type JwtUser } from "../auth.js";
import { schoolYearForDate, WEBHOOK_AUTH_RESULTS, WEBHOOK_EVENT_STATUS } from "../db/schema.js";
import type { WebhookAuthResult, WebhookEventDetail, WebhookEventStatus } from "../db/schema.js";
import {
  countRecentWebhookEvents,
  countUnattributedWebhookEvents,
  getWebhookEvent,
  hasSuccessfulReplay,
  listReplayCandidates,
  listWebhookEvents,
  recordWebhookEvent,
  webhookEventStats,
  webhookRetention,
} from "../db/webhook-events.js";
import type { WebhookEventFilter } from "../db/webhook-events.js";
import { handleGoogleWebhookPayload, type IntakeOutcome } from "../webhook/intake.js";

export const webhookEventsRouter = Router();

// -----------------------------------------------------------------------------
// ADMIN ONLY: the inbound webhook log (docs/plans/webhook-log.md).
//
// Q2 was explicit: `role === 'admin'` is the single gate. There is no
// `menu_items` key and no `app_settings` flag, so there is nothing else to check
// — do not add a second, overlapping visibility switch.
//
// The log is read through `organization_id` on the row. The intake endpoint
// itself is global (one shared secret for the whole deployment), so without a
// scope an admin in one organization could read another organization's parent
// payloads. Rows whose form could not be resolved have no organization and are
// therefore excluded from every admin's view; `unattributed` reports how many
// there are so they are never *silently* missing.
// -----------------------------------------------------------------------------

webhookEventsRouter.use(requireAuth, requireRoles("admin"));

/** `null` means "not scoped"; a number means "restricted to that organization". */
function scopeOf(user: JwtUser): number | undefined {
  return user.organization_id ?? undefined;
}

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseIso(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Build the list filter from the query string. Unknown values are ignored. */
function listFilter(query: Record<string, unknown>, organizationId: number | undefined) {
  const filter: WebhookEventFilter = { organizationId };

  const status = typeof query.status === "string" ? query.status : "";
  if ((WEBHOOK_EVENT_STATUS as readonly string[]).includes(status)) {
    filter.status = status as WebhookEventStatus;
  }
  const authResult = typeof query.auth_result === "string" ? query.auth_result : "";
  if ((WEBHOOK_AUTH_RESULTS as readonly string[]).includes(authResult)) {
    filter.auth_result = authResult as WebhookAuthResult;
  }
  const formId = typeof query.form_id === "string" ? Number(query.form_id) : NaN;
  if (Number.isInteger(formId) && formId > 0) filter.form_id = formId;

  filter.from = parseIso(query.from);
  filter.to = parseIso(query.to);

  if (typeof query.search === "string" && query.search.trim() !== "") {
    // Capped so a pathological query string cannot produce a 2 KB LIKE pattern.
    filter.search = query.search.trim().slice(0, 100);
  }

  const limit = typeof query.limit === "string" ? Number(query.limit) : NaN;
  if (Number.isInteger(limit) && limit > 0) filter.limit = limit;
  const offset = typeof query.offset === "string" ? Number(query.offset) : NaN;
  if (Number.isInteger(offset) && offset >= 0) filter.offset = offset;

  return filter;
}

// -----------------------------------------------------------------------------
// ADMIN: GET /api/webhook/events — one page of the log.
// Query: status, auth_result, form_id, from, to, search, limit, offset
// -----------------------------------------------------------------------------
webhookEventsRouter.get("/", async (req, res, next) => {
  try {
    const organizationId = scopeOf(req.user!);
    const page = await listWebhookEvents(listFilter(req.query as Record<string, unknown>, organizationId));
    const retention = await webhookRetention(organizationId);
    res.json({ ...page, retention });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// ADMIN: GET /api/webhook/events/summary — the counters the dashboard (Q9) and
// the republish banner (Q4) need without pulling a page of rows.
//
// DECLARED BEFORE `/:id`. Both are one segment deep, so Express would match
// `/summary` against `/:id` if the order were reversed — and `parseId("summary")`
// would then 400 instead of returning counters.
//
// Query: days (default 7), form_id (optional)
// -----------------------------------------------------------------------------
webhookEventsRouter.get("/summary", async (req, res, next) => {
  try {
    const organizationId = scopeOf(req.user!);
    const daysRaw = Number(req.query.days);
    const days = Number.isInteger(daysRaw) && daysRaw > 0 && daysRaw <= 365 ? daysRaw : 7;

    const window = await countRecentWebhookEvents(days, organizationId);

    // Per-form totals, for "N responses for this form failed while it was
    // unpublished" — the hint the republish prompt links to.
    const formIdRaw = Number(req.query.form_id);
    const formId = Number.isInteger(formIdRaw) && formIdRaw > 0 ? formIdRaw : null;
    const formStats = formId
      ? await webhookEventStats({ organizationId, form_id: formId })
      : null;

    const retention = await webhookRetention(organizationId);

    // Computed unconditionally, NOT read off `formStats`. `formStats` only exists
    // when `form_id` was supplied, so reading the count from it made the dashboard
    // call (which has no form) always report 0 — the "attempts could not be
    // attributed" notice could never appear on the one screen meant to show it.
    const unattributed = await countUnattributedWebhookEvents();

    res.json({
      days,
      window,
      form: formStats
        ? {
            form_id: formId,
            succeeded: formStats.succeeded,
            failed: formStats.failed,
            total: formStats.total,
          }
        : null,
      unattributed,
      retention,
    });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// ADMIN: GET /api/webhook/events/:id — one row, payload included.
// -----------------------------------------------------------------------------
webhookEventsRouter.get("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid event id" });
      return;
    }
    const row = await scopedEvent(id, req.user!);
    if (!row) {
      res.status(404).json({ error: "Webhook event not found" });
      return;
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// ADMIN: POST /api/webhook/events/:id/replay — re-run one stored attempt.
//
// Replay re-runs the CURRENT intake rules against the STORED payload. That is
// the entire feature: the payload never changed, but "is this form published?"
// is answered with today's answer, so a response lost while the form was
// accidentally unpublished is delivered once the form is republished (Q4/Q7).
//
// One-shot (Q5): `createSubmission` mints a fresh `submission_seq` and
// `public_id` on every call, so a second replay would silently file a duplicate
// submission. A succeeding child row records that the replay happened; a failed
// child row does not, so a replay that fails may be retried.
// -----------------------------------------------------------------------------
webhookEventsRouter.post("/:id/replay", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid event id" });
      return;
    }
    const row = await scopedEvent(id, req.user!);
    if (!row) {
      res.status(404).json({ error: "Webhook event not found" });
      return;
    }
    const refusal = await replayRefusal(row);
    if (refusal) {
      res.status(409).json({ error: refusal });
      return;
    }

    // 200 even when the DELIVERY failed: the request was well-formed and was
    // processed, and the outcome is in the body. A 400 here would read as "you
    // sent a bad request", which is a different problem from "the form is still
    // unpublished" — and the client would have to unpack it to tell them apart.
    const result = await replayEvent(row, req.user!);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// ADMIN: POST /api/webhook/events/replay — bulk replay.
// Body: { event_ids?: number[], form_id?: number }
//
// Every row goes through the SAME guards as the single-row endpoint, so a batch
// is just N safe single replays — there is no fast path that could skip the
// duplicate check. Sequential on purpose, not `Promise.all`: each iteration's
// duplicate guard reads rows written by previous iterations, and running them
// concurrently would let two replays of the same source row both pass it.
// -----------------------------------------------------------------------------
webhookEventsRouter.post("/replay", async (req, res, next) => {
  try {
    const user = req.user!;
    const organizationId = scopeOf(user);
    const body = (req.body ?? {}) as { event_ids?: unknown; form_id?: unknown };

    const ids: number[] = Array.isArray(body.event_ids)
      ? body.event_ids
          .map((v) => Number(v))
          .filter((n) => Number.isInteger(n) && n > 0)
          .slice(0, 200)
      : [];
    const formIdRaw = Number(body.form_id);
    const formId = Number.isInteger(formIdRaw) && formIdRaw > 0 ? formIdRaw : undefined;

    if (ids.length === 0 && formId === undefined) {
      res.status(400).json({ error: "Provide event_ids or form_id" });
      return;
    }

    // `form_id` mode re-derives the selection in SQL (see listReplayCandidates):
    // only failed rows with a stored payload and no succeeding replay.
    const targets = ids.length > 0 ? ids : await listReplayCandidates({ form_id: formId, organizationId });

    const results: ReplayResult[] = [];
    for (const id of targets) {
      const row = await scopedEvent(id, user);
      if (!row) {
        results.push({ id, status: "skipped", public_id: null, error_code: null, error: "Not found in your organization" });
        continue;
      }
      const refusal = await replayRefusal(row);
      if (refusal) {
        results.push({ id, status: "skipped", public_id: null, error_code: null, error: refusal });
        continue;
      }
      results.push(await replayEvent(row, user));
    }

    const succeeded = results.filter((r) => r.status === "succeeded").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    res.json({ attempted: results.length, succeeded, failed, skipped, results });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Fetch a row, or `null` when it is not in the caller's organization.
 *
 * Deliberately returns the same `null` as "no such row": replying 403 for a row
 * that exists but belongs to another organization would confirm its existence,
 * which is exactly the cross-organization leak this scope exists to prevent.
 */
async function scopedEvent(id: number, user: JwtUser): Promise<WebhookEventDetail | null> {
  const row = await getWebhookEvent(id);
  if (!row) return null;
  const organizationId = scopeOf(user);
  if (organizationId !== undefined && row.organization_id !== organizationId) return null;
  return row;
}

/**
 * Why this row cannot be replayed, or `null` when it can.
 *
 * The client mirrors these rules to disable the button, so the two must stay in
 * step — but the server is the authority, and the button is only an affordance.
 */
async function replayRefusal(row: WebhookEventDetail): Promise<string | null> {
  if (row.status === "succeeded") {
    return "This attempt already succeeded — replaying it would file a duplicate submission.";
  }
  if (!row.payload_raw) {
    return row.payload_bytes
      ? `The payload was not stored (it was larger than the storage cap), so this attempt cannot be replayed.`
      : "No payload was stored for this attempt, so it cannot be replayed.";
  }
  if (row.error_code === "invalid_body") {
    return "The stored payload does not match the expected shape, so a replay would fail the same way.";
  }
  if (await hasSuccessfulReplay(row.id)) {
    return "This attempt has already been replayed successfully.";
  }
  return null;
}

type ReplayResult = {
  id: number;
  status: "succeeded" | "failed" | "skipped";
  public_id: string | null;
  error_code: string | null;
  error: string | null;
};

/**
 * Re-run one stored attempt and record the result as a NEW row.
 *
 * Two deliberate choices:
 *   - The new row is never written over the source row. The original failure
 *     stays visible, and `replay_of` links the pair, so the log shows the full
 *     history rather than only the final state.
 *   - `received_at` is left to the column DEFAULT (now), because that is the
 *     truth: the replay arrived now. Q7 keeps the ORIGINAL arrival time in the
 *     source row and uses it only for `school_year`.
 */
async function replayEvent(row: WebhookEventDetail, user: JwtUser): Promise<ReplayResult> {
  // Q7 option C: file the submission under the school year the response
  // originally arrived in, not the year the admin happened to click Replay.
  // Without this a July response replayed in September lands in the next year.
  const schoolYear = schoolYearForDate(new Date(row.received_at));

  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_raw as string);
  } catch {
    return {
      id: row.id,
      status: "failed",
      public_id: null,
      error_code: "internal_error",
      error: "The stored payload could not be parsed",
    };
  }

  const fallback: IntakeOutcome = {
    status: "failed",
    httpStatus: 500,
    errorCode: "internal_error",
    error: "Unexpected error during replay",
    formId: row.form_id,
    organizationId: row.organization_id,
    submissionId: null,
    publicId: null,
    body: {},
    schoolYear,
  };

  let outcome: IntakeOutcome = fallback;
  try {
    outcome = await handleGoogleWebhookPayload(payload, { schoolYear, origin: "replay" });
  } catch (err) {
    console.error("[webhook-events] replay failed unexpectedly:", err);
  }

  const recorded = await recordWebhookEvent({
    source: row.source,
    // Left NULL on purpose: this row was not received from the network. The
    // provenance is `replay_of` + `replayed_by`, and copying the admin's IP into
    // a column that otherwise means "where Google called from" would be a lie
    // that a future log reader would have no way to detect.
    remoteIp: null,
    userAgent: null,
    authResult: "ok",
    status: outcome.status,
    httpStatus: outcome.httpStatus,
    errorCode: outcome.errorCode,
    error: outcome.error,
    formId: outcome.formId,
    // Re-resolved from the form as it exists NOW, not copied from the source row:
    // a form that was missing at intake and has since been created now has an
    // organization, and that is the one that should own the delivered row.
    organizationId: outcome.organizationId,
    submissionId: outcome.submissionId,
    publicId: outcome.publicId,
    payloadRaw: row.payload_raw,
    payloadBytes: row.payload_bytes,
    payloadHash: row.payload_hash,
    replayOf: row.id,
    replayedBy: user.id,
  });

  if (recorded === null) {
    // The submission may well exist, but the log could not record it. Say so
    // rather than reporting success for a row the admin will never see.
    return {
      id: row.id,
      status: "failed",
      public_id: outcome.publicId,
      error_code: "internal_error",
      error: "The submission was processed but the log entry could not be written.",
    };
  }

  return {
    id: row.id,
    status: outcome.status,
    public_id: outcome.publicId,
    error_code: outcome.errorCode,
    error: outcome.error,
  };
}
