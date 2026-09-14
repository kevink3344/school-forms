# Plan — Adopt the WCPSS CSS Style for School Forms

**Status:** ✅ Implemented (2026-09-13) — WCPSS stylesheet only
**Date:** 2026-09-13
**Source of truth (reference):** `C:\Users\kkey2\Desktop\Gitlab code\hr-reporting-local`
**Target:** `school-forms-v1` client (`client/src/styles/global.css` + `client/index.html`)

---

## 1. Goal

Restyle the School Forms SPA so it visually matches the **WCPSS design system** used in the
HR Reporting app, **without changing any component markup, class names, or behavior**.

The reference project contains two stylesheets:

| File | Role | Verdict |
| --- | --- | --- |
| `client/src/styles.css` (564 lines) | The app's *own* theme — Space Grotesk / green-brown "editorial" look, plus a **dark theme** and a huge pile of app-specific selectors (`.report-*`, `.record-*`, `.position-*`). | **Do NOT copy.** Wrong palette and 90% of the selectors don't exist in School Forms. |
| `docs/css/wcpss.css` (143 lines) | A **standalone, dependency-free, token-driven design system** explicitly documented as "reusable" and "drop-in safe". Palette from wcpss.net: navy `#165788`, orange `#df6d1c`, Open Sans + Roboto Mono, 4px radius. | **This is the one to adopt.** |

**Decision:** Port the *tokens and visual language* of `wcpss.css` into the existing
`global.css`, re-pointing its selectors at School Forms' own class names. We are **not**
copying `wcpss.css` verbatim, because its classes (`.wcpss-header`, `.wcpss-card`, …) do not
match School Forms' markup (`.banner`, `.card`, `.grid`, …).

---

## 2. Why not just drop `wcpss.css` in?

`wcpss.css` is scoped under a `.wcpss` class and every component uses `wcpss-`-prefixed class
names. School Forms uses a completely different, already-established set of class names
(`.app-shell`, `.banner`, `.sidebar`, `.card`, `.grid`, `.field-list`, `.filter-bar`, …) across
**15 TSX files / ~450 className usages**. Adopting the reference verbatim would require editing
every component. Instead we keep the markup and **swap the design tokens + restyle the existing
selectors** — a CSS-only change, which is far lower risk and keeps the diff reviewable.

---

## 3. Current state (School Forms)

- **Single stylesheet:** `client/src/styles/global.css` (791 lines), imported once in
  `client/src/main.tsx` (`import "./styles/global.css";`).
- **Current look:** "TeamSupportPro" theme — navy `#0d2f4f` header/sidebar, blue accent
  `#0078d4`, Work Sans + JetBrains Mono, 2px radius, soft large shadows.
- **Tokens** live in a `:root` block at the top (lines 1–24) and are referenced throughout via
  `var(--…)`: `--accent`, `--button-bg`, `--header-bg`, `--menu-bg`, `--text`, `--text-muted`,
  `--app-bg`, `--card-bg`, `--panel-bg`, `--border`, `--input-bg`, `--radius`, `--shadow-card`.
- **Sections:** Design tokens → Shell (banner/sidebar/main/page-head) → Staff queue table/card
  toggle → Comment thread → Responsive (<768px) → Login split layout.
- **Fonts** loaded in `client/index.html` via a Google Fonts `<link>` (Work Sans, JetBrains Mono).

### Class-name inventory (the surface we must restyle)

Shell/layout: `app-shell`, `banner`, `logo`, `logo-badge`, `logo-text`, `actions`, `user-chip`,
`avatar`, `u-meta`, `u-name`, `u-school`, `body-flex`, `sidebar`, `nav-label`, `sidebar-link`,
`s-label`, `banner-toggle`, `main`, `page-head`, `title-block`, `head-actions`.

Surfaces: `card`, `card-head`, `card-body`, `card-foot`, `panel`, `divider`, `collapse-head`,
`collapse-title-wrap`, `collapse-title`, `collapse-body`, `sub`.

Tables/lists: `grid`, `grid-wrap`, `grid-row`, `cell-strong`, `cell-mono`, `queue-list`,
`queue-item`, `field-list`, `field`, `f-label`, `f-value`, `status-track`, `badge`,
`badge-blue`, `badge-button`, `view-toggle`.

Forms/controls: `filter-bar`, `filter-group`, `filter-spacer`, `cf`, `toggle`, `track`, `thumb`,
`edit-input`, `form-grid`, `field-edit-grid`, `field-actions`, `clear`.

Buttons: `primary-button`, `secondary-button`, `icon-button`, `link-name`.

