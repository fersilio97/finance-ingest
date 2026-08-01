/**
 * Browser verification harness for finance-ingest.
 *
 * Loads every page in a real Chromium, fails on console errors or failed network
 * requests, and writes screenshots to .artifacts/ so a human (or an agent with the
 * Read tool) can actually LOOK at the result. This exists because this project
 * repeatedly shipped UI that was logically correct and visually unverified.
 *
 * Read-only: it never POSTs, so it is safe to run against the live database.
 *
 *   node scripts/ui-check.mjs                  # all pages, light + dark, 2 widths
 *   node scripts/ui-check.mjs --page index     # one page
 *   node scripts/ui-check.mjs --url http://…   # different host
 *
 * Exit code 0 = clean, 1 = problems found (details printed).
 */

import { chromium } from "playwright";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE_URL = getArg("url", "http://127.0.0.1:8000");
const ONLY_PAGE = getArg("page", null);
const ARTIFACTS = path.resolve("./.artifacts");

const PAGES = [
  { name: "index", path: "/index.html", waitFor: "#review-table, #review-empty" },
  { name: "insights", path: "/insights.html", waitFor: "#category-table, #category-empty" },
];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "narrow", width: 480, height: 900 },
];

const THEMES = ["light", "dark"];

// Noise we don't want failing the run. Keep this list short and justified —
// every entry here is a check we've chosen to stop doing.
const IGNORED = [/favicon\.ico/];
const isIgnored = (text) => IGNORED.some((re) => re.test(text));

// A page more than this many viewports tall is almost certainly rendering an
// unbounded list. Generous on purpose — this should flag pathology, not length.
const MAX_PAGE_HEIGHT_RATIO = 12;
// Same idea for DOM size — generous, flags pathology not richness.
const MAX_DOM_NODES = 10000;

const problems = [];
const screenshots = [];
const heights = [];

async function checkPage(browser, page_, viewport, theme) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: theme,
  });
  const page = await context.newPage();

  const consoleErrors = [];
  const failedRequests = [];

  page.on("console", (msg) => {
    if (msg.type() === "error" && !isIgnored(msg.text())) consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`uncaught: ${err.message}`));
  page.on("requestfailed", (req) => {
    if (!isIgnored(req.url())) failedRequests.push(`${req.url()} — ${req.failure()?.errorText}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400 && !isIgnored(res.url())) {
      failedRequests.push(`${res.status()} ${res.url()}`);
    }
  });

  const label = `${page_.name} · ${viewport.name} · ${theme}`;
  try {
    const res = await page.goto(`${BASE_URL}${page_.path}`, {
      waitUntil: "networkidle",
      timeout: 20000,
    });
    if (!res || !res.ok()) {
      problems.push(`${label}: page returned ${res ? res.status() : "no response"}`);
    }
    if (page_.waitFor) {
      await page.waitForSelector(page_.waitFor, { timeout: 10000 }).catch(() => {
        problems.push(`${label}: expected selector "${page_.waitFor}" never appeared`);
      });
    }

    // Horizontal overflow on the body is a real layout bug, not a nitpick —
    // it's the classic symptom of a wide table escaping its scroll container.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    if (overflow) problems.push(`${label}: page scrolls horizontally`);

    // Viewport-only, not fullPage: a fullPage shot of an unpaginated 860-row
    // table is a 6MB strip nobody can actually look at. Page height is captured
    // as a number instead — that's the useful signal, and an absurd value is
    // itself a finding worth surfacing.
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const domNodes = await page.evaluate(() => document.querySelectorAll("*").length);
    heights.push({ label, pageHeight, viewportHeight: viewport.height, domNodes });
    if (pageHeight > viewport.height * MAX_PAGE_HEIGHT_RATIO) {
      problems.push(
        `${label}: page is ${pageHeight}px tall (${Math.round(pageHeight / viewport.height)}x the viewport) — ` +
          `likely an unpaginated list`
      );
    }
    if (domNodes > MAX_DOM_NODES) {
      problems.push(`${label}: ${domNodes} DOM nodes — likely rendering an unbounded list at full detail`);
    }

    const file = path.join(ARTIFACTS, `${page_.name}-${viewport.name}-${theme}.png`);
    await page.screenshot({ path: file });
    screenshots.push(file);
  } catch (err) {
    problems.push(`${label}: ${err.message}`);
  }

  for (const e of consoleErrors) problems.push(`${label}: console error — ${e}`);
  for (const f of failedRequests) problems.push(`${label}: request failed — ${f}`);

  await context.close();
}

async function main() {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(ARTIFACTS, { recursive: true });

  const pages = ONLY_PAGE ? PAGES.filter((p) => p.name === ONLY_PAGE) : PAGES;
  if (pages.length === 0) {
    console.error(`No page named "${ONLY_PAGE}". Known: ${PAGES.map((p) => p.name).join(", ")}`);
    process.exit(1);
  }

  const browser = await chromium.launch();
  try {
    for (const p of pages) {
      for (const v of VIEWPORTS) {
        for (const t of THEMES) {
          await checkPage(browser, p, v, t);
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\nScreenshots (${screenshots.length}) in .artifacts/ — viewport-sized, open them:`);
  for (const s of screenshots) console.log(`  ${s}`);

  console.log("\nPage heights / DOM size:");
  for (const h of heights) {
    console.log(
      `  ${h.label.padEnd(30)} ${String(h.pageHeight).padStart(7)}px  (${(h.pageHeight / h.viewportHeight).toFixed(1)}x viewport)   ${h.domNodes} DOM nodes`
    );
  }

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error("\nOpen the screenshots above before assuming these are false positives.");
    process.exit(1);
  }

  console.log("\n✓ No console errors, failed requests, or horizontal overflow.");
  console.log("  This does NOT mean the UI looks right — open the screenshots and check.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
