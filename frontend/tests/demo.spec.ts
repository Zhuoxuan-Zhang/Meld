import { test, expect } from "./fixtures";
import JSZip from "jszip";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const all = {
  version: 1,
  domains: ["Productivity", "Wellness", "Fitness", "Learning", "Finance"],
  selected: {
    forest: ["timer", "garden"],
    ticktick: ["tasks", "habits"],
    notion: ["notes", "boards", "bookmarks"],
    headspace: ["breathing"],
    daylio: ["journal", "insights"],
    strava: ["workouts", "goals"],
    anki: ["flashcards"],
    readwise: ["reading"],
    ynab: ["budget", "expenses"],
  },
  name: "Everything Together",
  audience: "Demo testers",
  description: "All of the little things in one place.",
  style: "warm",
  built: true,
};
async function prepare(page: any) {
  await page.goto("/");
  await page.evaluate(
    (all) => localStorage.setItem("meld.workspace.v1", JSON.stringify(all)),
    all,
  );
  await page.goto("/?seed=1#/result");
  return page.frameLocator("iframe");
}

test("all 16 output features have working interactions and useful validation", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const app = await prepare(page);
  const tab = async (name: string) => {
    await app.getByRole("button", { name, exact: true }).click();
    await expect(app.getByRole("heading", { name, exact: true })).toBeVisible();
  };
  await test.step("timer start, pause, invalid duration and reset", async () => {
    await tab("Focus timer");
    await app.getByRole("button", { name: "Start focus" }).click();
    await expect(
      app.getByRole("button", { name: "Pause", exact: true }),
    ).toBeVisible();
    await app.getByRole("button", { name: "Pause", exact: true }).click();
    await app.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(app.locator(".digits")).toHaveText("25:00");
    await app
      .getByRole("spinbutton", { name: "Minutes", exact: true })
      .fill("0");
    await app.getByRole("button", { name: "Set time", exact: true }).click();
    await expect(app.getByRole("status")).toContainText("1 to 180");
    await app
      .getByRole("spinbutton", { name: "Minutes", exact: true })
      .fill("10");
    await app.getByRole("button", { name: "Set time", exact: true }).click();
    await expect(app.locator(".digits")).toHaveText("10:00");
  });
  await test.step("focus garden logs and resets", async () => {
    await tab("Your focus garden");
    await app.getByRole("button", { name: "Log a focus session" }).click();
    await expect(app.getByText("1 focus session completed")).toBeVisible();
    await app.getByRole("button", { name: "Reset garden" }).click();
    await expect(app.getByText("0 focus sessions completed")).toBeVisible();
  });
  await test.step("tasks validate, add, complete, and remove", async () => {
    await tab("Simple task lists");
    await app.getByRole("button", { name: "Add", exact: true }).click();
    await expect(app.getByRole("status")).toContainText("enter a name");
    await app.getByRole("textbox", { name: "Add a task" }).fill("Write a page");
    await app.getByRole("textbox", { name: "Add a task" }).press("Enter");
    await app.getByRole("checkbox", { name: "Write a page" }).check();
    await expect(
      app.getByRole("checkbox", { name: "Write a page" }),
    ).toBeChecked();
  });
  await test.step("habits retain check-ins across tabs", async () => {
    await tab("Daily habit check-ins");
    await app
      .getByRole("textbox", { name: "Add a daily habit" })
      .fill("Read a chapter");
    await app.getByRole("button", { name: "Add", exact: true }).click();
    await app.getByRole("checkbox", { name: "Read a chapter" }).check();
    await tab("Simple task lists");
    await expect(
      app.getByRole("checkbox", { name: "Write a page" }),
    ).toBeChecked();
    await tab("Daily habit check-ins");
    await expect(
      app.getByRole("checkbox", { name: "Read a chapter" }),
    ).toBeChecked();
  });
  await test.step("notes save, edit and remove", async () => {
    await tab("Quick notes");
    await app.getByRole("button", { name: "Save note" }).click();
    await expect(app.getByRole("status")).toContainText("Write a note");
    await app
      .getByRole("textbox", { name: "Write a note" })
      .fill("An idea worth keeping");
    await app.getByRole("button", { name: "Save note" }).click();
    await app.getByRole("button", { name: "Edit", exact: true }).click();
    await app
      .getByRole("textbox", { name: "Write a note" })
      .fill("An even better idea");
    await app.getByRole("button", { name: "Save changes" }).click();
    await expect(
      app.getByText("An even better idea", { exact: true }),
    ).toBeVisible();
    await app
      .getByRole("button", { name: "Remove An even better idea" })
      .click();
    await expect(
      app.getByText("Nothing here yet. Add your first one above."),
    ).toBeVisible();
  });
  await test.step("idea boards move between states", async () => {
    await tab("Idea boards");
    await app.getByRole("textbox", { name: "A new idea" }).fill("A new garden");
    await app.getByRole("button", { name: "Add idea" }).click();
    await app
      .getByRole("combobox", { name: "Status for A new garden" })
      .selectOption("Done");
    await expect(
      app.getByRole("combobox", { name: "Status for A new garden" }),
    ).toHaveValue("Done");
  });
  await test.step("bookmarks reject script URLs and accept web links", async () => {
    await tab("Saved inspiration");
    await app.getByRole("textbox", { name: "Link title" }).fill("My link");
    await app
      .getByRole("textbox", { name: "Web link", exact: true })
      .fill("javascript:alert(1)");
    await app.getByRole("button", { name: "Save", exact: true }).click();
    await expect(app.getByRole("status")).toContainText("http:// or https://");
    await app
      .getByRole("textbox", { name: "Web link", exact: true })
      .fill("https://example.com");
    await app.getByRole("button", { name: "Save", exact: true }).click();
    await expect(app.getByRole("link", { name: "My link" })).toHaveAttribute(
      "href",
      "https://example.com/",
    );
  });
  await test.step("breathing starts and stops", async () => {
    await tab("Guided breathing");
    await app.getByRole("button", { name: "Start breathing" }).click();
    await expect(app.locator(".orb")).toHaveText("Breathe in");
    await app.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(app.locator(".orb")).toHaveText("Ready?");
  });
  await test.step("journal requires a mood and saves reflections", async () => {
    await tab("Mood journal");
    await app.getByRole("button", { name: "Save check-in" }).click();
    await expect(app.getByRole("status")).toContainText("Choose a mood");
    await app.getByRole("button", { name: "Good", exact: true }).click();
    await app
      .getByRole("textbox", { name: "Your reflection" })
      .fill("A good day for a walk.");
    await app.getByRole("button", { name: "Save check-in" }).click();
    await expect(app.getByText(/A good day for a walk./)).toBeVisible();
  });
  await test.step("workout log validates and adds duration", async () => {
    await tab("Workout log");
    await app
      .getByRole("textbox", { name: "Activity name" })
      .fill("Morning walk");
    await app
      .getByRole("spinbutton", { name: "Minutes", exact: true })
      .fill("30");
    await app.getByRole("button", { name: "Log activity" }).click();
    await expect(app.getByText("Morning walk · 30 min")).toBeVisible();
  });
  await test.step("goals count progress and stop at their target", async () => {
    await tab("Personal goals");
    await app
      .getByRole("textbox", { name: "Goal name" })
      .fill("Read two books");
    await app
      .getByRole("spinbutton", { name: "Target", exact: true })
      .fill("2");
    await app.getByRole("button", { name: "Add goal" }).click();
    await app.getByRole("button", { name: "+1", exact: true }).click();
    await app.getByRole("button", { name: "+1", exact: true }).click();
    await expect(
      app.getByRole("button", { name: "+1", exact: true }),
    ).toBeDisabled();
    await expect(
      app.getByRole("progressbar", { name: "Read two books" }),
    ).toHaveAttribute("value", "2");
  });
  await test.step("flashcards validate, flip, and cycle", async () => {
    await tab("Practice flashcards");
    await app.getByRole("button", { name: "Add card" }).click();
    await expect(app.getByRole("status")).toContainText("both a question");
    await app
      .getByRole("textbox", { name: "Question", exact: true })
      .fill("Capital of France?");
    await app
      .getByRole("textbox", { name: "Answer", exact: true })
      .fill("Paris");
    await app.getByRole("button", { name: "Add card" }).click();
    await app.getByRole("button", { name: "Show answer" }).click();
    await expect(app.getByRole("button", { name: "Show question" })).toHaveText(
      "Paris",
    );
    await app.getByRole("button", { name: "Next card" }).click();
    await expect(app.getByRole("button", { name: "Show answer" })).toHaveText(
      "Capital of France?",
    );
  });
  await test.step("reading list works with no URL", async () => {
    await tab("Reading list");
    await app
      .getByRole("textbox", { name: "Book or article title" })
      .fill("A book about trees");
    await app.getByRole("button", { name: "Save", exact: true }).click();
    await app.getByRole("button", { name: "Mark read" }).click();
    await expect(app.getByRole("button", { name: "Read ✓" })).toBeVisible();
  });
  await test.step("budget and expenses share records and calculate totals", async () => {
    await tab("Monthly budget");
    await app
      .getByRole("spinbutton", { name: "Monthly budget", exact: true })
      .fill("100");
    await app.getByRole("button", { name: "Set budget" }).click();
    await app
      .getByRole("textbox", { name: "Expense description" })
      .fill("Coffee");
    await app
      .getByRole("spinbutton", { name: "Amount", exact: true })
      .fill("4.50");
    await app.getByRole("button", { name: "Add expense" }).click();
    await expect(app.getByText("$95.50", { exact: true })).toBeVisible();
    await tab("Expense tracking");
    await expect(app.getByText("Coffee · $4.50")).toBeVisible();
    await app.getByRole("button", { name: "Remove Coffee" }).click();
    await tab("Monthly budget");
    await expect(app.getByText("$100.00", { exact: true })).toBeVisible();
  });
  await test.step("insights reflect actual changes across modules", async () => {
    await tab("Progress at a glance");
    const stats = app.locator(".stat");
    await expect(stats.nth(0).locator("b")).toHaveText("1");
    await expect(stats.nth(1).locator("b")).toHaveText("1");
    await expect(stats.nth(3).locator("b")).toHaveText("30");
  });
  expect(errors).toEqual([]);
});
test("timer completion adds exactly one plant and survives changing feature tabs", async ({
  page,
}) => {
  await page.clock.install();
  const app = await prepare(page);
  await app.getByRole("spinbutton", { name: "Minutes", exact: true }).fill("1");
  await app.getByRole("button", { name: "Set time" }).click();
  await app.getByRole("button", { name: "Start focus" }).click();
  await app
    .getByRole("button", { name: "Your focus garden", exact: true })
    .click();
  await page.clock.fastForward(61000);
  await expect(app.getByText("1 focus session completed")).toBeVisible();
  await page.clock.fastForward(61000);
  await expect(app.getByText("1 focus session completed")).toBeVisible();
});
test("export works offline, persists data, and includes no external runtime dependencies", async ({
  page,
  browser,
}) => {
  await prepare(page);
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download project" }).click();
  const downloaded = await event;
  const zip = await JSZip.loadAsync(
    await fs.readFile((await downloaded.path())!),
  );
  const html = await zip.file("index.html")!.async("string");
  expect(html).not.toMatch(/<script[^>]+src=/);
  expect(html).not.toMatch(/<link[^>]+href=/);
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "meld-export-test-"));
  const file = path.join(folder, "index.html");
  await fs.writeFile(file, html);
  const offline = await browser.newPage();
  await offline.context().setOffline(true);
  try {
    await offline.goto(pathToFileURL(file).href);
    await expect(
      offline.getByRole("heading", { name: "Everything Together" }),
    ).toBeVisible();
    await offline
      .getByRole("button", { name: "Simple task lists", exact: true })
      .click();
    await offline
      .getByRole("textbox", { name: "Add a task" })
      .fill("Works offline");
    await offline.getByRole("button", { name: "Add", exact: true }).click();
    await offline.reload();
    await offline
      .getByRole("button", { name: "Simple task lists", exact: true })
      .click();
    await expect(
      offline.getByRole("checkbox", { name: "Works offline" }),
    ).toBeVisible();
  } finally {
    await offline.close();
    await fs.rm(folder, { recursive: true, force: true });
  }
});
