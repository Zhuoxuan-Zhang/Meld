import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { marketResult } from "./market-data";
import { buildCatalog } from "../src/market";
import type { MarketResult } from "../src/market";

function notes(domain = "Productivity", ready = false): MarketResult {
  const result = marketResult(domain, { indexes: [1] });
  if (ready) result.apps[0].listedFeatures = summary;
  return result;
}
const summary = { items: [{ name: "Quick notes", detail: "Write and save notes offline." }], model: "fixture", template: "fixture", generatedAt: "2026-10-15T00:00:00Z" };
async function start(page: Page, domain = "Productivity") {
  await page.goto("/");
  await page.getByLabel("Enter a domain", { exact: true }).fill(domain);
  await page.getByRole("button", { name: "Add domain", exact: true }).click();
  await page.getByRole("button", { name: "Explore selected domains" }).click();
}
async function marketAvailable(page: Page) {
  await page.route("**/api/market/status", route => route.fulfill({ json: { available: true } }));
}
async function noPresets(page: Page) {
  await expect(page.getByText("Forest", { exact: true })).toHaveCount(0);
  await expect(page.getByText("TickTick", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Curated demo collection", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Start with a smarter combination" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try an example" })).toHaveCount(0);
}

test("missing and empty scans never create a catalog from presets", () => {
  expect(buildCatalog(["Productivity", "Notes & lists"], undefined)).toEqual([]);
  const empty = { ...notes(), apps: [] };
  expect(buildCatalog(["Productivity"], { Productivity: empty })).toEqual([]);
});

test("search shows only progress, then real cards, then completed listing features", async ({ page }) => {
  let finishScan!: () => void, finishSummary!: () => void;
  const scanning = new Promise<void>(resolve => { finishScan = resolve; });
  const summarizing = new Promise<void>(resolve => { finishSummary = resolve; });
  await marketAvailable(page);
  await page.route("**/api/market/scan", async route => { await scanning; await route.fulfill({ json: { result: notes() } }); });
  await page.route("**/api/claude/status", route => route.fulfill({ json: { available: true } }));
  await page.route("**/api/claude/features", async route => { await summarizing; await route.fulfill({ json: { features: { "com.example.notes": summary } } }); });
  try {
    await start(page);
    await expect(page.locator(".studio-scan-row").getByRole("status")).toContainText("Searching Google Play");
    await expect(page.locator(".studio-reference-card")).toHaveCount(0);
    await expect(page.getByText(/No apps were found/)).toHaveCount(0);
    await noPresets(page);
    finishScan();
    await expect(page.locator(".studio-reference-card")).toHaveCount(1);
    await expect(page.getByText("Reading store listings… Feature summaries are still processing.")).toBeVisible();
    const select = page.getByRole("button", { name: "Select all features from Notes Daily", exact: true });
    await expect(select).toBeDisabled();
    await page.getByRole("button", { name: "Explore Notes Daily", exact: true }).click();
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await noPresets(page);
    finishSummary();
    await expect(select).toBeEnabled();
    await expect(page.getByRole("checkbox")).toHaveCount(1);
    await select.click();
    await page.reload();
    await expect(page.getByRole("button", { name: "Clear all features from Notes Daily", exact: true })).toHaveAttribute("aria-pressed", "true");
    await noPresets(page);
  } finally { finishScan(); finishSummary(); await page.unrouteAll({ behavior: "wait" }); }
});

test("rescanning cancels the old summary and ignores its late result", async ({ page }) => {
  let scans = 0, summaries = 0, releaseOld!: () => void;
  const old = new Promise<void>(resolve => { releaseOld = resolve; });
  await marketAvailable(page);
  await page.route("**/api/market/scan", route => route.fulfill({ json: { result: { ...notes(), generatedAt: `2026-10-15T00:00:0${++scans}Z` } } }));
  await page.route("**/api/claude/status", route => route.fulfill({ json: { available: true } }));
  await page.route("**/api/claude/features", async route => {
    const attempt = ++summaries;
    if (attempt === 1) await old;
    await route.fulfill({ json: { features: { "com.example.notes": { ...summary, items: [{ name: attempt === 1 ? "Old summary" : "Fresh notes", detail: "Write and save notes offline." }] } } } }).catch(() => undefined);
  });
  try {
    await start(page);
    await expect.poll(() => summaries).toBe(1);
    await page.getByRole("button", { name: "Rescan", exact: true }).click();
    await expect.poll(() => summaries).toBe(2);
    await page.getByRole("button", { name: "Explore Notes Daily", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: /Fresh notes/ })).toBeVisible();
    releaseOld();
    await page.unrouteAll({ behavior: "wait" });
    await expect(page.getByRole("checkbox", { name: /Old summary/ })).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("meld.workspace.v1")!).market.Productivity.apps[0].listedFeatures.items[0].name)).toBe("Fresh notes");
  } finally { releaseOld(); await page.unrouteAll({ behavior: "wait" }); }
});

test("unavailable scanner stays empty and reconnecting runs a real scan", async ({ page }) => {
  await start(page);
  await expect(page.getByText("Disabled for this test.", { exact: false })).toBeVisible();
  await expect(page.locator(".studio-reference-card")).toHaveCount(0);
  await noPresets(page);
  await marketAvailable(page);
  await page.route("**/api/market/scan", route => route.fulfill({ json: { result: notes("Productivity", true) } }));
  await page.getByRole("button", { name: "Check connection", exact: true }).click();
  await expect(page.locator(".studio-reference-card")).toHaveCount(1);
});

