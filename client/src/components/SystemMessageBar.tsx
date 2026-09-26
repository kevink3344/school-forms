import { useCallback, useEffect, useState } from "react";
import { Megaphone, X } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { audienceLabel } from "../lib/settings";
import { useAuth } from "../context/AuthContext";
import type { SystemMessage } from "../types";

/**
 * The last successful response, per user, held at MODULE scope.
 *
 * App.tsx renders `<AppShell>` inside every authenticated route element, so
 * whether React preserves this component across a navigation or unmounts and
 * re-creates it is a reconciliation detail that must not show up as a visual
 * difference. With the cached list as the initial state the strip is painted from
 * the first frame on every page, instead of disappearing and re-appearing on each
 * change of page, and a navigation costs no request.
 *
 * Keyed by user id rather than cleared on logout: this app supports signing out
 * and back in as someone else (select-mode login), and a second user must never
 * be shown the first user's leftover list — not even for the moment before the
 * refresh lands. Keying is cheaper than remembering to clear a module variable
 * from the auth context.
 *
 * It is a cache, not a source of truth: every mount still refreshes, and a failed
 * refresh settles to an empty list rather than to stale rows.
 */
let cached: { userId: string; rows: SystemMessage[] } | null = null;

/** The mounted strips, if any, so a mutation elsewhere can tell them to re-read. */
const listeners = new Set<() => void>();

/**
 * Drop the cache and ask every mounted strip to re-read its list. Call this after
 * ANY change to the messages themselves — create, edit, activate, deactivate,
 * delete, or an audience change.
 *
 * It exists because the strip caches: without it, an admin who posts a message in
 * Settings and then navigates to another page would not see it until a hard
 * reload, which reads as "saving did nothing". Settings calls this from its
 * message loader, so every path that changes the data goes through one line
 * rather than each mutation having to remember.
 *
 * Safe to call when no strip is mounted (the cache simply stays empty and the next
 * mount fetches), and safe to call twice in a row.
 */
export function refreshSystemMessages(): void {
  cached = null;
  for (const fn of Array.from(listeners)) fn();
}

/**
 * The System Messages strip — administrative notices shown at the top of every
 * page until the signed-in user closes each one out.
 *
 * WHERE IT RENDERS, AND WHY IT IS INSIDE <main>
 * ---------------------------------------------
 * components/layout.tsx mounts this immediately inside <main>, not between the
 * banner and the body row. That is deliberate and not a style preference:
 * `.sidebar` and `.sidebar-overlay` are `position: fixed` with
 * `top: var(--banner-h)`, so flow content placed above `.body-flex` occupies
 * space those two fixed elements cannot see, and the open drawer would be drawn
 * over the notice instead of beside it. Inside <main> the strip is ordinary flow
 * content and needs no height coordination with either fixed element.
 *
 * It is also absent on the forced-password screen, because that route is
 * deliberately rendered outside <AppShell> (see App.tsx) — there is no shell
 * there to put a strip in, and a notice competing with a mandatory password
 * change is not a notice anyone can act on.
 *
 * WHAT IS RENDERED IS THE SERVER'S ANSWER
 * ---------------------------------------
 * This component renders exactly what `/api/system-messages/active` returns. All
 * three things that narrow that list — the message is active, the viewer's role
 * is in its audience, and this user has not already closed it — are decided by
 * the server, inside the same statement that applies the three-row cap.
 *
 * Do NOT slice the array here. `rows.slice(0, 3)` in this component would look
 * identical to the server cap and would silently deny the existence of a message
 * the user is entitled to see — the same defect as filtering a list after
 * truncating it. If the strip must ever show fewer, change the cap in
 * `listActiveSystemMessagesForUser`, where the audience filter lives.
 *
 * Closing a message out is a per-user, one-way action: the dismissal is recorded
 * against this user alone and an admin cannot restore it for them, so the X has
 * no confirmation step. Undoing it means posting a new message.
 */
