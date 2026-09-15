import type { Form } from "../types";

/**
 * The forms that may appear in an in-app form selector (the dashboard, the staff
 * queue, the reports page).
 *
 * A form is selectable only while it is `published`. `draft` and `archived` are
 * both "unpublished": the first is still being written, the second has been
 * retired. Neither should be offered as something to view or report on, and both
 * are already hidden from parents by `GET /api/forms/public`.
 *
 * Every selector must go through this helper rather than filtering inline. These
 * lists previously drifted — the dashboard filtered to published while the staff
 * queue and reports page rendered every form the API returned — so a form that
 * had been unpublished kept showing up in two of the three selectors. A single
 * definition makes that class of bug impossible to reintroduce.
 *
 * The admin Forms page (`/admin/forms`) deliberately does NOT use this: it is the
 * management surface, so it must keep listing drafts and archived forms.
 */
export function selectableForms(forms: Form[]): Form[] {
  return forms.filter((f) => f.status === "published");
}
