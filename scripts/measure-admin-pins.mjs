// Measures the on-screen position of named controls for each guide figure, so the
// numbered pins in docs/guides/admin/*.html can be placed from real element
// rectangles instead of guessed percentages.
//
// Run:  node scripts/measure-admin-pins.mjs
//
// Prints, per figure, the percentage coordinates (relative to the 1440x900
// capture) of the controls that figure's callout list names. Paste those into the
// `--x`/`--y` of the corresponding <span class="pin">.
import puppeteer from "puppeteer";

const BASE = (process.env.GUIDE_BASE_URL || "https://webform-sandbox-addph8hsd9feghdp.eastus2-01.azurewebsites.net").replace(/\/$/, "");
const W = 1440, H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2", timeout: 90000 });
  await page.waitForSelector("#select-org");
  await page.select("#select-org", "1");
  await sleep(1200);
  await page.select("#select-user", "1");
  await sleep(300);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 90000 }).catch(() => {}),
    page.click("button[type=submit]"),
  ]);
  await sleep(3000);
  return page;
}

// Percentage of the capture box for an element's top-left, nudged to its centre.
const measure = (page, spec) =>
  page.evaluate((s) => {
    const find = () => {
      if (s.selector) {
        const els = Array.from(document.querySelectorAll(s.selector));
        return s.index != null ? els[s.index] : els[0];
      }
      const all = Array.from(document.querySelectorAll("button, a, h3, h2, th, td, label, span, div, input, select"));
      const matches = all.filter((e) => {
        const t = (e.textContent || "").trim();
        if (s.exact) return t === s.text;
        return t.startsWith(s.text);
      });
      // Prefer the deepest match: a wrapper div's textContent also starts with the
      // label, and its rectangle is far too large to point at a control.
      matches.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
      return matches[s.index || 0];
    };
    const el = find();
    if (!el) return null;
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) return null;
    return {
      x: +(((b.x + b.width / 2) / 1440) * 100).toFixed(1),
      y: +(((b.y + b.height / 2) / 900) * 100).toFixed(1),
      label: (el.textContent || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 34),
    };
  }, spec);

async function scrollTo(page, text, offset = 120) {
  await page.evaluate(({ t, o }) => {
    const all = Array.from(document.querySelectorAll("h3, h2"));
    const h = all.find((x) => x.textContent.trim() === t);
    if (h) window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - o);
  }, { t: text, o: offset });
  await sleep(600);
}

async function openSection(page, title) {
  await page.evaluate((t) => {
    const head = Array.from(document.querySelectorAll(".collapse-head")).find(
      (h) => h.querySelector(".collapse-title")?.textContent.trim() === t,
    );
    if (head) {
      const body = head.parentElement.querySelector(".collapse-body");
      if (!body || body.offsetParent === null) head.click();
    }
  }, title);
  await sleep(900);
  await page.evaluate((t) => {
    const head = Array.from(document.querySelectorAll(".collapse-head")).find(
      (h) => h.querySelector(".collapse-title")?.textContent.trim() === t,
    );
    if (head) window.scrollTo(0, head.getBoundingClientRect().top + window.scrollY - 90);
  }, title);
  await sleep(500);
}

const go = async (page, route, wait = 2500) => {
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle2", timeout: 90000 });
  await sleep(wait);
};

