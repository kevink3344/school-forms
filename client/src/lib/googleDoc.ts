// ---------------------------------------------------------------------------
// Google Drive document answers.
//
// A `google_doc` field stores the bare Drive file id(s) — that is what a Google
// Forms file-upload (or short-answer) question sends. The URL is DERIVED here at
// render time rather than stored, so a future change to the URL shape is a
// one-line edit with no data migration, and the stored value stays exactly what
// the webhook sent.
//
// ★ `drive.google.com/file/d/`, NOT `docs.google.com/document/d/`. A Google Forms
// file UPLOAD stores a binary file in Drive (a PDF, an image, …), not a Google
// Doc, and the two paths are not interchangeable. Measured against the Drive API
// with the app's own credentials, reading each file's own `webViewLink`:
//
//   application/pdf                        -> drive.google.com/file/d/<id>/view
//   application/vnd.google-apps.document   -> docs.google.com/document/d/<id>/edit
//
// So the shape is decided by the file's MIME type, and an uploaded attachment is
// the first kind. The `docs` path 404s for it.
//
// ★ The URL template is DUPLICATED in server/src/export/table.ts, because the
// server cannot import from the client and the client cannot import from here.
// `google-doc-field.test.ts` asserts the two are byte-identical — a hand-copy is
// acceptable only when a gate diffs it against its source, which is the same
// technique MENU_ITEM_KEYS <-> MENU_ITEMS and the two dialects' index lists use.
// ---------------------------------------------------------------------------

export const GOOGLE_DOC_URL_PREFIX = "https://drive.google.com/file/d/";
export const GOOGLE_DOC_URL_SUFFIX = "/view";

/** The Docs viewer URL for a Drive document id. */
export function googleDocUrl(id: string): string {
  // `encodeURIComponent` costs nothing and means a malformed value cannot break
  // out of the path segment. This is the whole reason the app builds the URL
  // rather than interpolating a stored value into JSX.
  return `${GOOGLE_DOC_URL_PREFIX}${encodeURIComponent(id)}${GOOGLE_DOC_URL_SUFFIX}`;
}

/**
 * The document ids carried by a google_doc answer, in order.
 *
 * Handles BOTH shapes the webhook can produce: an array (a Google Forms
 * file-upload question answers with an array of Drive ids) and a bare string (a
 * short-answer question). A string is split on whitespace and commas so a
 * hand-typed list works too. Blank entries are dropped so a trailing empty answer
 * does not render a dead link.
 */
export function googleDocIds(value: unknown): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.map((v) => String(v))
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  return raw.map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * True only for an absolute http(s) URL — never for `javascript:` or `data:`.
 *
 * ★ This is the one place a link renderer can become an XSS vector, so the
 * allowlist is explicit: a scheme test, not "contains a colon". A stored
 * `javascript:alert(1)` must render as plain text.
 */
export function isAbsoluteHttpUrl(v: string): boolean {
  return /^https?:\/\//i.test(v);
}

/**
 * The href for one google_doc entry.
 *
 * A value that is ALREADY an absolute http(s) URL is linked as-is, so a form
 * whose Apps Script was later changed to send a full URL does not get
 * double-wrapped into `…/document/d/https://…/view`. Anything else is treated as
 * an id and wrapped.
 */
export function googleDocHref(entry: string): string {
  return isAbsoluteHttpUrl(entry) ? entry : googleDocUrl(entry);
}