Overlays: `modal`, `modal-head`, `modal-body`, `modal-foot`, `drawer`, `drawer-overlay`,
`drawer-head`, `drawer-body`, `drawer-foot`.

States: `loading-state`, `empty-state`, `spinner`, `alert-error`, `alert-success`, `muted-note`,
`pdf-viewer`, `pdf-toolbar`, `pdf-stage`.

Login: `login-split`, `login-card`, `login-auth`.

---

## 4. Target design system (extracted from `wcpss.css`)

### 4.1 Palette

| Token | Value | Use |
| --- | --- | --- |
| Primary (navy) | `#165788` | Header, sidebar, buttons, links, bars |
| Primary strong | `#10405f` | Hover / pressed |
| Accent (orange) | `#df6d1c` | Top rule, highlights, secondary emphasis |
| Accent strong | `#b8530d` | Orange hover |
| Ink | `#525252` | Body copy |
| Ink strong | `#23303a` | Headings |
| Muted | `#7b8794` | Labels, secondary copy |
| BG | `#ffffff` | Page background |
| Surface | `#fafbfc` | Card headers/footers |
| Line | `#dde3ea` | Borders |
| Line soft | `#eef1f5` | Dividers, bar tracks |
| Navy tint | `#f2f7fb` / line `#d7e6f2` | Info backgrounds |
| Orange tint | `#fdf1e7` / line `#f2d3b8` | Warnings, badges |
| Vacant | bg `#fdf1e7` fg `#a8500f` | Pending / flagged |
| Filled | bg `#eaf3f9` fg `#124a72` | Resolved / submitted |

### 4.2 Type, shape, elevation

- **Fonts:** `Open Sans` (body + headings), `Roboto Mono` (numbers, codes, IDs — tabular).
- **Radius:** `4px` (controls), `2px` (small).
- **Shadows:** `--shadow-1: 0 4px 14px rgba(22,87,136,.14)`,
  `--shadow-2: 0 10px 24px rgba(16,64,95,.18)`.
- **Focus:** `2px solid #165788`, `outline-offset: 2px`.
- **Layout:** content wrap `1100px` (wide `1240px`), gutter `24px`.

### 4.3 Signature elements to reproduce

- **6px orange top rule** above the header (the wcpss.net bar) → maps onto the top of `.banner`.
- **White header with navy text** and a navy brand mark, instead of the current navy banner.
- **Crisp 4px corners**, thin `#dde3ea` borders, minimal shadow — replacing the current 2px
  radius + heavy `0 30px 80px` shadow.

---

## 5. Approach — token remap first, selector polish second

Two phases, so we can stop after Phase 1 if the palette alone is enough.

### Phase 1 — Remap the design tokens (highest impact, lowest risk)

Rewrite the `:root` block in `global.css` so every existing `var(--…)` reference inherits the
WCPSS look. **No selector changes** — the whole app re-skins instantly.

| Existing token | New value | Note |
| --- | --- | --- |
| `--font` | `'Open Sans', 'Segoe UI', sans-serif` | was Work Sans |
| `--font-mono` | `'Roboto Mono', 'Courier New', monospace` | was JetBrains Mono |
| `--accent` | `#165788` | was `#0078d4` |
| `--button-bg` | `#165788` | |
| `--button-text` | `#ffffff` | |
| `--header-bg` | `#165788` | navy banner/sidebar |
| `--menu-bg` | `#10405f` | sidebar hover depth |
| `--text` | `#23303a` | ink strong |
| `--text-muted` | `#7b8794` | |
| `--app-bg` | `#ffffff` | was `#f4f7fb` |
| `--card-bg` | `#ffffff` | |
| `--panel-bg` | `#fafbfc` | surface |
| `--border` | `#dde3ea` | |
| `--input-bg` | `#ffffff` | |
| `--radius` | `4px` | was `2px` |
| `--shadow-card` | `0 4px 14px rgba(22,87,136,.14)` | was the huge soft shadow |

**Also update `client/index.html`** to load Open Sans + Roboto Mono instead of Work Sans +
JetBrains Mono (keep the existing `preconnect` links).

### Phase 2 — Selector-level polish

Add/adjust rules so the signature WCPSS details land. Each item is a small, localized edit:

1. **Orange top rule** — add a 6px `#df6d1c` bar at the very top of `.app-shell` (via
   `border-top` or a `::before`).
2. **Header** — `.banner`: white background, `#dde3ea` bottom border, navy text; `.logo-badge`
   becomes a navy square (2px radius) with white lettering.