const PLAN = [
  ["A2 menu", async (page) => {
    await go(page, "/admin");
    await page.click("button[aria-label='Open menu']").catch(() => {});
    await sleep(700);
    return [
      ["menu button", { selector: "button[aria-label='Open menu']" }],
      ["Dashboard", { selector: ".sidebar-link", index: 0 }],
      ["Forms", { text: "Forms", exact: true }],
      ["Settings", { text: "Settings", exact: true }],
      ["user chip", { selector: ".user-chip" }],
    ];
  }],
  ["A3 dashboard", async (page) => {
    await go(page, "/admin");
    return [
      ["School", { text: "School", exact: true }],
      ["Form", { text: "Form", exact: true }],
      ["Status", { text: "Status", exact: true }],
      ["Columns", { text: "Columns", exact: true }],
      ["Export", { text: "Export", exact: true }],
      ["Review", { text: "Review", exact: true }],
    ];
  }],
  ["A5 forms list", async (page) => {
    await go(page, "/admin/forms");
    return [
      ["New Form", { text: "New Form" }],
      ["Design", { text: "Design", exact: true }],
      ["Publish", { text: "Publish", exact: true }],
    ];
  }],
  ["A6 new form", async (page) => {
    await go(page, "/admin/forms");
    await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => /New Form/i.test(b.textContent))?.click());
    await sleep(900);
    return [
      ["title input", { selector: "input[type=text]" }],
      ["Create & Design", { text: "Create & Design" }],
    ];
  }],
  ["A7 designer details", async (page) => {
    await go(page, "/admin/forms/2");
    return [
      ["Publish", { text: "Publish", exact: true }],
      ["Form Details", { text: "Form Details", exact: true }],
      ["Title label", { text: "Title", exact: true }],
      ["Description label", { text: "Description", exact: true }],
      ["Drive Folder", { text: "Drive Folder" }],
      ["Google Form URL", { text: "Google Form URL" }],
    ];
  }],
  ["A8 designer fields", async (page) => {
    await go(page, "/admin/forms/2");
    await scrollTo(page, "Fields");
    return [
      ["Fields heading", { text: "Fields", exact: true }],
      ["Form Fields tab", { text: "Form Fields" }],
      ["Staff Only tab", { text: "Staff Only Fields" }],
      ["Add Form Field", { text: "Add Form Field" }],
      ["Label", { text: "Label", exact: true }],
      ["Type", { text: "Type", exact: true }],
    ];
  }],
  ["A9 staff fields", async (page) => {
    await go(page, "/admin/forms/2");
    await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => /Staff Only Fields/i.test(b.textContent))?.click());
    await sleep(900);
    await scrollTo(page, "Fields");
    return [
      ["Fields heading", { text: "Fields", exact: true }],
      ["Staff Only tab", { text: "Staff Only Fields" }],
      ["Access label", { text: "Access", exact: true }],
      ["Add Staff Only Field", { text: "Add Staff Only Field" }],
    ];
  }],
  ["A10 visibility", async (page) => {
    await go(page, "/admin/forms/2");
    await scrollTo(page, "Visibility");
    return [
      ["Visibility heading", { text: "Visibility", exact: true }],
      ["Public", { text: "Public", exact: true }],
      ["Private", { text: "Private", exact: true }],
    ];
  }],
  ["A11 public link", async (page) => {
    await go(page, "/admin/forms/2");
    await page.evaluate(() => {
      const h = Array.from(document.querySelectorAll("h3")).find((x) => x.textContent.trim() === "Public link");
      if (h) window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - 140);
    });
    await sleep(700);
    return [
      ["Public link heading", { text: "Public link", exact: true }],
      ["link field", { selector: "input" }],
      ["copy button", { selector: "button" }],
    ];
  }],
  ["A12 access requests", async (page) => {
    await go(page, "/admin/access-requests");
    return [
      ["heading", { selector: ".page-head h1" }],
      ["Approve", { text: "Approve" }],
      ["Decline", { text: "Decline" }],
    ];
  }],
  ["A13 reports", async (page) => {
    await go(page, "/admin/reports");
    return [
      ["Save View", { text: "Save View" }],
      ["Export", { text: "Export", exact: true }],
      ["Form label", { text: "Form", exact: true }],
      ["Select Columns", { text: "Select Columns" }],
      ["Group by", { text: "Group by" }],
    ];
  }],
  ["A15 webhook log", async (page) => {
    await go(page, "/admin/webhooks");
    return [
      ["Status label", { text: "Status", exact: true }],
      ["Replay", { text: "Replay", exact: true }],
      ["Attempts heading", { text: "Attempts", exact: true }],
    ];
  }],
  ["A16 documents", async (page) => {
    await go(page, "/admin/documents");
    return [
      ["Refresh", { text: "Refresh" }],
      ["Open", { text: "Open", exact: true }],
      ["Status header", { text: "Status", exact: true }],
    ];
  }],
  ["A17 account menu", async (page) => {
    await go(page, "/admin");
    await page.click(".user-chip");
    await sleep(600);
    return [
      ["user chip", { selector: ".user-chip" }],
      ["Change password", { text: "Change password" }],
    ];
  }],
  ["S1 settings", async (page) => {
    await go(page, "/admin/settings");
    return [
      ["Add User", { text: "+ Add User" }],
      ["Users", { text: "Users", exact: true }],
      ["Roles", { text: "Roles", exact: true }],
      ["Login Mode", { text: "Login Mode", exact: true }],
      ["Organizations", { text: "Organizations", exact: true }],
    ];
  }],
  ["S2 users", async (page) => {
    await go(page, "/admin/settings");
    await openSection(page, "Users");
    return [
      ["Add User", { text: "+ Add User" }],
      ["first row", { selector: "table.grid tbody tr" }],
      ["Role header", { text: "Role", exact: true }],
      ["Status header", { text: "Status", exact: true }],
    ];
  }],
  ["S4 roles", async (page) => {
    await go(page, "/admin/settings");
    await openSection(page, "Roles");
    return [
      ["Add Role", { text: "+ Add Role" }],
      ["first role row", { selector: "table.grid tbody tr" }],
      ["View submissions", { text: "View submissions" }],
    ];
  }],
  ["S5 login mode", async (page) => {
    await go(page, "/admin/settings");
    await openSection(page, "Login Mode");
    return [
      ["Select User card", { text: "Select User (Test)" }],
      ["Password card", { text: "Password (Production)" }],
      ["Maintenance card", { text: "System Maintenance" }],
    ];
  }],
  ["S7 menu settings", async (page) => {
    await go(page, "/admin/settings");
    await openSection(page, "Menu Settings");
    return [
      ["Forms row", { text: "Forms", exact: true }],
      ["Everyone", { text: "Everyone" }],
    ];
  }],
  ["S11 system messages", async (page) => {
    await go(page, "/admin/settings");
    await openSection(page, "System Messages");
    return [
      ["Add Message", { text: "+ Add Message" }],
      ["first message", { selector: ".collapse-body .card, .collapse-body table tbody tr" }],
    ];
  }],
  ["S13 schools", async (page) => {
    await go(page, "/admin/settings");
    await openSection(page, "Schools");
    return [
      ["Import Schools", { text: "Import Schools" }],
      ["Search", { text: "Search", exact: true }],
      ["first school row", { selector: "table.grid tbody tr" }],
    ];
  }],
  ["S14 school name matching", async (page) => {
    await go(page, "/admin/settings");
    await openSection(page, "School Name Matching");
    return [["first row", { selector: "table.grid tbody tr" }]];
  }],
];

(async () => {
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  let page;
  try {
    page = await signIn(browser);
    for (const [name, fn] of PLAN) {
      try {
        const specs = await fn(page);
        const out = {};
        for (const [label, spec] of specs) {
          const m = await measure(page, spec);
          out[label] = m ? `${m.x}% , ${m.y}%   (${m.label})` : "NOT FOUND";
        }
        console.log(`\n### ${name}`);
        for (const [k, v] of Object.entries(out)) console.log(`  ${k.padEnd(22)} ${v}`);
      } catch (err) {
        console.log(`\n### ${name}\n  ERROR: ${err.message}`);
        page = await signIn(browser);
      }
    }
  } finally {
    await browser.close();
  }
})();
