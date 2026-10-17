import { useState } from "react";
import { Lock, Clock, Ban, Send, X } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { AvailableForm } from "../types";

// ---------------------------------------------------------------------------
// The locked state — the three states of "there is something here and you are
// not in it" (docs/plans/public-private-forms.md §10.1).
//
// ★ This panel exists because the alternative is an EMPTY GRID, which says
// "there is nothing here". Those are the same pixels and different facts, and
// only one of them is an invitation.
//
// ★ The `denied` state now offers **Request access again**: a `denied` row IS
// re-requestable (§18), and the administrator decides. That is what makes
// "Remove access" in the Edit User drawer reversible without an admin acting
// first. The earlier "declines are final, so show no control" rule was REVERSED
// on 2026-10-02 — an "Ask again" button that the API refuses was the worse bug.
// ---------------------------------------------------------------------------

function fmtDate(v: string | null | undefined): string {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function LockedFormPanel({
  form,
  onChanged,
  compact = false,
}: {
  form: AvailableForm;
  /** Called after a successful request/withdraw so the caller can re-read. */
  onChanged?: () => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = `#${form.id} ${form.title}`;

  // ★ A REVOKED grant is also `denied`, and the removal is NOT narrated back to
  // the person. It is an administrative act, so the row is presented exactly like
  // a form they never held — the ordinary "ask an administrator" state — with the
  // same Request access button, because a `denied` row is re-requestable (§18).
  // The `revoked` event stays in the audit log, so an administrator reading the
  // history can still tell a refusal from a removal (§18.2). AvailableForms
  // suppresses the same sentence for the same reason; this keeps the two pages
  // from telling the same person different stories about one row.
  const revoked = form.access === "denied" && form.last_event === "revoked";

  // ★ NOT optimistic. The API refuses a `denied` row and a form that is already
  // public, so a row that moved on a refusal would be a lie. Re-render from the
  // response instead.
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  const body = (() => {
    if (form.access === "pending") {
      return (
        <>
          <span className="locked-text">
            Your request for <strong>{label}</strong> was sent
            {form.requested_at ? ` on ${fmtDate(form.requested_at)}` : ""}. An administrator has not
            answered yet.
          </span>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => act(() => api.withdrawFormAccess(form.id))}
          >
            <X size={14} /> Withdraw request
          </button>
        </>
      );
    }
    if (form.access === "denied" && !revoked) {
      return (
        <>
          <span className="locked-text">
            Your request for <strong>{label}</strong> was declined
            {form.decided_at ? ` on ${fmtDate(form.decided_at)}` : ""}.
            {form.note ? <em className="locked-note"> “{form.note}”</em> : null}
          </span>
          {/* ★ A `denied` row IS re-requestable. The person may ask again, and the
              administrator decides — which is what makes removing access in the
              Edit User drawer reversible without an admin having to act first. */}
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => act(() => api.requestFormAccess(form.id))}
          >
            <Send size={14} /> Request access again
          </button>
        </>
      );
    }
    return (
      <>
        <span className="locked-text">
          <strong>{label}</strong> is a private form. Ask an administrator for access.
        </span>
        <button
          type="button"
          className="primary-button"
          disabled={busy}
          onClick={() => act(() => api.requestFormAccess(form.id))}
        >
          <Send size={14} /> Request access
        </button>
      </>
    );
  })();

  const Icon =
    form.access === "pending" ? Clock : form.access === "denied" && !revoked ? Ban : Lock;

  return (
    <div className={`locked-panel${compact ? " locked-panel--compact" : ""}`}>
      <Icon size={16} className="locked-icon" aria-hidden="true" />
      <div className="locked-body">
        {body}
        {error && (
          <div className="locked-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
