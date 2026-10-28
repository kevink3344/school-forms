import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { PageHead } from "../../components/layout";
import { api } from "../../lib/api";
import { useAccessRequests } from "../../context/AccessRequestsContext";
import type { AccessGrantRow, AccessRequestRow } from "../../types";

// -----------------------------------------------------------------------------
// Access Requests — the queue for private forms
// (docs/plans/access-requests.md §6).
//
// ★ This page is where an access request is ANSWERED. The bell in the banner is
// the same queue, projected down to the newest few with inline Approve/Decline,
// and both read one server-derived value — so a decision taken in either place is
// reflected in the other with no reload and no second source of truth.
//
// ★ The per-form access list moved here from Settings, with the queue it belongs
// to. Settings keeps a one-line link, because the grant list is only meaningful
// next to the request that produced it (and because two copies of a triage table
// is two places to fix when the triage rule changes).
// -----------------------------------------------------------------------------

type Tab = "pending" | "approved" | "denied" | "all";

const TABS: { key: Tab; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "denied", label: "Denied" },
  { key: "all", label: "All" },
];

// One empty state per tab. "Nothing has been declined yet" and "No requests are
// waiting" are different facts, and the reader is looking at a specific tab to
// find out which one holds.
const EMPTY: Record<Tab, string> = {
  pending: "No requests are waiting.",
  approved: "Nothing has been approved yet.",
  denied: "Nothing has been declined yet.",
  all: "No requests yet.",
};

const STATUS_BADGE: Record<AccessRequestRow["status"], string> = {
  pending: "badge-blue",
  approved: "badge-green",
  denied: "badge-gray",
};

function rowKey(row: AccessRequestRow): string {
  return `${row.user_id}:${row.form_id}`;
}

