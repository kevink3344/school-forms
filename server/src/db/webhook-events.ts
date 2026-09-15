import { execute } from "./queries.js";
import { getDbKind } from "./pool.js";
import { getDialect } from "./dialect/index.js";
import type {
  ListWebhookEventRow,
  WebhookAuthResult,
  WebhookErrorCode,
  WebhookEventDetail,
  WebhookEventStatus,
} from "./schema.js";

/** Statement builders for the active dialect (see db/dialect/). */
function dialect() {
  return getDialect(getDbKind());
}

// -----------------------------------------------------------------------------
// Inbound webhook intake log (docs/plans/webhook-log.md).
//
// This module is pure persistence — it never validates a payload and never
// decides an outcome. The intake path (webhook/intake.ts) owns those decisions
// and hands the result here to be recorded.
//
// The single most important property of this file is that
// `recordWebhookEvent` NEVER THROWS. It is called from a `finally` block on the
// webhook route, so a throw here would replace a legitimate 400/401/404 with an
// unhandled rejection, and a logging failure would become a *worse* outage than
// the one it was meant to make visible.
// -----------------------------------------------------------------------------

/** The columns every read projects (everything except `payload_raw`). */
const EVENT_COLUMNS = [
  "e.id",
  "e.source",
  "e.received_at",
  "e.remote_ip",
  "e.user_agent",
  "e.auth_result",
  "e.status",
  "e.http_status",
  "e.error_code",
  "e.error",
  "e.form_id",
  "e.organization_id",
  "e.submission_id",
  "e.public_id",
  "e.payload_bytes",
  "e.payload_hash",
  "e.replay_of",
  "e.replayed_by",
].join(", ");

// The label projections. `form_id` is deliberately NOT a foreign key, so a
// deleted form leaves a dangling id — the LEFT JOIN then yields NULL and the UI
// renders "(deleted form)" rather than dropping the row. Same for replayed_by.
const EVENT_JOINS =
  "LEFT JOIN dbo.forms f ON f.id = e.form_id\n" +
  "     LEFT JOIN dbo.users u ON u.id = e.replayed_by";

const EVENT_LABELS =
  "f.title AS form_title, f.code AS form_code, u.display_name AS replayed_by_name, " +
  // Derived in SQL rather than fetched: a page of 100 failures must not ship 100
  // payloads just so the grid can grey out the Replay button. `CASE WHEN ... THEN
  // 1 ELSE 0 END` is valid on both dialects (unlike a bare boolean expression,
  // which SQL Server has no type for).
  "CASE WHEN e.payload_raw IS NOT NULL THEN 1 ELSE 0 END AS payload_present, " +
  "CASE WHEN EXISTS (SELECT 1 FROM dbo.webhook_events c " +
  "WHERE c.replay_of = e.id AND c.status = 'succeeded') THEN 1 ELSE 0 END AS has_replay";

/**
 * Normalize a dialect-derived flag. SQL Server returns the CASE as an INT, and
 * libSQL may hand back 1 or true depending on the driver, so accept all three
 * rather than trusting one spelling.
 */
