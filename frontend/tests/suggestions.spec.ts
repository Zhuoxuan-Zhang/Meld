import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import JSZip from "jszip";
import fs from "node:fs/promises";
import { apps, domains } from "../src/data";
import { exampleSuggestion } from "../src/suggestions";

const key = "meld.workspace.v1";
const original = {
  version: 1,
  domains: ["Productivity", "Wellness"],
  selected: { forest: ["garden"] },
  name: "",
  audience: "",
  description: "",
  goal: "",
  style: "warm",
  built: false,
};
const plan = {
  name: "Study & Reset",
  summary: "Plan one task, focus on it, then reset with a breathing break.",
  audience: "Students",
  source: "ai",
  model: "test-model",
  features: [
    {
      appId: "ticktick",
      featureId: "tasks",
      reason: "Choose the next assignment before starting a focus session.",
    },
    {
      appId: "forest",
      featureId: "timer",
      reason: "Give each chosen task one clear block of focused time.",
    },
    {
      appId: "headspace",
      featureId: "breathing",
      reason: "Take a short breathing break between focused tasks.",
    },
  ],
  journey: [
    "Pick one assignment from your tasks.",
    "Start a timer and work on that assignment.",
    "Take a breathing break, then choose the next task.",
  ],
};
async function seed(page: Page, value: object = original) {
  await page.route("**/api/ai/status", (r) =>
    r.fulfill({ json: { available: true, provider: "OpenRouter" } }),
  );
  await page.goto("/");
  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key, value },
  );
  await page.goto("/?suggestion-test=1#/apps");
}
async function saved(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
}

