# Plan — Staff User Guide (HTML → PDF, with screenshots)

**Status:** Implemented — see §14 for what shipped
**Date:** 2026-10-25
**Deliverable:** A staff-only, screenshot-driven PDF guide, authored as HTML and rendered to PDF
**Supersedes (for staff):** Part 3 of [user-guide.md](./user-guide.md) — the all-roles guide

---

## 1. Goal

Give every **Staff** and **School Contact** account a printable guide that answers "how do I
do X?" for the work they actually do — without admin material they cannot use.

The guide is **task-oriented**, **screenshot-first** (one figure per task), and **accurate to
the shipped UI**. Every button and label it names must exist in the app.

---

## 2. Audience

| Role | In scope? | Notes |
| --- | --- | --- |
| `staff` | **Yes** | Organization-wide access; sees every school's submissions |
| `cdm_contact` (School Contact) | **Yes** | Same screens, locked to one school; no School filter |
| `admin` | **No** | Covered by [user-guide.md](./user-guide.md) Part 2 |
| Parent / anonymous | **No** | Out of scope (see §11) |

The guide is written for both staff roles, with **School Contact differences called out in
callouts** rather than in a separate part. Where the two differ, the difference is one line:
"School Contacts see only their own school and have no **School** filter."

---

## 3. Why a separate HTML guide

The existing `docs/guides/user-guide.md` is Markdown rendered by `md-to-pdf`
(`npm run guide:pdf`). It is good for the admin half and should stay.

This guide is **HTML-authored** for four reasons:

1. **Figure layout.** A screenshot plus its numbered callout list needs a two-column figure
   block (`<figure>` + `<figcaption>` with an `<ol>`). Markdown cannot express that, and CSS
   alone cannot invent the structure.
2. **Callouts on the image.** Numbered badges are positioned over the screenshot. That needs
   an absolutely-positioned overlay element inside the figure.
3. **Print control.** Per-part page breaks, running headers per part, and "keep this figure
   on one page" are far easier with explicit classes than with Markdown heuristics.
4. **It reuses the app's own CSS variables** (navy `#165788`, orange `#df6d1c`, Open Sans),
   so the guide looks like the product.

Rendering stays the same toolchain the repo already has: **headless Chromium via
`md-to-pdf`'s bundled Puppeteer**, or a tiny Playwright/Chrome print step. No new runtime.

---

## 4. Proposed table of contents

```
Cover — School Forms Staff Guide (logo, version, date)
Contents
How to use this guide (figure conventions, callout legend)

PART 1 — GETTING STARTED
  1.1  What School Forms does for you
  1.2  Signing in                      [F1  login — password mode]
  1.3  Creating your account           [F2  registration]
  1.4  Finding your way around         [F3  banner + open menu, annotated]
  1.5  Reading system messages         [F4  system message bar]

PART 2 — FORMS AND ACCESS
  2.1  Viewing the forms you can open  [F5  Available Forms — My forms]
  2.2  Requesting access to a form     [F6  Available to request]
  2.3  Tracking and withdrawing a request [F7  Requested]
  2.4  Opening a form from the list    [F8  Open → queue filtered to that form]
  2.5  When a form is locked           [F9  Locked form panel]

PART 3 — YOUR SUBMISSIONS QUEUE
  3.1  The queue at a glance           [F10 queue, annotated]
  3.2  Filtering by status             [F11 status chips active]
  3.3  Filtering by form               [F12 Forms dropdown]
  3.4  Choosing columns                [F13 Columns drawer]
  3.5  Showing archived submissions    [F14 Show archived only + notice]
  3.6  Opening a submission            [F15 Review button]

PART 4 — FILLING IN STAFF-ONLY FIELDS  (the core of the guide)
  4.1  What staff-only fields are      [F16 staff-only columns washed + pencil hint]
  4.2  Fill in a field "inline" from the queue
       4.2.1 Text, number, date, email  [F17 cell in edit mode]
       4.2.2 Dropdown (Select)          [F18 select commits on change]
       4.2.3 Radio / Checkbox           [F19 option menu]
       4.2.4 Toggle (Yes / No)          [F20 toggle in a cell]
       4.2.5 Keyboard and save rules    [F21 saved-flash state]
  4.3  Fill in staff-only fields from submission details
       4.3.1 Open the Staff-only fields card   [F22 card, annotated]
       4.3.2 Save and read the audit note      [F23 "Last saved by …"]
  4.4  Which method should I use?      (decision table, no figure)

PART 5 — REVIEWING A SUBMISSION
  5.1  The submission detail page      [F24 full page, annotated]
  5.2  Changing the status             [F25 Select Status dropdown]
  5.3  Editing a parent's answers      [F26 edit mode]
  5.4  Additional fields from a Google Form [F27 Additional fields card]
  5.5  Archiving and restoring         [F28 Archive / archived notice]

PART 6 — DOCUMENTS
  6.1  Generated Documents list        [F29 documents table]
  6.2  Opening in Google Docs / View PDF [F30 PDF drawer]
  6.3  Documents from a submission     [F31 document line on detail page]

PART 7 — REPORTS AND EXPORT
  7.1  Building a report               [F32 Reports toolbar]
  7.2  Selecting columns               [F33 Select Columns drawer]
  7.3  Grouping rows                   [F34 grouped preview]
  7.4  Saving a view                   [F35 Save View panel]
  7.5  Exporting CSV / Excel / PDF     [F36 Export]
  7.6  Quick export from the queue     [F37 Export Submissions drawer]

PART 8 — YOUR ACCOUNT
  8.1  Changing your password          [F38 account menu → Change password]
  8.2  The password form               [F39 three fields + Update password]
  8.3  Forced password reset           [F40 /account/password/required]
  8.4  Signing out                     [F41 log-out button]

PART 9 — REFERENCE
  9.1  Status meanings
  9.2  Field types
  9.3  "I can't see it" — menu items, documents, fields
  9.4  Troubleshooting
  9.5  Glossary
```