3. **Sidebar** — `.sidebar`: navy `#165788`; `.sidebar-link.active` uses a lighter navy
   (`#10405f`) or orange left-rule instead of the solid blue fill.
4. **Cards** — `.card`: `1px solid var(--border)`, `4px` radius, `--shadow-card`; `.card-head`
   uses `--panel-bg` with a bottom border.
5. **Tables** — `table.grid`: uppercase `#7b8794` `th`, `--line-soft` row dividers, navy hover
   tint `#f2f7fb`; `.cell-mono` uses `--font-mono`.
6. **Buttons** — `.primary-button` navy → hover `#10405f`; `.secondary-button` navy outline on
   white; `.badge-button`/`.badge-blue` use navy tint `#f2f7fb` / `#d7e6f2`.
7. **Status badges** — `.badge`: vacant/flagged → orange tint `#fdf1e7`/`#a8500f`;
   resolved/submitted → `#eaf3f9`/`#124a72`.
8. **Forms** — inputs get `1px solid var(--border)`, `4px` radius, navy focus ring
   (`0 0 0 3px rgba(22,87,136,.14)`); `.toggle .track`/`.thumb` recolored to navy.
9. **Login** — `.login-card` left panel (`.login-auth`) navy gradient; primary button navy.
10. **Alerts** — `.alert-error` orange tint, `.alert-success` navy/teal tint, both with
    matching `*-line` borders.
11. **Responsive** — leave the existing `<768px` block intact; only colors change via tokens.

---

## 6. Files to change

| File | Change |
| --- | --- |
| `client/src/styles/global.css` | Rewrite `:root` tokens (Phase 1); add/adjust the ~11 selector groups (Phase 2). **Only file with real CSS churn.** |
| `client/index.html` | Swap the Google Fonts `<link>` to Open Sans + Roboto Mono. |
| `docs/plans/css-style.md` | This plan. |

**No TSX files change.** No class names change. No component logic changes.

---

## 7. Optional — dark mode (out of scope unless requested)

`wcpss.css` documents a token-only dark mode (`[data-theme="dark"]`), and the reference app
supports it. School Forms has **no** theme toggle today. Adding dark mode would mean: a theme
toggle in the banner, a `data-theme` attribute on `<html>`, and a `[data-theme="dark"]` token
block. **Recommend deferring** to a separate plan — it's a feature, not a restyle.

---

## 8. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Inline `style={{}}` in TSX overrides tokens (e.g. `color: "var(--text-muted)"`). | Those still work — they reference the same tokens we're remapping. Verify no hard-coded hex in TSX. |
| `.pdf-*` classes are not in the current `global.css` section list. | Grep confirmed `.pdf-viewer`, `.pdf-toolbar`, `.pdf-stage` are used; confirm they're styled somewhere before editing, add if missing. |
| Font swap changes metrics → layout shifts. | Open Sans is slightly wider than Work Sans; spot-check the login card and queue table at 1280px and 390px. |
| Low-contrast text after palette change. | Verify `#7b8794` on `#ffffff` (4.5:1) and navy-on-white for links. |

---

## 9. Verification plan

1. `npm run dev` (server + client); open `http://localhost:5173`.
2. Walk every route and confirm the WCPSS look: Login, Register, Parent submit/confirmation,
   Staff queue, Staff submission detail, Staff documents, Admin dashboard/forms/form designer/
   schools/settings.
3. Check states: loading spinner, empty state, error/success alerts, modal, drawer, PDF viewer.
4. Responsive check at 1280px, 768px, and 390px (the table→card switch at `<768px`).
5. Confirm fonts load (Open Sans / Roboto Mono) and no FOUT regression.
6. `npm run typecheck` (unchanged, but run to be safe).

---

## 10. Open decisions for review

1. **Scope of Phase 2** — do all 11 polish items, or stop after Phase 1 (tokens only)?
2. **Header treatment** — white WCPSS header (as in `wcpss.css`) vs. keeping a navy banner but
   recolored to `#165788`? The reference system is white-header; the current app is navy.
3. **Sidebar** — keep the navy sidebar (recolored) or move to the light `wcpss.css` pattern?
4. **Dark mode** — defer (recommended) or include?
5. **Fonts** — confirm Open Sans + Roboto Mono is acceptable vs. keeping Work Sans.

---

## 11. Implementation log (2026-09-13)

