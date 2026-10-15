import { test, expect } from "./fixtures";
import { fromScannerReport } from "../src/market";
import { scannerReport } from "./market-data";
import { rankForIntent, featureMatches } from "../src/relevance";
import { buildCatalog } from "../src/market";
import { parseIntent, intentBrief } from "../src/intent";
import type { SearchPlan } from "../src/intent";
import AxeBuilder from "@axe-core/playwright";

export const searchPlan: SearchPlan = { summary: "Offline notes for students", audience: "Students", features: [{ name: "Quick notes", terms: ["quick notes", "notepad"] }], exclusions: ["Accounts and sync"], assumptions: ["One device"], topics: [{ domain: "Notes & lists", queries: ["offline quick notes", "student notepad"] }] };
test("idea asks questions before scanning, then confirms specific queries and survives reload", async ({ page }) => {
  const scans: any[] = [], calls: any[] = [];
  await page.route("**/api/intent/clarify", route => {
    const input = route.request().postDataJSON(); calls.push(input);
    return route.fulfill({ json: input.turns.length ? { message: "Check this scope.", questions: [], plan: searchPlan } : { message: "Two details will help.", questions: [{ id: "audience", question: "Who will use this?", options: ["Students", "Just me"] }, { id: "task", question: "What should it do first?", options: ["Quick notes", "Flashcards"] }], plan: null } });
  });
  await page.route("**/api/market/**", route => {
    if (route.request().url().endsWith("status")) return route.fulfill({ json: { available: true } });
    scans.push(route.request().postDataJSON());
    return route.fulfill({ json: { result: fromScannerReport("Notes & lists", scannerReport("Notes & lists")) } });
  });
  await page.goto("/");
  await expect(page.locator(".studio-domain-grid button")).toHaveCount(6);
  await page.getByLabel("What would you like to build?", { exact: true }).fill("Something for studying");
  await page.getByRole("button", { name: "Clarify my idea" }).click();
  await expect(page.getByRole("group", { name: "Who will use this?" })).toBeVisible();
  expect(scans).toHaveLength(0);
  await page.getByRole("button", { name: "Students", exact: true }).click();
  await page.getByRole("button", { name: "Quick notes", exact: true }).click();
  await page.getByRole("button", { name: "Continue with answers" }).click();
  await expect(page.getByRole("heading", { name: "Check your search plan" })).toBeVisible();
  expect(calls[1].turns.map((t: any) => t.answer)).toEqual(["Students", "Quick notes"]);
  expect(scans).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Confirm and find apps" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm and find apps" }).click();
  await expect(page.getByRole("heading", { name: "Explore reference apps" })).toBeVisible();
  await expect.poll(() => scans.length).toBeGreaterThan(0);
  expect(scans[0].queries).toEqual(searchPlan.topics[0].queries);
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem("meld.workspace.v1")!))).intent.approved).toBe(true);
});
test("failed clarification keeps the idea and offers retry without inventing a plan", async ({ page }) => {
  await page.route("**/api/intent/clarify", route => route.fulfill({ status: 502, json: { error: { message: "The model is temporarily unavailable." } } }));
  await page.goto("/"); await page.getByLabel("What would you like to build?", { exact: true }).fill("A gaming app");
  await page.getByRole("button", { name: "Clarify my idea" }).click();
  await expect(page.getByRole("alert")).toContainText("temporarily unavailable");
  await expect(page.getByRole("button", { name: "Retry clarification" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm and find apps" })).toHaveCount(0);
  await page.reload(); await expect(page.getByLabel("What would you like to build?", { exact: true })).toHaveValue("A gaming app");
});
test("editing a pending idea discards a late response", async ({ page }) => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/intent/clarify", async route => { await hold; await route.fulfill({ json: { message: "Old plan", questions: [], plan: searchPlan } }).catch(() => {}); });
  await page.goto("/"); await page.getByLabel("What would you like to build?", { exact: true }).fill("Old idea");
  await page.getByRole("button", { name: "Clarify my idea" }).click();
  await expect(page.getByRole("region", { name: "Describe your idea" }).getByRole("status")).toContainText("Clarifying");
  await page.getByLabel("What would you like to build?", { exact: true }).fill("New idea"); release();
  await expect(page.getByRole("button", { name: "Clarify my idea" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Confirm and find apps" })).toHaveCount(0);
});
test("feature relevance ranks matches without changing market scores or hiding unmatched apps", () => {
  const result = fromScannerReport("Notes & lists", scannerReport("Notes & lists"));
  const apps = buildCatalog(["Notes & lists"], { "Notes & lists": result });
  const ranked = rankForIntent(apps, searchPlan);
  expect(ranked[0].id).toBe("com.example.notes"); expect(featureMatches(ranked[0], searchPlan)).toEqual(["Quick notes"]);
  expect(ranked).toHaveLength(apps.length); expect(ranked[0].market!.score).toBe(result.apps.find(a => a.appId === ranked[0].id)!.score);
  expect(parseIntent({ idea: "test", turns: [], approved: true, reply: { message: "test", questions: [], plan: { ...searchPlan, topics: [] } } })).toBeUndefined();
});
test("confirmed scope limits survive a long clarification history", () => {
  const brief = intentBrief({ idea: "Long original idea. ".repeat(150), turns: Array.from({ length: 9 }, () => ({ question: "More context?", answer: "detail ".repeat(150) })), approved: true, reply: { message: "Confirmed", questions: [], plan: searchPlan } });
  expect(brief.length).toBeLessThanOrEqual(6000);
  expect(brief).toContain("Confirmed scope: Offline notes for students");
  expect(brief).toContain("Excluded: Accounts and sync");
  expect(brief).toContain("Agreed assumptions: One device");
});
test("changing domains discards a clarification for the old scope", async ({ page }) => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/intent/clarify", async route => { await hold; await route.fulfill({ json: { message: "Old plan", questions: [], plan: searchPlan } }).catch(() => {}); });
  await page.goto("/"); await page.getByLabel("What would you like to build?", { exact: true }).fill("A study app");
  await page.getByRole("button", { name: "Clarify my idea" }).click();
  await expect(page.getByRole("region", { name: "Describe your idea" }).getByRole("status")).toContainText("Clarifying");
  await page.locator(".studio-domain-grid button").first().click(); release();
  await expect(page.getByRole("button", { name: "Clarify my idea" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Confirm and find apps" })).toHaveCount(0);
  await expect(page.getByLabel("What would you like to build?", { exact: true })).toHaveValue("A study app");
});
test("idea panel keeps the six-domain layout accessible on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("damaged saved intent does not discard the rest of the workspace", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("meld.workspace.v1", JSON.stringify({ version: 1, name: "My saved project", domains: ["Notes & lists"], selected: {}, intent: { idea: "test", turns: [], approved: true, reply: { message: "test", questions: [], plan: { summary: "test", audience: "test", topics: [null] } } } })));
  await page.reload();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("meld.workspace.v1")!).name)).toBe("My saved project");
  await expect(page.getByRole("button", { name: "Remove Notes & lists", exact: true })).toBeVisible();
  await expect(page.getByLabel("What would you like to build?", { exact: true })).toBeEmpty();
});

for (const cached of [false, true]) test("confirmed idea opens " + (cached ? "saved" : "new") + " results without domain selection or lost choices", async ({ page }) => {
  const result = { ...fromScannerReport("Notes & lists", scannerReport("Notes & lists", { indexes: [1] })), scanId: "scan-" + "a".repeat(64) };
  result.apps[0].listedFeatures = { items: [{ name: "Quick notes", detail: "Write and save notes offline." }], model: "fixture", template: "fixture", generatedAt: result.generatedAt };
  const scans: any[] = [];
  await page.route("**/api/market/**", route => {
    if (route.request().url().endsWith("status")) return route.fulfill({ json: { available: true } });
    scans.push(route.request().postDataJSON());
    return route.fulfill({ json: { result } });
  });
  await page.goto("/");
  await page.evaluate(({ searchPlan, result, cached }) => localStorage.setItem("meld.workspace.v1", JSON.stringify({
    version: 1, domains: ["Notes & lists"], discoveryStarted: false,
    intent: { idea: "I want an app", turns: [{ question: "What should it do?", answer: "Keep my notes" }], reply: { message: "Ready", questions: [], plan: searchPlan }, approved: true },
    selected: cached ? { "com.example.notes": ["com.example.notes:quick-notes"] } : {},
    market: cached ? { "Notes & lists": result } : {},
    customFeatures: [{ id: "custom-pin", name: "Pin notes", description: "Pin one note at the top." }],
  })), { searchPlan, result, cached });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your confirmed search plan", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Select your domains", exact: true })).toBeVisible();
  await expect(page.locator(".studio-domain-grid button")).toHaveCount(6);
  await expect(page.getByRole("button", { name: "Explore selected domains" })).toBeVisible();
  expect(scans).toHaveLength(0);
  await page.getByRole("button", { name: "View app results", exact: true }).click();
  await expect(page.locator(".studio-reference-card")).toHaveCount(1);
  expect(scans).toHaveLength(cached ? 0 : 1);
  if (!cached) {
    expect(scans[0].queries).toEqual(searchPlan.topics[0].queries);
    await page.getByRole("button", { name: "Select all features from Notes Daily", exact: true }).click();
  }
  await expect(page.getByRole("button", { name: "Clear all features from Notes Daily", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: "Your feature mix" })).toContainText("Pin notes");
  await page.getByRole("button", { name: "Edit idea or domains", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "View app results", exact: true }).click();
  await expect(page.getByRole("button", { name: "Clear all features from Notes Daily", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: "Your feature mix" })).toContainText("Pin notes");
  expect(scans).toHaveLength(cached ? 0 : 1);
});