**Figure count: 41.** Each figure is captioned "Figure N — …" and referenced by number in
the steps.

---

## 5. Screenshot inventory

All captures use the **same seeded data** and a **1440 × 900 viewport**, cropped to the
relevant region where noted. No real student data.

| # | Screen | Route | Role | Notes / what to annotate |
| --- | --- | --- | --- | --- |
| F1 | Sign In (password mode) | `/login` | none | Email, Password, **Sign In**, **Create an account** |
| F2 | Registration | `/register` | none | Full Name, School, Email, Password |
| F3 | Banner + open menu | `/staff` | staff | Hamburger, logo, user chip, log-out; menu items annotated |
| F4 | System message bar | `/staff` | staff | Title, body, audience badge, close **✕** |
| F5 | Available Forms — My forms | `/staff/forms` | staff | **Open** button; Access badge (Public / Your role / Granted) |
| F6 | Available to request | `/staff/forms` | staff | **Request access**; a declined row with its note |
| F7 | Requested | `/staff/forms` | staff | **Waiting since …** badge, **Withdraw** |
| F8 | Queue opened from a form | `/staff?form_id=1` | staff | Forms dropdown showing the named form |
| F9 | Locked form panel | `/staff?form_id=2` | staff | Locked text + **Request access** |
| F10 | Queue at a glance | `/staff` | staff | Columns, **Review**, **Columns**, **Export** |
| F11 | Status chips active | `/staff` | staff | **All / Submitted (n) / In Review / Flagged / Completed** |
| F12 | Forms dropdown | `/staff` | staff | Only shown when >1 form is open to the user |
| F13 | Columns drawer | `/staff` | staff | Ticked list, **Select all**, scope label |
| F14 | Archived view | `/staff` + **Show archived only** | staff | Archive notice strip |
| F15 | Review button | `/staff` | staff | Row **Review** → detail page |
| F16 | Staff-only columns | `/staff?form_id=1` | staff | Tinted staff columns + pencil hint on hover |
| F17 | Inline text edit | `/staff?form_id=1` | staff | Cell in edit mode, caret |
| F18 | Inline select | `/staff?form_id=1` | staff | Dropdown open, saves on change |
| F19 | Option menu | `/staff?form_id=1` | staff | Radio/checkbox menu with **Save** / **Cancel** |
| F20 | Inline toggle | `/staff?form_id=1` | staff | Toggle mid-flip |
| F21 | Saved flash | `/staff?form_id=1` | staff | Cell after save + "Saving…" state |
| F22 | Staff-only fields card | `/staff/:publicId` | staff | Card header, **Staff only** lock tag, fields, **Save staff fields** |
| F23 | Audit note | `/staff/:publicId` | staff | "Last saved by … on …" |
| F24 | Submission detail | `/staff/:publicId` | staff | Header, status, actions, answers, staff card |
| F25 | Select Status | `/staff/:publicId` | staff | Label + dropdown |
| F26 | Edit mode | `/staff/:publicId` | staff | **Edit** → **Save changes** / **Cancel** |
| F27 | Additional fields | `/staff/:publicId` | staff | Captured Google Form questions, **Promote** (admin only — show read-only) |
| F28 | Archive / archived notice | `/staff/:publicId` | staff | **Archive** button, then the archived notice |
| F29 | Generated Documents | `/staff/documents` | staff | Columns, **Open**, **View PDF**, **Refresh** |
| F30 | PDF drawer | `/staff/documents` | staff | Document Details + preview |
| F31 | Document line on detail | `/staff/:publicId` | staff | Pending spinner / generated link / **Retry** |
| F32 | Reports toolbar | `/staff/reports` | staff | Form, Saved View, **Select Columns**, Group by, Format |
| F33 | Select Columns drawer | `/staff/reports` | staff | Ticked list, footer count, **Done** |
| F34 | Grouped preview | `/staff/reports` | staff | Group header with row count |
| F35 | Save View | `/staff/reports` | staff | Name field, **Save as New** / **Update View** / **Make Default** / **Delete** |
| F36 | Export | `/staff/reports` | staff | **Export** with format chip selected |
| F37 | Export Submissions drawer | `/staff` | staff | Rows / Columns stats, **Export CSV** |
| F38 | Account menu | `/staff` | staff | User chip open, **Change password** |
| F39 | Change password | `/account/password` | staff | Current / New / Confirm, **Update password**, **Cancel** |
| F40 | Forced reset | `/account/password/required` | staff | **Temporary Password**, no Cancel, **Sign out** |
| F41 | Log out | `/staff` | staff | Log-out icon in the banner |

