---
title: "School Forms — User Guide"
subtitle: "Wake County Public School System"
date: "September 2026"
---

<div class="cover">

# School Forms

## User Guide

**Wake County Public School System**

*September 2026*

</div>

<div class="page-break"></div>

## Contents

**1. Getting Started**
- 1.1 What is School Forms?
- 1.2 Roles at a glance
- 1.3 Signing in
- 1.4 Finding your way around

**2. For Administrators**
- 2.1 Viewing submissions
- 2.2 Filtering submissions
- 2.3 Exporting to CSV
- 2.4 Creating a form
- 2.5 Designing a form
- 2.6 Adding fields
- 2.7 Staff-only fields and access
- 2.8 Publishing a form
- 2.9 Deleting a form
- 2.10 Managing schools
- 2.11 Managing users
- 2.12 Login Mode
- 2.13 Documents Link
- 2.14 Menu Settings
- 2.15 Slack notifications
- 2.16 Organizations
- 2.17 Reports
- 2.18 Webhook Log

**3. For Staff and School Contacts**
- 3.1 Your submissions queue
- 3.2 Reviewing a submission
- 3.3 Changing a submission's status
- 3.4 Editing parent answers
- 3.5 Filling in staff-only fields
- 3.6 Adding a staff comment
- 3.7 Viewing generated documents
- 3.8 Reports

**4. For Parents**
- 4.1 Filling in a form

**5. Reference**
- 5.1 Status meanings
- 5.2 Field types
- 5.3 Troubleshooting

<div class="page-break"></div>

# 1. Getting Started

## 1.1 What is School Forms?

School Forms is a web application for collecting and reviewing school forms. Administrators
design form templates, parents fill them in online, and staff review the submissions and
generate documents from them.

The application has three staff-facing roles — **Admin**, **Staff**, and **School Contact** —
plus an anonymous parent-facing form that requires no sign-in.

## 1.2 Roles at a glance

| Role | What they can do |
| --- | --- |
| **Admin** | Everything: view submissions from every school, export data, design and publish forms, import schools, manage users and organizations, configure the app |
| **Staff** | Review and comment on submissions **for their own school**, edit answers, fill in staff-only fields, export their school's data |
| **School Contact** | The same access as Staff |
| **Parent** | Open a shared link, fill in the form, and receive a submission ID — no sign-in required |

