import { test, expect } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";
import JSZip from "jszip";
import fs from "node:fs/promises";
const key = "meld.workspace.v1";
const draft = {
  version: 1,
  domains: ["Productivity", "Wellness"],
  selected: {
    forest: ["timer", "garden"],
    ticktick: ["timer", "tasks", "habits"],
    daylio: ["journal", "insights"],
  },
  name: "Little by Little",
  audience: "Curious people",
  description: "A calmer everyday rhythm.",
  style: "warm",
  built: false,
};
async function seed(page: any, data: any = draft, route = "/apps") {
  await page.goto("/");
  await page.evaluate(
    ({ key, data }: any) => localStorage.setItem(key, JSON.stringify(data)),
    { key, data },
  );
  await page.goto("/?seed=1#" + route);
}

test("domain tags: add, normalize, reject duplicates, remove, and preserve on reload", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Explore apps" }),
  ).toBeDisabled();
  await page.getByLabel("Your domains").fill("  productivity  ");
  await page.getByLabel("Your domains").press("Enter");
  await expect(
    page.getByRole("button", { name: "Remove Productivity", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Your domains").fill("PRODUCTIVITY");
  await page.getByLabel("Your domains").press("Enter");
  await expect(page.getByRole("alert")).toHaveText(
    "Productivity is already on your list.",
  );
  await page.getByRole("button", { name: /^Wellness/ }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Remove Wellness", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Remove Productivity", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove Productivity", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Explore apps" }).click();
  await expect(page).toHaveURL(/#\/apps$/);
  await expect(
    page.getByRole("button", { name: /Headspace.*A softer/ }),
  ).toBeVisible();
});
test("custom domains, empty input, length limit, domain limit, and unsubmitted text", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add domain", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Type a domain");
  await page.getByLabel("Your domains").fill("a".repeat(49));
  await page.getByLabel("Your domains").press("Enter");
  await expect(page.getByRole("alert")).toContainText("48 characters");
  await page.getByLabel("Your domains").fill("Gardening");
  await page.getByLabel("Your domains").press("Enter");
  await page.getByLabel("Your domains").fill("Pending");
  await page.getByRole("button", { name: "Explore apps" }).click();
  await expect(page.getByRole("alert")).toContainText("Add this domain first");
  await page.getByLabel("Your domains").fill("");
  await page.getByRole("button", { name: "Explore apps" }).click();
  await expect(
    page.getByText("A new direction", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Choose example domains" }).click();
  for (let i = 0; i < 7; i++) {
    await page.getByLabel("Your domains").fill("Interest " + i);
    await page.getByLabel("Your domains").press("Enter");
  }
  await page.getByLabel("Your domains").fill("Ninth interest");
  await page.getByLabel("Your domains").press("Enter");
  await expect(page.getByRole("alert")).toContainText("up to 8 domains");
});
test("catalog filters, search, empty state, clear search", async ({ page }) => {
  await seed(page);
  await expect(page.locator(".reference-card")).toHaveCount(6);
  await page.getByRole("button", { name: "Wellness", exact: true }).click();
  await expect(page.locator(".reference-card")).toHaveCount(3);
  await page
    .getByRole("button", { name: "All interests", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Search apps and features" })
    .fill("timer");
  await expect(page.locator(".reference-card")).toHaveCount(3);
  await page
    .getByRole("textbox", { name: "Search apps and features" })
    .fill("not-an-app");
  await expect(
    page.getByRole("heading", { name: "No apps found" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator(".reference-card")).toHaveCount(6);
});
test("feature details, select all, clear all, autosave, browser back, and selection tray", async ({
  page,
}) => {
  await seed(page, { ...draft, selected: {} });
  await page.getByRole("button", { name: /Forest.*Find your focus/ }).click();
  await page
    .getByRole("button", { name: "See the user journey" })
    .first()
    .click();
  await expect(
    page.getByText(
      "Choose a duration, start a session, then pause or reset it.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await expect(page.getByRole("checkbox").first()).toBeChecked();
  await page.getByRole("button", { name: "Deselect all", exact: true }).click();
  await expect(page.getByRole("checkbox").first()).not.toBeChecked();
  await page.getByRole("checkbox", { name: /Focus timer/ }).check();
  await page.reload();
  await expect(
    page.getByRole("checkbox", { name: /Focus timer/ }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Save & return" }).click();
  await expect(
    page.getByRole("button", { name: "Remove Focus timer from Forest" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /TickTick.*A little order/ }).click();
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "Remove Focus timer from Forest" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Remove Focus timer from Forest" })
    .click();
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeDisabled();
});
test("review merges duplicate features, validates name, edits style, and builds", async ({
  page,
}) => {
  await seed(page);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("6 features, inspired by 3 apps.")).toBeVisible();
  await expect(
    page.getByText("1 repeated choice becomes part of a shared feature."),
  ).toBeVisible();
  await page.getByLabel("What will you call it?").fill("   ");
  await page.getByRole("button", { name: "Create my app" }).click();
  await expect(page.getByRole("alert")).toContainText("Give your app a name");
  await page.getByLabel("What will you call it?").fill("A Quiet Day");
  await page.getByRole("radio", { name: "Calm & natural" }).check();
  await page.getByRole("button", { name: "Create my app" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForURL(/#\/result$/);
  await expect(
    page.getByRole("heading", { name: "A Quiet Day" }),
  ).toBeVisible();
  await expect(page.frameLocator("iframe").locator("body")).toHaveClass("sage");
  await page.reload();
  await expect(page).toHaveURL(/#\/result$/);
  await expect(
    page.getByRole("heading", { name: "A Quiet Day" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Refine your app" }).click();
  await page.getByLabel("What will you call it?").fill("A Changed Day");
  await page.goto("/#/result");
  await expect(page).toHaveURL(/#\/review$/);
});
test("README and design dialogs, keyboard dismissal, focus restoration, downloads", async ({
  page,
}) => {
  await seed(page, { ...draft, built: true }, "/result");
  const readme = page.getByRole("button", {
    name: /README.md Setup and usage/,
  });
  await readme.click();
  await expect(page.getByRole("dialog")).toContainText("not an Android APK");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(readme).toBeFocused();
  await page.getByRole("button", { name: /Design & feature briefs/ }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Reference: Forest, TickTick",
  );
  const event = page.waitForEvent("download");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Download", exact: true })
    .click();
  const downloaded = await event;
  expect(downloaded.suggestedFilename()).toBe("DESIGN.md");
  await page.keyboard.press("Escape");
  const zipEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download project" }).click();
  const download = await zipEvent;
  expect(download.suggestedFilename()).toBe("little-by-little-demo.zip");
  const zip = await JSZip.loadAsync(
    await fs.readFile((await download.path())!),
  );
  expect(Object.keys(zip.files)).toEqual(
    expect.arrayContaining([
      "index.html",
      "README.md",
      "DESIGN.md",
      "project.json",
      "designs/forest.md",
      "designs/ticktick.md",
      "designs/daylio.md",
    ]),
  );
  const design = await zip.file("DESIGN.md")!.async("string");
  expect(design.match(/### Focus timer/g)).toHaveLength(1);
  expect(design).toContain("Forest, TickTick");
  const popupEvent = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open my demo" }).click();
  const popup = await popupEvent;
  await expect(
    popup.getByRole("heading", { name: "Little by Little" }),
  ).toBeVisible();
  await popup.close();
});
test("domain removal prunes its selections, and empty review returns to apps", async ({
  page,
}) => {
  await seed(page, draft, "/domains");
  await page
    .getByRole("button", { name: "Remove Productivity", exact: true })
    .click();
  await page.getByRole("button", { name: "Explore apps" }).click();
  await expect(
    page.getByRole("button", { name: "Remove Focus timer from Forest" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Remove Mood journal from Daylio" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("button", { name: "Remove Mood journal from Daylio" })
    .click();
  await page
    .getByRole("button", { name: "Remove Progress at a glance from Daylio" })
    .click();
  await expect(page).toHaveURL(/#\/apps$/);
});
test("route guards, malformed storage, invalid references, and storage unavailable", async ({
  page,
}) => {
  await page.goto("/#/result");
  await expect(page).toHaveURL(/#\/domains$/);
  await page.evaluate((key) => localStorage.setItem(key, "{broken"), key);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: /What do you want to build/ }),
  ).toBeVisible();
  await seed(
    page,
    {
      ...draft,
      selected: { unknown: ["timer"], forest: ["wrong", "timer", "timer"] },
    },
    "/apps/not-real",
  );
  await expect(page).toHaveURL(/#\/domains$/);
  await page.goto("/#/apps");
  await expect(
    page.getByRole("button", { name: "Remove Focus timer from Forest" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove Focus timer from Forest" }),
  ).toHaveCount(1);
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error("storage disabled");
    };
  });
  await page.reload();
  await expect(
    page.getByText("Browser storage is unavailable.", { exact: false }),
  ).toBeVisible();
});
test("new project confirmation can cancel or clear and persists the reset", async ({
  page,
}) => {
  await seed(page);
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("button", { name: "Keep working" }).click();
  await expect(
    page.getByRole("button", { name: "Remove Focus timer from Forest" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("button", { name: "Start new project" }).click();
  await page.reload();
  await expect(page).toHaveURL(/#\/domains$/);
  await expect(
    page.getByRole("button", { name: "Explore apps" }),
  ).toBeDisabled();
});
test("hostile text remains text in documents and generated output", async ({
  page,
}) => {
  const name = "<img src=x onerror=alert(1)> / My app";
  await seed(
    page,
    {
      ...draft,
      name,
      description: "</script><script>alert(1)</script>",
      built: true,
    },
    "/result",
  );
  let dialogs = 0;
  page.on("dialog", async (d) => {
    dialogs++;
    await d.dismiss();
  });
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name, exact: true }),
  ).toBeVisible();
  await expect(page.frameLocator("iframe").locator("script")).toHaveCount(2);
  expect(dialogs).toBe(0);
  await expect(page.locator("img")).toHaveCount(0);
});
for (const width of [320, 390, 768, 1024, 1440])
  test(`responsive flow has no horizontal overflow at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await seed(page, { ...draft, built: true }, "/domains");
    for (const route of [
      "/domains",
      "/apps",
      "/apps/forest",
      "/review",
      "/result",
    ]) {
      await page.goto("/#" + route);
      await expect(page.locator("main")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        route,
      ).toBe(true);
    }
    if (width < 761) {
      await page.getByRole("button", { name: "Toggle navigation" }).click();
      await expect(
        page.getByRole("navigation", { name: "Build your app" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Close navigation", exact: true })
        .click();
    }
  });
for (const route of ["/domains", "/apps", "/apps/forest", "/review", "/result"])
  test(`accessibility audit ${route}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1050 });
    await seed(page, { ...draft, built: true }, route);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      results.violations.map((v) => ({
        id: v.id,
        description: v.description,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      })),
    ).toEqual([]);
  });

test("all 18 app detail pages contribute to one merged design", async ({
  page,
}) => {
  test.setTimeout(90000);
  await seed(
    page,
    {
      ...draft,
      domains: [
        "Productivity",
        "Wellness",
        "Learning",
        "Finance",
        "Fitness",
        "Creativity",
      ],
      selected: {},
    },
    "/apps",
  );
  await expect(page.locator(".reference-card")).toHaveCount(18);
  const names = [
    "Forest",
    "TickTick",
    "Notion",
    "Headspace",
    "Calm",
    "Daylio",
    "Duolingo",
    "Anki",
    "Readwise",
    "YNAB",
    "Spendee",
    "Money Lover",
    "Strava",
    "Strong",
    "Habitica",
    "Pinterest",
    "Milanote",
    "Day One",
  ];
  for (const name of names) {
    await page
      .locator(".reference-card")
      .filter({ has: page.getByRole("heading", { name, exact: true }) })
      .click();
    await page.getByRole("button", { name: "Select all", exact: true }).click();
    await page.getByRole("button", { name: "Save & return" }).click();
  }
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByText("16 features, inspired by 18 apps."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Preview the design brief" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Reference: Forest, TickTick, Calm, Anki, Strong",
  );
});
test("mobile full flow and navigation keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: /^Productivity/ }).click();
  await page.getByRole("button", { name: "Explore apps" }).click();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await expect(
    page.getByRole("button", { name: "Close navigation", exact: true }),
  ).toBeFocused();
  for (let i = 0; i < 9; i++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => !!document.activeElement?.closest(".sidebar")),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Toggle navigation" }),
  ).toBeFocused();
  await page
    .locator(".reference-card")
    .filter({
      has: page.getByRole("heading", { name: "TickTick", exact: true }),
    })
    .click();
  await page.getByRole("checkbox", { name: /Simple task lists/ }).check();
  await page.getByRole("button", { name: "Save & return" }).click();
  await expect(page.getByRole("region", { name: "Your mix" })).toBeVisible();
  await page.getByRole("button", { name: "Review mix" }).click();
  await page.getByLabel("What will you call it?").fill("Small Steps");
  await page.getByRole("radio", { name: "Clean & crisp" }).check();
  await page.getByRole("button", { name: "Create my app" }).click();
  await page.waitForURL(/#\/result$/);
  const app = page.frameLocator("iframe");
  await expect(app.locator("body")).toHaveClass("ink");
  await app
    .getByRole("textbox", { name: "Add a task" })
    .fill("A small first step");
  await app.getByRole("button", { name: "Add", exact: true }).click();
  await app.getByRole("checkbox", { name: "A small first step" }).check();
  await expect(
    app.getByRole("checkbox", { name: "A small first step" }),
  ).toBeChecked();
  await page.getByRole("button", { name: /README.md Setup and usage/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Small Steps");
});
