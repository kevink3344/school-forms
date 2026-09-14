# Plan — PDF User Guide with Screenshots

**Status:** Approved — decisions locked (see §10)
**Date:** 2026-09-14
**Deliverable:** A single, concise, WCPSS-branded, printable PDF user guide covering Admin,
Staff, and School Contact roles

---

## 1. Goal

Produce a **PDF user guide** that lets a new admin, staff member, or School Contact get
productive without training. It must include **annotated screenshots** of every screen and
walk through the real workflows end to end.

The guide is **task-oriented**, not a feature list: each section answers "how do I do X?"

---

## 2. Audience & structure

Four audiences, in this order (most-privileged first, since admins configure what others see):

| Part | Audience | Covers |
| --- | --- | --- |
| **1. Getting Started** | Everyone | What the app is, the roles, signing in |
| **2. For Administrators** | `admin` | Forms, designer, submissions, schools, settings |
| **3. For Staff & School Contacts** | `staff`, `cdm_contact` | Queue, submission detail, documents |
| **4. For Parents** | Anonymous | Opening a link, filling a form, confirmation |
| **5. Reference** | Everyone | Status vocabulary, FAQ, troubleshooting |

---

## 3. Proposed table of contents

```
Cover page — School Forms User Guide (logo, version, date)
Contents

PART 1 — GETTING STARTED
  1.1  What is School Forms?
  1.2  Roles at a glance (Admin / Staff / School Contact / Parent)
  1.3  Signing in            [screenshot: login, 3 modes]
  1.4  Creating a staff account  [screenshot: registration]
  1.5  Finding your way around   [screenshot: sidebar, annotated]

PART 2 — FOR ADMINISTRATORS
  2.1  The Submissions dashboard   [screenshot: dashboard + filters]
  2.2  Filtering submissions       [screenshot: filter bar + cleared]
  2.3  Exporting to CSV            [screenshot: export drawer, columns, preview]
  2.4  Creating a form             [screenshot: New Form card]
  2.5  The Form Designer           [screenshot: full designer, annotated]
        - Form Details (Title, Description, Drive Folder ID, Google Form URL)
        - Form Fields vs Staff Only Fields tabs
        - Field types & options
        - Access buttons & Required
        - The Public link
  2.6  Publishing a form           [screenshot: Publish + Public link card]
  2.7  Deleting a form             [screenshot: delete modal]
  2.8  Managing schools            [screenshot: schools table + filters]
  2.9  Settings → Users            [screenshot: users table + Edit User drawer]
  2.10 Settings → Login Mode       [screenshot: 3 mode cards]
  2.11 Settings → Documents Link   [screenshot: per-role toggles]
  2.12 Settings → Menu Settings    [screenshot: menu visibility toggles]
  2.13 Settings → Slack            [screenshot: test message panel]
  2.14 Settings → Organizations    [screenshot: org table + drawer]

PART 3 — FOR STAFF & SCHOOL CONTACTS
  3.1  Your submissions queue      [screenshot: queue, table + card views]
  3.2  Filtering by status         [screenshot: status tabs]
  3.3  Reviewing a submission      [screenshot: detail page, annotated]
  3.4  Changing a submission's status  [screenshot: Select Status dropdown]
  3.5  Editing parent answers      [screenshot: edit mode]
  3.6  Filling in staff-only fields [screenshot: staff-only card]
  3.7  Adding a staff comment      [screenshot: comments + composer]
  3.8  Viewing generated documents [screenshot: documents table + PDF drawer]
  3.9  Exporting your school's data [screenshot: export drawer]

PART 4 — FOR PARENTS
  4.1  Opening the form link
  4.2  Filling in the form         [screenshot: parent form]
  4.3  Submitting & saving your ID [screenshot: confirmation page]

PART 5 — REFERENCE
  5.1  Status meanings (submissions, forms, documents, users)
  5.2  Field types explained
  5.3  Frequently asked questions
  5.4  Troubleshooting
```

---

## 4. Screenshot inventory (~28 shots)

Each screenshot should be **captured at a consistent width (1440px)** with **annotations**
(numbered callouts or arrows) pointing at the control being described.

| # | Screen | Route | Notes |
| --- | --- | --- | --- |
| 1 | Login — Select User mode | `/login` | Show org + test-user dropdowns |
| 2 | Login — Password mode | `/login` | Toggle via `?admin=1` |
| 3 | Login — Maintenance mode | `/login` | Amber panel |
| 4 | Registration | `/register` | |
| 5 | Sidebar (admin) | `/admin` | Annotate all 5 items |
| 6 | Submissions dashboard | `/admin` | Full page with filters + grid |
| 7 | Filter bar (active) | `/admin` | Show a filtered result |
| 8 | Export drawer | `/admin` | Columns + preview + Include staff-only |
| 9 | Forms list | `/admin/forms` | Show Published + Draft rows |
| 10 | New Form card | `/admin/forms` | Expanded |
| 11 | Delete form modal | `/admin/forms` | |
| 12 | Form Designer — top | `/admin/forms/:id` | Form Details card |
| 13 | Form Designer — fields | `/admin/forms/:id` | A field row with all controls |
| 14 | Form Designer — staff field | `/admin/forms/:id` | Access buttons + Required |
| 15 | Public link card | `/admin/forms/:id` | Published form |
| 16 | Schools | `/admin/schools` | Table + filters + pagination |
| 17 | Settings — Users | `/admin/settings` | |
| 18 | Edit User drawer | `/admin/settings` | |
| 19 | Login Mode | `/admin/settings` | 3 cards, one ACTIVE |
| 20 | Documents Link | `/admin/settings` | |
| 21 | Menu Settings | `/admin/settings` | |
| 22 | Slack Notifications | `/admin/settings` | |
| 23 | Organizations | `/admin/settings` | |
| 24 | Staff queue — table | `/staff` | |
| 25 | Staff queue — cards | `/staff` | Toggle view |
| 26 | Submission detail | `/staff/:publicId` | Annotate status dropdown |
| 27 | Staff-only fields + comments | `/staff/:publicId` | |
| 28 | Generated Documents | `/staff/documents` | Table + PDF drawer |
| 29 | Parent form | `/org/:slug/forms/:id` | |
| 30 | Confirmation page | `/submission/:publicId` | |

