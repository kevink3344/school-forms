import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "./AuthContext";
import type { AccessRequestRow } from "../types";

// -----------------------------------------------------------------------------
// The administrator's access-request notifications
// (docs/plans/access-requests.md §6.6).
//
// ONE source for the bell's badge, the bell's dropdown, and the queue page. Two
// components each fetching `/notifications` is how a badge comes to say 3 above a
// list of 2: every copy has its own refresh path, and a decision updates whichever
// one happened to re-run. Here a decision calls `refresh()` once and every surface
// reading this value is correct.
//
// ★ The value is DERIVED by the server from `form_access` — there is no
// notification row and no read state anywhere. So there is nothing to synchronise
// beyond re-reading the queue, and no "mark as read" to disagree with the queue:
// the only thing that clears a notification is a decision, which is the same act
// that removes it from the queue.
//
// ★ Read at the APPLICATION level, above <Routes>, not inside <AppShell>. AppShell
// is declared once per route, so a provider there would unmount on every
// navigation and reset the badge to zero for a moment on each click.
// -----------------------------------------------------------------------------

/** How many the dropdown lists. Must match the server's default (5) or the
 *  "View all" footer is off by a row. The PAGE does not use this — it reads the
 *  uncapped queue endpoint — so the number is about the bell alone. */
const BELL_LIMIT = 5;

/** The interval for the one case a route change cannot cover: an administrator
 *  sitting on one page while a request arrives. Paused while the tab is hidden. */
const POLL_MS = 60_000;

export interface AccessRequestsValue {
  pending: number;
  requests: AccessRequestRow[];
  /** Re-read the queue. Called after every decision. */
  refresh: () => Promise<void>;
  /** Approve, decline or revoke — then re-read, so both surfaces agree. */
  decide: (input: {
    user_id: number;
    form_id: number;
    decision: "approve" | "decline" | "revoke";
    note?: string | null;
  }) => Promise<void>;
  decideError: string | null;
  clearDecideError: () => void;
}

const AccessRequestsContext = createContext<AccessRequestsValue | undefined>(undefined);

export function AccessRequestsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  const isAdmin = user?.role === "admin";

  const [pending, setPending] = useState(0);
  const [requests, setRequests] = useState<AccessRequestRow[]>([]);
  const [decideError, setDecideError] = useState<string | null>(null);

  // Only the newest response may write state. Two overlapping reads (a route
  // change landing on top of the interval) can resolve out of order, and the older
  // one would then restore a count that has already been superseded.
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await api.getAccessRequestNotifications(BELL_LIMIT);
      if (mine !== seq.current) return;
      setPending(res.pending);
      setRequests(res.requests);
    } catch {
      // ★ Keep the last good numbers rather than blanking the badge. A failed
      // refresh is not evidence that the queue emptied, and a badge that
      // disappears on a network blip teaches the administrator to distrust it.
    }
  }, []);

  const decide = useCallback<AccessRequestsValue["decide"]>(
    async (input) => {
      setDecideError(null);
      try {
        await api.decideFormAccess(input);
      } catch (e) {
        setDecideError(e instanceof Error ? e.message : "That decision could not be saved.");
        throw e;
      } finally {
        // ★ Even a FAILED decision re-reads. A 409 means the row moved under this
        // screen — another administrator approved it, or the requester withdrew —
        // and the correction is the same either way: show the queue as it is.
        // Without this the bell keeps offering Approve on a request that is gone.
        await refresh();
      }
    },
    [refresh]
  );

  const clearDecideError = useCallback(() => setDecideError(null), []);

  // Read on mount and on every route change. Because react-router keeps this
  // provider mounted, `location.pathname` is what carries the "the administrator
  // navigated, so they may want fresh numbers" signal — the per-route remount that
  // would have given it for free does not happen at this level.
  useEffect(() => {
    if (!isAdmin) {
      // Signed out, or signed in as someone who cannot see the queue: clear the
      // numbers rather than leave the last administrator's badge on screen.
      seq.current += 1;
      setPending(0);
      setRequests([]);
      setDecideError(null);
      return;
    }
    void refresh();
  }, [isAdmin, location.pathname, refresh]);

  useEffect(() => {
    if (!isAdmin) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [isAdmin, refresh]);

  const value = useMemo(
    () => ({ pending, requests, refresh, decide, decideError, clearDecideError }),
    [pending, requests, refresh, decide, decideError, clearDecideError]
  );

  return <AccessRequestsContext.Provider value={value}>{children}</AccessRequestsContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAccessRequests(): AccessRequestsValue {
  const ctx = useContext(AccessRequestsContext);
  if (!ctx) throw new Error("useAccessRequests must be used within an AccessRequestsProvider");
  return ctx;
}