### 5.1 Capture rules

- **Seed first.** Run `npm run seed`, then create the two demo accounts (§6.2). Capture only
  against seeded data — never production.
- **Deterministic viewport.** 1440 × 900, device scale factor 2 (retina-crisp in print).
- **Freeze motion.** Disable CSS transitions/animations and the spinner before capture so a
  "Saving…" or "Loading…" frame is a deliberate choice, not an accident.
- **Hover states** (F16 pencil hint) are captured with `page.hover()` before the shot.
- **Annotations**: numbered badges (①②③) are added as an absolutely-positioned overlay on the
  figure in the HTML, not burned into the PNG. That keeps the PNG reusable and lets the
  callout text live in the document.
- **Crop**: full-page for page-level figures (F10, F24, F29); element-scoped for control-level
  figures (F18, F20, F25, F38).

---

## 6. How to produce it

### 6.1 File layout

```
docs/guides/staff/
  staff-guide.html        ← source (hand-authored, versioned)
  staff-guide.css         ← print stylesheet (extends ../guide.css variables)
  images/                 ← F1…F41 PNGs
  staff-guide.pdf         ← rendered output (versioned, like the existing PDF)
scripts/
  capture-staff-guide.mjs ← screenshot script (§6.3)
```

### 6.2 Prerequisites for a capture run

