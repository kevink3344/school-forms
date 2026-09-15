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

/**
 * A form's display name with its numeric ID in front: "#2 CDM Non-Traditional".
 *
 * The ID is load-bearing outside this app — an Apps Script bound to a Google Form
 * is configured with this exact number — so it is shown wherever a form is named,
 * not only on the designer page where it used to live alone. Titles are ambiguous
 * on their own ("CDM Traditional" and "CDM Non-Traditional" are one word apart at
 * the end), and the ID is the only thing that can be matched against a script.
 *
 * Use this for plain-text contexts — `<option>` labels, document titles, log
 * lines — where the ID cannot be styled. Inside JSX, prefer `FormIdBadge` from
 * components/layout: it sets the number apart from the title so it is scannable
 * rather than read as part of the name.
 *
 * `Pick` rather than `Form` so this works on FormWithFields and PublicForm too.
 */
export function formLabel(form: Pick<Form, "id" | "title">): string {
  return `#${form.id} ${form.title}`;
}
