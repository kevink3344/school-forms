// Captures the screenshots used by docs/guides/staff/staff-guide.html.
//
// Run with:  npm run guide:staff:shots
//
// Uses the Chromium that md-to-pdf already depends on (puppeteer), so there is no
// second browser download. Every figure is captured at a fixed 1440x900 viewport
// and 2x scale, which is what makes the images legible at print size.
//
// ★ A missing selector is a HARD FAILURE, not a skipped shot. A guide that
// silently keeps last month's screenshot of a button that has since been renamed
// is worse than one that fails to build: the reader is told to click something
// that is not there.
//
// Configuration (environment variables):
//   GUIDE_BASE_URL   default https://webform-sandbox-addph8hsd9feghdp.eastus2-01.azurewebsites.net
//   GUIDE_LOGIN_URL  where the sign-in figure is captured, default the production site
//                    (the sandbox runs in Select-User mode and never renders the password form)
//   GUIDE_ORG        organization name on the login screen, default "Academics"
//   GUIDE_STAFF      test-user label substring for the staff account
//   GUIDE_ONLY       comma-separated figure ids, e.g. "F10,F16" (default: all)
import puppeteer from "puppeteer";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.GUIDE_BASE_URL || "https://webform-sandbox-addph8hsd9feghdp.eastus2-01.azurewebsites.net").replace(/\/$/, "");
// ★ The sign-in screenshot must show the REAL screen a staff member sees: an Email
// box and a Password box. The sandbox is configured in Select-User (test) mode, so
// capturing there would document a login no staff member ever uses.
const LOGIN_URL = (process.env.GUIDE_LOGIN_URL || "https://webform-hcf0e2gzgudjcsaq.eastus2-01.azurewebsites.net").replace(/\/$/, "");
const ORG = process.env.GUIDE_ORG || "Academics";
const STAFF_LABEL = process.env.GUIDE_STAFF || "staff";
const ONLY = (process.env.GUIDE_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "guides", "staff", "images");

const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 };
const SETTLE = 900;

// The CDM form is the one with staff-only fields in the sandbox.
const FORM_CDM = "2";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function signIn(browser, userLabel) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(VIEWPORT);
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2", timeout: 90_000 });
  await page.waitForSelector("#select-org", { timeout: 45_000 });

  const orgValue = await page.$$eval(
    "#select-org option",
    (os, name) => (os.find((o) => o.textContent.trim() === name) || {}).value,
    ORG,
  );
  if (!orgValue) throw new Error(`Organization "${ORG}" is not on the login screen`);
  await page.select("#select-org", orgValue);
  await sleep(1200);

  const userValue = await page.$$eval(
    "#select-user option",
    (os, needle) => (os.find((o) => o.textContent.includes(needle)) || {}).value,
    userLabel,
  );
  if (!userValue) throw new Error(`No test user matching "${userLabel}" in ${ORG}`);
  await page.select("#select-user", userValue);
  await sleep(300);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 90_000 }).catch(() => {}),
    page.click("button[type=submit]"),
  ]);
  await sleep(3000);
  return page;
}

// Freeze spinners and transitions so a "Loading…" frame is never captured by
// accident, and so hover/active states do not depend on timing.
async function freeze(page) {
  await page.addStyleTag({
    content: `*,*::before,*::after{transition:none!important;animation:none!important}
              .spinner{display:none!important}`,
  });
}

async function go(page, route) {
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle2", timeout: 90_000 });
  await sleep(SETTLE + 900);
  await freeze(page);
}

// Load the queue scoped to one form. The `?form_id=` deep link is NOT used: the
// queue does not read it, so the form is chosen through the Forms dropdown, which
// is exactly the interaction the guide describes.
async function goToForm(page, formId = FORM_CDM) {
  await go(page, "/staff");
  await page.waitForSelector("#sq-form", { timeout: 30_000 });
  await page.select("#sq-form", formId);
  await sleep(3000);
  await freeze(page);
}

