import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { integrated } from "./studio-fixtures";
import { randomUUID } from "node:crypto";
import { Handoff, importSelection } from "../server/workflow";
import { handoffBody } from "../src/workflow";

const plan = { summary: "Offline study notes", audience: "Students", features: [{ name: "Quick notes", terms: ["quick notes", "notepad"] }], exclusions: ["Accounts and sync"], assumptions: ["One device"], topics: [{ domain: "Notes & lists", queries: ["offline quick notes", "student notepad"] }] };
async function connect(page: Page, server: Awaited<ReturnType<typeof integrated>>) {
  for (const pattern of ["**/api/status", "**/api/projects", "**/api/projects/**", "**/api/workflow/**", "**/api/jobs/**"]) await page.route(pattern, async route => {
    const req = route.request(), url = new URL(req.url());
    const response = await page.request.fetch(server.address + url.pathname + url.search, { method: req.method(), headers: { "Content-Type": "application/json", Origin: server.address }, data: req.postData() || undefined });
    await route.fulfill({ response });
  });
}
test("upstream studio clarifies, searches beyond five apps, keeps customized features, edits outline and delivers (synthetic workers)", async ({ page }) => {
  test.setTimeout(60000);
  const server = await integrated(), scans: any[] = [];
  try {
    await connect(page, server);
    const note = server.scan.apps.find(a => a.appId === "com.example.notes")!;
    const scan = await server.signals.record({ ...server.scan, apps: Array.from({ length: 8 }, (_, i) => ({ ...note, appId: i ? `com.example.notes${i}` : note.appId, title: i ? `Notes ${i}` : "Notes Daily", rank: i + 1 })), ranked: 8 });
    await page.route("**/api/market/**", route => {
      if (route.request().url().endsWith("status")) return route.fulfill({ json: { available: true } });
      scans.push(route.request().postDataJSON()); return route.fulfill({ json: { result: scan } });
    });
    await page.route("**/api/intent/clarify", route => route.fulfill({ json: route.request().postDataJSON().turns.length ? { message: "Check this plan.", questions: [], plan } : { message: "One detail first.", questions: [{ id: "audience", question: "Who will use it?", options: ["Students", "Just me"] }], plan: null } }));
    await page.goto("/"); await expect(page.getByRole("navigation", { name: "App creation steps" }).getByRole("button")).toHaveCount(3);
    await expect(page.locator(".studio-domain-grid button")).toHaveCount(6);
    await page.getByLabel("What would you like to build?", { exact: true }).fill("A study app");
    await page.getByRole("button", { name: "Clarify my idea" }).click(); await page.getByRole("button", { name: "Students", exact: true }).click();
    expect(scans).toHaveLength(0); await page.getByRole("button", { name: "Continue with answers" }).click();
    await page.getByRole("button", { name: "Confirm and find apps" }).click();
    await expect(page.locator(".studio-reference-card")).toHaveCount(8);
    expect(scans[0].queries).toEqual(plan.topics[0].queries);
    await expect(page.getByText("Listing mentions: Quick notes", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Select all features from Notes Daily", exact: true }).click();
    await expect(page.getByRole("button", { name: "Clear all features from Notes Daily", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Explore Notes Daily", exact: true }).click();
    await page.getByText("Customize Quick notes", { exact: true }).click();
    await page.getByLabel("Feature name", { exact: true }).fill("Capture class notes");
    await page.getByLabel("How should it work?", { exact: true }).fill("Save plain text on this phone.");
    await page.getByLabel("Your own feature idea", { exact: true }).fill("Pin a note"); await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.reload(); await expect(page.locator(".studio-reference-card")).toHaveCount(8);
    await expect(page.getByRole("button", { name: "Clear all features from Notes Daily", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Confirm features and generate design" }).click();
    await expect(page.getByRole("heading", { name: "Your app, in plain language." })).toBeVisible();
    expect(server.received[0].featurePreferences.customRequests).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Capture class notes", description: "Save plain text on this phone." }), expect.objectContaining({ name: "Pin a note" })]));
    expect(server.received[0].brief.input).toContain("Confirmed scope: Offline study notes");
    expect(server.counts()).toEqual({ analysisCalls: 0, buildCalls: 0 });
    await page.getByRole("button", { name: "Edit App summary", exact: true }).dblclick();
    await page.getByLabel("App summary", { exact: true }).fill("Capture class notes offline.");
    await page.getByLabel("App summary", { exact: true }).press("Tab");
    await expect(page.getByRole("button", { name: "Approve design and build app" })).toBeDisabled();
    await page.getByRole("button", { name: "Save design edits", exact: true }).click();
    await expect(page.getByRole("button", { name: "Approve design and build app" })).toBeEnabled();
    await page.reload(); await expect(page.getByRole("button", { name: "Edit App summary", exact: true })).toContainText("Capture class notes offline.");
    await page.getByRole("button", { name: "Approve design and build app" }).click();
    await expect(page.getByRole("heading", { name: "Your Android app is ready.", exact: true })).toBeVisible({ timeout: 20000 });
    const downloaded = page.waitForEvent("download"); await page.getByRole("link", { name: "Download Android app" }).click(); expect((await downloaded).suggestedFilename()).toBe("app.apk");
    await page.reload(); await expect(page.getByRole("link", { name: "Download Android app" })).toBeVisible();
    expect(server.counts()).toEqual({ analysisCalls: 1, buildCalls: 1 });
  } finally { await page.unrouteAll({ behavior: "wait" }).catch(() => undefined); await server.close(); }
});

for (const width of [390, 1440]) test(`upstream landing page preserves six domains and is accessible at ${width}px`, async ({ page }) => {
  await page.route("**/api/projects", route => route.fulfill({ json: { projects: [] } }));
  await page.setViewportSize({ width, height: 1000 }); await page.goto("/");
  await expect(page.locator(".studio-domain-grid button")).toHaveCount(6);
  await page.getByRole("button", { name: /^Notes & lists/ }).click(); await page.getByLabel("Enter a domain", { exact: true }).fill("Gaming");
  await page.getByRole("button", { name: "Add domain", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove Gaming", exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole("button", { name: "Remove Gaming", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});

test("filtered scans keep real counts and pending summaries cannot be selected", async ({ page }) => {
  const server = await integrated();
  try {
    await connect(page, server);
    const note = server.scan.apps.find(a => a.appId === "com.example.notes")!;
    const scan = { ...server.scan, ranked: 2, apps: [{ ...note, listedFeatures: undefined }, { ...note, appId: "com.example.cloud", title: "Team Notes", summary: "Shared real-time collaboration with cloud sync", description: "A social network with cloud sync and team collaboration" }] };
    await page.route("**/api/market/**", route => route.fulfill({ json: route.request().url().endsWith("status") ? { available: true } : { result: scan } }));
    await page.goto("/"); await page.getByRole("button", { name: /^Notes & lists/ }).click(); await page.getByRole("button", { name: "Explore selected domains" }).click();
    await expect(page.locator(".studio-reference-card")).toHaveCount(1);
    await expect(page.getByText("1 shown · 2 ranked", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Select all features from Notes Daily", exact: true })).toBeDisabled();
    await page.getByText("See what was filtered out (1)", { exact: true }).click(); await expect(page.getByText("Team Notes", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Explore Notes Daily", exact: true }).click(); await expect(page.getByText("Features are not ready yet.", { exact: false })).toBeVisible();
  } finally { await page.unrouteAll({ behavior: "wait" }).catch(() => undefined); await server.close(); }
});

test("expired browser preview offers reopening after a server restart", async ({ page }) => {
  const server = await integrated();
  try {
    let project = await server.service.create({ requestKey: randomUUID(), brief: { name: "Notes", input: "An offline notes app", audience: "Students", purpose: "Save notes", goal: "Study", domains: ["Notes & lists"], style: "warm" }, exampleId: "notes" });
    await server.service.build(project.id, { requestKey: randomUUID(), expectedVersion: project.version, revision: project.currentDesignRevision! }); await server.service.idle();
    project = await server.service.get(project.id);
    await connect(page, server);
    await page.route("**/api/status", route => route.fulfill({ json: { available: true, emulatorAvailable: true } }));
    await page.route(/\/emulator(?:\/|$)/, route => route.fulfill(route.request().method() === "POST" ? { json: { id: "emulator-fixture", projectId: project.id, buildId: project.latestBuild!.id, apkSha256: "fixture", status: "starting", phase: "Starting preview", width: 0, height: 0 } } : { status: 404, json: { error: { code: "emulator_expired", message: "This preview ended. Open it again to continue." } } }));
    await page.goto(`/?project=${project.id}`); await page.getByRole("button", { name: "Try app in browser", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("This preview ended.");
    await expect(page.getByRole("button", { name: "Try app in browser", exact: true })).toBeEnabled();
  } finally { await page.unrouteAll({ behavior: "wait" }).catch(() => undefined); await server.close(); }
});

test("a failed outline keeps imported selections and retries after reload", async ({ page }) => {
  const server = await integrated({ outlineFailures: 1 });
  try {
    const project = await importSelection(server.service, server.signals, Handoff.parse({ ...handoffBody(server.draft), requestKey: randomUUID() }));
    await server.service.design(project.id, { requestKey: randomUUID(), expectedVersion: project.version }); await server.service.idle();
    await connect(page, server); await page.goto(`/?project=${project.id}`);
    await expect(page.getByRole("alert")).toContainText("Temporary outline failure");
    await page.reload(); await page.getByRole("button", { name: "Retry outline", exact: true }).click();
    await expect(page.getByLabel("High-level design", { exact: true })).toBeVisible();
    expect(server.received).toHaveLength(2); expect(server.received[1].featurePreferences).toEqual(project.featurePreferences);
  } finally { await page.unrouteAll({ behavior: "wait" }).catch(() => undefined); await server.close(); }
});
