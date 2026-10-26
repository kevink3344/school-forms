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
- 2.0 See the separate [Admin Guide](admin/admin-guide.pdf) and [Settings Reference](admin/settings-reference.pdf)

**3. For Staff and School Contacts**
- 3.0 See the separate [Staff Guide](staff/staff-guide.pdf)

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

Administrator workflows are documented in two separate, screenshot-driven guides:

- **[Admin Guide](admin/admin-guide.pdf)** (`docs/guides/admin/admin-guide.pdf`) — the dashboard,
  filtering and export, the Forms list, the Form Designer (Form Details, fields, staff-only field
  access, visibility, publishing and the public link), access requests, reports, the Webhook Log,
  generated documents, and changing your own password.
- **[Settings Reference](admin/settings-reference.pdf)**
  (`docs/guides/admin/settings-reference.pdf`) — one chapter for each of the twelve Settings
  sections: Users, Roles, Login Mode, Documents Link, Menu Settings, Slack, Access Requests,
  Webhook Log, System Messages, Organizations, Schools and School Name Matching.

Both are kept separate from this document because they need full-size screenshots and a level of
detail that would bury the parent-facing material below.

<div class="page-break"></div>

# 3. For Staff and School Contacts

Staff and School Contact workflows are documented in a **separate, screenshot-driven guide**:
[School Forms — Staff Guide](staff/staff-guide.pdf) (`docs/guides/staff/staff-guide.pdf`).

That guide covers, task by task and with an annotated screenshot for each:

- Signing in, the menu, and reading system messages
- **Available Forms** — which forms you can open, and how to request, track, or withdraw access
  to a private one
- The submissions queue — status chips, the form filter, choosing columns, archived submissions
- **Filling in staff-only fields** — both inline in the queue and on the submission page
- Reviewing a submission — status, editing a parent's answer, archiving and restoring
- Generated documents, reports and export
- **Changing your password** and signing out
- A reference section: status meanings, field types, and "I can't see it" troubleshooting

It is kept separate because staff need different screenshots and a different level of detail from
the administrator material in [Part 2](#2-for-administrators).

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
| **Google Document** | A Google Drive file id, shown as a clickable link that opens the file in Google Drive |
| **Select** | A dropdown list of options |
| **Radio** | A single choice from a short list |
| **Checkbox** | One or more choices from a list |
| **Toggle** | An on/off switch with exactly two answers: **No** (off, the default) or **Yes** (on) |

### Toggle fields

A **Toggle** field is a switch, not a checkbox. It has exactly two answers — **No** and **Yes** —
and no option list, so there is nothing to configure beyond its label. It starts **off**, which
reads as **No**; switching it on stores **Yes** and switching it back stores **No**. The answer is
saved as the word itself, so it reads as "Yes" or "No" everywhere: the Submissions grid, the
submission detail page, and every export.

Toggles are most often used for **Staff Only** fields, such as a "Generate document" style switch
that staff flip while reviewing a submission. In the Submissions grid a toggle saves as soon as it
is flipped — there is no separate confirm step.

### Google Document fields

A **Google Document** field holds the **id** of a file in Google Drive — not the file itself. The
app turns each id into a link that opens the file in Google Drive, so a reviewer can click straight
through.

Where the id comes from: a Google Forms **file upload** question answers with the Drive file id, and
so does a short-answer question whose script sends one. If the question allows more than one file,
the answer is a **list** — each file is shown as a numbered link.

**Access is managed in Google Drive, not in School Forms.** The app builds the link but does not
grant permission to open it. If a link says you do not have access, ask a staff member to share the
file (or the folder it lives in) with you.

You can find a submission by its file id, or by pasting the whole Google Drive **URL** into the
search box — the app recognises the URL and matches the id inside it.

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