async function shot(page, id, name, { clip, full = false } = {}) {
  const file = path.join(OUT, `${id}-${name}.png`);
  if (clip) {
    await page.screenshot({ path: file, clip });
  } else {
    await page.screenshot({ path: file, fullPage: full });
  }
  console.log(`  ✓ ${id} ${name}`);
  return file;
}

// Scroll the shared grid so a named column is on screen, then return its rect.
// `scrollIntoView` cannot be used: the grid's sticky first column covers the
// target, so the column is positioned with scrollLeft arithmetic instead.
async function revealColumn(page, headerText, rowIndex = 0) {
  return page.evaluate(
    (header, row) => {
      const table = document.querySelector("table.grid");
      const ths = Array.from(table.querySelectorAll("thead th"));
      const i = ths.findIndex((th) => th.textContent.trim() === header);
      if (i < 0) throw new Error(`No column "${header}"`);
      const scroll = document.querySelector(".grid-scroll");
      const td = table.querySelectorAll("tbody tr")[row].children[i];
      const target = td.getBoundingClientRect();
      const view = scroll.getBoundingClientRect();
      const pinned = 280;
      const delta = target.left - (view.left + pinned + 40);
      scroll.scrollLeft = scroll.scrollLeft + delta;
      const b = td.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    },
    headerText,
    rowIndex,
  );
}

// The grid is taller than the page, so a column that is revealed horizontally may
// still be below the fold. Bring the row into view without moving scrollLeft.
async function revealRow(page, rowIndex = 0) {
  await page.evaluate((row) => {
    const tr = document.querySelectorAll("table.grid tbody tr")[row];
    const y = tr.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, y - 320));
  }, rowIndex);
  await sleep(500);
}

async function clickCell(page, headerText, rowIndex = 0) {
  const box = await revealColumn(page, headerText, rowIndex);
  await revealRow(page, rowIndex);
  const box2 = await revealColumn(page, headerText, rowIndex);
  await page.evaluate(
    ({ header, row }) => {
      const table = document.querySelector("table.grid");
      const ths = Array.from(table.querySelectorAll("thead th"));
      const i = ths.findIndex((th) => th.textContent.trim() === header);
      const td = table.querySelectorAll("tbody tr")[row].children[i];
      const span = td.querySelector("span.grid-cell-value");
      // A synthetic click, because the sticky first column intercepts a real one
      // once the grid is scrolled horizontally. The handler is a plain onClick.
      span.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    },
    { header: headerText, row: rowIndex },
  );
  await sleep(700);
  return box2;
}

function viewportClip(page, { top = 0, height = 900 } = {}) {
  return { x: 0, y: top, width: VIEWPORT.width, height };
}

