import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, ChevronLeft, ChevronRight, RefreshCw, RotateCcw, X } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import type {
  Form,
  WebhookAuthResult,
  WebhookEventDetail,
  WebhookEventPage,
  WebhookEventRow,
  WebhookEventStatus,
} from "../../types";
import { PageHead } from "../../components/layout";

// Rows per request. Small enough that a page is quick and the pager is
// meaningful, large enough that an ordinary investigation fits on one page.
const PAGE_SIZE = 50;

const EMPTY_PAGE: WebhookEventPage = {
  events: [],
  stats: { succeeded: 0, failed: 0, total: 0 },
  unattributed: 0,
  retention: { rows: 0, threshold: 100_000, warning: false },
};

/**
 * The plain-language reason for a failed attempt.
 *
 * Written from `error_code` rather than the raw server text because the server
 * message is the parent-facing one ("Form is not accepting submissions") and does
 * not say *why* — the whole reason `error_code` exists. The original message is
 * still shown beside it so nothing is hidden.
 */
function reasonLabel(row: WebhookEventRow): string {
  switch (row.error_code) {
    case "form_not_published":
      return "Form was not published";
    case "unauthorized":
      return row.auth_result === "missing" ? "No secret sent" : "Wrong secret";
    case "form_not_found":
      return "Unknown form id";
    case "invalid_body":
      return "Malformed body";
    case "internal_error":
      return "Server error";
    default:
      return row.status === "succeeded" ? "Delivered" : "Failed";
  }
}

/**
 * The badge text. Deliberately the same two words the Status filter offers, so a
 * filtered list and its badge can never disagree. The machine-readable code is
 * too long for a badge and is shown beside the human reason instead.
 */
function statusLabel(row: WebhookEventRow): string {
  return row.status === "succeeded" ? "succeeded" : "failed";
}

function statusBadgeClass(row: WebhookEventRow): string {
  if (row.status === "succeeded") return "badge badge-green";
  if (row.error_code === "unauthorized") return "badge badge-red";
  return "badge badge-amber";
}

/**
 * Why Replay is unavailable, or null when it can run.
 *
 * This mirrors `replayRefusal()` on the server — the server stays the authority,
 * but a button that is enabled and then rejected reads as a broken app, so the
 * rules are stated up front. The `title` explains a disabled button, which unlike
 * a greyed-out control is not self-explanatory.
 */
function replayBlockedReason(row: WebhookEventRow): string | null {
  if (row.status === "succeeded") return "This attempt already succeeded.";
  if (!row.payload_present) return "No payload was stored for this attempt, so there is nothing to re-send.";
  if (row.has_replay) return "This attempt has already been replayed successfully.";
  return null;
}

