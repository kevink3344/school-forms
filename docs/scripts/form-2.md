// Google Apps Script: File → Project Settings → trigger onFormSubmit
//
// Forwards a Google Form response to the School Forms webhook endpoint.
//   POST {API_BASE}/api/webhook/google
//   Header: X-Webhook-Secret  (must equal GOOGLE_FORMS_WEBHOOK_SECRET in .env)
//   Body:   { form_id: <number>, answers: [{ field_id?, label?, value }] }
//
// The Google Form does NOT have to be defined in the School Forms designer.
// Every answer carries its question title as `label`, and the numeric `field_id`
// is added only when the title resolves against the published form's field list.
// A title with no matching field is STILL forwarded — the server captures it as
// a text field on the submission — so nothing is dropped.
//
// `field_id` wins when present; `label` is the fallback identity of a question.

const API_BASE = 'https://webform-sandbox-addph8hsd9feghdp.eastus2-01.azurewebsites.net';
const FORM_ID = 2;                       // numeric DB form_id, NOT a string
const WEBHOOK_SECRET = '[guid-here]';    // must match GOOGLE_FORMS_WEBHOOK_SECRET

function onFormSubmit(e) {
  const itemResponses = (e.response || e.source.getActiveResponse()).getItemResponses();

  // 1. Map each question title to its numeric field_id. Best-effort: may be {}
  //    (a form with no designer fields), which is a normal, supported case.
  const fieldMap = getFieldMap(FORM_ID); // { "<label>": field_id }

  // 2. Build the answers array. EVERY answer carries the question title as
  //    `label`; the numeric `field_id` is added only when the title matches a
  //    defined field. An answer with no match is STILL sent — the server
  //    captures it as a text field on the submission, so nothing is dropped.
  const answers = [];
  itemResponses.forEach((itemResponse) => {
    const title = itemResponse.getItem().getTitle();
    const raw = itemResponse.getResponse();
    // Normalize: single value -> string; checkbox/array -> string[]; blank -> "".
    // (Without the `raw == null` guard a missing answer would become the literal
    // string "null" and be captured as a real value.)
    const value = raw == null ? '' : (Array.isArray(raw) ? raw.map(String) : String(raw));

    const fieldId = fieldMap[title];
    answers.push(fieldId
      ? { field_id: fieldId, label: title, value }  // defined field: id + title
      : { label: title, value });                    // undefined field: title only
  });

  // ★ No more "no answers mapped" abort. An unmatched title is captured as text,
  // so a form the staff never defined simply works. This only fires when the
  // Google Form genuinely has no questions.
  if (answers.length === 0) {
    console.warn('No item responses to forward for form ' + FORM_ID);
    return;
  }

  // 3. Post to the webhook (secret-guarded, anonymous).
  const payload = { form_id: FORM_ID, answers: answers };
  const res = UrlFetchApp.fetch(API_BASE + '/api/webhook/google', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Webhook-Secret': WEBHOOK_SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true, // so we can inspect the HTTP status on failure
  });

  const status = res.getResponseCode();
  if (status !== 201) {
    throw new Error('Webhook failed (' + status + '): ' + res.getContentText());
  }
  Logger.log('Submitted — HTTP ' + status + ' — ' + res.getContentText());
}

// Fetch the published form and return { "<label>": field_id }.
// The public endpoint only returns non staff_only fields, so title matching
// applies to the parent-facing questions only.
//
// BEST-EFFORT on purpose: the map is a nicety, not a requirement. A PUBLISHED
// form with no designer fields legitimately returns { fields: [] } (every title
// is then captured as text), and a non-200 means the form is not published (400)
// or does not exist (404) — in which case the webhook POST below is rejected for
// the same reason, so a lookup failure must not stop the attempt being recorded.
function getFieldMap(formId) {
  try {
    const res = UrlFetchApp.fetch(API_BASE + '/api/forms/' + formId + '/public', {
      method: 'get',
      contentType: 'application/json',
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code !== 200) {
      console.warn('Field map for form ' + formId + ' unavailable (HTTP ' + code + ') — ' +
        (code === 404
          ? 'no such form id; check FORM_ID.'
          : code === 400
            ? 'the form is NOT PUBLISHED; the webhook will reject the submission too.'
            : 'check API_BASE and that the server is reachable.') +
        ' Forwarding the answers by title anyway.');
      return {};
    }
    const form = JSON.parse(res.getContentText());
    const map = {};
    (form.fields || []).forEach(function (field) { map[field.label] = field.id; });
    return map;
  } catch (err) {
    console.warn('Field map lookup failed (network/parse) — forwarding the answers by title: ' + err);
    return {};
  }
}