function flag(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

/** A row exactly as the driver returns it, before the flags are normalized. */
type RawEventRow = Omit<ListWebhookEventRow, "payload_present" | "has_replay"> & {
  payload_present: unknown;
  has_replay: unknown;
};

/**
 * Normalize the flags on a row, preserving whatever else it carries. Generic so
 * the detail row (which adds `payload_raw`) keeps its extra column instead of
 * being widened to the list shape.
 */
function toRow<T extends { payload_present: unknown; has_replay: unknown }>(
  raw: T
): Omit<T, "payload_present" | "has_replay"> & {
  payload_present: boolean;
  has_replay: boolean;
} {
  const { payload_present, has_replay, ...rest } = raw;
  return { ...rest, payload_present: flag(payload_present), has_replay: flag(has_replay) };
}

/** A detail row as the driver returns it, before the flags are normalized. */
type RawEventDetail = RawEventRow & { payload_raw: string | null };

export interface WebhookEventInsert {
  source: string;
  remoteIp: string | null;
  userAgent: string | null;
  authResult: WebhookAuthResult;
  status: WebhookEventStatus;
  httpStatus: number;
  errorCode: WebhookErrorCode | null;
  error: string | null;
  formId: number | null;
  organizationId: number | null;
  submissionId: number | null;
  publicId: string | null;
  payloadRaw: string | null;
  payloadBytes: number | null;
  payloadHash: string | null;
  replayOf: number | null;
  replayedBy: number | null;
}

export interface WebhookEventFilter {
  status?: WebhookEventStatus;
  auth_result?: WebhookAuthResult;
  form_id?: number;
  /**
   * Restrict to one organization. This is the scope control: the intake endpoint
   * is global (one shared secret for the whole deployment), but the LOG is read
   * by org-scoped admins, so an org must never see another org's payloads.
   */
  organizationId?: number;
  /** Inclusive lower bound on `received_at`, as an ISO-8601 UTC instant. */
  from?: string;
  /** Inclusive upper bound on `received_at`. */
  to?: string;
  /** Free-text match against the submission id, the error text and the client IP. */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface WebhookEventStats {
  succeeded: number;
  failed: number;
  /** Total rows matching the filter, ignoring limit/offset. */
  total: number;
}

export interface WebhookEventPage {
  events: ListWebhookEventRow[];
  stats: WebhookEventStats;
  /**
   * Organization-wide count of attempts that could not be attributed to any
   * organization ("form not found", or a form deleted since). They are excluded
   * from the scoped list on purpose — attributing them would mean guessing, and
   * guessing wrong leaks one org's parent data to another org's admin. The count
   * is surfaced so they are never *silently* missing.
   */
  unattributed: number;
}

// -----------------------------------------------------------------------------
// Write
// -----------------------------------------------------------------------------

/**
 * Record one intake attempt. Returns the new row id, or `null` if the write
 * itself failed — which is deliberately NOT an error: the caller has already
 * produced a real HTTP response and must not have it replaced by a logging
 * failure. `received_at` is left to the column DEFAULT so the two dialects agree
 * without a bound-date conversion (see db/client.ts `normalizeParamValue`).
 */
export async function recordWebhookEvent(input: WebhookEventInsert): Promise<number | null> {
  try {
    const rows = await execute<{ id: number }>(
      dialect().insertReturning({
        table: "webhook_events",
        columns: [
          "source",
          "remote_ip",
          "user_agent",
          "auth_result",
          "status",
          "http_status",
          "error_code",
          "error",
          "form_id",
          "organization_id",
          "submission_id",
          "public_id",
          "payload_raw",
          "payload_bytes",
          "payload_hash",
          "replay_of",
          "replayed_by",
        ],
        returning: ["id"],
        values:
          "@source, @remoteIp, @userAgent, @authResult, @status, @httpStatus, " +
          "@errorCode, @error, @formId, @organizationId, @submissionId, @publicId, " +
          "@payloadRaw, @payloadBytes, @payloadHash, @replayOf, @replayedBy",
      }),
      {
        source: input.source,
        remoteIp: input.remoteIp,
        userAgent: input.userAgent,
        authResult: input.authResult,
        status: input.status,
        httpStatus: input.httpStatus,
        errorCode: input.errorCode,
        error: input.error,
        formId: input.formId,
        organizationId: input.organizationId,
        submissionId: input.submissionId,
        publicId: input.publicId,
        payloadRaw: input.payloadRaw,
        payloadBytes: input.payloadBytes,
        payloadHash: input.payloadHash,
        replayOf: input.replayOf,
        replayedBy: input.replayedBy,
      }
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    // Loud in the server log, invisible to the caller — see the file header.
    console.error("[webhook-events] failed to record intake event:", err);
    return null;
  }
}

// -----------------------------------------------------------------------------
// Read
// -----------------------------------------------------------------------------

/**
 * Build the shared WHERE clause. Kept in one place so the page query and its
 * COUNT can never disagree — a count that used a different predicate than its
 * page is the classic "showing 100 of 118" bug.
 *
 * All values are bound as named params; only the *presence* of a clause is
 * interpolated, never a value.
 */
function buildWhere(filter: WebhookEventFilter): {
  where: string;
  params: Record<string, unknown>;
} {
  const clauses: string[] = ["1 = 1"];
  const params: Record<string, unknown> = {};

  if (filter.organizationId !== undefined) {
    // Scoped on the stored COLUMN, not on the joined form, so a row survives the
    // deletion of its form. See WebhookEvent.organization_id in schema.ts.
    clauses.push("e.organization_id = @organizationId");
    params.organizationId = filter.organizationId;
  }
  if (filter.status) {
    clauses.push("e.status = @status");
    params.status = filter.status;
  }
  if (filter.auth_result) {
    clauses.push("e.auth_result = @authResult");
    params.authResult = filter.auth_result;
  }
  if (filter.form_id !== undefined) {
    clauses.push("e.form_id = @formId");
    params.formId = filter.form_id;
  }
  if (filter.from) {
    clauses.push("e.received_at >= @from");
    params.from = filter.from;
  }
  if (filter.to) {
    clauses.push("e.received_at <= @to");
    params.to = filter.to;
  }
  if (filter.search) {
    // Covers every column the grid puts in front of the admin: the public id and
    // the error text, the client IP, and the two SHORT codes — `error_code`
    // ("form_not_published") and the HTTP status ("401"). Both codes are what an
    // admin actually types to isolate a class of failure, and the status is cast
    // to text because SQL Server will not LIKE an INT and the cast has to be
    // spelled the same way in both dialects.
    //
    // The metacharacters are escaped (hence the repeated ESCAPE clause) so that
    // typing `%` into the search box matches a literal percent sign instead of
    // every row, and `_` does not silently match any single character. Only `%`,
    // `_` and the escape character itself are escaped: `[` is a wildcard in
    // T-SQL but NOT in SQLite, so escaping it would corrupt the Turso query.
    // A stray `[` on SQL Server can therefore still open a bracket expression,
    // which degrades to "no match" — never to "match everything".
    const escaped = filter.search.replace(/[\\%_]/g, (m) => `\\${m}`);
    clauses.push(
      "(e.public_id LIKE @search ESCAPE '\\' OR e.error LIKE @search ESCAPE '\\' " +
        "OR e.remote_ip LIKE @search ESCAPE '\\' OR e.error_code LIKE @search ESCAPE '\\' " +
        "OR CAST(e.http_status AS VARCHAR(8)) LIKE @search ESCAPE '\\')"
    );
    params.search = `%${escaped}%`;
  }

  return { where: `WHERE ${clauses.join("\n       AND ")}`, params };
}

/**
 * Row count above which the log is flagged for trimming (Q8 asked to keep
 * payloads indefinitely, with a warning once the table gets large). Sized so the
 * warning arrives long before the ~2 GB `NVARCHAR(MAX)` growth is a problem.
 */
export const RETENTION_WARNING_THRESHOLD = 100_000;

export interface WebhookRetention {
  rows: number;
  threshold: number;
  warning: boolean;
}

/** The retention figures shown on the log page. */
export async function webhookRetention(organizationId?: number): Promise<WebhookRetention> {
  const rows = await countWebhookEvents(organizationId);
  return {
    rows,
    threshold: RETENTION_WARNING_THRESHOLD,
    warning: rows > RETENTION_WARNING_THRESHOLD,
  };
}

/**
 * Counts for a filter, unfiltered by limit/offset, plus the unattributable total.
 *
 * Extracted so the page grid, the summary endpoint and the republish banner all
 * count the same way — a stats strip that disagrees with its own grid is the
 * classic "showing 100 of 118" bug.
 */
export async function webhookEventStats(
  filter: WebhookEventFilter = {}
): Promise<WebhookEventStats & { unattributed: number }> {
  const { where, params } = buildWhere(filter);
  const counted = await execute<{ status: string; n: number }>(
    `SELECT e.status AS status, COUNT(*) AS n
       FROM dbo.webhook_events e
       ${where}
      GROUP BY e.status`,
    params
  );

  let succeeded = 0;
  let failed = 0;
  for (const row of counted) {
    // `Number(rows[0]?.n ?? 0)` would turn "no row" into a real 0 and make a
    // failed query indistinguishable from "nothing happened"; guard on finiteness.
    const n = Number(row.n);
    if (!Number.isFinite(n)) continue;
    if (row.status === "succeeded") succeeded += n;
    else if (row.status === "failed") failed += n;
  }

  // Rows that no organization owns. Reported as a bare count so the UI can say
  // "N attempts could not be attributed to a form" without showing anyone's data.
  const unattributed = await countUnattributedWebhookEvents();

  return { succeeded, failed, total: succeeded + failed, unattributed };
}

/**
 * One page of the log plus the counts for the same filter.
 *
 * `payload_raw` is NOT projected here — a page of 100 failures must not ship 100
 * verbatim payloads to the browser. The drawer fetches it via
 * `getWebhookEvent` when the admin actually asks to see one.
 */
export async function listWebhookEvents(
  filter: WebhookEventFilter = {}
): Promise<WebhookEventPage> {
  const pageSize = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  const { where, params } = buildWhere(filter);

  const rows = await execute<RawEventRow>(
    dialect().selectPage({
      select: `${EVENT_COLUMNS}, ${EVENT_LABELS}`,
      from: `dbo.webhook_events e\n     ${EVENT_JOINS}`,
      where,
      // Newest first, with `id DESC` as the tie-breaker: a bulk replay writes
      // several rows inside the same millisecond, and without a total order the
      // database is free to return them in any sequence — including a different
      // one for the page than for the count.
      orderBy: "e.received_at DESC, e.id DESC",
    }),
    { ...params, pageSize, offset }
  );

  const stats = await webhookEventStats(filter);

  return {
    events: rows.map(toRow),
    stats: { succeeded: stats.succeeded, failed: stats.failed, total: stats.total },
    unattributed: stats.unattributed,
  };
}

/**
 * Failed attempts that a bulk replay should pick up, oldest first.
 *
 * The guard here mirrors `replayRefusal()` in routes/webhookEvents.ts and exists
 * to keep the batch small: `payload_raw IS NOT NULL` excludes the attempts whose
 * body was never stored (a failed secret check, or a body over the cap), and the
 * NOT EXISTS excludes rows a previous replay already delivered. Doing it in SQL
 * means a "replay everything for this form" request does not fetch and discard
 * hundreds of ineligible rows one at a time.
 *
 * Oldest first because `createSubmission` allocates `submission_seq` in call
 * order — replaying out of order would number the recovered submissions
 * backwards relative to when they actually arrived.
 */
export async function listReplayCandidates(input: {
  form_id?: number;
  organizationId?: number;
  limit?: number;
}): Promise<number[]> {
  const clauses: string[] = [
    "e.status = 'failed'",
    "e.payload_raw IS NOT NULL",
    // A body that failed schema validation will fail it again identically.
    "(e.error_code IS NULL OR e.error_code <> 'invalid_body')",
    "NOT EXISTS (SELECT 1 FROM dbo.webhook_events c WHERE c.replay_of = e.id AND c.status = 'succeeded')",
  ];
  const params: Record<string, unknown> = {};
  if (input.form_id !== undefined) {
    clauses.push("e.form_id = @formId");
    params.formId = input.form_id;
  }
  if (input.organizationId !== undefined) {
    clauses.push("e.organization_id = @organizationId");
    params.organizationId = input.organizationId;
  }
  const batchSize = Math.min(Math.max(input.limit ?? 200, 1), 200);

  // Paged through the dialect builder, not with an inline OFFSET/FETCH: the
  // paging spelling is the one thing that genuinely differs between SQL Server
  // and libSQL, and the shared-file guard in db/driver/libsql.test.ts rejects the
  // SQL Server form here on purpose (that is why `selectPage` exists).
  const rows = await execute<{ id: number }>(
    dialect().selectPage({
      select: "e.id AS id",
      from: "dbo.webhook_events e",
      where: `WHERE ${clauses.join("\n        AND ")}`,
      orderBy: "e.received_at ASC, e.id ASC",
    }),
    { ...params, pageSize: batchSize, offset: 0 }
  );
  return rows.map((r) => r.id).filter((id) => Number.isInteger(id));
}

/**
 * Attempts whose form could never be resolved, so no organization can be shown
 * the row. Cheap because of IX_webhook_events_org (NULLs are indexed).
 */
export async function countUnattributedWebhookEvents(): Promise<number> {
  const rows = await execute<{ n: number }>(
    "SELECT COUNT(*) AS n FROM dbo.webhook_events WHERE organization_id IS NULL"
  );
  const n = Number(rows[0]?.n);
  return Number.isFinite(n) ? n : 0;
}

/** Full row including the stored payload — used by the detail drawer and replay. */
export async function getWebhookEvent(id: number): Promise<WebhookEventDetail | null> {
  const rows = await execute<RawEventDetail>(
    `SELECT ${EVENT_COLUMNS}, ${EVENT_LABELS}, e.payload_raw
       FROM dbo.webhook_events e
       ${EVENT_JOINS}
      WHERE e.id = @id`,
    { id }
  );
  const raw = rows[0];
  return raw ? toRow(raw) : null;
}

/**
 * Whether this event has already been replayed successfully.
 *
 * Replay is ONE-SHOT (docs/plans/webhook-log.md Q5): `createSubmission` mints a
 * fresh `submission_seq` and `public_id` on every call, so replaying the same
 * source row twice silently files two submissions. A succeeding child row is the
 * record that the replay already happened, and "undo a replay" would mean
 * deleting an audit row — so the second attempt is refused instead.
 */
export async function hasSuccessfulReplay(id: number): Promise<boolean> {
  const rows = await execute<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM dbo.webhook_events
      WHERE replay_of = @id AND status = 'succeeded'`,
    { id }
  );
  const n = Number(rows[0]?.n);
  return Number.isFinite(n) && n > 0;
}

/**
 * A small aggregate for the admin dashboard: how many intake attempts landed in
 * the last N days, split by outcome. Uses a bound cutoff rather than
 * `DATEADD`/`datetime('now')` so the single statement is valid on both dialects.
 */
export async function countRecentWebhookEvents(
  days = 7,
  organizationId?: number
): Promise<{ succeeded: number; failed: number }> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const scoped = organizationId !== undefined;
  const rows = await execute<{ status: string; n: number }>(
    `SELECT e.status AS status, COUNT(*) AS n
       FROM dbo.webhook_events e
      WHERE e.received_at >= @cutoff
        ${scoped ? "AND e.organization_id = @organizationId" : ""}
      GROUP BY e.status`,
    scoped ? { cutoff, organizationId } : { cutoff }
  );

  let succeeded = 0;
  let failed = 0;
  for (const row of rows) {
    // `Number(rows[0]?.n ?? 0)` would turn "no row" into a real 0 and make a
    // failed query indistinguishable from "nothing happened"; guard on finiteness.
    const n = Number(row.n);
    if (!Number.isFinite(n)) continue;
    if (row.status === "succeeded") succeeded += n;
    else if (row.status === "failed") failed += n;
  }
  return { succeeded, failed };
}

/**
 * Row count for the retention warning (Q8: keep indefinitely, warn above
 * 100,000). Scoped like every other admin read, so the warning an admin sees is
 * about the log they can actually see.
 */
export async function countWebhookEvents(organizationId?: number): Promise<number> {
  const scoped = organizationId !== undefined;
  const rows = await execute<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM dbo.webhook_events
      ${scoped ? "WHERE organization_id = @organizationId" : ""}`,
    scoped ? { organizationId } : {}
  );
  const n = Number(rows[0]?.n);
  return Number.isFinite(n) ? n : 0;
}
