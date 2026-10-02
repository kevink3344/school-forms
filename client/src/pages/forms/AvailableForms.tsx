import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check, FileText, Lock, Send, Clock } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { PageHead } from "../../components/layout";
import { useAuth } from "../../context/AuthContext";
import type { AvailableForm } from "../../types";

// ---------------------------------------------------------------------------
// Available Forms — every published form in the organization, grouped by the
// caller's relationship to it (docs/plans/public-private-forms.md §16).
//
// ★ WHY THIS PAGE EXISTS: the locked panel (§10.1) was originally reachable only
// from the zero-forms empty state. With more than one published form, a refused
// School Contact still has a working queue, so the panel never rendered and the
// request workflow was UNREACHABLE for the person it was built for. An
// affordance that lives only inside an empty state disappears the moment the
// state is not empty — a locked form is a ROW, and a row needs a list.
//
// ★ This page is a VIEW, not a permission system. It renders `access` from the
// payload and never tests `visibility` itself: that would be a second
// implementation of the rule, and the two would disagree.
// ---------------------------------------------------------------------------

type Group = "mine" | "requestable" | "requested";

function groupOf(f: AvailableForm): Group {
  if (f.access === "granted") return "mine";
  // ★ A `denied` row is REQUESTABLE, not parked. Access that was removed (or a
  // request that was declined) must leave the person able to ask again — which is
  // what the admin's Edit User drawer promises when it says the account will see
  // the form under "Available to request".
  if (f.access === "none" || f.access === "denied") return "requestable";
  return "requested"; // pending
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export default function AvailableForms() {
  const { user } = useAuth();
  const [forms, setForms] = useState<AvailableForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setForms(await api.listAvailableForms());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The request did not reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ★ Re-read from the response rather than moving the row optimistically: the
  // API refuses a declined row and a form that is already public, so a row that
  // moved on a refusal would be a lie.
  const act = async (form: AvailableForm, fn: () => Promise<unknown>) => {
    setBusyId(form.id);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The request did not reach the server.");
    } finally {
      setBusyId(null);
    }
  };

  const groups: Record<Group, AvailableForm[]> = { mine: [], requestable: [], requested: [] };
  for (const f of forms) groups[groupOf(f)].push(f);

  // The queue/report a form opens into depends on the role, matching the nav.
  const queueHref = user?.role === "admin" ? "/admin" : "/staff";

  return (
    <>
      <PageHead
        title="Available Forms"
        subtitle="Every form in your organization, and which ones you can open."
      />

      {error && (
        <div className="alert-error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className="card empty-state">Loading forms…</div>
      ) : (
        <>
          <section className="card">
            <div className="card-head">
              <h3>
                <Check size={16} /> My forms ({groups.mine.length})
              </h3>
            </div>
            <div className="card-body">
            {groups.mine.length === 0 ? (
              // Per-group empty state, not a page-level one: "My forms" is never
              // empty for a staff or admin account, so a page-level state would
              // be unreachable.
              <p className="empty-note">You do not have access to any form yet.</p>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>Form</th>
                    <th>Access</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {groups.mine.map((f) => (
                    <tr key={f.id}>
                      <td data-label="Form">
                        <span className="cell-strong">
                          #{f.id} {f.title}
                        </span>
                        {f.description && <div className="cell-sub">{f.description}</div>}
                      </td>
                      <td data-label="Access">
                        <span className="badge badge-green">
                          {f.reason === "public" ? "Public" : f.reason === "role" ? "Your role" : "Granted"}
                        </span>
                      </td>
                      <td>
                        <Link className="badge-button" to={`${queueHref}?form_id=${f.id}`}>
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>
                <Lock size={16} /> Available to request ({groups.requestable.length})
              </h3>
            </div>
            <div className="card-body">
            {groups.requestable.length === 0 ? (
              <p className="empty-note">You have access to every form.</p>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>Form</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {groups.requestable.map((f) => (
                    <tr key={f.id}>
                      <td data-label="Form">
                        <span className="cell-strong">
                          #{f.id} {f.title}
                        </span>
                        {f.description && <div className="cell-sub">{f.description}</div>}
                        {/* A previous decision is stated, not hidden — the person
                            asked once and deserves to know what happened. */}
                        {f.access === "denied" && (
                          <div className="cell-sub">
                            {f.last_event === "revoked" ? "Access was removed" : "Declined"}
                            {f.decided_at ? ` ${fmtDate(f.decided_at)}` : ""}
                            {f.note ? ` — “${f.note}”` : ""}
                          </div>
                        )}
                      </td>
                      <td>
                        {/* A BUTTON, not a link: there is no page behind a locked
                            form to open, and a link to a 403 reads as broken. */}
                        <button
                          type="button"
                          className="primary-button"
                          disabled={busyId === f.id}
                          onClick={() => act(f, () => api.requestFormAccess(f.id))}
                        >
                          <Send size={14} /> Request access
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>
                <Clock size={16} /> Requested ({groups.requested.length})
              </h3>
            </div>
            <div className="card-body">
            {groups.requested.length === 0 ? (
              <p className="empty-note">You have no access requests.</p>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>Form</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {groups.requested.map((f) => (
                    <tr key={f.id}>
                      <td data-label="Form">
                        <span className="cell-strong">
                          #{f.id} {f.title}
                        </span>
                      </td>
                      <td data-label="Status">
                        <span className="badge badge-blue">
                          Waiting{f.requested_at ? ` since ${fmtDate(f.requested_at)}` : ""}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busyId === f.id}
                          onClick={() => act(f, () => api.withdrawFormAccess(f.id))}
                        >
                          Withdraw
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            </div>
          </section>

          {forms.length === 0 && (
            <div className="card">
              <div className="card-body empty-state">
                <FileText size={20} />
                <p>There are no published forms in your organization yet.</p>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