1. Server + client running (`npm run dev`), DB reachable.
2. `npm run seed` for schools and forms.
3. Two demo accounts (passwords are seeded, never committed):

   ```powershell
   # Staff — any school id from the seeded list
   $body = @{ email='guide.staff@schoolforms.local'; password='<seeded>'; school_id=1; display_name='Guide Staff' } | ConvertTo-Json
   Invoke-RestMethod -Uri 'http://127.0.0.1:4000/api/auth/seed-staff' -Method Post `
     -Headers @{ Authorization = "Bearer $adminToken" } -ContentType 'application/json' -Body $body
   ```

   A **School Contact** account is created by the admin in **Settings → Users** (role
   `cdm_contact`) so the two School-Contact differences (no School filter, no Documents when
   disabled) can be captured.
4. At least one **private** form the staff account cannot read (for F6/F9) and one **published
   public** form with staff-only fields (for F16–F23).
5. At least one submission per status, one archived submission, and one generated document.

### 6.3 Capture script

`scripts/capture-staff-guide.mjs` — Playwright, already the repo's browser tool:

```js
// Shape only — one entry per figure in §5.
const shots = [
  { id: "F10", role: "staff", path: "/staff", full: true },
  { id: "F18", role: "staff", path: "/staff?form_id=1",
    act: async (page) => page.getByRole("button", { name: /^Edit Course Choice 1/ }).click(),
    clip: "table" },
  // …
];
```

- Signs in once per role, reuses `storageState`.
- Writes `docs/guides/staff/images/F10-queue.png` etc.
- Exits non-zero if any selector is missing — a renamed button fails the build instead of
  producing a stale screenshot.

### 6.4 Render to PDF

```powershell
# Option A — reuse the md-to-pdf dependency already installed
npx md-to-pdf docs/guides/staff/staff-guide.html --config-file docs/guides/staff/md-to-pdf.config.js

# Option B — Chromium print directly
chrome --headless --print-to-pdf=docs/guides/staff/staff-guide.pdf `
       --no-pdf-header-footer file:///.../staff-guide.html
```

Add to the root `package.json`:

```json
"guide:staff:shots": "node scripts/capture-staff-guide.mjs",
"guide:staff:pdf":   "md-to-pdf docs/guides/staff/staff-guide.html --config-file docs/guides/staff/md-to-pdf.config.js"
```

The print config mirrors `docs/guides/md-to-pdf.config.js`: Letter, 20/18/18/18 mm margins,
footer "School Forms — Staff Guide · page N".

---

## 7. HTML structure and conventions

### 7.1 Figure pattern

```html
<figure class="shot" id="fig-18">
  <div class="shot-frame">
    <img src="images/F18-inline-select.png" alt="A staff-only column being edited inline">
    <span class="pin" style="--x:42%;--y:38%">2</span>
  </div>
  <figcaption>
    <strong>Figure 18 — Editing a dropdown inline.</strong>
    <ol><li>…</li><li>…</li></ol>
  </figcaption>
</figure>
```

CSS: `figure.shot { page-break-inside: avoid; }`, `.pin` absolutely positioned, badge in the
brand orange.

### 7.2 Task pattern

Each task subsection is exactly:

1. **What it's for** — one sentence.
2. **Steps** — numbered, ≤ 6 steps, every UI label in **bold**.
3. **Figure N** — one screenshot.
4. **Tip / Note / Warning** — a callout, only when it earns its space.

### 7.3 Writing rules

- Second person, active voice: "Click **Save staff fields**".
- Bold the exact on-screen label, including punctuation: **Save staff fields**, **Select
  Status**, **Show archived only**.
- Never invent a control. If it is not in the code, it is not in the guide.
- Destructive or irreversible actions get a **Warning** callout.
- School Contact differences get a **Note** callout, not a separate section.

### 7.4 Print CSS

- Cover page, contents page, then **one page break per Part** (`h1 { page-break-before: always }`).
- Figures never split across pages; a figure's caption stays with its image.
- Screenshots print at full content width (174 mm); control-level crops are centered at 60–80 %.
- Body 10.5 pt, captions 8.5 pt — the same scale as the existing guide.

---

## 8. Accuracy requirements

These are the traps found while writing this plan. Each must be checked against the code
before the guide is published.

