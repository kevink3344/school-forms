import { useEffect, useRef } from "react";
import { Check, X } from "lucide-react";

/**
 * A transient confirmation, pinned to the viewport instead of the page flow.
 *
 * WHY THIS EXISTS ALONGSIDE THE INLINE ALERT
 * ------------------------------------------
 * Settings already renders an `.alert-success` banner just under the page head,
 * and for most of its actions that is the right place for the message. Saving a
 * USER is the exception, and not because of anything to do with the message: it
 * is about where the admin is standing when they cause it. The Users grid runs to
 * 44 rows, so reaching a particular account means scrolling well past the banner.
 * The old "User updated." text was therefore painted above the fold, off screen,
 * at the exact moment it mattered — which reads as "the save did nothing", the
 * same failure mode a silently swallowed click has. Anchoring the confirmation to
 * the viewport puts it in front of the admin wherever they made the save from.
 *
 * It also REPLACES the banner message for that action rather than adding to it.
 * Two success notices for one save are worse than one in the wrong place, so the
 * caller clears the banner and shows this.
 *
 * WHY THE CALLER PASSES A `key`
 * -----------------------------
 * Saving twice in a row produces the same message text, and React would
 * reconcile that as "nothing changed": the node stays, the dismiss timer is not
 * restarted, and a live region whose content did not change is not re-announced.
 * Mounting this with a fresh `key` per notification forces a remount, which
 * restarts the timer and hands the live region a genuinely new insertion to
 * announce. Without it a second confirmation is missed by the eye and by a
 * screen reader alike.
 *
 * ACCESSIBILITY
 * -------------
 * `role="status"` is a polite live region, matching the convention the
 * `.alert-success` banner already uses, so the announcement is the sentence
 * alone — the tick is decorative and hidden from the accessibility tree. The
 * dismiss button carries a real label, because an icon-only button has an empty
 * text content and is reachable only by its accessible name.
 */
export function Toast({
  message,
  onDismiss,
  durationMs = 4000,
}: {
  message: string;
  onDismiss: () => void;
  durationMs?: number;
}) {
  // Held in a ref rather than closed over directly, so the timer effect does not
  // depend on the identity of the callback. A parent that re-renders for an
  // unrelated reason would otherwise clear and restart this timeout, and a toast
  // on a busy page would keep being pushed out of reach and never dismiss.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    const timer = window.setTimeout(() => dismissRef.current(), durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs]);

  return (
    <div className="toast" role="status">
      <Check className="toast__icon" size={16} aria-hidden="true" />
      <span className="toast__text">{message}</span>
      <button
        type="button"
        className="toast__close"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        title="Dismiss notification"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
