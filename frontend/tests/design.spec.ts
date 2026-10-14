import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { designServer } from "./design-fixtures";
import { fromScannerReport } from "../src/market";
import { scannerReport } from "./market-data";

const draft = { version: 1, domains: ["Productivity"], selected: { notion: ["notes"] }, name: "Notes Studio", audience: "Personal notes", description: "A simple offline notebook", style: "sage", built: false, goal: "Capture ideas", designId: "notes" };
async function connect(page: Page, address: string) {
  await page.route("**/api/design/**", async route => {
    const request = route.request(), url = new URL(request.url());
    const response = await page.request.fetch(address + url.pathname + url.search, { method: request.method(), headers: { "Content-Type": "application/json", Origin: address }, data: request.postData() || undefined });
    await route.fulfill({ response });
  });
}
async function seed(page: Page, value: unknown = draft) {
  await page.goto("/"); await page.evaluate(value => localStorage.setItem("meld.workspace.v1", JSON.stringify(value)), value);
  await page.goto("/?seed=design#/review");
}
test("Review page uses the real backend contract for partial confirmation, refreshed references and build handoff", async ({ page }) => {
  const api = await designServer();
  try {
    await connect(page, api.address); await seed(page);
    const panel = page.getByRole("region", { name: "Interactive design document" });
    await expect(panel.getByText("Design v1", { exact: true })).toBeVisible();
    await panel.locator(".design-evidence summary").first().click(); await expect(panel.locator("pre").first()).toContainText("写笔记");
    await panel.getByLabel("What would you like to change?").fill("change"); await panel.getByRole("button", { name: "Suggest changes" }).click();
    await expect(panel.getByRole("heading", { name: "Choose what to keep" })).toBeVisible(); expect((await api.service.get("notes")).version).toBe(1);
    await panel.locator(".design-change").filter({ hasText: "改主色" }).getByRole("checkbox").uncheck();
    await panel.getByRole("button", { name: "Confirm selected changes" }).click(); await expect(panel.getByText("Design v2", { exact: true })).toBeVisible();
    const raw = await api.service.store.revision("notes"); expect(raw.data.design.features[0].title).toBe("记录想法"); expect(raw.data.design.visual.colors[0].value).toBe("#315DA8");
    await expect(panel.locator(".design-evidence pre").first()).toContainText("记录想法");
    await expect(page.getByRole("button", { name: "Export approved design", exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Create my app", exact: true })).toHaveCount(0);
    await page.reload(); await expect(panel.getByText("Design v2", { exact: true })).toBeVisible();
    const download = page.waitForEvent("download"); await panel.getByRole("button", { name: "Export approved build input" }).click();
    expect((await download).suggestedFilename()).toMatch(/build-input\.json$/);
  } finally { await api.close(); }
});
test("random input asks for clarification or preserves the design; cancel and restore are explicit", async ({ page }) => {
  const api = await designServer();
  try {
    await connect(page, api.address); await seed(page); const panel = page.getByRole("region", { name: "Interactive design document" });
    await expect(panel.getByText("Design v1", { exact: true })).toBeVisible();
    await panel.getByLabel("What would you like to change?").fill("vague"); await panel.getByRole("button", { name: "Suggest changes" }).click();
    await expect(panel.getByRole("heading", { name: "A quick question" })).toBeVisible(); await panel.getByRole("button", { name: "颜色", exact: true }).click();
    await expect(panel.getByLabel("What would you like to change?")).toHaveValue(/My choice: 颜色/); expect((await api.service.get("notes")).version).toBe(1);
    await panel.getByRole("button", { name: "Cancel suggestions" }).click();
    await panel.getByLabel("What would you like to change?").fill("unrelated"); await panel.getByRole("button", { name: "Suggest changes" }).click();
    await expect(panel.getByRole("heading", { name: "No design changes" })).toBeVisible(); await expect(panel.getByRole("button", { name: "Confirm selected changes" })).toHaveCount(0);
    await panel.getByRole("button", { name: "Cancel suggestions" }).click(); await panel.getByLabel("What would you like to change?").fill("change"); await panel.getByRole("button", { name: "Suggest changes" }).click();
    await expect(panel.getByRole("heading", { name: "Choose what to keep" })).toBeVisible(); await panel.getByRole("button", { name: "Confirm selected changes" }).click(); await expect(panel.getByText("Design v2", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Version history" }).click(); const old = panel.locator(".design-history>div").filter({ hasText: "v1" });
    await old.getByRole("button", { name: "View", exact: true }).click(); await expect(panel.getByText("You are reading a historical version.")).toBeVisible();
    await old.getByRole("button", { name: "Restore", exact: true }).click(); expect((await api.service.get("notes")).version).toBe(2);
    await panel.getByRole("button", { name: "Confirm restore", exact: true }).click(); await expect(panel.getByText("Design v3", { exact: true })).toBeVisible(); expect((await api.service.get("notes")).implementation.status).toBe("in_sync");
  } finally { await api.close(); }
});
test("ranked Top 5 reaches the pipeline and missing files never become a generated app", async ({ page }) => {
  const api = await designServer();
  try {
    const scan = await api.signals.record(fromScannerReport("Productivity", scannerReport("Productivity")));
    await connect(page, api.address); await seed(page, { ...draft, designId: undefined, selected: { "com.example.notes": ["notes"] }, market: { Productivity: scan } });
    const panel = page.getByRole("region", { name: "Interactive design document" }); await panel.getByRole("button", { name: "Generate design", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Your references are saved" })).toBeVisible(); await expect(panel.locator(".design-waiting li")).toHaveCount(5); expect(api.model.calls).toHaveLength(2);
    await page.reload(); await expect(panel.getByRole("heading", { name: "Your references are saved" })).toBeVisible(); await expect(panel.getByText("Design v1", { exact: true })).toHaveCount(0);
  } finally { await api.close(); }
});
for (const width of [320, 390, 1440]) test(`interactive design stays accessible and fits at ${width}px`, async ({ page }) => {
  const api = await designServer();
  try {
    await page.setViewportSize({ width, height: 950 }); await connect(page, api.address); await seed(page);
    await expect(page.getByText("Design v1", { exact: true })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(); expect(report.violations).toEqual([]);
  } finally { await api.close(); }
});
