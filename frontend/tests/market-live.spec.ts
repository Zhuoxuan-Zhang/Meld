import { test, expect } from "@playwright/test";
import type { MarketResult } from "../src/market";
import { assessFit, recommendedDomains } from "../src/feasibility";

// Live Google Play and the real local API. No model calls are needed.
test.skip(!process.env.MELD_LIVE_MARKET, "Set MELD_LIVE_MARKET=1 to run live scans.");
test.describe.configure({ mode: "serial" });
test.setTimeout(360_000);
test.beforeEach(async ({ page }) => {
  await page.route("**/api/claude/**", route => route.fulfill({ json: { available: false, reason: "Live market check; model summaries disabled." } }));
  await page.route("**/api/design/status", route => route.fulfill({ json: { available: false, exampleId: null } }));
});

for (const domain of recommendedDomains) test(`${domain}: full live ranking is filtered without invented features`, async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: new RegExp(`^${domain.replace(/[&]/g, "&")}`) }).click();
  await page.getByRole("button", { name: "Explore selected domains" }).click();
  await expect(page.locator(".studio-scan-row")).toContainText("ranked", { timeout: 300_000 });
  const result = await page.evaluate(domain => JSON.parse(localStorage.getItem("meld.workspace.v1")!).market[domain] as MarketResult, domain);
  expect(result.scanId).toMatch(/^scan-[a-f\d]{64}$/);
  expect(result.apps.length).toBeGreaterThan(5);
  const simple = result.apps.filter(app => assessFit(app, domain).level === "simple");
  expect(simple.length).toBeGreaterThan(["Notes & lists", "Focus & habits"].includes(domain) ? 5 : 0);
  await expect(page.locator(".studio-reference-card")).toHaveCount(simple.length);
  expect(await page.locator(".studio-reference-card h3").allTextContents()).toEqual(simple.map(app => app.title));
  await page.getByRole("button", { name: `Explore ${simple[0].title}`, exact: true }).click();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByText("Live market check; model summaries disabled.", { exact: false })).toBeVisible();
  await expect(page.locator(".studio-reference-card").first().locator(".studio-reference-toggle")).toBeDisabled();
  await page.reload();
  await expect(page.locator(".studio-reference-card").first().locator(".studio-reference-toggle")).toBeDisabled();
});

test("two focused domains share a deduplicated catalog and the filter survives reload", async ({ page }) => {
  await page.goto("/");
  for (const domain of ["Notes & lists", "Focus & habits"]) await page.getByRole("button", { name: new RegExp(`^${domain}`) }).click();
  await page.getByRole("button", { name: "Explore selected domains" }).click();
  await expect(page.locator(".studio-scan-row").filter({ hasText: /\d+ ranked/ })).toHaveCount(2, { timeout: 300_000 });
  const results: Record<string, MarketResult> = await page.evaluate(() => JSON.parse(localStorage.getItem("meld.workspace.v1")!).market);
  const ids = new Set(Object.values(results).flatMap(r => r.apps.filter(a => assessFit(a, r.domain).level === "simple").map(a => a.appId)));
  await expect(page.locator(".studio-reference-card")).toHaveCount(ids.size);
  await page.getByLabel("App complexity").selectOption("review");
  const before = await page.locator(".studio-reference-card").count();
  expect(before).toBeGreaterThanOrEqual(ids.size);
  await page.reload();
  await expect(page.getByLabel("App complexity")).toHaveValue("review");
  await expect(page.locator(".studio-reference-card")).toHaveCount(before);
});
