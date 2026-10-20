// A `toggle` field's two answers.
//
// ★ The answer is the STRING "Yes" or "No", not a boolean and not an option
// array. That is what makes the value readable everywhere a plain text answer is
// shown — the submissions grid, the detail page, the CSV/XLSX/PDF export and the
// webhook payload all print "Yes"/"No" with no type-specific code at all.
//
// "No" is the default: a toggle that has never been saved reads as off, and
// switching it off writes "No" rather than clearing the value, so the stored
// answer is always one of the two.
export const TOGGLE_OFF = "No";
export const TOGGLE_ON = "Yes";

/**
 * Is a stored toggle answer on?
 *
 * Only an explicit "Yes" is on. A missing value is the default, which is off —
 * so an unsaved toggle never reads as Yes. `true` is accepted as well, for a
 * value written by something other than this UI (a webhook, an older client).
 */
export function isToggleOn(value: unknown): boolean {
  if (value === true) return true;
  return typeof value === "string" && value.trim().toLowerCase() === TOGGLE_ON.toLowerCase();
}

/** The answer to store for a given switch position. */
export function toggleAnswer(on: boolean): string {
  return on ? TOGGLE_ON : TOGGLE_OFF;
}