test("failed search shows a retry, without fake cards or a false empty result", async ({ page }) => {
  let attempts = 0;
  await marketAvailable(page);
  await page.route("**/api/market/scan", route => ++attempts === 1 ? route.fulfill({ status: 502, json: { error: "Google Play is temporarily unavailable." } }) : route.fulfill({ json: { result: notes("Productivity", true) } }));
  await start(page);
  await expect(page.locator(".studio-scan-row").getByRole("status")).toContainText("Google Play is temporarily unavailable.");
  await expect(page.locator(".studio-reference-card")).toHaveCount(0);
  await expect(page.getByText(/No apps were found/)).toHaveCount(0);
  await noPresets(page);
  await page.getByRole("button", { name: "Retry search", exact: true }).click();
  await expect(page.locator(".studio-reference-card")).toHaveCount(1);
  expect(attempts).toBe(2);
});

for (const filtered of [false, true]) test(filtered ? "excluded real results stay distinct from an empty scan" : "completed empty scan stays empty, including after reload", async ({ page }) => {
  const result = filtered ? notes() : { ...notes(), apps: [], ranked: 0 };
  if (filtered) { result.apps[0].title = "AI Notes"; result.ranked = 1; }
  await marketAvailable(page);
  await page.route("**/api/market/scan", route => route.fulfill({ json: { result } }));
  await start(page);
  await expect(page.locator(".studio-scan-row").getByRole("status")).toContainText(filtered ? "0 shown · 1 ranked" : "0 shown · 0 ranked");
  await expect(page.getByText(filtered ? "Apps were found, but none match these filters. Adjust the filter or your search." : "No apps were found for this search. Try another domain or rescan.", { exact: true })).toBeVisible();
  await expect(page.locator(".studio-reference-card")).toHaveCount(0);
  if (filtered) { await page.getByText("See what was filtered out (1)", { exact: true }).click(); await expect(page.getByText("AI Notes", { exact: true })).toBeVisible(); }
  await page.reload();
  await expect(page.locator(".studio-reference-card")).toHaveCount(0);
  await noPresets(page);
});

test("a failed feature summary retries from its real listing", async ({ page }) => {
  let attempts = 0;
  await marketAvailable(page);
  await page.route("**/api/market/scan", route => route.fulfill({ json: { result: notes() } }));
  await page.route("**/api/claude/status", route => route.fulfill({ json: { available: true } }));
  await page.route("**/api/claude/features", route => ++attempts === 1 ? route.fulfill({ status: 502, json: { error: "Summary provider unavailable." } }) : route.fulfill({ json: { features: { "com.example.notes": summary } } }));
  await start(page);
  await expect(page.getByRole("alert")).toContainText("Summary provider unavailable.");
  await expect(page.getByRole("button", { name: "Select all features from Notes Daily", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry feature summaries", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select all features from Notes Daily", exact: true })).toBeEnabled();
  expect(attempts).toBe(2);
  await noPresets(page);
});

test("a rescan keeps selected real apps that left the new ranking", async ({ page }) => {
  let attempts = 0;
  await marketAvailable(page);
  await page.route("**/api/market/scan", route => route.fulfill({ json: { result: ++attempts === 1 ? notes("Productivity", true) : marketResult("Productivity", { indexes: [0] }) } }));
  await start(page);
  await page.getByRole("button", { name: "Select all features from Notes Daily", exact: true }).click();
  await page.getByRole("button", { name: "Rescan", exact: true }).click();
  await expect(page.locator(".studio-reference-card")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Clear all features from Notes Daily", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Clear all features from Notes Daily", exact: true })).toBeVisible();
  await noPresets(page);
});

test("one completed domain never fills a second pending domain with samples", async ({ page }) => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await marketAvailable(page);
  await page.route("**/api/market/scan", async route => {
    const { domain } = route.request().postDataJSON();
    if (domain === "Focus & habits") await hold;
    await route.fulfill({ json: { result: domain === "Notes & lists" ? notes(domain, true) : { ...marketResult(domain), apps: [], ranked: 0 } } });
  });
  try {
    await page.goto("/");
    for (const name of [/^Notes & lists/, /^Focus & habits/]) await page.getByRole("button", { name }).click();
    await page.getByRole("button", { name: "Explore selected domains" }).click();
    await expect(page.locator(".studio-reference-card")).toHaveCount(1);
    await expect(page.locator(".studio-scan-row").filter({ hasText: "Focus & habits" })).toContainText("Searching Google Play");
    await noPresets(page);
    release();
    await expect(page.locator(".studio-scan-row").filter({ hasText: "Focus & habits" })).toContainText("0 shown · 0 ranked");
    await expect(page.locator(".studio-reference-card")).toHaveCount(1);
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
});

for (const width of [390, 1440]) test("live discovery is accessible and fits at " + width + "px", async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await marketAvailable(page);
  await page.route("**/api/market/scan", route => route.fulfill({ json: { result: notes("Productivity", true) } }));
  await start(page);
  await page.getByRole("button", { name: "Explore Notes Daily", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});

for (const excluded of [false, true]) test("completed summary with " + (excluded ? "excluded" : "no") + " features never looks pending or invents choices", async ({ page }) => {
  const result = notes("Productivity", true);
  result.apps[0].listedFeatures!.items = excluded ? [{ name: "Cloud sync", detail: "Sync notes across devices." }] : [];
  await marketAvailable(page);
  await page.route("**/api/market/scan", route => route.fulfill({ json: { result } }));
  await start(page);
  await page.getByRole("button", { name: "Explore Notes Daily", exact: true }).click();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByText("No eligible features", { exact: true })).toBeVisible();
  await expect(page.getByText("Awaiting feature summary", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Select all features from Notes Daily", exact: true })).toBeDisabled();
});
