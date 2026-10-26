// Captures the screenshots used by docs/guides/admin/admin-guide.html and
// docs/guides/admin/settings-reference.html.
//
// Run with:  npm run guide:admin:shots
//
// Same contract as scripts/capture-staff-guide.mjs: fixed 1440x900 viewport at 2x,
// and a missing selector is a HARD FAILURE rather than a skipped shot. A guide
// that silently keeps last month's screenshot of a renamed button is worse than
// one that fails to build.
//
// Configuration (environment variables):
//   GUIDE_BASE_URL   default https://webform-sandbox-addph8hsd9feghdp.eastus2-01.azurewebsites.net
//   GUIDE_LOGIN_URL  where the sign-in figure is captured, default the production site
//                    (the sandbox runs in Select-User mode and never renders the password form)
//   GUIDE_ORG        organization name on the login screen, default "Academics"
//   GUIDE_ADMIN      test-user label substring for the admin account, default "admin"
//   GUIDE_ONLY       comma-separated figure ids, e.g. "A10,S3" (default: all)
import puppeteer from "puppeteer";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.GUIDE_BASE_URL || "https://webform-sandbox-addph8hsd9feghdp.eastus2-01.azurewebsites.net").replace(/\/$/, "");
const LOGIN_URL = (process.env.GUIDE_LOGIN_URL || "https://webform-hcf0e2gzgudjcsaq.eastus2-01.azurewebsites.net").replace(/\/$/, "");
const ORG = process.env.GUIDE_ORG || "Academics";
const ADMIN_LABEL = process.env.GUIDE_ADMIN || "admin";
const ONLY = (process.env.GUIDE_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "guides", "admin", "images");

const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 };
const SETTLE = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function signIn(browser) {
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
    ADMIN_LABEL,
  );
  if (!userValue) throw new Error(`No test user matching "${ADMIN_LABEL}" in ${ORG}`);
  await page.select("#select-user", userValue);
  await sleep(300);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 90_000 }).catch(() => {}),
    page.click("button[type=submit]"),
  ]);
  await sleep(3000);
  return page;
}

async function freeze(page) {
  await page.addStyleTag({
    content: `*,*::before,*::after{transition:none!important;animation:none!important}
              .spinner{display:none!important}`,
  });
}

async function go(page, route, wait = 2500) {
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle2", timeout: 90_000 });
  await sleep(wait);
  await freeze(page);
}

async function shot(page, id, name, { clip, full = false } = {}) {
  const file = path.join(OUT, `${id}-${name}.png`);
  await page.screenshot(clip ? { path: file, clip } : { path: file, fullPage: full });
  console.log(`  ✓ ${id} ${name}`);
}

const clip = (height = 900, top = 0) => ({ x: 0, y: top, width: VIEWPORT.width, height });