function day(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

export default function AccessRequests() {
  const { refresh: refreshBell, decide, decideError, clearDecideError } = useAccessRequests();
  const [params, setParams] = useSearchParams();

  const [tab, setTab] = useState<Tab>("pending");
  const [rows, setRows] = useState<AccessRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [declineFor, setDeclineFor] = useState<string | null>(null);
  const [declineNote, setDeclineNote] = useState("");

  // The per-form access list, with a Revoke per row and each account's history.
  // A revoke control needs a list to act on, and the HISTORY is what makes
  // "declined" and "access removed" distinguishable afterwards — `denied` is the
  // state both produce (docs/plans/public-private-forms.md §15 Q6/Q7).
  const [grantsFormId, setGrantsFormId] = useState<number | null>(null);
  const [grants, setGrants] = useState<AccessGrantRow[]>([]);
  const [grantsBusy, setGrantsBusy] = useState(false);

  // The row a deep link from the bell points at, held in state rather than
  // written straight onto the DOM so React owns the class list.
  const [flashKey, setFlashKey] = useState<string | null>(null);

  const load = useCallback(async (which: Tab) => {
    setLoading(true);
    setError(null);
    try {
      if (which === "all") {
        // "All" is three reads of the SAME endpoint merged, not a fourth route:
        // `status` is what the server already offers, and a second endpoint with
        // its own idea of "all" is a second place for the tabs to disagree about
        // what a row's status is.
        const [pending, approved, denied] = await Promise.all([
          api.listAccessRequests("pending"),
          api.listAccessRequests("approved"),
          api.listAccessRequests("denied"),
        ]);
        setRows(
          [...pending, ...approved, ...denied].sort(
            (a, b) => new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime()
          )
        );
      } else {
        setRows(await api.listAccessRequests(which));
      }
    } catch (e) {
      setRows([]);
      setError(e instanceof Error ? e.message : "Could not load access requests.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(tab);
  }, [load, tab]);

  // --- Deep link: /admin/access-requests?user_id=9&form_id=2 ------------------
  //
  // ★ The bell lists the PENDING queue, so arriving with these parameters always
  // means "show me the one that is waiting" — whatever tab this page was last
  // left on. Without this an administrator who last looked at Denied would land
  // on a page that does not contain the row they clicked.
  const userId = params.get("user_id");
  const formId = params.get("form_id");
  const focusKey = userId && formId ? `${userId}:${formId}` : null;
  const focusId = userId && formId ? `req-${userId}-${formId}` : null;
  const focused = useRef<string | null>(null);

  useEffect(() => {
    if (focusKey) setTab("pending");
  }, [focusKey]);

  useEffect(() => {
    if (!focusId || focusKey === null || loading) return;
    // Once per key: a later re-read (the 60-second bell poll, a decision) must not
    // scroll the page out from under whatever the reviewer is reading.
    if (focused.current === focusKey) return;
    const el = document.getElementById(focusId);
    if (!el) return;
    focused.current = focusKey;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlashKey(focusKey);
    const t = window.setTimeout(() => setFlashKey(null), 2400);
    return () => window.clearTimeout(t);
  }, [focusId, focusKey, loading, rows]);

  // ★ A deep link that no longer resolves must SAY so. It cannot silently no-op:
  // "nothing happened" and "nothing was there" are indistinguishable, and the
  // reviewer would reasonably conclude the page is broken rather than that
  // someone else answered the request a minute ago.
  const focusMissing =
    focusKey !== null && !loading && !rows.some((r) => rowKey(r) === focusKey);

  // Takes the pair rather than a row, because a revoke acts on a grant row and a
  // decision acts on a request row — the endpoint only ever wanted the two ids.
  const onDecide = async (
    target: { user_id: number; form_id: number },
    decision: "approve" | "decline" | "revoke"
  ) => {
    const key = `${target.user_id}:${target.form_id}`;
    setBusy(key);
    try {
      await decide({
        user_id: target.user_id,
        form_id: target.form_id,
        decision,
        note: decision === "decline" ? declineNote.trim() || null : null,
      });
      setDeclineFor(null);
      setDeclineNote("");
      // The row has left the `pending` set, so the tab has to be re-read — the
      // context refreshed the COUNT, this refreshes the LIST.
      await load(tab);
      if (grantsFormId !== null) await loadGrants(grantsFormId);
    } catch {
      // `decide` recorded the message and re-read the queue; re-loading the tab
      // here as well is what removes a row another administrator already decided.
      await load(tab);
    } finally {
      setBusy(null);
    }
  };

  async function loadGrants(forForm: number) {
    setGrantsBusy(true);
    try {
      setGrants(await api.listAccessGrants(forForm));
    } catch {
      setGrants([]);
    } finally {
      setGrantsBusy(false);
    }
  }

  const toggleGrants = async (forForm: number) => {
    clearDecideError();
    if (grantsFormId === forForm) {
      setGrantsFormId(null);
      return;
    }
    setGrantsFormId(forForm);
    setGrants([]);
    await loadGrants(forForm);
  };

  const setTabAndClearFocus = (next: Tab) => {
    setTab(next);
    if (focusKey) {
      // Leaving the tab the deep link pointed at: drop the parameters so the
      // "no longer waiting" notice does not follow the reviewer around, and so a
      // refresh does not snap them back to Pending.
      const remaining = new URLSearchParams(params);
      remaining.delete("user_id");
      remaining.delete("form_id");
      setParams(remaining, { replace: true });
    }
  };

  return (
    <div>
      <PageHead
        title="Access Requests"
        subtitle="Who has asked to read a private form, and who holds a grant. Approving is the only thing that grants access."
        actions={
          <button
            className="secondary-button"
            onClick={() => {
              void load(tab);
              void refreshBell();
            }}
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        }
      />

      <div className="view-toggle" style={{ marginBottom: 14 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={tab === t.key ? "active" : undefined}
            aria-pressed={tab === t.key}
            onClick={() => setTabAndClearFocus(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {(error || decideError) && (
        <div className="alert-error" role="alert" style={{ marginBottom: 14 }}>
          {error ?? decideError}
        </div>
      )}

      {focusMissing && tab === "pending" && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-body" style={{ fontSize: "0.8125rem" }}>
            That request is no longer waiting — it was approved, declined, or withdrawn by the person who
            asked.{" "}
            <button
              type="button"
              className="badge-button"
              onClick={() => setTabAndClearFocus("all")}
            >
              Show all requests
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <table className="grid">
          <thead>
            <tr>
              <th>Requester</th>
              <th>Form</th>
              <th>Requested</th>
              <th>Status</th>
              <th>Note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: 24 }}>
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: 24 }}>
                  {EMPTY[tab]}
                  {tab === "pending" && (
                    <div className="muted-note" style={{ marginTop: 6 }}>
                      Requests appear here when someone asks for access to a private form from{" "}
                      <Link to="/staff/forms">Available Forms</Link>.
                    </div>
                  )}
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const key = rowKey(r);
                const rowBusy = busy === key;
                return (
                  <tr key={key} id={`req-${r.user_id}-${r.form_id}`} className={flashKey === key ? "row-flash" : undefined}>
                    <td data-label="Requester">
                      <div className="cell-strong">{r.user_name ?? `User ${r.user_id}`}</div>
                      <div className="cell-sub">
                        {r.user_email}
                        {r.school_name ? ` · ${r.school_name}` : ""}
                      </div>
                    </td>
                    <td data-label="Form">
                      <div className="cell-strong">
                        <span className="ni-form-id">#{r.form_id}</span> {r.form_title ?? "Untitled form"}
                      </div>
                      <button type="button" className="badge-button" onClick={() => void toggleGrants(r.form_id)}>
                        {grantsFormId === r.form_id ? "Hide access list" : "Who has access?"}
                      </button>
                    </td>
                    <td data-label="Requested" className="cell-mono">
                      {day(r.requested_at)}
                    </td>
                    <td data-label="Status">
                      <span className={`badge ${STATUS_BADGE[r.status]}`}>{r.status}</span>
                      {/* ★ Names the DECIDER, not the action. "Approved by Ada" is
                          the sentence an administrator is asked for after the fact,
                          and it is the one fact the badge cannot carry. The date is
                          the decision date — the same `decided_at` the row is
                          stamped with in the same transaction as `decided_by`. */}
                      {r.decided_at && (
                        <div className="cell-sub">
                          {r.status === "pending"
                            ? `Decided ${day(r.decided_at)}`
                            : `By ${r.decided_by_name ?? "an administrator"} on ${day(r.decided_at)}`}
                        </div>
                      )}
                    </td>
                    <td data-label="Note">
                      {r.note ? <span className="cell-sub">“{r.note}”</span> : <span className="muted-note">—</span>}
                    </td>
                    <td>
                      {r.status === "pending" &&
                        (declineFor === key ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            <input
                              className="edit-input"
                              placeholder="Reason (shown to the requester)"
                              aria-label="Reason for declining"
                              value={declineNote}
                              onChange={(e) => setDeclineNote(e.target.value)}
                            />
                            <div style={{ display: "flex", gap: 6 }}>
                              <button
                                type="button"
                                className="badge-button danger"
                                disabled={rowBusy}
                                onClick={() => void onDecide(r, "decline")}
                              >
                                {rowBusy ? "Saving…" : "Confirm decline"}
                              </button>
                              <button
                                type="button"
                                className="badge-button"
                                disabled={rowBusy}
                                onClick={() => {
                                  setDeclineFor(null);
                                  setDeclineNote("");
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div style={{ display: "flex", gap: 6 }}>
                            <button
                              type="button"
                              className="badge-button"
                              disabled={rowBusy}
                              onClick={() => void onDecide(r, "approve")}
                            >
                              {rowBusy ? "Saving…" : "Approve"}
                            </button>
                            <button
                              type="button"
                              className="badge-button danger"
                              disabled={rowBusy}
                              onClick={() => {
                                setDeclineFor(key);
                                setDeclineNote("");
                              }}
                            >
                              Decline
                            </button>
                          </div>
                        ))}
                      {r.status === "approved" && (
                        <button
                          type="button"
                          className="badge-button danger"
                          disabled={rowBusy}
                          onClick={() => void onDecide(r, "revoke")}
                        >
                          {rowBusy ? "Saving…" : "Revoke"}
                        </button>
                      )}
                      {/* A denied row (declined or revoked) has no action: asking
                          again is the requester's move, and re-granting is what
                          Approve on their next request is for. */}
                      {r.status === "denied" && <span className="muted-note">—</span>}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {grantsFormId !== null && (
          <div style={{ borderTop: "1px solid var(--border)", padding: 14 }}>
            <h3 className="section-title">
              #{grantsFormId} — who can read this form
            </h3>
            {grantsBusy ? (
              <p className="empty-note">Loading…</p>
            ) : grants.length === 0 ? (
              <p className="empty-note">Nobody holds a grant on this form.</p>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Status</th>
                    <th>History</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {grants.map((g) => (
                    <tr key={g.user_id}>
                      <td data-label="Account">
                        <div className="cell-strong">{g.user_name ?? `User ${g.user_id}`}</div>
                        <div className="cell-sub">{g.user_email}</div>
                      </td>
                      <td data-label="Status">
                        <span
                          className={`badge ${
                            g.status === "approved"
                              ? "badge-green"
                              : g.status === "pending"
                                ? "badge-blue"
                                : "badge-gray"
                          }`}
                        >
                          {g.status ?? "no row"}
                        </span>
                        {g.source === "backfill" && (
                          <div className="cell-sub">Grandfathered when the form went private</div>
                        )}
                      </td>
                      <td data-label="History">
                        <ul className="event-list">
                          {g.events.map((e) => (
                            <li key={e.id}>
                              <span className="cell-mono">{e.event}</span> {day(e.created_at)}
                              {e.actor_name ? ` by ${e.actor_name}` : ""}
                              {e.note ? ` — “${e.note}”` : ""}
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td>
                        {g.status === "approved" && (
                          <button
                            type="button"
                            className="badge-button danger"
                            disabled={busy === `${g.user_id}:${grantsFormId}`}
                            onClick={() => void onDecide({ user_id: g.user_id, form_id: grantsFormId }, "revoke")}
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