**Decision taken:** "Copy only the WCPSS stylesheet." → Adopted **`docs/css/wcpss.css`** only;
**`client/src/styles.css`** (the HR Reporting app's own theme) was **not** used.

**Phase 1 — tokens (`client/src/styles/global.css`)**
- Replaced the `:root` block with the WCPSS palette: navy `#165788` (primary), orange `#df6d1c`
  (accent), ink `#23303a`, muted `#7b8794`, bg `#ffffff`, surface `#fafbfc`, line `#dde3ea`,
  line-soft `#eef1f5`, tints `#f2f7fb`/`#d7e6f2` and `#fdf1e7`/`#f2d3b8`, status
  `#fdf1e7`/`#a8500f` and `#eaf3f9`/`#124a72`.
- Added `--accent-strong`, `--wcpss-orange`, `--wcpss-orange-strong`, `--tint`, `--tint-line`,
  `--orange-tint`, `--orange-tint-line`, `--vacant-bg`, `--vacant-fg`, `--filled-bg`,
  `--filled-fg`, `--line-soft`, `--radius-sm`, `--shadow-2`.
- Radius `2px → 4px`; shadow `0 30px 80px` → `0 4px 14px rgba(22,87,136,.14)`.
- Fonts `Work Sans`/`JetBrains Mono` → `Open Sans`/`Roboto Mono`.
- **`client/index.html`:** swapped the Google Fonts `<link>` to Open Sans + Roboto Mono.

**Phase 2 — selector polish**
- `.app-shell` — 6px orange top rule (`border-top`).
- `.banner` — white background, `--border` bottom rule, navy/dark text; `.logo-badge` square
  (`--radius-sm`) navy with white lettering; `.user-chip` light surface; `.u-school` muted.
- `.sidebar-link.active` — `--menu-bg` fill + 3px orange inset left-rule (was solid blue).
- `.primary-button` — navy with `--accent-strong` hover; disabled `#a9c1d4`.
- `.secondary-button` — navy outline; hover navy tint.
- `.badge-button` / `.icon-button` — navy-tint hover instead of solid blue.
- `.card-head` / `.card-foot` — `--panel-bg` surface + `--line-soft` borders.
- `table.grid thead th` — **solid navy header with white text**; row hover `--tint`; zebra
  `--panel-bg`; `.cell-mono` tabular-nums.
- `.filter-group` inputs — navy focus ring (`0 0 0 3px rgba(22,87,136,.14)`).
- `.alert-error` → orange tint; `.alert-success` → navy tint.
- `.badge-*` — remapped to WCPSS tint/vacant/filled tokens.
- `.view-toggle`, `.tabs .tab.active`, `.queue-item:hover`, `.comment-mine`,
  `.export-preview thead th`, `.pdf-toolbar-link:hover` — recolored to navy/orange.
- `.login-split` — orange top rule; `.login-card` — 1px border + 4px radius.

**Verification**
- CSS braces balanced (303/303).
- `npm run typecheck:client` — passes.
- Rendered `/staff` in the browser — white header, navy sidebar with orange active rule,
  navy table headers, WCPSS palette confirmed. No stale palette hex remains in the CSS.

**Not done (per "WCPSS only"):** the reference app's own `styles.css` theme and its dark-mode
toggle were intentionally excluded. Dark mode remains deferred (see §7).

---

## 12. Refinement — cleaner / minimalistic pass (2026-09-13)

After reviewing screenshots of the HR Reporting app, the theme was simplified to match its
cleaner, more minimalistic aesthetic. Changes in `client/src/styles/global.css`:

- **Removed the 6px orange top rule** from `.app-shell` (and `.login-split`).
- **Header** — taller (64px), 24px padding; `.logo-badge` is now a 4px-radius navy square;
  `.user-chip` is **borderless/transparent** with right-aligned name/school; `.avatar` uses the
  navy tint (`--tint`) with navy text instead of a solid navy circle.
- **Sidebar** — switched from navy to **light**: white background, `--border` right rule, dark
  text; `.sidebar-link.active` is a subtle `--tint` fill with navy text + bold (no orange rule);
  hover is `--panel-bg`.
- **Icon buttons** — fully **borderless & transparent**, muted color, `--panel-bg` hover.
- **Cards** — `.card-head` / `.card-foot` now have transparent backgrounds (no `--panel-bg` fill)
  and `--border` rules; body padding 20px.
- **Tables** — `table.grid thead th` is now **transparent with muted uppercase text** (was solid
  navy with white text); zebra striping removed; row hover is `--panel-bg`; roomier padding
  (12–14px 16px).

Verified: CSS braces balanced (304/304), no orphaned declarations, `npm run typecheck:client`
passes, and the rendered `/login` and `/staff` pages confirm the clean minimal look.