---

## 5. How to produce it

### 5.1 Capture (automated, reproducible)

Use the **Playwright browser tools already available** to script the captures. This beats
manual screenshots because it's repeatable when the UI changes.

- A capture script walks the routes in §4, at a fixed viewport (`1440×900`), signs in as the
  right role for each shot, and saves PNGs to `docs/guides/images/`.
- **Deterministic data**: seed a known state first (`npm run seed`) so screenshots are
  consistent and don't leak real student data.
- **Annotations**: add numbered callouts as an overlay (absolutely-positioned badges) before
  capture, or annotate after in the layout step.

### 5.2 Assemble (pick one)

| Option | How | Pros | Cons |
| --- | --- | --- | --- |
| **A. Markdown → PDF** *(recommended)* | Write `docs/guides/user-guide.md`, render with `md-to-pdf` / `pandoc` + a CSS stylesheet | Plain text, versioned in git, easy to diff | Layout control is CSS-only |
| **B. HTML → PDF** | Hand-write `user-guide.html`, print to PDF via headless Chrome | Full layout control, can reuse the app's CSS | More markup to maintain |
| **C. Word/Google Doc → PDF** | Write in Docs, export | Non-technical editors can help | Not versioned with the code |

**Recommendation: A** — keep the source in the repo (`docs/guides/user-guide.md`) so it's
reviewable in PRs, and render to PDF as a build step. Use a print stylesheet with page breaks
per part and figure captions.

### 5.3 Suggested tooling

- **Rendering:** `md-to-pdf` (npm) or `pandoc` — both handle Markdown + images + a CSS theme.
- **Scripts:** add `npm run guide:shots` (capture) and `npm run guide:pdf` (render) to the root
  `package.json` so regenerating is one command.
- **Output:** `docs/guides/school-forms-user-guide.pdf` (and keep the `.md` + `images/` in git).

---

## 6. Writing conventions

- **Second person, active voice** — "Click **Publish**", not "The form should be published".
- **Bold the exact UI label** every time it's referenced: **Save**, **Select Status**, **Form Fields**.
  (The terminology cheat-sheet in §8 of the research is the source of truth.)
- **One task per subsection**, each with: what it's for → numbered steps → the screenshot →
  a "Tip" or "Note" callout where useful.
- **Call out destructive actions** explicitly (Delete form, Unpublish) with a warning box.
- **Never include real student data** in screenshots — use seeded/sample records only.

---

## 7. Accuracy requirements

The guide must match the shipped UI. Two things to verify before publishing:

1. **The Google Form URL / Generate form fields controls** are present but the generation is
   **not yet functional** (needs the Google Forms OAuth scope). The guide should describe the
   URL field as informational and either omit or clearly mark the generate feature as
   "coming soon".
2. **Menu Settings / Documents Link** can hide sidebar items — the guide should note that a
   missing menu item may be hidden by an admin rather than broken.

---

## 8. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Screenshots go stale as the UI changes. | Automate capture (§5.1) so regenerating is one command. |
| Real student data leaks into the PDF. | Seed deterministic sample data; never screenshot production. |
| Guide drifts from the app. | Keep the source `.md` in git; note the app version/date on the cover. |
| Screenshots need a live DB (currently warming). | Capture after the DB is up; the seeded state makes shots reproducible. |
| Too long to be usable. | Keep Part 1–4 task-focused; push detail into Part 5 Reference. |

---

## 9. Verification plan

1. Every route in §4 captures without error and shows the expected UI.
2. Every button/label named in the guide actually exists in the UI (spot-check against the
   terminology list).
3. The rendered PDF has: a cover, a contents page, page numbers, and captioned figures.
4. Images are legible at print size (no sub-10px text).
5. No real student names/emails appear anywhere.

---

## 10. Decisions (locked)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Scope | **One document for all roles** — Admin, Staff, School Contact |
| 2 | Length | **Concise** (~20-page task guide) |
| 3 | Assembly tool | **Markdown → PDF**, and **keep BOTH** the `.md` source and the `.pdf` in git |
| 4 | Screenshots | **Automated via Playwright** |
| 5 | Branding | **WCPSS-branded** (logo + navy/orange palette) |
| 6 | Distribution | **Committed to `docs/guides/`** |

### Implications of these decisions

- **No parent section.** The guide covers Admin, Staff, and School Contact only. Part 4 (For
  Parents) from §3 is **dropped**; the parent-facing screenshots (#29, #30) are removed from §4.
- **Concise** means: keep each task to 3–6 steps, one screenshot per task, and push detail
  into the Part 5 reference. Target ~20 pages.
- **Keep both** means the repo carries `docs/guides/user-guide.md` (source) **and**
  `docs/guides/school-forms-user-guide.pdf` (rendered), plus `docs/guides/images/`.
- **Branded** means the print CSS uses the WCPSS palette already in the app
  (navy `#165788`, orange `#df6d1c`, Open Sans) and the cover carries `/wcpss-logo.svg`.
- **Committed to Guides** means output paths are under `docs/guides/` and are tracked in git
  (not gitignored).