| # | The guide must say | Why |
| --- | --- | --- |
| 1 | Inline editing works **only on staff-only columns**; parent answers are read-only in the grid. | `SubmissionsGrid.tsx` renders non-staff columns read-only by design. |
| 2 | **Enter** saves, **Esc** cancels, **Shift+Enter** is a newline in a text cell; clicking another cell also saves. | `StaffCell` key/blur handlers. |
| 3 | **Select**, single-option **Checkbox** and **Toggle** save the moment you change them; text-like types save on Enter/blur. | `commitsOnChange()` in `SubmissionsGrid.tsx`. |
| 4 | Radio / multi-checkbox cells open an **option menu** with **Save** / **Cancel**. | `GridOptionMenu`. |
| 5 | There is **no Table/Cards toggle** on the queue. The grid stacks into cards on a narrow screen. | The toggle was removed with the hand-rolled table. An older draft of the all-roles guide still describes it — fix that too. |
| 6 | There are **no staff comments** on a submission. | No comment UI exists in `client/src`. The all-roles guide §3.6 is stale and must be removed or corrected. |
| 7 | **Staff-only fields** on the detail page are always editable — there is no Edit step for them. **Save staff fields** is the only save. | `StaffSubmissionDetail.tsx`. |
| 8 | **Archive** is available to staff; **Delete permanently** is admin-only and never shown to staff. | `canArchive` / `canDelete`. |
| 9 | **Documents** appears only if an administrator enabled it for your role. | `useDocumentsEnabled(role)`. |
| 10 | **Available Forms**, **Reports** can be hidden by an administrator in **Settings → Menu Settings**. | `menuVisible(item)`. |
| 11 | The **School** filter does not exist for a School Contact; Reports shows a fixed school value instead. | `schoolScoped` in both pages. |
| 12 | The **Forms** filter on the queue appears only when more than one form is open to you. | `forms.length > 1`. |
| 13 | Reports search is a **text search** ("Search any field…", "Search in"), not From/To dates. | `ReportsPage.tsx`. |
| 14 | Report formats are **CSV**, **Excel**, **PDF**; the queue's quick export is **CSV** only. | `FORMATS` vs `ExportModal`. |
| 15 | The account menu (**Change password**) is on the **user chip** in the banner; there is no separate Settings page for staff. | `layout.tsx`. |
| 16 | A forced reset page has **no Cancel** — only **Sign out**. | `ChangePasswordPage` `forced` branch. |

---

## 9. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Screenshots go stale | Scripted capture (§6.3) fails loudly on a renamed control; regenerate in one command |
| Two guides drift apart | This guide owns staff content; remove Part 3 from `user-guide.md` and link to this PDF (§10) |
| Real student data in the PDF | Seeded demo accounts and forms only; a review step greps the PNG filenames and the HTML for real names |
| HTML source becomes unmaintainable | Strict figure/task templates (§7); one `<section>` per task |
| Guide too long to print | Task-level brevity: ≤ 6 steps, one figure, reference detail pushed to Part 9 |
| Staff-only fields explained twice, inconsistently | Part 4 is the single source; Part 5 links back to it |

---

## 10. Relationship to the existing all-roles guide

Decision needed (see §12, Q1). Recommended:

- `docs/guides/user-guide.md` keeps **Parts 1, 2 (admin), 4 (parents), 5 (reference)**.
- Its **Part 3 (staff)** is replaced by a one-paragraph pointer to the new staff PDF.
- The new guide is the only place staff workflows are documented in detail.

If both must stay complete, Part 3 of the Markdown guide is **corrected** to match §8 items
5, 6 and 7 — otherwise the two documents contradict each other.

---

## 11. Out of scope

- Admin workflows (form designer, users, schools, settings, webhook log, access requests).
- The parent-facing submission form and confirmation page.
- API, webhook, and Apps Script documentation (covered in `docs/features/`).
- Localization / translation.

---

## 12. Decisions needed

| # | Question | Recommended |
| --- | --- | --- |
| 1 | Replace Part 3 of the all-roles guide, or keep both complete? | **Replace** with a pointer; one source of truth per audience |
| 2 | Include School Contact as a separate part, or callouts? | **Callouts** — the screens are identical |
| 3 | Renderer: `md-to-pdf` (already installed) or a Playwright print step? | **`md-to-pdf`** — no new dependency |
| 4 | Keep the HTML source and PNGs in git alongside the PDF? | **Yes**, matching the existing guide |
| 5 | Include an appendix of keyboard shortcuts? | **No** — only the inline-edit keys, in Part 4.2.5 |

---

## 13. Verification plan

1. `npm run guide:staff:shots` completes with zero missing selectors.
2. Every figure in §5 exists in `docs/guides/staff/images/` and is referenced exactly once.
3. Every bolded label in the HTML is present in the client source (spot-check against §8).
4. The rendered PDF has a cover, contents, page numbers, and numbered figures.
5. No figure is split across pages; no caption is orphaned from its image.
6. No real student names or emails appear in the HTML or the PNGs.
7. A staff demo account can follow every task end to end without hitting a hidden control.

