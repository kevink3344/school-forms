import { useEffect } from "react";

/**
 * Lock the page behind an overlay while it is open.
 *
 * A drawer or modal is `position: fixed`, but the page underneath it is still a
 * full-length document — so the browser keeps showing that page's scrollbar down
 * the far right, and the wheel scrolls content the user cannot see. With the
 * overlay open there is exactly one thing to scroll (the drawer's own body), and
 * this is what says so.
 *
 * ★ BOTH `<html>` and `<body>` are locked, and that is not belt-and-braces. The
 * app's scroll container is the DOCUMENT ELEMENT, not `<body>`: `body` here is
 * only `min-height: 100%`, so its own box never overflows and `body { overflow:
 * hidden }` leaves the page scrolling exactly as before — measured, the page
 * still scrolled 200px with the lock applied. `<html>` is the element that
 * actually carries the scrollbar, so it is the one that must be stopped.
 *
 * ★ The previous values are SAVED and restored, not reset to "". The admin
 * sidebar (`components/layout.tsx`) uses the same property for its own lock, so
 * two overlays can be open at once on a narrow screen; resetting to "" would
 * release the other one's lock early. Restoring what was there keeps them
 * independent.
 *
 * ★ The scrollbar's width is compensated with padding rather than left alone.
 * Hiding it widens the viewport by ~15px, and the page behind a fixed overlay is
 * still laid out — so without the padding the whole page visibly jumps sideways
 * the moment the drawer opens and jumps back when it closes.
 */
export function useBodyScrollLock(locked: boolean): void {
  useEffect(() => {
    if (!locked) return;
    const html = document.documentElement;
    const body = document.body;
    const previous = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      bodyPaddingRight: body.style.paddingRight,
    };
    const scrollbarWidth = window.innerWidth - html.clientWidth;

    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;

    return () => {
      html.style.overflow = previous.htmlOverflow;
      body.style.overflow = previous.bodyOverflow;
      body.style.paddingRight = previous.bodyPaddingRight;
    };
  }, [locked]);
}
