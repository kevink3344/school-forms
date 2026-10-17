import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useAccessRequests } from "../context/AccessRequestsContext";
import type { AccessRequestRow } from "../types";

// -----------------------------------------------------------------------------
// The administrator's notification bell
// (docs/plans/access-requests.md §5).
//
// What "a notification for administrators when someone requests access" is, in
// this app: the bell IS the pending queue, projected. The server derives both the
// badge and the list from the same `form_access` rows (see
// `GET /api/form-access/notifications`), so the alert can never point at a request
// that has already been decided — the failure mode a stored notification has and
// an approval button cannot survive.
//
// ★ ADMIN ONLY, and NOT gated by the `menu_items` setting — deliberately. Every
// other link in the sidebar can be switched off by role, because hiding a link
// costs the role a convenience. Hiding THIS would hide the only signal that work
// is waiting, which is the defect the feature exists to fix. The Access Requests
// *page* is a `menu_items` item; the bell is not.
// -----------------------------------------------------------------------------

/** A compact age, the conventional thing a bell shows: exact timestamps belong on
 *  the page, where there is room to read one. */
function shortAge(value: Date | string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function rowKey(row: AccessRequestRow): string {
  return `${row.user_id}:${row.form_id}`;
}

export function NotificationBell() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { pending, requests, decide, decideError, clearDecideError } = useAccessRequests();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [declineFor, setDeclineFor] = useState<string | null>(null);
  const [declineNote, setDeclineNote] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const isAdmin = user?.role === "admin";

  // Close on a route change, so a deep link clicked from the dropdown does not
  // leave the panel open over the page it navigated to.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // Outside click closes. `mousedown` rather than `click` so the panel is gone
  // before the click resolves on whatever was underneath it — the same reasoning
  // as the account menu in lib/layout.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Forgetting a half-typed decline reason when the panel closes, and clearing the
  // last failure, so reopening never shows a stale message about a different row.
  useEffect(() => {
    if (open) return;
    setDeclineFor(null);
    setDeclineNote("");
    clearDecideError();
  }, [open, clearDecideError]);

  const onDecide = async (row: AccessRequestRow, decision: "approve" | "decline") => {
    const key = rowKey(row);
    setBusy(key);
    try {
      await decide({
        user_id: row.user_id,
        form_id: row.form_id,
        decision,
        // A reason on an approval would be read as a condition of the grant; the
        // requester sees this text, so it is only collected where it means
        // something.
        note: decision === "decline" ? declineNote.trim() || null : null,
      });
      setDeclineFor(null);
      setDeclineNote("");
    } catch {
      // `decide` has already re-read the queue and recorded the message; the row
      // is either gone or still there and correct. Nothing to do but stay put.
    } finally {
      setBusy(null);
    }
  };

  if (!isAdmin) return null;

  const goToRequest = (row: AccessRequestRow) => {
    setOpen(false);
    navigate(`/admin/access-requests?user_id=${row.user_id}&form_id=${row.form_id}`);
  };

  return (
    <div className="notif-wrap" ref={wrapRef}>
      <button
        type="button"
        className="icon-button notif-button"
        // Not `aria-haspopup="menu"`: the panel holds a text input, and a menu's
        // children must be menuitems — announcing it as a menu would promise a
        // keyboard model it does not have.
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="notif-panel"
        // The count is in the accessible name, which is what makes it reachable
        // without the bubble. ★ The badge carries no `aria-live`: a region that
        // announced every refresh would re-announce the same number every minute.
        aria-label={
          pending > 0 ? `Access requests, ${pending} waiting` : "Access requests, none waiting"
        }
        title="Access requests"
        onClick={() => setOpen((o) => !o)}
      >
        <Bell size={18} />
        {/* ★ Nothing at zero. A "0" bubble is a permanent object on a screen whose
            whole message is "there is nothing here", and it is the state most
            installations are in most of the time. Capped at 99+ so a backlog
            cannot widen the banner. */}
        {pending > 0 && <span className="notif-badge">{pending > 99 ? "99+" : pending}</span>}
      </button>

      {open && (
        <div className="notif-panel" id="notif-panel">
          <div className="notif-head">
            <span className="notif-title">Access requests</span>
            {pending > 0 && <span className="notif-count">{pending} waiting</span>}
          </div>

          {decideError && (
            <p className="notif-error" role="alert">
              {decideError}
            </p>
          )}

          {requests.length === 0 ? (
            <p className="notif-empty">No requests are waiting.</p>
          ) : (
            <ul className="notif-list">
              {requests.map((row) => {
                const key = rowKey(row);
                const rowBusy = busy === key;
                return (
                  <li key={key} className="notif-item">
                    <div className="ni-top">
                      <span className="ni-who">
                        {row.user_name ?? row.user_email ?? `User #${row.user_id}`}
                      </span>
                      <span className="ni-when">{shortAge(row.requested_at)}</span>
                    </div>
                    {/* The form is the link to the item: the reviewer can see which
                        form before deciding, and open the queue positioned on this
                        request if they would rather read the history first. */}
                    <button type="button" className="ni-form" onClick={() => goToRequest(row)}>
                      <span className="ni-form-id">#{row.form_id}</span>
                      <span className="ni-form-title">{row.form_title ?? "Untitled form"}</span>
                    </button>

                    {declineFor === key ? (
                      <div className="ni-decline">
                        <input
                          className="edit-input"
                          placeholder="Reason (shown to the requester)"
                          aria-label="Reason for declining"
                          value={declineNote}
                          onChange={(e) => setDeclineNote(e.target.value)}
                        />
                        <div className="ni-actions">
                          <button
                            type="button"
                            className="badge-button danger"
                            disabled={rowBusy}
                            onClick={() => void onDecide(row, "decline")}
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
                      <div className="ni-actions">
                        <button
                          type="button"
                          className="badge-button"
                          disabled={rowBusy}
                          onClick={() => void onDecide(row, "approve")}
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
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* ★ Always present, including at zero, so the page is reachable from the
              bell even when there is nothing to triage — and it is the honest
              answer when `pending` exceeds the rows shown, which is the only case
              where the list is a window onto a longer queue. */}
          <button
            type="button"
            className="notif-viewall"
            onClick={() => {
              setOpen(false);
              navigate("/admin/access-requests");
            }}
          >
            {pending > requests.length ? "View all requests →" : "Open access requests →"}
          </button>
        </div>
      )}
    </div>
  );
}