> **Note:** A menu item you expect to see may be hidden by an administrator. See
> [Menu Settings](#214-menu-settings).

## 1.3 Signing in

Open the School Forms URL and sign in.

![Sign In page](images/01-login-select.png)

The sign-in screen adapts to the mode your administrator has configured:

- **Select User (Test)** — choose an Organization and a Test User, then click **Sign In**.
  No password is required.
- **Password (Production)** — enter your **Email** and **Password**, then click **Sign In**.
- **System Maintenance** — sign-in is temporarily disabled and a maintenance message is shown.

New staff members can click **Create an account** to register. The sign-up form asks for your
**Full Name**, **School**, **Email**, and **Password** — no organization picker, because your
administrator configures which organization new accounts join.

## 1.4 Finding your way around

After signing in, the menu is hidden to give your work the full width of the screen. Click the
menu button in the top-left to slide it out; it lists the sections available to your role.
Administrators see **Dashboard**, **Forms**, **Reports**, and **Settings**; Staff
and School Contacts see **Submissions** and **Reports**. The **Documents** item appears when
your administrator has enabled it.

The menu closes again when you click outside it, press `Esc`, or pick a section — so you never
have to close it by hand. Click **Log out** in the top-right to end your session.

<div class="page-break"></div>

# 2. For Administrators

## 2.1 Viewing submissions

The **Dashboard** shows every submission across all schools.

![Submissions dashboard](images/02-admin-dashboard.png)

Each row shows the **Student / School**, the **Submission ID**, the **Status**, and when it was
**Submitted**. Click **Review** on any row to open the full submission.

## 2.2 Filtering submissions

Use the filter bar at the top of the Dashboard to narrow the list:

- **School** — all schools, or one specific school
- **Form** — all forms, or one published form
- **Status** — Submitted, In Review, Flagged, or Completed
- **Date from** / **Date to** — restrict by submission date

Click **Clear** to reset the filters.

> **Note:** **Clear** resets the school, status, and date filters but leaves the **Form**
> filter in place.

## 2.3 Exporting to CSV

Click **Export** on the Dashboard to open the export panel.

![Export panel](images/03-export-drawer.png)

1. Tick the columns to show in the preview. Use **Select all** to include everything.
2. Staff-only fields are included by default. They are labelled with a **Staff** badge so
   you can spot them.
3. Check the **Preview** table to confirm the output.
4. Click **Export CSV** to download the file.

The file downloads as `submissions-export.csv`.

## 2.4 Creating a form

Go to **Forms** and click **New Form**.

![Forms list](images/04-forms-list.png)

1. Enter a **Form title** — for example, *Course Designation Form (CDM)*.
2. Optionally choose a **School**, or leave it as **All schools** for a district-wide form.
3. Click **Create & Design**. The Form Designer opens.

The Forms list shows each form's **Status**, its **Submissions** count, and when it was
**Created**. From here you can **Edit**, **Publish**/**Unpublish**, or **Delete** a form.

## 2.5 Designing a form

The Form Designer is where you set the form's details and build its fields.

![Form Designer](images/05-form-designer.png)

**Form Details** contains:

| Field | Purpose |
| --- | --- |
| **Title** | The form's name, shown to parents and staff |
| **Description** | An optional note shown to parents |
| **Drive Folder ID** | Where generated documents are saved. A green **Valid** check confirms the folder is reachable. Leave blank to use the default folder. |
| **Google Form URL** | An optional link to a matching Google Form, shown to staff |
| **Generate form fields** | Reserved for automatic field creation from a Google Form |

Click **Save** when you are finished. The button stays disabled until you make a change.

## 2.6 Adding fields

The **Fields** card has two tabs: **Form Fields** and **Staff Only Fields**.

![Form fields](images/06-form-designer-fields.png)

- **Form Fields** are shown to parents when they submit the form.
- **Staff Only Fields** are hidden from parents and filled in by staff later.

Click **Add Form Field** or **Add Staff Only Field** to add one. Each field has:

- **Label** — the question text
- **Type** — Text, Text Area, Number, Date, Email, Select, Radio, or Checkbox
- **Options (comma separated)** — for Select, Radio, and Checkbox types only
- **Required** — whether the parent must answer

Use the **↑** and **↓** buttons to reorder fields, and **✕** to remove one.

## 2.7 Staff-only fields and access

Staff-only fields have an extra **Access** row. Each button grants or removes access for a role:

![Staff-only field access](images/06-form-designer-fields.png)

- A filled button (for example **✓ Staff**) means that role can see and fill the field.
- An outlined button (for example **+ Staff**) means that role cannot.

Click a button to toggle it. This lets you keep a field visible to Administrators only, or to
Administrators and School Contacts but not Staff.

## 2.8 Publishing a form

A form must be **Published** before parents can use it. Click **Publish** in the Form Designer
header, or use the **Publish** button on the Forms list.

Once published, a **Public link** card appears at the bottom of the Form Designer. Copy this
link and share it with parents:

```
/org/{organization}/forms/{form-id}
```

To take a form offline, click **Unpublish**. Existing submissions are not affected.

## 2.9 Deleting a form

On the **Forms** list, click **Delete** on a form that has no submissions.

![Delete form confirmation](images/04-forms-list.png)

A confirmation dialog appears. Click **Delete** to confirm.

> **Warning:** Deleting a form cannot be undone. The **Delete** button is disabled for any form
> that already has submissions, so submission data is never lost.

## 2.10 Managing schools

On **Settings**, expand **Schools** to see the list loaded from the district data source.

![Schools](images/07-schools.png)

- Click **Import Schools** to refresh the list from the district source.
- Use **Search** to find a school by name or district.
- Filter by **Grade Level** or **Calendar**.
- Use **‹ Prev** and **Next ›** to page through the results.

## 2.11 Managing users

Open **Settings** and expand **Users**.

![Users](images/09-settings-users.png)

The table lists every account with its **Name**, **Email**, **Role**, **School**, and
**Status**. Click any row to edit that user.

![Edit User](images/10-edit-user.png)

In the **Edit User** panel you can change the **Display name**, **Email**, **Role**,
**Organization**, and **School**, and switch the account **Active** or **Inactive**. Click
**Save** to apply your changes.

Click **+ Add User** to create a new account. New accounts require a password of at least
8 characters.

> **Note:** You cannot deactivate your own account.

## 2.12 Login Mode

Expand **Login Mode** to control how users sign in.

![Login Mode](images/11-login-mode.png)

Choose one of three modes:

- **Select User (Test)** — pick a user from a directory, no password needed. Useful for
  testing and demonstrations.
- **Password (Production)** — requires an email and password for every sign-in. Use this for
  real deployments.
- **System Maintenance** — blocks sign-in and shows a maintenance message.

The active mode is marked with an **ACTIVE** badge. When **System Maintenance** is selected,
edit the **Maintenance message** and click **Save Maintenance Message**.

## 2.13 Documents Link

Expand **Documents Link** to control which roles see the **Documents** item in the sidebar.

![Documents Link](images/08-settings.png)

Each role has a toggle. Switch it on to show the Documents link for that role, or off to hide it.

This is the **only** control for the Documents item. Unlike the other sidebar links, Documents is
not repeated under Menu Settings, because this setting also decides whether the documents API
accepts a request.

## 2.14 Menu Settings

Expand **Menu Settings** to control which sidebar items each role can see.

![Menu Settings](images/12-menu-settings.png)

The panel is grouped by menu item — **Forms** and **Reports** — with a toggle for each role.
Switch a toggle off to hide that item from that role.

> **Note:** Hiding a menu item only removes it from the sidebar. It does not delete any data or
> change permissions on the underlying page.

> **Note:** **Documents** is not listed here. Use
> [Documents Link](#213-documents-link) above to show or hide it — that setting also decides
> whether the documents API accepts a request.

> **Note:** **Webhook Log** is not listed here either. It is reached from
> [Settings → Webhook Log](#218-webhook-log) and is always available to administrators.

## 2.15 Slack notifications

Expand **Slack Notifications** to verify that admin alerts are being delivered.

![Slack Notifications](images/08-settings.png)

1. Enter a **Subject** and optional **Body**. Slack formatting such as `*bold*` and
   `` `code` `` is supported.
2. Click **Send Test Message**.

A confirmation appears when the message is delivered.

## 2.16 Organizations

Expand **Organizations** to manage tenant boundaries. Schools are shared across all
organizations.

![Organizations](images/13-organizations.png)

The table shows each organization's **Name**, **Slug**, **Members**, and **Status**. Click
**+ Add Organization** to create one, or click a row to edit it.

In the organization panel you can set the **Name**, **Slug**, **Description**, and **Active**
status. Leave the **Slug** blank to derive it automatically from the name.

> **Note:** You cannot deactivate your own organization.

## 2.17 Reports

**Reports** builds a filtered, column-selected table from a form's submissions and exports
it as CSV, Excel, or PDF. Whatever is on screen is exactly what lands in the file.

![Reports page](images/19-reports.png)

1. Pick a **Form** (required — the available columns belong to that form).
2. Narrow the rows with **School**, **Status**, **From**/**To**, and the **Filter rows**
   search box. The search box looks across the submission id, the school name, and every
   field value.
3. Click **Select Columns** to open the column panel, which slides out from the right.
   Tick the fields you want; the count in the panel footer tracks your selection. Click
   **Done** (or press `Esc`, or click outside the panel) to close it. Then pick a
   **Format** (`CSV`, `Excel`, or `PDF`).
4. Click **Export** to download. The preview grid updates as you change the filters.

Staff-only fields are included by default and are labelled with a **Staff** badge in the
column panel and the preview header. Untick any you don't want before exporting.
Un-ticking every column falls back to all columns you have access to, so a report is
never empty by accident.

### Saving a view

Click **Save View**, give it a name, and click **Save as New**. Saved views remember the
form, filters, columns, and format. Select one from the **Saved View** dropdown to apply
it; use **Update View** to overwrite it, **Make Default** to flag it as your preferred
view, and **Delete** to remove it. Saved views are private to your account.

## 2.18 Webhook Log

**Webhook Log** lists every response that Google Forms has posted to this app — including
the ones the app **rejected**. It is the answer to "a form looks empty, did anything even
arrive?"

It is visible to **administrators only**, and unlike most menu items it cannot be turned
off, because it is a diagnostic tool rather than a feature.

Open it from **Settings → Webhook Log**. That section shows the last seven days of intake
at a glance — how many responses were delivered and how many were rejected — and links
through to the log itself. The log is deliberately **not** a sidebar item, and it is not
listed under [Menu Settings](#214-menu-settings), so there is no setting that can hide it.

Each row is one **attempt**, not one submission. A response that was rejected and later
re-sent appears twice: the original failure and the successful re-send.

| Column | Meaning |
| ------ | ------- |
| **Received** | When the request arrived at the server. |
| **Result** | `succeeded` or `failed`. |
| **HTTP** | The status code the app returned to Google. `201` = stored, `400` = rejected, `401` = bad secret, `404` = unknown form. |
| **Form** | Which form the response was for. Empty when the form no longer exists. |
| **Reason** | A plain-language explanation, with the machine code (`form_not_published`, `invalid_body`, …) underneath. |
| **Submission** | A link to the submission that was created — or `replay of #N` when this row is itself a re-send. |
| **Replay** | Re-sends this attempt. Greyed out when it cannot be re-sent (see below). |

Click any row to open a panel with the full detail, including the **exact payload** that
Google sent, which is what makes a re-send possible.

### Filtering

The log opens showing **All** attempts, so nothing that arrived is hidden by a default you
did not choose. Use the filters above the grid to narrow to **Status**
(`All` / `Failed` / `Succeeded`), a single **Form**, a **Secret** result
(`Accepted` / `Wrong` / `Missing`), a search term, or a date range. **Clear** resets every
filter back to **All**. The header shows how many attempts matched and how they split between
succeeded and failed, and the rows say which is which, so you can see the failures without
filtering for them first.

> **Tip:** the dashboard, the post-publish banner, and a form's design page link here with
> the **Failed** filter already applied, and the page honours that — but opening the log from
> **Settings** (or the menu) always starts from **All**.

### Re-sending a response after republishing a form

This is the case the log was built for. A form was unpublished — by accident, or while
being edited — so Google kept collecting responses and the app rejected each one with
`400 Form is not accepting submissions`. Those responses are **not lost**: the app stored
what Google sent before rejecting it.

1. **Publish the form again.** Re-publishing does *not* re-send anything by itself. A banner
   appears on the Forms list and on the form's design page telling you how many responses
   were rejected, with a **Review and re-send** link that opens the log already filtered to
   that form.
2. In the log, click **Replay** on a failed row — or **Replay all failed** to do every
   eligible attempt for the selected form at once.
3. The re-send runs through **today's** rules: the form must be published *now*, and its
   fields are matched as they exist *now*. A recovered submission is stamped with today's
   time, while its **school year** comes from the date the response originally arrived —
   so a response from the previous school year lands in the previous school year.

After a successful re-send the original row stays **failed** (the log is a record of what
happened, and history is not rewritten) and reports `replay of #N` on the new row.

### Why some rows cannot be replayed

The **Replay** button is disabled, with the reason shown on hover, when:

- the attempt **already succeeded** — there is nothing to recover;
- **no payload was stored**, so there is nothing to send (see below);
- the attempt **has already been replayed successfully** — a re-send is allowed **once**. A
  second one would be a duplicate submission. If a re-send itself fails, *that* row can be
  replayed, so retrying is always possible — just forward.

### Attempts rejected for a bad or missing secret

A request whose secret is wrong or missing is logged, but **its body is deliberately not
stored** and it **cannot be listed** — the secret was never verified, so the form id in that
body cannot be trusted to say which organization the row belongs to. These attempts appear
only as a count at the top of the log:

> *12 attempts could not be attributed to a form or organization and cannot be listed
> here — usually a request with a wrong or missing secret, or one naming a form that no
> longer exists.*

If that count starts climbing, something is posting with an out-of-date secret — usually an
Apps Script that was not updated after the secret was rotated. Because the payload is never
stored, these attempts cannot be replayed.

### Retention

The log keeps every payload **indefinitely**. Past **100,000** rows a warning banner appears
at the top of the page — that is a nudge to review and decide, not an automatic deletion.
Nothing is ever removed on its own, because the log is sometimes the only remaining copy of
a response.

<div class="page-break"></div>

# 3. For Staff and School Contacts

## 3.1 Your submissions queue

The **Submissions** page lists every submission for your school.

![Submissions queue](images/14-staff-queue.png)

Use the **Table** and **Cards** buttons to switch between layouts:

![Card view](images/15-staff-queue-cards.png)

Use the status tabs — **All**, **Submitted**, **In Review**, **Flagged**, **Completed** — to
filter the list. Click **Review** on any row to open the submission.

## 3.2 Reviewing a submission

The submission detail page shows the student's answers, the staff-only fields, and the comment
thread.

![Submission detail](images/16-submission-detail.png)

The **Submission Answers** card lists the parent's responses, including the **Submission ID**,
**Submission Time**, and **School Year**.

## 3.3 Changing a submission's status

Use the **Select Status** dropdown in the page header to change the status.

![Select Status](images/16-submission-detail.png)

Choose **Submitted**, **In Review**, **Flagged**, or **Completed**. The change saves
immediately.

## 3.4 Editing parent answers

Click **Edit** in the page header to make the answers editable.

![Editing a submission](images/17-submission-edit.png)

Change any value, then click **Save changes**. Click **Cancel** to discard your edits.

## 3.5 Filling in staff-only fields

The **Staff-only fields** card holds the internal fields your administrator defined. These are
never shown to parents.

![Staff-only fields](images/16-submission-detail.png)

Fill in the values and click **Save staff fields**. A note below the fields records who last
saved them and when.

## 3.6 Adding a staff comment

The **Staff comments** card is an internal discussion thread for the submission.

![Staff comments](images/16-submission-detail.png)

Type your comment in the box and click **Post comment**. Only staff can see these comments.

## 3.7 Viewing generated documents

The **Documents** page lists the Google Docs generated from submissions.

![Generated documents](images/18-documents.png)

Each row shows the **Date**, **Student Name**, **School Name**, **Course Title**, **Phase I
Result**, and **Status**. Use the **Open** link to open the document in Google Docs, or
**View PDF** to preview it in the app.

Click **Refresh** to reload the list.

## 3.8 Reports

**Reports** works the same way for staff and School Contacts as it does for administrators
(see [2.17 Reports](#217-reports)), with one difference: you are locked to **your own
school**, so there is no School selector and the exported rows only ever contain your
school's submissions.

Saved views are private to you, so you can keep your own set of frequently used reports.

<div class="page-break"></div>

# 4. For Parents

## 4.1 Filling in a form

Open the link you were given. No sign-in is required.

![Parent form](images/20-parent-form.png)

1. Fill in each field. Fields marked with a red **\*** are required.
2. Click **Submit Form** when you are finished.

After submitting, a confirmation page shows your **Submission ID**. **Keep this ID safe** — it
is your only reference for the submission.

<div class="page-break"></div>

# 5. Reference

## 5.1 Status meanings

**Submissions**

| Status | Meaning |
| --- | --- |
| **Submitted** | Received and awaiting review |
| **In Review** | Currently being reviewed by staff |
| **Flagged** | Needs attention or follow-up |
| **Completed** | Reviewed and complete |

**Forms**

| Status | Meaning |
| --- | --- |
| **Draft** | Not yet available to parents |
| **Published** | Live and accepting submissions |
| **Archived** | Retired |

**Documents**

| Status | Meaning |
| --- | --- |
| **Pending** | Being generated |
| **Completed** | Ready to view |
| **Failed** | Generation failed and can be retried |

**Webhook attempts**

| Status / reason | Meaning |
| --- | --- |
| **Succeeded** | The app accepted the response and created a submission |
| `form_not_published` | The form was not published when the response arrived. **Replayable** once the form is published again |
| `invalid_body` | The payload was missing required keys. Not replayable |
| `form_not_found` | The form id does not exist. Not replayable |
| `unauthorized` | Wrong or missing secret. Logged **without** the payload, so not replayable and not listable |
| `internal_error` | The server failed. Replayable |

## 5.2 Field types

| Type | Use for |
| --- | --- |
| **Text** | A short single-line answer |
| **Text Area** | A longer, multi-line answer |
| **Number** | A numeric value |
| **Date** | A calendar date |
| **Email** | An email address |
| **Select** | A dropdown list of options |
| **Radio** | A single choice from a short list |
| **Checkbox** | One or more choices from a list |

## 5.3 Troubleshooting

**A menu item is missing.**
An administrator may have hidden it in **Settings → Menu Settings**. Ask them to check.

**A form says "Form is not accepting submissions".**
The form is not published. An administrator must click **Publish**.

**Responses sent from a Google Form are not appearing.**
Open **Settings → Webhook Log** (administrators only) and set **Status** to **Failed** — see
[2.18 Webhook Log](#218-webhook-log). If the response was rejected because the form was
unpublished, publish the form and click **Replay** on that row; the stored response is
re-sent. If the count at the top of the page is climbing instead, the Apps Script is posting
with a wrong or out-of-date secret and must be updated.

**I cannot sign in.**
Your account may be inactive, or the app may be in **System Maintenance** mode. Contact an
administrator.

**A document shows "Failed".**
Open the submission and click **Retry** on the document row to generate it again.

**The page shows a "warming up" message.**
The database is starting up. Wait a moment and the page will load automatically.
