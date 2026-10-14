import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { projectServer, idea } from "./project-fixtures";
import type { ProjectTestServer } from "./project-fixtures";

async function connect(page: Page, api: ProjectTestServer) {
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    const response = await page.request.fetch(api.address + url.pathname + url.search, { method: request.method(), headers: { "Content-Type": "application/json", Origin: api.address }, data: request.postData() || undefined });
    await route.fulfill({ response });
  });
}
async function example(page: Page) { await page.goto("/"); await page.getByRole("button", { name: "Try the Notes example" }).click(); await expect(page.getByRole("heading", { name: "Your app, in plain language." })).toBeVisible(); }
test("three-step workflow: idea → research → human choices → design → selective change → APK (synthetic providers)", async ({ page }) => {
  test.setTimeout(60000); const api = await projectServer({ listedFeatures: true });
  try {
    await connect(page, api); await page.goto("/"); await page.getByLabel("Describe your app", { exact: true }).fill(idea.input);
    await page.getByText("A few preferences, if you have them").click(); await page.getByLabel("App name", { exact: true }).fill(idea.name); await page.getByLabel("Search topic", { exact: true }).fill("Productivity");
    await page.getByRole("button", { name: "Explore ideas", exact: true }).click();
    await expect(page.getByRole("heading", { name: "What would you like to keep?" })).toBeVisible();
    const appOrder = await page.locator(".studio-market-app h3").allTextContents();
    expect(appOrder.length).toBeGreaterThan(0); expect(appOrder.length).toBeLessThanOrEqual(5);
    expect(api.counts().analysisCalls).toBe(0);
    expect(await page.locator(".studio-feature-choice").count()).toBe(appOrder.length * 3);
    const feature = page.locator(".studio-feature-choice").filter({ hasText: "Quick notes" }).first();
    await feature.getByRole("checkbox").check();
    await feature.getByText("Customize Quick notes", { exact: true }).click();
    await feature.getByLabel("Feature name", { exact: true }).fill("Quick capture");
    await feature.getByLabel("How should it work?", { exact: true }).fill("Capture a note offline with a single action.");
    expect(await page.locator(".studio-market-app h3").allTextContents()).toEqual(appOrder);
    await page.getByPlaceholder("Describe a feature you’d like to add").fill("Pin important notes");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    expect(api.counts().analysisCalls).toBe(0);
    await page.getByRole("button", { name: "Confirm features and generate design" }).click(); await expect(page.getByRole("heading", { name: "A few choices shape your app." })).toBeVisible();
    const featureProjectId = new URL(page.url()).searchParams.get("project")!;
    const featureProject = await api.service.get(featureProjectId), preferences = featureProject.featurePreferences;
    const designJob = await api.service.storedJob(featureProject.activeJobId!);
    const submitted = await api.service.pipeline.get(designJob.pipelineJobId!);
    expect(submitted.input.feature_requests).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Quick capture", description: "Capture a note offline with a single action." }), expect.objectContaining({ name: "Pin important notes" })]));
    expect(submitted.input.feature_requests.some(feature => feature.name === "Quick notes")).toBe(false);
    expect(preferences.customRequests).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Quick capture", description: "Capture a note offline with a single action." }), expect.objectContaining({ name: "Pin important notes" })]));
    expect(Object.values(preferences.selections).flat()).toContain(preferences.customRequests.find(feature => feature.name === "Quick capture")!.id);
    await page.getByRole("radio", { name: "option-save-explicit" }).check(); await page.getByRole("button", { name: "Use these choices" }).click();
    await expect(page.getByRole("heading", { name: "Your app, in plain language." })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Your app profile" })).toContainText("Pocket Notes");
    const id = new URL(page.url()).searchParams.get("project")!; const saved = await api.service.get(id); expect((await api.service.buildInput(id)).decisions.chosen_by).toBe("user");
    await page.getByLabel("What would you like to change?", { exact: true }).fill("change"); await page.getByRole("button", { name: "Review suggested changes" }).click();
    await expect(page.getByRole("heading", { name: "Choose what to keep." })).toBeVisible(); expect((await api.service.get(id)).currentDesignRevision).toBe(saved.currentDesignRevision);
    await page.locator(".studio-change").filter({ hasText: "Rename the writing feature" }).getByRole("checkbox").uncheck(); await page.getByRole("button", { name: "Confirm selected changes" }).click();
    await expect(page.getByText("Version 2", { exact: true })).toBeVisible(); expect((await api.service.buildInput(id)).developer_design.visual.colors[0].value).toBe("#246B4A");
    await page.getByRole("button", { name: "Approve and build" }).click(); await expect(page.getByRole("heading", { name: "Your Android app is ready." })).toBeVisible();
    await page.reload(); await expect(page.getByRole("heading", { name: "Your Android app is ready." })).toBeVisible();
    const download = page.waitForEvent("download"); await page.getByRole("link", { name: "Download Android app" }).click(); expect((await download).suggestedFilename()).toBe("app.apk");
    const delivered = await api.service.get(id); expect(delivered.latestBuild!.revision).toBe(delivered.currentDesignRevision); expect(api.counts()).toEqual({ analysisCalls: 2, buildCalls: 1 });
  } finally { await page.unrouteAll({ behavior: "wait" }).catch(() => undefined); await api.close(); }
});
test("free text, clarification, dismiss and restore stay in one review workspace", async ({ page }) => {
  test.setTimeout(60000);
  const api = await projectServer();
  try {
    await connect(page, api); await example(page);
    await page.getByLabel("What would you like to change?").fill("vague"); await page.getByRole("button", { name: "Review suggested changes" }).click();
    await expect(page.getByRole("heading", { name: "Let’s clarify one thing." })).toBeVisible(); await page.getByRole("button", { name: "Color", exact: true }).click(); await expect(page.getByLabel("What would you like to change?")).toHaveValue(/My choice: Color/);
    await page.getByRole("button", { name: "Dismiss suggestions" }).click(); await page.getByLabel("What would you like to change?").fill("unrelated"); await page.getByRole("button", { name: "Review suggested changes" }).click(); await expect(page.getByRole("heading", { name: "Your design is unchanged." })).toBeVisible();
    await page.getByRole("button", { name: "Dismiss suggestions" }).click(); await page.getByLabel("What would you like to change?").fill("change"); await page.getByRole("button", { name: "Review suggested changes" }).click(); await page.getByRole("button", { name: "Confirm selected changes" }).click(); await expect(page.getByText("Version 2", { exact: true })).toBeVisible();
    await page.getByText("Design history and development files", { exact: true }).click(); await page.getByRole("button", { name: "Version history", exact: true }).click(); page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "Restore", exact: true }).click(); await expect(page.getByText("Version 3", { exact: true })).toBeVisible();
  } finally { await page.unrouteAll({ behavior: "wait" }).catch(() => undefined); await api.close(); }
});
test("missing APKs continue to the design while progress stays concise across reload", async ({ page }) => {
  test.setTimeout(60000); const api = await projectServer({ apks: false });
  try {
    await connect(page, api); await page.goto("/"); await page.getByLabel("Describe your app", { exact: true }).fill(idea.input); await page.getByText("A few preferences, if you have them").click(); await page.getByLabel("Search topic", { exact: true }).fill("Productivity"); await page.getByRole("button", { name: "Explore ideas", exact: true }).click();
    await page.getByRole("button", { name: "Confirm features and generate design" }).click(); await expect(page.getByRole("heading", { name: "A few choices shape your app." })).toBeVisible();
    const progress = page.getByLabel("Design generation progress"); await expect(progress).toContainText("Get reference apps"); await expect(progress.locator("li")).toHaveCount(5);
    await expect(progress.locator(".studio-pipeline-apps")).toHaveCount(0); await expect(page.getByText("Check again", { exact: true })).toHaveCount(0); await expect(page.getByRole("button", { name: "Retry failed APK downloads" })).toHaveCount(0);
    await page.reload(); await expect(page.getByRole("heading", { name: "A few choices shape your app." })).toBeVisible();
    await page.getByRole("button", { name: "Use these choices" }).click(); await expect(page.getByRole("heading", { name: "Your app, in plain language." })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download Android app" })).toHaveCount(0); expect(api.counts().analysisCalls).toBe(2);
  } finally { await page.unrouteAll({ behavior: "wait" }).catch(() => undefined); await api.close(); }
});
for (const width of [320, 390, 1440]) test(`new workspace is accessible and fits at ${width}px`, async ({ page }) => {
  test.setTimeout(60000);
  const api = await projectServer();
  try {
    await page.setViewportSize({ width, height: 1000 }); await connect(page, api); await page.goto("/");
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Try the Notes example" }).click(); await expect(page.getByRole("heading", { name: "Your app, in plain language." })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  } finally { await page.unrouteAll({ behavior: "wait" }).catch(() => undefined); await api.close(); }
});