test("domains remain an explicit alternative to a confirmed idea", async ({ page }) => {
  const result = { ...fromScannerReport("Notes & lists", scannerReport("Notes & lists", { indexes: [1] })), scanId: "scan-" + "a".repeat(64) };
  const scans: any[] = [];
  await page.route("**/api/market/**", route => {
    if (route.request().url().endsWith("status")) return route.fulfill({ json: { available: true } });
    scans.push(route.request().postDataJSON()); return route.fulfill({ json: { result } });
  });
  await page.goto("/");
  await page.evaluate(({ searchPlan, result }) => localStorage.setItem("meld.workspace.v1", JSON.stringify({ version: 1, domains: ["Notes & lists"], discoveryStarted: false, selected: {}, market: { "Notes & lists": result }, intent: { idea: "Keep my notes", turns: [], reply: { message: "Ready", questions: [], plan: searchPlan }, approved: true } })), { searchPlan, result });
  await page.reload();
  await page.getByRole("button", { name: "Use domains only", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Select your domains", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Explore selected domains", exact: true }).click();
  await expect.poll(() => scans.length).toBe(1);
  expect(scans[0]).toEqual({ domain: "Notes & lists", refresh: false });
});

test("unfinished chat can browse selected domains and resume its saved answers", async ({ page }) => {
  const scans: any[] = [], chats: any[] = [];
  await page.route("**/api/market/**", route => {
    if (route.request().url().endsWith("status")) return route.fulfill({ json: { available: true } });
    scans.push(route.request().postDataJSON());
    return route.fulfill({ json: { result: { ...fromScannerReport("Notes & lists", scannerReport("Notes & lists", { indexes: [1] })), scanId: "scan-" + "a".repeat(64) } } });
  });
  await page.route("**/api/intent/clarify", route => {
    const input = route.request().postDataJSON(); chats.push(input);
    return route.fulfill({ json: input.turns.length ? { message: "Ready", questions: [], plan: searchPlan } : { message: "One detail first.", questions: [{ id: "audience", question: "Who will use it?", options: ["Students", "Just me"] }], plan: null } });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Explore selected domains", exact: true })).toBeDisabled();
  await page.getByLabel("What would you like to build?", { exact: true }).fill("An app for my classes");
  await page.getByRole("button", { name: "Clarify my idea", exact: true }).click();
  await page.getByRole("button", { name: "Students", exact: true }).click();
  await page.getByRole("button", { name: /^Notes & lists/ }).click();
  await expect(page.getByRole("button", { name: "Explore selected domains", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Explore selected domains", exact: true }).click();
  await expect(page.locator(".studio-reference-card")).toHaveCount(1);
  expect(scans).toEqual([{ domain: "Notes & lists", refresh: false }]);
  await expect(page.getByRole("heading", { name: "Your confirmed search", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".studio-reference-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Edit idea or domains", exact: true }).click();
  await expect(page.getByLabel("What would you like to build?", { exact: true })).toHaveValue("An app for my classes");
  await expect(page.getByRole("button", { name: "Students", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Continue with answers", exact: true }).click();
  expect(chats[1].turns).toEqual([{ question: "Who will use it?", answer: "Students" }]);
  await page.getByRole("button", { name: "Confirm and find apps", exact: true }).click();
  await expect.poll(() => scans.length).toBe(2);
  expect(scans[1].queries).toEqual(searchPlan.topics[0].queries);
});

test("domain changes preserve a confirmed chat and each result button uses its own search", async ({ page }) => {
  const scans: any[] = [];
  await page.route("**/api/market/**", route => {
    if (route.request().url().endsWith("status")) return route.fulfill({ json: { available: true } });
    const input = route.request().postDataJSON(); scans.push(input);
    return route.fulfill({ json: { result: { ...fromScannerReport(input.domain, scannerReport(input.domain, { indexes: input.domain === "Focus & habits" ? [4] : [1] })), scanId: "scan-" + "a".repeat(64) } } });
  });
  await page.goto("/");
  await page.evaluate(plan => localStorage.setItem("meld.workspace.v1", JSON.stringify({ version: 1, domains: ["Notes & lists"], discoveryStarted: false, selected: {}, goal: plan.summary, description: plan.summary, audience: plan.audience, intent: { idea: "Study notes", turns: [], reply: { message: "Ready", questions: [], plan }, approved: true } })), searchPlan);
  await page.reload();
  await page.getByRole("button", { name: "Remove Notes & lists", exact: true }).click();
  await page.getByRole("button", { name: /^Focus & habits/ }).click();
  await expect(page.getByRole("button", { name: "View app results", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Explore selected domains", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Explore selected domains", exact: true }).click();
  await expect(page.locator(".studio-reference-card")).toHaveCount(1);
  expect(scans).toEqual([{ domain: "Focus & habits", refresh: false }]);
  let saved = await page.evaluate(() => JSON.parse(localStorage.getItem("meld.workspace.v1")!));
  expect(saved.intent.reply.plan).toEqual(searchPlan);
  expect(saved.goal).toBe(""); expect(saved.description).toBe("");
  await page.reload();
  await expect(page.locator(".studio-reference-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Edit idea or domains", exact: true }).click();
  await page.getByRole("button", { name: "View app results", exact: true }).click();
  await expect(page.locator(".studio-reference-card h3")).toHaveText("Notes Daily");
  expect(scans[1]).toEqual({ domain: "Notes & lists", refresh: false, queries: searchPlan.topics[0].queries });
  saved = await page.evaluate(() => JSON.parse(localStorage.getItem("meld.workspace.v1")!));
  expect(saved.discoverySource).toBe("idea"); expect(saved.goal).toBe(searchPlan.summary);
});

test("domain search cancels pending clarification and ignores its late reply", async ({ page }) => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/intent/clarify", async route => { await hold; await route.fulfill({ json: { message: "Late plan", questions: [], plan: searchPlan } }).catch(() => {}); });
  await page.route("**/api/market/**", route => route.fulfill({ json: route.request().url().endsWith("status") ? { available: true } : { result: { ...fromScannerReport("Notes & lists", scannerReport("Notes & lists", { indexes: [1] })), scanId: "scan-" + "a".repeat(64) } } }));
  try {
    await page.goto("/");
    await page.getByRole("button", { name: /^Notes & lists/ }).click();
    await page.getByLabel("What would you like to build?", { exact: true }).fill("An app for classes");
    await page.getByRole("button", { name: "Clarify my idea", exact: true }).click();
    await expect(page.getByRole("region", { name: "Describe your idea" }).getByRole("status")).toContainText("Clarifying");
    await page.getByRole("button", { name: "Explore selected domains", exact: true }).click();
    await expect(page.locator(".studio-reference-card")).toHaveCount(1);
    release();
    await page.getByRole("button", { name: "Edit idea or domains", exact: true }).click();
    await expect(page.getByRole("button", { name: "Confirm and find apps", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("What would you like to build?", { exact: true })).toHaveValue("An app for classes");
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
});