---

## 14. What shipped (2026-10-25)

### Files

| File | Purpose |
| --- | --- |
| `docs/guides/staff/staff-guide.html` | The guide source (hand-authored HTML) |
| `docs/guides/staff/staff-guide.css` | Print stylesheet — WCPSS palette, figure/pin/callout model |
| `docs/guides/staff/md-to-pdf.config.js` | Render config (Letter, footer, page numbers) |
| `docs/guides/staff/staff-guide.pdf` | The rendered PDF (~4 MB, 25 pages) |
| `docs/guides/staff/images/` | 24 figure PNGs at 2880×1800 (1440×900 @ 2x) |
| `scripts/capture-staff-guide.mjs` | Puppeteer capture script |
| `package.json` | `guide:staff:shots` and `guide:staff:pdf` scripts |

### Deviations from the plan

| Planned | Shipped | Why |
| --- | --- | --- |
| Playwright for capture | **Puppeteer** | Already installed as `md-to-pdf`'s renderer — no second browser download |
| 41 figures | **24** | Several planned figures were merged (e.g. all inline-edit types share one figure) or dropped where the UI has no such control |
| `?form_id=` deep link | **Forms dropdown** | The queue does not read the query string; the dropdown is the real interaction |
| Separate School Contact part | **Callouts** | Screens are identical; only the School filter differs |
| 20-figure capture on the sandbox | 24 captured | Includes Reports, Documents, account menu and the password form |

### Figures captured

1 Sign-in · 2 Menu · 3 Available Forms · 4 Requested · 5 Queue · 6 Status chip —
7 Form filter · 8 Columns drawer · 9 Archived view · 10 Staff-only columns —
11 Inline text · 12 Inline toggle · 13 Staff-only fields card · 14 Submission detail —
15 Status control · 16 Edit mode · 17 Documents · 18 PDF preview · 19 Reports —
20 Report columns · 21 Grouped report · 22 Export drawer · 23 Account menu · 24 Password form

### Not captured (documented in prose instead)

- **Registration** - the sandbox runs in Select-User mode, so the registration link is not
  rendered. Documented as a Tip in section 1.2.
- **Available-to-request / Locked panel** - no private form is locked to the staff demo account
  in the sandbox. Documented in prose in section 2.2.
- **Additional fields** - no CDM submission carries captured Google Form questions.
- **Document line on a submission** - no CDM submission has a generated document.
- **Forced password reset** - requires an admin to set a temporary password.

Re-capture any of these by adding a figure entry to `scripts/capture-staff-guide.mjs` once the
sandbox contains the state.

### Verification performed

- `npm run guide:staff:shots` - all 24 figures captured, zero missing selectors.
- Guide structure: 24 figures numbered 1-24 sequentially, 0 broken images, 0 pins outside
  their frame, 0 broken internal anchors, 9 tables, 22 callouts.
- `npm run guide:staff:pdf` - renders without error (25 pages, ~4 MB).

### Still to do

1. **Visual proof-read of the PDF** - the pin positions were computed from measured element
   rectangles but have not been eyeballed page by page.
2. **Redact demo names** if the guide is published outside the district - the sandbox contains
   test records such as "Suzy Smith" and "x".

### Done after the first render

- **Part 3 of `user-guide.md` replaced** with a pointer to this guide, and its contents list
  updated to match. The two stale claims listed in section 8 (the removed Table/Cards toggle and
  the non-existent staff comments) are gone with it. `npm run guide:pdf` re-rendered cleanly.
- **Figure 1 re-captured in password mode.** The sandbox runs in Select-User (test) mode, so its
  login screen shows Organization and Test User lists ? a screen no staff member ever uses. The
  figure is now captured from the production site, which renders the real Email and Password
  boxes. `GUIDE_LOGIN_URL` controls this, and the capture asserts `#password` exists so it
  fails rather than silently documenting the wrong screen. Pins were re-measured against the
  live element rectangles (Email 1002,431 ? Password 1002,501 ? Sign In 1002,551 ?
  Create an account 927,596) and verified to map back to those exact source pixels.
