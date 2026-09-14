// Google Apps Script: File → Project Settings → trigger onFormSubmit
//
// Forwards a Google Form response to the School Forms webhook endpoint.
//   POST {API_BASE}/api/webhook/google
//   Header: X-Webhook-Secret  (must equal GOOGLE_FORMS_WEBHOOK_SECRET in .env)
//   Body:   { form_id: <number>, answers: [{ field_id: <number>, value }] }
//
// Question titles in the Google Form must EXACTLY match the field `label`
// values you set in the School Forms form designer; this script maps
// title -> field_id by fetching the published form's field list.

// AFTER ✅
const API_BASE = 'https://webform-sandbox-addph8hsd9feghdp.eastus2-01.azurewebsites.net';
const FORM_ID = 2;                       // numeric DB form_id, NOT a string
const WEBHOOK_SECRET = '[guid-here]';    // must match GOOGLE_FORMS_WEBHOOK_SECRET

function onFormSubmit(e) {
  const itemResponses = (e.response || e.source.getActiveResponse()).getItemResponses();

  // 1. Map each question title to its numeric field_id.
  const fieldMap = getFieldMap(FORM_ID); // { "<label>": field_id }

  // 2. Build the answers array: [{ field_id, value }].
  const answers = [];
  itemResponses.forEach((itemResponse) => {
    const title = itemResponse.getItem().getTitle();
    const raw = itemResponse.getResponse();
    // Normalize: single value -> string; checkbox/array -> string[].
    const value = Array.isArray(raw) ? raw.map(String) : String(raw);

    const fieldId = fieldMap[title];
    if (fieldId) {
      answers.push({ field_id: fieldId, value });
    } else {
      console.log('No matching field for question: ' + title);
    }
  });

  if (answers.length === 0) {
    throw new Error('No answers mapped to form fields. Check question titles against field labels.');
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
// The public endpoint only returns non staff_only fields, so title-case matching
// applies to the parent-facing questions only.
function getFieldMap(formId) {
  const res = UrlFetchApp.fetch(API_BASE + '/api/forms/' + formId + '/public', {
    method: 'get',
    contentType: 'application/json',
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Could not fetch form ' + formId + ': ' + res.getContentText());
  }
  const form = JSON.parse(res.getContentText());
  const map = {};
  form.fields.forEach((field) => { map[field.label] = field.id; });
  return map;
}