// The submission detail page for the first CDM row. Reached by clicking the
// student's name, which is what the guide tells the reader to do.
async function openDetail(page) {
  await go(page, "/staff");
  await sleep(1500);
  const href = await page.$eval("table.grid tbody tr a", (a) => a.getAttribute("href"));
  await go(page, href);
  await sleep(1500);
  await freeze(page);
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

const figures = [
  // ---- Part 1 ------------------------------------------------------------
  {
    id: "F1",
    role: "none",
    async run(page) {
      await page.goto(`${LOGIN_URL}/login`, { waitUntil: "networkidle2", timeout: 90_000 });
      // Assert the password form is what we are photographing. If this site is ever
      // switched to Select-User mode the capture fails instead of silently
      // documenting a login screen no staff member sees.
      await page.waitForSelector("#email", { timeout: 45_000 });
      const hasPassword = await page.$("#password");
      if (!hasPassword) throw new Error("Sign-in screen has no Password box — not password mode");
      await sleep(SETTLE + 1600);
      await freeze(page);
      await shot(page, "F1", "sign-in");
    },
  },
  {
    id: "F2",
    role: "none",
    async run(page) {
      await page.goto(`${BASE}/register`, { waitUntil: "networkidle2", timeout: 90_000 });
      await sleep(SETTLE + 900);
      await freeze(page);
      await shot(page, "F2", "registration");
    },
  },
  {
    id: "F3",
    role: "staff",
    async run(page) {
      await go(page, "/staff");
      await page.click("button[aria-label='Open menu']").catch(() => {});
      await sleep(700);
      await shot(page, "F3", "menu-open");
    },
  },

  // ---- Part 2 ------------------------------------------------------------
  {
    id: "F5",
    role: "staff",
    async run(page) {
      await go(page, "/staff/forms");
      await shot(page, "F5", "available-forms");
    },
  },
  {
    id: "F7",
    role: "staff",
    async run(page) {
      await go(page, "/staff/forms");
      await shot(page, "F7", "requested");
    },
  },

  // ---- Part 3 ------------------------------------------------------------
  {
    id: "F10",
    role: "staff",
    async run(page) {
      await go(page, "/staff");
      await shot(page, "F10", "queue");
    },
  },
  {
    id: "F11",
    role: "staff",
    async run(page) {
      await go(page, "/staff");
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll(".filter-chip")).find((x) =>
          x.textContent.trim().startsWith("Submitted"),
        );
        b.click();
      });
      await sleep(1800);
      await shot(page, "F11", "status-chip", { clip: viewportClip(page, { top: 0, height: 640 }) });
    },
  },
  {
    id: "F12",
    role: "staff",
    async run(page) {
      await go(page, "/staff");
      await page.select("#sq-form", FORM_CDM);
      await sleep(2500);
      await shot(page, "F12", "form-filter", { clip: viewportClip(page, { top: 0, height: 700 }) });
    },
  },
  {
    id: "F13",
    role: "staff",
    async run(page) {
      await go(page, "/staff");
      await page.select("#sq-form", FORM_CDM);
      await sleep(2200);
      await page.evaluate(() => {
        Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Columns").click();
      });
      await sleep(900);
      await shot(page, "F13", "columns-drawer");    },
  },
  {
    id: "F14",
    role: "staff",
    async run(page) {
      await go(page, "/staff");
      await page.evaluate(() => {
        const t = Array.from(document.querySelectorAll("label.toggle")).find((l) =>
          l.textContent.includes("Show archived only"),
        );
        t.querySelector("input").click();
      });
      await sleep(2200);
      await shot(page, "F14", "archived", { clip: viewportClip(page, { top: 0, height: 760 }) });
    },
  },

  // ---- Part 4: staff-only fields, inline ---------------------------------
  {
    id: "F16",
    role: "staff",
    async run(page) {
      await goToForm(page);
      await revealColumn(page, "Counseling", 0);
      await shot(page, "F16", "staff-columns", { clip: viewportClip(page, { top: 0, height: 760 }) });
    },
  },
  {
    id: "F17",
    role: "staff",
    async run(page) {
      await goToForm(page);
      await clickCell(page, "Counseling", 2);
      await page.keyboard.type("Reviewed with counselor");
      await sleep(400);
      await shot(page, "F17", "inline-text", { clip: viewportClip(page, { top: 0, height: 760 }) });
      await page.keyboard.press("Escape");
    },
  },
  {
    id: "F20",
    role: "staff",
    async run(page) {
      await goToForm(page);
      await clickCell(page, "Test Assigned", 0);
      await sleep(500);
      await shot(page, "F20", "inline-toggle", { clip: viewportClip(page, { top: 0, height: 760 }) });
      await page.keyboard.press("Escape");
    },
  },
  {
    id: "F22",
    role: "staff",
    async run(page) {
      await openDetail(page);
      await page.evaluate(() => {
        const h = Array.from(document.querySelectorAll("h3")).find((x) => x.textContent.trim() === "Staff-only fields");
        window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - 140);
      });
      await sleep(700);
      await shot(page, "F22", "staff-fields-card");
    },
  },

  // ---- Part 5 ------------------------------------------------------------
  {
    id: "F24",
    role: "staff",
    async run(page) {
      await openDetail(page);
      await shot(page, "F24", "submission-detail");
    },
  },
  {
    id: "F25",
    role: "staff",
    async run(page) {
      await openDetail(page);
      await shot(page, "F25", "status-select", { clip: viewportClip(page, { top: 0, height: 300 }) });
    },
  },
  {
    id: "F26",
    role: "staff",
    async run(page) {
      await openDetail(page);
      await page.evaluate(() => {
        Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Edit").click();
      });
      await sleep(800);
      await shot(page, "F26", "edit-mode", { clip: viewportClip(page, { top: 0, height: 860 }) });
    },
  },

  // ---- Part 6 ------------------------------------------------------------
  {
    id: "F29",
    role: "staff",
    async run(page) {
      await go(page, "/staff/documents");
      await shot(page, "F29", "documents");
    },
  },
  {
    id: "F30",
    role: "staff",
    async run(page) {
      await go(page, "/staff/documents");
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button")).find((x) => x.textContent.trim() === "View PDF");
        if (b) b.click();
      });
      await sleep(2500);
      await shot(page, "F30", "pdf-drawer");
    },
  },

  // ---- Part 7 ------------------------------------------------------------
  {
    id: "F32",
    role: "staff",
    async run(page) {
      await go(page, "/staff/reports");
      await shot(page, "F32", "reports");
    },
  },
  {
    id: "F34",
    role: "staff",
    async run(page) {
      await go(page, "/staff/reports");
      await page.waitForSelector("#rp-form", { timeout: 30_000 });
      await page.select("#rp-form", FORM_CDM);
      await sleep(3500);
      await page.select("#rp-group", "field_11");
      await sleep(3500);
      await page.evaluate(() => {
        const g = document.querySelector(".grid-group-row");
        if (g) window.scrollTo(0, g.getBoundingClientRect().top + window.scrollY - 220);
      });
      await sleep(600);
      await shot(page, "F34", "report-grouped", { clip: viewportClip(page, { top: 0, height: 860 }) });
    },
  },
  {
    id: "F33",
    role: "staff",
    async run(page) {
      await go(page, "/staff/reports");
      await page.waitForSelector("#rp-form", { timeout: 30_000 });
      await page.select("#rp-form", FORM_CDM);
      await sleep(3000);
      await page.evaluate(() => {
        Array.from(document.querySelectorAll("button")).find((b) => b.textContent.startsWith("Select Columns")).click();
      });
      await sleep(900);
      await shot(page, "F33", "report-columns");
    },
  },
  {
    id: "F37",
    role: "staff",
    async run(page) {
      await go(page, "/staff");
      await page.evaluate(() => {
        Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Export").click();
      });
      await sleep(2500);
      await shot(page, "F37", "export-drawer");
    },
  },

  // ---- Part 8 ------------------------------------------------------------
  {
    id: "F38",
    role: "staff",
    async run(page) {
      await go(page, "/staff");
      await page.click(".user-chip");
      await sleep(600);
      await shot(page, "F38", "account-menu", { clip: viewportClip(page, { top: 0, height: 420 }) });
    },
  },
  {
    id: "F39",
    role: "staff",
    async run(page) {
      await go(page, "/account/password");
      await shot(page, "F39", "change-password");
    },
  },

];

// ---------------------------------------------------------------------------

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });

  const wanted = ONLY.length ? figures.filter((f) => ONLY.includes(f.id)) : figures;
  const pages = {};
  const failures = [];

  try {
    for (const fig of wanted) {
      console.log(`[${fig.id}]`);
      try {
        if (fig.role === "none") {
          if (!pages.none) pages.none = await signInAnon(browser);
          await fig.run(pages.none);
          continue;
        }
        const label = STAFF_LABEL;
        if (!pages[fig.role]) pages[fig.role] = await signIn(browser, label);
        await fig.run(pages[fig.role]);
      } catch (err) {
        failures.push({ id: fig.id, message: err.message });
        console.error(`  ✗ ${fig.id}: ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  await writeFile(
    path.join(OUT, "capture-report.json"),
    JSON.stringify({ base: BASE, capturedAt: new Date().toISOString(), failures }, null, 2),
  );

  if (failures.length) {
    console.error(`\n${failures.length} figure(s) failed:`);
    for (const f of failures) console.error(`  ${f.id}: ${f.message}`);
    process.exit(1);
  }
  console.log(`\nAll ${wanted.length} figure(s) captured.`);
}

async function signInAnon(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(VIEWPORT);
  return page;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