// Open one of the Settings collapsible sections by its title.
async function openSection(page, title) {
  const opened = await page.evaluate((t) => {
    const head = Array.from(document.querySelectorAll(".collapse-head")).find(
      (h) => h.querySelector(".collapse-title")?.textContent.trim() === t,
    );
    if (!head) return false;
    const body = head.parentElement.querySelector(".collapse-body");
    const isOpen = body && body.offsetParent !== null;
    if (!isOpen) head.click();
    return true;
  }, title);
  if (!opened) throw new Error(`No Settings section titled "${title}"`);
  await sleep(900);
  // Scroll the section to just under the banner so its heading and content are
  // both in frame.
  await page.evaluate((t) => {
    const head = Array.from(document.querySelectorAll(".collapse-head")).find(
      (h) => h.querySelector(".collapse-title")?.textContent.trim() === t,
    );
    window.scrollTo(0, head.getBoundingClientRect().top + window.scrollY - 90);
  }, title);
  await sleep(500);
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

const figures = [
  // ===== ADMIN GUIDE ======================================================
  {
    id: "A1",
    async run(page) {
      await page.goto(`${LOGIN_URL}/login`, { waitUntil: "networkidle2", timeout: 90_000 });
      await page.waitForSelector("#email", { timeout: 45_000 });
      if (!(await page.$("#password"))) throw new Error("Sign-in screen has no Password box");
      await sleep(SETTLE + 1600);
      await freeze(page);
      await shot(page, "A1", "sign-in");
    },
  },
  {
    id: "A2",
    async run(page) {
      await go(page, "/admin");
      await page.click("button[aria-label='Open menu']").catch(() => {});
      await sleep(700);
      await shot(page, "A2", "menu-open");
    },
  },
  {
    id: "A3",
    async run(page) {
      await go(page, "/admin");
      await shot(page, "A3", "dashboard");
    },
  },
  {
    id: "A4",
    async run(page) {
      await go(page, "/admin");
      await page.evaluate(() => {
        Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Export").click();
      });
      await sleep(2500);
      await shot(page, "A4", "export-drawer");
    },
  },
  {
    id: "A5",
    async run(page) {
      await go(page, "/admin/forms");
      await shot(page, "A5", "forms-list");
    },
  },
  {
    id: "A6",
    async run(page) {
      await go(page, "/admin/forms");
      await page.evaluate(() => {
        Array.from(document.querySelectorAll("button")).find((b) => /New Form/i.test(b.textContent)).click();
      });
      await sleep(900);
      await shot(page, "A6", "new-form", { clip: clip(760) });
    },
  },
  {
    id: "A7",
    async run(page) {
      await go(page, "/admin/forms");
      const href = await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll("a, button")).find((x) => /Design/i.test(x.textContent));
        return a ? a.getAttribute("href") : null;
      });
      await go(page, href || "/admin/forms/2");
      await shot(page, "A7", "designer-details", { clip: clip(900) });
    },
  },
  {
    id: "A8",
    async run(page) {
      await go(page, "/admin/forms/2");
      await page.evaluate(() => {
        const h = Array.from(document.querySelectorAll("h3")).find((x) => x.textContent.trim() === "Fields");
        window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - 120);
      });
      await sleep(700);
      await shot(page, "A8", "designer-fields", { clip: clip(880) });
    },
  },
  {
    id: "A9",
    async run(page) {
      await go(page, "/admin/forms/2");
      await page.evaluate(() => {
        const tab = Array.from(document.querySelectorAll("button")).find((b) => /Staff Only Fields/i.test(b.textContent));
        if (tab) tab.click();
      });
      await sleep(900);
      await page.evaluate(() => {
        const h = Array.from(document.querySelectorAll("h3")).find((x) => x.textContent.trim() === "Fields");
        window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - 120);
      });
      await sleep(600);
      await shot(page, "A9", "designer-staff-fields", { clip: clip(880) });
    },
  },
  {
    id: "A10",
    async run(page) {
      await go(page, "/admin/forms/2");
      await page.evaluate(() => {
        const h = Array.from(document.querySelectorAll("h3")).find((x) => x.textContent.trim() === "Visibility");
        window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - 120);
      });
      await sleep(700);
      await shot(page, "A10", "designer-visibility", { clip: clip(700) });
    },
  },
  {
    id: "A11",
    async run(page) {
      await go(page, "/admin/forms/2");
      await page.evaluate(() => {
        const h = Array.from(document.querySelectorAll("h3")).find((x) => x.textContent.trim() === "Public link");
        if (h) window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - 140);
      });
      await sleep(700);
      await shot(page, "A11", "public-link", { clip: clip(620) });
    },
  },
  {
    id: "A12",
    async run(page) {
      await go(page, "/admin/access-requests");
      await shot(page, "A12", "access-requests");
    },
  },
  {
    id: "A13",
    async run(page) {
      await go(page, "/admin/reports");
      await shot(page, "A13", "reports");
    },
  },
  {
    id: "A14",
    async run(page) {
      await go(page, "/admin/reports");
      await page.waitForSelector("#rp-form", { timeout: 30_000 });
      await page.select("#rp-form", "2");
      await sleep(3000);
      await page.evaluate(() => {
        Array.from(document.querySelectorAll("button")).find((b) => b.textContent.startsWith("Select Columns")).click();
      });
      await sleep(900);
      await shot(page, "A14", "report-columns");
    },
  },
  {
    id: "A15",
    async run(page) {
      await go(page, "/admin/webhooks");
      await shot(page, "A15", "webhook-log");
    },
  },
  {
    id: "A16",
    async run(page) {
      await go(page, "/admin/documents");
      await shot(page, "A16", "documents");
    },
  },
  {
    id: "A17",
    async run(page) {
      await go(page, "/admin");
      await page.click(".user-chip");
      await sleep(600);
      await shot(page, "A17", "account-menu", { clip: clip(420) });
    },
  },

  // ===== SETTINGS REFERENCE ===============================================
  {
    id: "S1",
    async run(page) {
      await go(page, "/admin/settings");
      await shot(page, "S1", "settings-overview");
    },
  },
  {
    id: "S2",
    async run(page) {
      await go(page, "/admin/settings");
      await openSection(page, "Users");
      await shot(page, "S2", "users", { clip: clip(880) });
    },
  },
  {
    id: "S3",
    async run(page) {
      await go(page, "/admin/settings");
      await openSection(page, "Users");
      await page.evaluate(() => {
        const row = document.querySelector("table.grid tbody tr");
        if (row) row.click();
      });
      await sleep(1200);
      await shot(page, "S3", "edit-user");
    },
  },
  {
    id: "S4",
    async run(page) {
      await go(page, "/admin/settings");
      await openSection(page, "Roles");
      await shot(page, "S4", "roles", { clip: clip(880) });
    },
  },
  {
    id: "S5",
    async run(page) {
      await go(page, "/admin/settings");
      await openSection(page, "Login Mode");
      await shot(page, "S5", "login-mode", { clip: clip(760) });
    },
  },
  {
    id: "S6",
    async run(page) {
      await go(page, "/admin/settings");
      await openSection(page, "Documents Link");
      await shot(page, "S6", "documents-link", { clip: clip(700) });
    },
  },
  {
    id: "S7",
    async run(page) {
      await go(page, "/admin/settings");
      await openSection(page, "Menu Settings");
      await shot(page, "S7", "menu-settings", { clip: clip(800) });
    },
  },
  {
    id: "S8",
    async run(page) {
      await go(page, "/admin/settings");
      await openSection(page, "Slack Notifications");
      await shot(page, "S8", "slack", { clip: clip(700) });
    },
  },
  {
    id: "S9",
    async run(page) {
      await go(page, "/admin/settings");
      await openSection(page, "Access Requests");
      await shot(page, "S9", "access-requests", { clip: clip(800) });
    },
  },
  {
    id: "S10",
    async run(page) {
      await go(page, "/admin/settings");
      await openSection(page, "Webhook Log");
      await shot(page, "S10", "webhook-log", { clip: clip(800) });
    },
  },
  {
    id: "S11",
    async run(page) {
      await go(page, "/admin/settings");
      await openSection(page, "System Messages");
      await shot(page, "S11", "system-messages", { clip: clip(800) });
    },
  },
  {
    id: "S12",
    async run(page) {
      await go(page, "/admin/settings");
      await openSection(page, "Organizations");
      await shot(page, "S12", "organizations", { clip: clip(760) });
    },
  },
  {
    id: "S13",
    async run(page) {
      await go(page, "/admin/settings");
      await openSection(page, "Schools");
      await shot(page, "S13", "schools", { clip: clip(800) });
    },
  },
  {
    id: "S14",
    async run(page) {
      await go(page, "/admin/settings");
      await openSection(page, "School Name Matching");
      await shot(page, "S14", "school-name-matching", { clip: clip(760) });
    },
  },
];

// ---------------------------------------------------------------------------

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const wanted = ONLY.length ? figures.filter((f) => ONLY.includes(f.id)) : figures;
  const failures = [];
  let page;

  try {
    for (const fig of wanted) {
      console.log(`[${fig.id}]`);
      try {
        if (!page) page = await signIn(browser);
        await fig.run(page);
      } catch (err) {
        failures.push({ id: fig.id, message: err.message });
        console.error(`  ✗ ${fig.id}: ${err.message}`);
        // A failed navigation can leave the page unusable; start fresh.
        try { page = await signIn(browser); } catch { page = null; }
      }
    }
  } finally {
    await browser.close();
  }

  if (failures.length) {
    console.error(`\n${failures.length} figure(s) failed:`);
    for (const f of failures) console.error(`  ${f.id}: ${f.message}`);
    process.exit(1);
  }
  console.log(`\nAll ${wanted.length} figure(s) captured.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