export function SystemMessageBar() {
  const { user } = useAuth();

  // Identity only — never compared for anything but equality, so the difference
  // between a number id and a string id is irrelevant here. `String()` on both
  // sides of the cache lookup keeps it that way.
  const userId = user ? String(user.id) : "";

  // `null` means "not answered yet". It renders identically to an empty list, so
  // there is no loading state to get wrong — but the distinction is kept because
  // it is what lets the module cache above be the initial value without a stale
  // list ever being displayed as if it were fresh.
  const [messages, setMessages] = useState<SystemMessage[] | null>(() =>
    cached && cached.userId === userId ? cached.rows : null
  );
  const [busyId, setBusyId] = useState<number | null>(null);
  const [dismissError, setDismissError] = useState<{ id: number; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Cancelling on unmount and on a change of user matters more here than in an
    // ordinary fetch effect: a response that lands after the signed-in user has
    // changed would otherwise write the previous user's list into both the state
    // and the cache, and the strip would show someone else's notices.
    const run = async () => {
      try {
        const rows = await api.listActiveSystemMessages();
        if (cancelled) return;
        setMessages(rows);
        cached = { userId, rows };
      } catch {
        // Deliberately silent. A notice strip that cannot load is not worth an
        // error banner of its own, and rendering one would put an unclosable
        // notice above every page for the rest of the session. Leaving the strip
        // off the screen claims nothing and the next load retries. Settling to an
        // empty list (rather than staying `null`) also stops a cached list from
        // surviving a failed refresh indefinitely.
        if (!cancelled) setMessages((cur) => cur ?? []);
      }
    };

    void run();
    // Subscribed so `refreshSystemMessages()` (called by Settings after a
    // message is created, edited, activated or deleted) re-reads this list
    // without a page reload.
    const onRefresh = () => void run();
    listeners.add(onRefresh);
    return () => {
      cancelled = true;
      listeners.delete(onRefresh);
    };
  }, [userId]);

  const dismiss = useCallback(async (id: number) => {
    setBusyId(id);
    setDismissError(null);
    try {
      await api.dismissSystemMessage(id);
    } catch (err) {
      // A 404 means the message itself is gone — an admin deleted it while it
      // was on this user's screen. Closing it out is moot, and refusing to
      // remove it would leave a notice the user has no way to clear, so a 404 is
      // treated as the outcome the user asked for rather than as a failure.
      const alreadyGone = err instanceof ApiError && err.status === 404;
      if (!alreadyGone) {
        setDismissError({
          id,
          text: err instanceof ApiError ? err.message : "Could not close this message.",
        });
        setBusyId(null);
        return;
      }
    }
    // Remove only once the server has recorded the dismissal. Removing first
    // would look faster and would put the notice back on the next page load
    // whenever the call failed, which reads as "the X did not work".
    setMessages((cur) => {
      const next = (cur ?? []).filter((m) => m.id !== id);
      if (cached) cached = { ...cached, rows: next };
      return next;
    });
    setBusyId(null);
  }, []);

  if (!messages || messages.length === 0) return null;

  return (
    <section className="sysmsg-stack" aria-label="System messages">
      {messages.map((m) => {
        // Read once per message rather than three times in the markup below: the
        // same string is the visible text, the tooltip and the accessible name,
        // and computing it in one place is what keeps those three from drifting
        // apart.
        const audience = audienceLabel(m.audience);
        return (
          <article className="sysmsg" key={m.id}>
            <span className="sysmsg-icon" aria-hidden="true">
              <Megaphone size={16} />
            </span>
            <div className="sysmsg-text">
              <h2 className="sysmsg-title">{m.title}</h2>
              {/* An empty description is a real state — the server defaults `body`
                  to "" and the admin form allows it — so the paragraph is omitted
                  rather than rendered as an empty line. */}
              {m.body.trim() !== "" && <p className="sysmsg-body">{m.body}</p>}
              {/* Who the notice was addressed to.

                  This is not a permission check and must not be read as one: the
                  server only returns messages whose audience includes this user's
                  role, so whatever renders here already reaches the reader. Its
                  job is the one thing the card cannot otherwise convey — whether
                  a notice went to everyone or to a narrower group.

                  "Everyone" is rendered like any other value rather than hidden as
                  redundant. For a notice, "this went to everybody" is information;
                  hiding it would leave the reader unable to tell it apart from a
                  message aimed at their own role. */}
              <div className="sysmsg-meta">
                <span
                  className="badge sysmsg-audience"
                  title={`Audience: ${audience}`}
                  aria-label={`Audience: ${audience}`}
                >
                  {audience}
                </span>
              </div>
              {dismissError?.id === m.id && (
                <p className="sysmsg-error" role="alert">
                  {dismissError.text}
                </p>
              )}
            </div>
            <button
              type="button"
              className="icon-button sysmsg-close"
              // The accessible name and the tooltip both name the message. Several
              // of these buttons are on screen at once and they are visually
              // identical, so "Close" alone would give a screen reader three
              // indistinguishable controls — and an icon-only button has no text
              // content to fall back on.
              title={`Close "${m.title}"`}
              aria-label={`Close "${m.title}"`}
              disabled={busyId === m.id}
              onClick={() => void dismiss(m.id)}
            >
              <X size={16} />
            </button>
          </article>
        );
      })}
    </section>
  );
}