test("AI plan: request, preview, apply, undo, persistence, combined brief and export", async ({
  page,
}) => {
  await seed(page);
  let payload: unknown;
  await page.route("**/api/ai/suggest", (r) => {
    payload = r.request().postDataJSON();
    return r.fulfill({ json: { plan } });
  });
  await page
    .getByLabel("What would you like to build?")
    .fill("Help students focus and take breaks.");
  await page
    .getByRole("button", { name: "Suggest a combination", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: plan.name, exact: true }),
  ).toBeVisible();
  expect(payload).toEqual({
    domains: original.domains,
    goal: "Help students focus and take breaks.",
  });
  expect((await saved(page)).selected).toEqual(original.selected);
  await page.getByRole("button", { name: "Use this plan" }).click();
  await expect(
    page.getByRole("button", { name: "Review app", exact: true }),
  ).toBeEnabled();
  expect((await saved(page)).selected).toEqual({
    ticktick: ["tasks"],
    forest: ["timer"],
    headspace: ["breathing"],
  });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await saved(page)).selected).toEqual(original.selected);
  await page.getByRole("button", { name: "Use this plan" }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Review app", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Review app", exact: true }).click();
  await expect(page.getByLabel("What will you call it?")).toHaveValue(
    plan.name,
  );
  await expect(page.locator(".accepted-plan .plan-journey")).not.toBeVisible();
  await page.locator(".approved-summary").click();
  await expect(page.locator(".accepted-plan .plan-journey")).toBeVisible();
  await page.locator(".approved-summary").click();
  await page.getByRole("button", { name: "Preview the design brief" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "AI suggestion via OpenRouter",
  );
  await expect(page.getByRole("dialog")).toContainText(plan.features[1].reason);
  await expect(page.getByRole("dialog")).toContainText(plan.journey[2]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Create my app" }).click();
  await expect(page).toHaveURL(/#\/result$/);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download project" }).click();
  const zip = await JSZip.loadAsync(
    await fs.readFile((await (await download).path())!),
  );
  expect(await zip.file("DESIGN.md")!.async("string")).toContain(
    plan.journey[2],
  );
  expect(Object.keys(zip.files)).toContain("designs/headspace.md");
  expect(
    JSON.parse(await zip.file("project.json")!.async("string")).plan,
  ).toMatchObject(plan);
});

test("provider failures and invalid suggestions preserve existing choices and allow retry", async ({
  page,
}) => {
  await seed(page);
  let calls = 0;
  await page.route("**/api/ai/suggest", (r) => {
    calls++;
    return calls === 1
      ? r.fulfill({
          status: 502,
          json: {
            error:
              "Your OpenRouter account needs credits. You can still use an example plan.",
          },
        })
      : calls === 2
        ? r.fulfill({
            json: {
              plan: {
                ...plan,
                features: [...plan.features.slice(0, 2), plan.features[0]],
              },
            },
          })
        : r.fulfill({ json: { plan } });
  });
  await page
    .getByRole("button", { name: "Suggest a combination", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("needs credits");
  expect((await saved(page)).selected).toEqual(original.selected);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("plan we could not use");
  expect((await saved(page)).selected).toEqual(original.selected);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: plan.name, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("cancel and navigating away discard an in-flight suggestion", async ({
  page,
}) => {
  await seed(page);
  const pending: (() => void)[] = [];
  await page.route("**/api/ai/suggest", async (r) => {
    await new Promise<void>((resolve) => pending.push(resolve));
    await r.fulfill({ json: { plan } }).catch(() => {});
  });
  const generate = page.getByRole("button", {
    name: "Suggest a combination",
    exact: true,
  });
  await generate.click();
  await expect(
    page.getByRole("button", { name: "Finding a useful combination…" }),
  ).toBeDisabled();
  await expect.poll(() => pending.length).toBe(1);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  pending[0]();
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect.poll(() => pending.length).toBe(2);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: /Choose domains/ })
    .click();
  pending[1]();
  await page.getByRole("button", { name: "Explore apps" }).click();
  await expect(page.locator(".suggestion-result")).toHaveCount(0);
  expect((await saved(page)).selected).toEqual(original.selected);
});

test("all six offline example plans are valid and custom-only domains give a useful empty state", async ({
  page,
}) => {
  for (const domain of domains) {
    const example = exampleSuggestion([domain.name]);
    expect(example?.features).toHaveLength(3);
    expect(new Set(example!.features.map((f) => f.appId)).size).toBeGreaterThan(
      1,
    );
  }
  await seed(page);
  await page.route("**/api/ai/status", (r) =>
    r.fulfill({ json: { available: false } }),
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Suggest a combination", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Try an example", exact: true })
    .click();
  await expect(page.getByText("EXAMPLE PLAN", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use this plan" }),
  ).toBeEnabled();
  await page.evaluate(
    (key) =>
      localStorage.setItem(
        key,
        JSON.stringify({ version: 1, domains: ["Gardening"], selected: {} }),
      ),
    key,
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Try an example", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Suggestions need apps to combine. Wait for market signals to find apps for your domains, or add a suggested domain.",
    ),
  ).toBeVisible();
});

test("bulk selection respects filtered apps, supports deselect all, and preserves catalog navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seed(page, { ...original, selected: {} });
  await page.getByRole("button", { name: "Wellness", exact: true }).click();
  const bulk = page.getByRole("group", { name: "Features in shown apps" });
  await bulk.getByRole("button", { name: "Select all", exact: true }).click();
  const selected = (await saved(page)).selected;
  for (const app of apps.filter((a) => a.domain === "Wellness"))
    expect(selected[app.id]).toEqual(app.features.map((f) => f.id));
  expect(selected.forest).toBeUndefined();
  await page.getByLabel("Search apps and features").fill("Calm");
  await bulk.getByRole("button", { name: "Deselect all", exact: true }).click();
  expect((await saved(page)).selected.calm).toEqual([]);
  expect((await saved(page)).selected.headspace.length).toBeGreaterThan(0);
  await page.locator(".reference-card").click();
  await expect(
    page.getByRole("heading", { name: "Calm features" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Back to app plan", exact: true })
    .click();
  await expect(page.getByLabel("Search apps and features")).toHaveValue("Calm");
  await expect(
    page.getByRole("button", { name: "Wellness", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".reference-card")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Deselect all selected features" })
    .click();
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeDisabled();
});

test("manual changes invalidate the accepted plan without losing the suggested plan", async ({
  page,
}) => {
  await seed(page);
  await page.getByRole("button", { name: "Try an example" }).click();
  await page.getByRole("button", { name: "Use this plan" }).click();
  await page
    .getByRole("button", { name: "Remove Focus timer from Forest" })
    .click();
  expect((await saved(page)).plan).toBeUndefined();
  expect((await saved(page)).suggestion).toBeTruthy();
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Use this plan" }),
  ).toBeEnabled();
  await page.reload();
  expect((await saved(page)).plan).toBeUndefined();
});

for (const width of [320, 390, 768, 1440])
  test(`suggested plan is readable, accessible and fits at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await seed(page, { ...original, suggestion: plan });
    await expect(page.locator(".plan-summary")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const heading = page.locator("#suggestion-title");
    expect((await heading.boundingBox())!.width).toBeGreaterThan(
      width < 561 ? 175 : 250,
    );
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      results.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
    ).toEqual([]);
    await page.getByRole("button", { name: "Use this plan" }).click();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Review app", exact: true }),
    ).toBeEnabled();
  });
