import { test, expect } from "./fixtures";
import { marketResult } from "./market-data";

for (const url of ["/#/domains", "/#/apps", "/#/apps/forest", "/legacy#/review", "/legacy#/result"]) test("old bookmark opens only the current studio: " + url, async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("meld.workspace.v1", JSON.stringify({ version: 1, name: "My notes", domains: ["Productivity"], selected: { forest: ["timer"], ticktick: ["tasks"] }, intent: { idea: "Tasks and short notes together", turns: [], approved: false } }));
      sessionStorage.setItem("seeded", "true");
    }
  });
  await page.goto(url);
  await expect(page.getByRole("navigation", { name: "App creation steps" }).getByRole("button")).toHaveCount(3);
  await expect(page.getByRole("heading", { name: "Select your domains", exact: true })).toBeVisible();
  await expect(page.getByLabel("What would you like to build?", { exact: true })).toHaveValue("Tasks and short notes together");
  expect(new URL(page.url()).hash).toBe("");
  expect(new URL(page.url()).pathname).toBe("/");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("meld.workspace.v1")!).selected)).toEqual({});
  await expect(page.getByRole("link", { name: "Earlier workspace & browser demos" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Start with a smarter combination" })).toHaveCount(0);
  await expect(page.getByText("Forest", { exact: true })).toHaveCount(0);
});

test("an older saved live scan and choices survive route migration", async ({ page }) => {
  const result = marketResult("Productivity", { indexes: [1] });
  result.apps[0].listedFeatures = { items: [{ name: "Quick notes", detail: "Write and save notes offline." }], model: "fixture", template: "fixture", generatedAt: result.generatedAt };
  await page.addInitScript(result => {
    localStorage.setItem("meld.workspace.v1", JSON.stringify({ version: 1, name: "My notes", domains: ["Productivity"], selected: { forest: ["timer"], "com.example.notes": ["com.example.notes:quick-notes"] }, market: { Productivity: result } }));
  }, result);
  await page.goto("/legacy#/apps");
  await expect(page.getByRole("button", { name: "Clear all features from Notes Daily", exact: true })).toBeVisible();
  await expect(page.locator(".studio-reference-card")).toHaveCount(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("meld.workspace.v1")!).selected)).toEqual({ "com.example.notes": ["com.example.notes:quick-notes"] });
});

test("new app clears the previous draft and stays in the current studio", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("What would you like to build?", { exact: true }).fill("Private study notes");
  await page.getByRole("button", { name: /^Notes & lists/ }).click();
  await page.getByRole("button", { name: "New app", exact: true }).click();
  await expect(page.getByLabel("What would you like to build?", { exact: true })).toBeEmpty();
  await expect(page.getByRole("button", { name: "Remove Notes & lists", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Select your domains", exact: true })).toBeVisible();
  await expect(page.getByLabel("What would you like to build?", { exact: true })).toBeEmpty();
});

test("an old approved idea resumes its confirmed search without another form", async ({ page }) => {
  const scans: unknown[] = [];
  await page.addInitScript(() => localStorage.setItem("meld.workspace.v1", JSON.stringify({ version: 1, domains: ["Productivity"], selected: { forest: ["timer"] }, intent: { idea: "Tasks and notes", turns: [], approved: true, reply: { message: "Ready", questions: [], plan: { summary: "Tasks and notes together", audience: "Me", features: [{ name: "Quick notes", terms: ["notes"] }], exclusions: [], assumptions: [], topics: [{ domain: "Productivity", queries: ["offline tasks and notes"] }] } } } })));
  await page.route("**/api/market/status", route => route.fulfill({ json: { available: true } }));
  await page.route("**/api/market/scan", route => { scans.push(route.request().postDataJSON()); return route.fulfill({ json: { result: { ...marketResult("Productivity"), apps: [], ranked: 0 } } }); });
  await page.goto("/#/apps");
  await expect(page.getByRole("heading", { name: "Your confirmed search", exact: true })).toBeVisible();
  await expect.poll(() => scans.length).toBe(1);
  expect(scans[0]).toMatchObject({ queries: ["offline tasks and notes"] });
  await expect(page.getByLabel("What would you like to build?", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Suggest a combination" })).toHaveCount(0);
});