function formatDateTime(v: string): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Pretty-print the stored body when it is JSON, otherwise show it verbatim. */
function prettyPayload(raw: string | null): string {
  if (raw == null || raw === "") return "(no payload stored)";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export default function WebhookLog() {
  // The republish prompt (Q4) and the dashboard counters (Q9) both link here
  // pre-filtered, so the initial filter is read from the URL. It seeds state
  // once rather than staying in sync: an admin changing a filter should not
  // rewrite the address they arrived on.
  const [searchParams] = useSearchParams();

  const [status, setStatus] = useState<WebhookEventStatus | "">(() => {
    const raw = searchParams.get("status");
    return raw === "succeeded" || raw === "failed" ? raw : "failed";
  });
  const [formId, setFormId] = useState(() => searchParams.get("form_id") ?? "");
  const [authResult, setAuthResult] = useState<WebhookAuthResult | "">("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);

  const [page, setPage] = useState<WebhookEventPage>(EMPTY_PAGE);
  const [forms, setForms] = useState<Form[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [selected, setSelected] = useState<WebhookEventDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [panelError, setPanelError] = useState("");
  const [replayMessage, setReplayMessage] = useState("");
  // Row-level replay happens without opening anything, so its outcome is
  // reported on the page itself — otherwise clicking Replay looks like it did
  // nothing but re-sort the list.
  const [notice, setNotice] = useState("");
  const [replaying, setReplaying] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMessage, setBulkMessage] = useState("");

  // One request per pause, rather than one per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  // EVERY form, not just the published ones: most failures in this log are
  // responses that arrived while their form was unpublished or archived, so a
  // picker limited to published forms could not name the thing that broke.
  useEffect(() => {
    api
      .listForms()
      .then((f) => setForms(f))
      .catch(() => setForms([]));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listWebhookEvents({
        status: status || undefined,
        auth_result: authResult || undefined,
        form_id: formId ? Number(formId) : undefined,
        from: from || undefined,
        to: to || undefined,
        search: search || undefined,
        limit: PAGE_SIZE,
        offset,
      })
      .then((p) => {
        setPage(p);
        setError("");
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the webhook log"))
      .finally(() => setLoading(false));
  }, [status, authResult, formId, from, to, search, offset]);

  useEffect(() => {
    load();
  }, [load]);

  // Any filter change invalidates the current page number — page 3 of the old
  // result is meaningless as page 3 of the new one — and any replay notice, which
  // talks about a row that may no longer be on screen.
  const changeFilter = (apply: () => void) => {
    apply();
    setOffset(0);
    setNotice("");
  };

  const clearFilters = () =>
    changeFilter(() => {
      setStatus("failed");
      setFormId("");
      setAuthResult("");
      setSearchInput("");
      setSearch("");
      setFrom("");
      setTo("");
    });

  const openDetail = async (row: WebhookEventRow) => {
    setSelected(null);
    setDetailLoading(true);
    setPanelError("");
    setReplayMessage("");
    try {
      // The list never carries `payload_raw`, so the payload is fetched here —
      // when the admin actually asks to see one row.
      setSelected(await api.getWebhookEvent(row.id));
    } catch (err) {
      setPanelError(err instanceof ApiError ? err.message : "Could not load this attempt");
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setSelected(null);
    setPanelError("");
    setReplayMessage("");
  };

  /**
   * Re-deliver one attempt, reporting the outcome where the click came from: in
   * the drawer's own Replay button, or as a page notice for the row button.
   *
   * Called from the ROW, this opens no drawer on purpose — the rows are the
   * working surface, and forcing a panel open just to press a second button is
   * a worse flow than answering inline.
   */
  const runReplay = async (id: number, fromDrawer = false) => {
    setReplaying(true);
    setBusyId(id);
    setPanelError("");
    setReplayMessage("");
    if (!fromDrawer) setNotice("");
    try {
      const result = await api.replayWebhookEvent(id);
      // A 200 does not mean delivery worked — the outcome is in the body.
      const text =
        result.status === "succeeded"
          ? `Delivered as ${result.public_id ?? "a new submission"}.`
          : `Replay did not deliver: ${result.error ?? result.error_code ?? "unknown reason"}`;
      if (fromDrawer) setReplayMessage(text);
      else setNotice(`Attempt #${id}: ${text}`);
      // The replay wrote its own row, and the source row now reports
      // `has_replay`, so both the grid and the open drawer are stale.
      load();
      if (selected) setSelected(await api.getWebhookEvent(selected.id));
    } catch (err) {
      const text = err instanceof ApiError ? err.message : "Could not replay this attempt";
      if (fromDrawer) setPanelError(text);
      else setNotice(`Attempt #${id}: ${text}`);
    } finally {
      setReplaying(false);
      setBusyId(null);
    }
  };

  const runBulkReplay = async () => {
    setBulkBusy(true);
    setBulkMessage("");
    try {
      const result = await api.replayWebhookEvents(formId ? { form_id: Number(formId) } : {});
      setBulkMessage(
        `Delivered ${result.succeeded} of ${result.attempted}` +
          (result.failed ? `, ${result.failed} failed` : "") +
          (result.skipped ? `, ${result.skipped} skipped` : "") +
          ".",
      );
      load();
    } catch (err) {
      setBulkMessage(err instanceof ApiError ? err.message : "Could not replay these attempts");
    } finally {
      setBulkBusy(false);
    }
  };

  const { stats, retention, unattributed } = page;
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < stats.total;
  const showingFrom = stats.total === 0 ? 0 : offset + 1;
  const showingTo = Math.min(offset + PAGE_SIZE, stats.total);

  const formOptions = useMemo(
    () => forms.slice().sort((a, b) => a.title.localeCompare(b.title)),
    [forms],
  );

  // Only offer "replay everything" when the filter names ONE form: a blanket
  // replay across every form in the organization is a bigger action than this
  // page should take on a single click.
  const canBulkReplay = Boolean(formId) && stats.failed > 0;

  return (
    <div>
      <PageHead
        title="Webhook Log"
        subtitle="Every response Google Forms has posted to this app, including the ones that were rejected."
        actions={
          <button className="secondary-button" onClick={load}>
            <RefreshCw size={14} />
            Refresh
          </button>
        }
      />

      {/* Q8: payloads are kept indefinitely, so the only retention signal is the
          row count. Shown above everything because it is a "plan for this" warning
          rather than an error to act on now. */}
      {retention.warning && (
        <div className="card" style={{ borderColor: "var(--orange-tint-line)", background: "var(--orange-tint)" }}>
          <div className="card-head">
            <AlertTriangle size={16} />
            <h3 style={{ marginLeft: 8 }}>This log is getting large</h3>
          </div>
          <div className="card-body">
            <p style={{ margin: 0, fontSize: 13 }}>
              {retention.rows.toLocaleString()} attempts are stored (warning threshold{" "}
              {retention.threshold.toLocaleString()}). Payloads are kept indefinitely, so this is the point to
              consider exporting and trimming older rows.
            </p>
          </div>
        </div>
      )}

      {/* Attempts with no resolvable organization are invisible to every admin by
          design — the form id in a rejected request cannot be trusted. Reporting
          the count is what keeps them from being *silently* missing. */}
      {unattributed > 0 && (
        <div className="card">
          <div className="card-body" style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {unattributed.toLocaleString()} attempt{unattributed === 1 ? "" : "s"} could not be attributed to a
            form or organization and cannot be listed here — usually a request with a wrong or missing secret,
            or one naming a form that no longer exists.
          </div>
        </div>
      )}

      {/* A failed *load*. Replay outcomes are reported where the click happened —
          in the bulk modal, or in the notice above the rows — so they are never
          shown here as well. */}
      {error && (
        <div
          style={{
            background: "rgb(255,232,234)",
            color: "rgb(186,48,64)",
            border: "1px solid var(--border)",
            padding: "10px 12px",
            borderRadius: "var(--radius)",
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      <div className="filter-bar">
        <div className="filter-group">
          <label>Status</label>
          <select
            value={status}
            onChange={(e) => changeFilter(() => setStatus(e.target.value as WebhookEventStatus | ""))}
          >
            <option value="failed">Failed</option>
            <option value="succeeded">Succeeded</option>
            <option value="">All</option>
          </select>
        </div>
        <div className="filter-group">
          <label>Form</label>
          <select value={formId} onChange={(e) => changeFilter(() => setFormId(e.target.value))}>
            <option value="">All forms</option>
            {formOptions.map((f) => (
              <option key={f.id} value={f.id}>
                {f.title} ({f.status})
              </option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label>Secret</label>
          <select
            value={authResult}
            onChange={(e) => changeFilter(() => setAuthResult(e.target.value as WebhookAuthResult | ""))}
          >
            <option value="">Any</option>
            <option value="ok">Accepted</option>
            <option value="invalid">Wrong</option>
            <option value="missing">Missing</option>
          </select>
        </div>
        <div className="filter-group">
          <label>Search</label>
          <input
            value={searchInput}
            placeholder="id, IP, status, reason"
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <div className="filter-group">
          <label>Date from</label>
          <input
            type="date"
            value={from}
            onChange={(e) => changeFilter(() => setFrom(e.target.value))}
          />
        </div>
        <div className="filter-group">
          <label>Date to</label>
          <input type="date" value={to} onChange={(e) => changeFilter(() => setTo(e.target.value))} />
        </div>
        {canBulkReplay && (
          <div className="filter-group">
            <label>&nbsp;</label>
            <button
              className="badge-button filter-chip"
              onClick={() => {
                // Drop the previous run's readout — reopening the dialog should
                // show the question, not last time's answer.
                setBulkMessage("");
                setBulkOpen(true);
              }}
            >
              <RotateCcw size={14} />
              Replay all failed
            </button>
          </div>
        )}
        <div className="filter-spacer" />
        <button className="clear" onClick={clearFilters}>
          Clear
        </button>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Attempts</h3>
          <span className="sub" style={{ marginLeft: "auto" }}>
            {stats.total === 0
              ? "no results"
              : `${showingFrom}–${showingTo} of ${stats.total}`}
            {" · "}
            <span className="badge badge-green">{stats.succeeded} succeeded</span>{" "}
            <span className="badge badge-amber">{stats.failed} failed</span>
          </span>
        </div>

        {/* The result of a row-level Replay lives here, next to the rows it is
            about — a notice at the top of the page would be off-screen for
            anyone working lower down the grid. */}
        {notice && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 14px",
              borderBottom: "1px solid var(--border)",
              background: "var(--filled-bg)",
              fontSize: 13,
            }}
          >
            <span>{notice}</span>
            <div style={{ flex: 1 }} />
            <button className="icon-button" onClick={() => setNotice("")} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        )}

        {loading ? (
          <div className="loading-state">
            <div className="spinner" /> Loading attempts...
          </div>
        ) : page.events.length === 0 ? (
          <div className="empty-state">
            Nothing matches these filters. Every inbound attempt is recorded, so an empty list here means the
            endpoint has not been called.
          </div>
        ) : (
          <div className="grid-wrap">
            <table className="grid" style={{ width: "100%", minWidth: 1000, borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ width: 180 }}>Received</th>
                  <th style={{ width: 110 }}>Result</th>
                  <th style={{ width: 70 }}>HTTP</th>
                  <th>Form</th>
                  <th>Reason</th>
                  <th style={{ width: 160 }}>Submission</th>
                  <th style={{ width: 90 }}>Replay</th>
                </tr>
              </thead>
              <tbody>
                {page.events.map((row) => {
                  const blocked = replayBlockedReason(row);
                  return (
                    <tr
                      key={row.id}
                      className={selected?.id === row.id ? "grid-row selected" : "grid-row"}
                      onClick={() => openDetail(row)}
                    >
                      <td className="cell-mono" data-label="Received">
                        {formatDateTime(row.received_at)}
                      </td>
                      <td data-label="Result">
                        <span className={statusBadgeClass(row)}>{statusLabel(row)}</span>
                      </td>
                      <td className="cell-mono" data-label="HTTP">
                        {row.http_status}
                      </td>
                      <td data-label="Form">
                        {row.form_title ? (
                          <>
                            <span className="cell-strong">{row.form_title}</span>
                            {row.form_code ? (
                              <span className="cell-mono" style={{ marginLeft: 8 }}>
                                {row.form_code}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="cell-mono">
                            {row.form_id != null ? `form #${row.form_id}` : "unattributed"}
                          </span>
                        )}
                      </td>
                      <td data-label="Reason">
                        {reasonLabel(row)}
                        {row.error_code ? (
                          <span className="cell-mono" style={{ marginLeft: 8, color: "var(--text-muted)" }}>
                            {row.error_code}
                          </span>
                        ) : null}
                      </td>
                      <td data-label="Submission">
                        {row.public_id ? (
                          <Link
                            className="link-name cell-mono"
                            to={`/admin/submissions/${row.public_id}`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {row.public_id}
                          </Link>
                        ) : row.replay_of != null ? (
                          <span className="cell-mono">replay of #{row.replay_of}</span>
                        ) : (
                          <span className="cell-mono">—</span>
                        )}
                      </td>
                      <td data-label="Replay">
                        {/* Row-level replay short-circuits the drawer's
                            `/replay` route (an already-replayed attempt answers
                            409), so it is split into a two-step confirm. */}
                        <button
                          className="badge-button"
                          disabled={blocked !== null || busyId === row.id || replaying}
                          title={blocked ?? "Re-send this stored response through today's rules"}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!blocked) void runReplay(row.id);
                          }}
                        >
                          {busyId === row.id ? "…" : "Replay"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {(canPrev || canNext) && (
          <div className="card-foot" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              className="secondary-button"
              disabled={!canPrev || loading}
              onClick={() => setOffset((o) => Math.max(o - PAGE_SIZE, 0))}
            >
              <ChevronLeft size={14} />
              Newer
            </button>
            <button
              className="secondary-button"
              disabled={!canNext || loading}
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
            >
              Older
              <ChevronRight size={14} />
            </button>
            <div className="spacer" style={{ flex: 1 }} />
            <span className="file-note" style={{ marginTop: 0 }}>
              {retention.rows.toLocaleString()} attempt{retention.rows === 1 ? "" : "s"} stored in total
            </span>
          </div>
        )}
      </div>

      {/* Detail drawer — including the verbatim stored payload, which is the whole
          reason a failed attempt can be replayed at all. */}
      {selected && (
        <div className="drawer-overlay open" onClick={closeDetail}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <h2>Attempt #{selected.id}</h2>
              <button className="icon-button close" onClick={closeDetail} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div className="drawer-body">
              <div className="field-list" style={{ gridTemplateColumns: "1fr", gap: "10px 0" }}>
                <div className="field">
                  <span className="f-label">Result</span>
                  <span>
                    <span className={statusBadgeClass(selected)}>{statusLabel(selected)}</span>
                    <span className="file-note" style={{ marginTop: 0, marginLeft: 8 }}>
                      HTTP {selected.http_status}
                    </span>
                  </span>
                </div>
                <div className="field">
                  <span className="f-label">Received</span>
                  <span>{formatDateTime(selected.received_at)}</span>
                </div>
                <div className="field">
                  <span className="f-label">Form</span>
                  <span>
                    {selected.form_title ?? "—"}
                    {selected.form_code ? ` (${selected.form_code})` : ""}
                  </span>
                </div>
                <div className="field">
                  <span className="f-label">Secret</span>
                  <span>{selected.auth_result}</span>
                </div>
                {selected.error && (
                  <div className="field">
                    <span className="f-label">Server message</span>
                    <span>{selected.error}</span>
                  </div>
                )}
                <div className="field">
                  <span className="f-label">Source IP</span>
                  <span className="cell-mono">{selected.remote_ip ?? "—"}</span>
                </div>
                <div className="field">
                  <span className="f-label">User agent</span>
                  <span className="cell-mono" style={{ wordBreak: "break-all" }}>
                    {selected.user_agent ?? "—"}
                  </span>
                </div>
                {selected.submission_id != null && (
                  <div className="field">
                    <span className="f-label">Submission</span>
                    <Link className="link-name" to={`/admin/submissions/${selected.public_id}`}>
                      {selected.public_id}
                    </Link>
                  </div>
                )}
                {selected.replay_of != null && (
                  <div className="field">
                    <span className="f-label">Replay of</span>
                    <span className="cell-mono">
                      attempt #{selected.replay_of}
                      {selected.replayed_by_name ? ` by ${selected.replayed_by_name}` : ""}
                    </span>
                  </div>
                )}
                <div className="field">
                  <span className="f-label">Payload</span>
                  <span className="cell-mono">
                    {formatBytes(selected.payload_bytes)}
                    {selected.payload_present ? "" : " (not stored)"}
                  </span>
                </div>
              </div>

              <div style={{ marginTop: 18 }}>
                <span className="f-label">Stored payload</span>
                <pre
                  style={{
                    background: "var(--panel-bg)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    padding: 12,
                    fontSize: 12,
                    maxHeight: 320,
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {prettyPayload(selected.payload_raw)}
                </pre>
              </div>

              {replayMessage && (
                <div
                  style={{
                    background: "var(--filled-bg)",
                    border: "1px solid var(--tint-line)",
                    padding: "10px 12px",
                    borderRadius: "var(--radius)",
                    fontSize: 13,
                    marginTop: 14,
                  }}
                >
                  {replayMessage}
                </div>
              )}

              {panelError && (
                <div
                  style={{
                    background: "rgb(255,232,234)",
                    color: "rgb(186,48,64)",
                    padding: "10px 12px",
                    borderRadius: "var(--radius)",
                    fontSize: 13,
                    marginTop: 14,
                  }}
                >
                  {panelError}
                </div>
              )}
            </div>

            <div className="drawer-foot">
              <span className="file-note" style={{ marginTop: 0 }}>
                {replayRefusalNote(selected)}
              </span>
              <div className="spacer" />
              <button className="secondary-button" onClick={closeDetail}>
                Close
              </button>
              <button
                className="primary-button"
                disabled={replayBlockedReason(selected) !== null || replaying}
                title={replayBlockedReason(selected) ?? "Re-send this stored response"}
                onClick={() => void runReplay(selected.id, true)}
              >
                {replaying ? "Replaying..." : "Replay"}
              </button>
            </div>
          </div>
        </div>
      )}

      {detailLoading && !selected && (
        <div className="drawer-overlay open">
          <div className="drawer">
            <div className="drawer-body">
              <div className="loading-state">
                <div className="spinner" /> Loading attempt...
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bulk replay confirmation. Paged to a form because replaying every failed
          attempt in the organization at once is a bigger action than a single
          click should carry. */}
      {bulkOpen && (
        <div className="modal-overlay open" onClick={() => !bulkBusy && setBulkOpen(false)}>
          <div className="modal" style={{ width: "min(480px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Replay failed attempts</h2>
              <button
                className="icon-button close"
                onClick={() => setBulkOpen(false)}
                disabled={bulkBusy}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
                Re-send the {stats.failed} failed attempt{stats.failed === 1 ? "" : "s"} for{" "}
                <strong>{forms.find((f) => String(f.id) === formId)?.title ?? "this form"}</strong> through
                today&apos;s rules?
              </p>
              <p style={{ margin: "10px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
                Attempts that already succeeded, were never stored, or failed schema validation are skipped. Each
                delivery is file-stamped at the moment it arrives, so a recovered submission gets today&apos;s
                timestamp while its school year comes from when the response originally arrived.
              </p>
              {bulkMessage && (
                <p style={{ margin: "10px 0 0", fontSize: 13 }}>{bulkMessage}</p>
              )}
            </div>
            <div className="modal-foot">
              <div className="spacer" />
              <button className="secondary-button" onClick={() => setBulkOpen(false)} disabled={bulkBusy}>
                Close
              </button>
              <button
                className="primary-button"
                onClick={() => void runBulkReplay()}
                disabled={bulkBusy}
              >
                {bulkBusy ? "Replaying..." : "Replay all"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The one-line explanation beside the drawer's Replay button. */
function replayRefusalNote(row: WebhookEventDetail): string {
  const blocked = replayBlockedReason(row);
  if (blocked) return blocked;
  return "Replay re-checks the stored response against today's rules.";
}
