import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import JSZip from "jszip";
import fs from "node:fs/promises";
import { marketResult } from "./market-data";

const key = "meld.workspace.v1";
type Reply = { status: number; json: object };
type Scan = { domain: string; refresh: boolean };

// Routes the local market API: each scan asks `reply` for its response.
async function liveMarket(
  page: Page,
  reply: (scan: Scan, call: number) => Reply | Promise<Reply> = (scan) => ({
    status: 200,
    json: { result: marketResult(scan.domain), cached: false },
  }),
) {
  const scans: Scan[] = [];
  await page.route("**/api/market/status", (r) =>
    r.fulfill({ json: { available: true, source: "Google Play" } }),
  );
  await page.route("**/api/market/scan", async (r) => {
    const scan = r.request().postDataJSON() as Scan;
    scans.push(scan);
    const { status, json } = await reply(scan, scans.length);
    // The page may have canceled this scan meanwhile.
    await r.fulfill({ status, json }).catch(() => {});
  });
  return scans;
}
async function start(page: Page, draft?: object) {
  await page.goto("/");
  await page.evaluate(
    ({ key, draft }) =>
      draft
        ? localStorage.setItem(key, JSON.stringify(draft))
        : localStorage.clear(),
    { key, draft },
  );
  await page.reload();
}
const saved = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);

test("market signals choose the shown apps and travel through review, documents and export", async ({
  page,
}) => {
  const scans = await liveMarket(page);
  await start(page);
  await page.getByRole("button", { name: /^Productivity/ }).click();
  // Scanning starts as soon as a domain is chosen.
  await expect.poll(() => scans).toEqual([
    { domain: "Productivity", refresh: false },
  ]);
  await expect(page.getByText("5 hot apps from Google Play")).toBeVisible();
  await page.getByRole("button", { name: "Explore apps" }).click();
  await expect(
    page.getByRole("heading", { name: "Explore hot apps" }),
  ).toBeVisible();
  await expect(page.locator(".reference-card h3")).toHaveText([
    "Calendar Pro",
    "Notes Daily",
    "Color Notes",
    "Todo Planner",
    "Focus Flow",
  ]);
  await expect(page.getByRole("button", { name: /Forest/ })).toHaveCount(0);
  await expect(page.locator(".market-rows li")).toContainText(
    "Top 5 of 28 ranked",
  );
  const first = page.locator(".reference-card").first();
  await expect(first.locator(".rank-label")).toHaveText("#1 · Productivity");
  await expect(first.locator(".market-metrics")).toHaveText(
    /4\.6\s*10B\+ installs\s*Score 13\/15/,
  );
  await expect(
    page.locator(".reference-card").nth(1).locator(".market-metrics"),
  ).toContainText("2B+ installs");
  await expect(page.getByText("Live Google Play signals")).toBeVisible();
  // Search covers the store listing as well as the sample features.
  await page.getByLabel("Search apps and features").fill("pomodoro");
  await expect(page.locator(".reference-card h3")).toHaveText(["Focus Flow"]);
  await page.getByLabel("Search apps and features").fill("");

  await first.click();
  await expect(page).toHaveURL(/#\/apps\/com\.example\.calendar$/);
  await expect(page.getByText("Productivity / #1 ON GOOGLE PLAY")).toBeVisible();
  const facts = page.locator(".market-facts");
  await expect(facts).toContainText("#1 of 28");
  await expect(facts).toContainText("13/15");
  await expect(facts).toContainText("4,864,771 ratings");
  await expect(facts).toContainText("10B+");
  await expect(
    facts.getByRole("link", { name: "View on Google Play" }),
  ).toHaveAttribute(
    "href",
    "https://play.google.com/store/apps/details?id=com.example.calendar&hl=en&gl=us",
  );
  await expect(page.getByText(/sample features for Calendar Pro/)).toBeVisible();
  // Sample features follow the listing: tasks, reminders and a focus timer.
  await expect(page.locator(".feature-title")).toContainText([
    "Simple task lists",
    "Focus timer",
  ]);
  await page.getByRole("checkbox", { name: /Simple task lists/ }).check();
  await page.getByRole("button", { name: "Save & return" }).click();
  await page.getByRole("button", { name: /Notes Daily/ }).click();
  await page.getByRole("checkbox", { name: /Quick notes/ }).check();
  await page.getByRole("button", { name: "Save & return" }).click();
  await expect(
    page.getByRole("button", { name: "Remove Quick notes from Notes Daily" }),
  ).toBeVisible();

  // Saved choices and scan results survive a reload without a new scan.
  await page.reload();
  await expect(page.locator(".reference-card")).toHaveCount(5);
  expect(scans).toHaveLength(1);
  const draft = await saved(page);
  expect(draft.selected).toEqual({
    "com.example.calendar": ["tasks"],
    "com.example.notes": ["notes"],
  });
  expect(draft.market.Productivity.apps[0].appId).toBe("com.example.calendar");

  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator(".market-chip")).toHaveText([
    "#1 Productivity",
    "#2 Productivity",
  ]);
  await page.getByLabel(/What will you call it/).fill("Market Mix");
  await page.getByRole("button", { name: "Preview the design brief" }).click();
  const brief = page.locator(".document-body");
  await expect(brief).toContainText("Market evidence");
  await expect(brief).toContainText(
    "Calendar Pro (com.example.calendar): #1 in Productivity on Google Play · opportunity 13/15 · rating 4.6 (4,864,771 ratings) · 10B+ installs · Free",
  );
  await expect(brief).toContainText(
    "Notes Daily (com.example.notes): #2 in Productivity on Google Play · opportunity 13/15 · rating 4.8 (15,269,706 ratings) · 2B+ installs · Free · in-app purchases · ads",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Create my app" }).click();
  await expect(
    page.getByRole("heading", { name: "Your app is ready to try." }),
  ).toBeVisible({ timeout: 10000 });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download project" }).click();
  const zip = await JSZip.loadAsync(
    await fs.readFile((await (await downloadPromise).path())!),
  );
  const project = JSON.parse(await zip.file("project.json")!.async("string"));
  expect(project.market.Productivity.apps).toHaveLength(5);
  expect(project.market.Productivity.status).toBe("complete");
  expect(await zip.file("DESIGN.md")!.async("string")).toContain(
    "## Market evidence",
  );
  const brief1 = await zip.file("designs/com.example.calendar.md")!.async("string");
  expect(brief1).toContain("Calendar Pro — feature brief");
  expect(brief1).toContain(
    "https://play.google.com/store/apps/details?id=com.example.calendar",
  );
  expect(await zip.file("README.md")!.async("string")).toContain(
    "come from a live Google Play scan",
  );
  const demo = await zip.file("index.html")!.async("string");
  expect(demo).toContain("Simple task lists");
  expect(demo).toContain("Quick notes");
});

test("a rescan keeps selected apps that left the top five, and failed scans can be retried", async ({
  page,
}) => {
  const scans = await liveMarket(page, (scan, call) => {
    if (scan.domain === "Finance" && call <= 2)
      return {
        status: 502,
        json: { error: "Google Play returned no usable apps for this domain." },
      };
    return {
      status: 200,
      json: {
        result: marketResult(
          scan.domain,
          scan.domain === "Finance"
            ? { prefix: "money" }
            : scan.refresh
              ? { indexes: [0, 1, 2, 3, 5] }
              : {},
        ),
        cached: false,
      },
    };
  });
  await start(page, {
    version: 1,
    domains: ["Productivity", "Finance"],
    selected: {},
  });
  await page.goto("/#/apps");
  const finance = page.locator('.market-rows li[data-domain="Finance"]');
  await expect(finance).toContainText(
    "Google Play returned no usable apps for this domain.",
  );
  await expect(
    page.getByRole("button", { name: /YNAB/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Focus Flow/ }).click();
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Save & return" }).click();

  await page.getByRole("button", { name: "Rescan Productivity" }).click();
  await expect(page.getByRole("button", { name: /Extra Budget/ })).toBeVisible();
  const kept = page.locator(".reference-card", { hasText: "Focus Flow" });
  await expect(kept).toBeVisible();
  await expect(kept.locator(".rank-label")).toHaveText("Earlier scan");
  expect(scans.filter((s) => s.domain === "Productivity")).toEqual([
    { domain: "Productivity", refresh: false },
    { domain: "Productivity", refresh: true },
  ]);

  await page.getByRole("button", { name: "Retry Finance" }).click();
  await expect(finance).toContainText("Top 5 of 28 ranked");
  await expect(
    page.getByRole("button", { name: /Calendar Pro \(money\)/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /YNAB/ })).toHaveCount(0);
  await expect(page.locator(".reference-card")).toHaveCount(11);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator(".review-app h3")).toHaveText(["Focus Flow"]);
});

test("without the scanner the sample catalog stays usable, and a chosen sample survives a later scan", async ({
  page,
}) => {
  await start(page, {
    version: 1,
    domains: ["Productivity"],
    selected: { forest: ["timer"] },
  });
  await page.goto("/#/apps");
  await expect(page.getByText("Market signals are not connected")).toBeVisible();
  await expect(page.getByText("Disabled for this test.")).toBeVisible();
  await expect(page.locator(".reference-card")).toHaveCount(3);
  await expect(page.getByText("Curated demo collection")).toBeVisible();

  // The scanner becomes available; the chosen sample app is kept beside live apps.
  await liveMarket(page);
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.locator(".reference-card")).toHaveCount(6);
  await expect(
    page.locator(".reference-card", { hasText: "Forest" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /TickTick/ })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Remove Focus timer from Forest" }),
  ).toBeVisible();
});

test("custom domains get live apps, example plans and AI requests use the shown catalog", async ({
  page,
}) => {
  await liveMarket(page);
  await page.route("**/api/ai/status", (r) =>
    r.fulfill({ json: { available: true, provider: "OpenRouter" } }),
  );
  let payload: { catalog?: { id: string; domain: string; features: string[] }[] } = {};
  await page.route("**/api/ai/suggest", (r) => {
    payload = r.request().postDataJSON();
    return r.fulfill({ status: 503, json: { error: "Test stop." } });
  });
  await start(page, { version: 1, domains: ["Gardening"], selected: {} });
  await page.goto("/#/apps");
  await expect(page.locator(".reference-card")).toHaveCount(5);
  await expect(page.getByText("A new direction")).toHaveCount(0);
  await expect(page.locator(".rank-label").first()).toHaveText("#1 · Gardening");

  await page.getByRole("button", { name: "Try an example", exact: true }).click();
  await expect(page.getByText("EXAMPLE PLAN", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Gardening Essentials" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Use this plan" }).click();
  const draft = await saved(page);
  expect(Object.keys(draft.selected).length).toBeGreaterThan(1);
  for (const id of Object.keys(draft.selected))
    expect(id).toMatch(/^com\.example\./);

  await page
    .getByRole("button", { name: "Suggest another plan", exact: true })
    .click();
  await expect(page.getByText("Test stop.")).toBeVisible();
  expect(payload.catalog?.map((a) => a.id)).toEqual([
    "com.example.calendar",
    "com.example.notes",
    "com.example.colornote",
    "com.example.todo",
    "com.example.focus",
  ]);
  expect(payload.catalog?.every((a) => a.domain === "Gardening")).toBe(true);
  // Only sample features whose words appear in the listing; no generic fill.
  expect(payload.catalog?.[0].features).toEqual(["tasks", "timer"]);
});

test("removing a domain stops its scan and forgets its results", async ({
  page,
}) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const scans = await liveMarket(page, async (scan) => {
    if (scan.domain === "Fitness") await hold;
    return {
      status: 200,
      json: { result: marketResult(scan.domain), cached: false },
    };
  });
  await start(page, {
    version: 1,
    domains: ["Productivity", "Fitness"],
    selected: {},
  });
  await page.goto("/#/apps");
  const fitness = page.locator('.market-rows li[data-domain="Fitness"]');
  await expect(fitness).toContainText("Scanning Google Play…");
  await expect(page.getByText("Strava")).toBeVisible();
  await page.goto("/#/domains");
  await page.getByRole("button", { name: "Remove Fitness", exact: true }).click();
  release();
  await page.getByRole("button", { name: "Explore apps" }).click();
  await expect(page.locator(".market-rows li")).toHaveCount(1);
  await expect(page.locator(".reference-card")).toHaveCount(5);
  const draft = await saved(page);
  expect(Object.keys(draft.market)).toEqual(["Productivity"]);
  expect(scans.map((s) => s.domain).sort()).toEqual(["Fitness", "Productivity"]);
});

for (const width of [320, 390, 1440])
  test(`live market views are accessible and fit at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await liveMarket(page, (scan) => ({
      status: 200,
      json: {
        result: marketResult(scan.domain, { prefix: "custom" }),
        cached: false,
      },
    }));
    // Productivity comes from the saved workspace; only the custom domain scans.
    await start(page, {
      version: 1,
      domains: ["Productivity", "A much longer custom interest"],
      selected: { "com.example.calendar": ["tasks"] },
      market: { Productivity: marketResult("Productivity") },
    });
    for (const route of ["/apps", "/apps/com.example.calendar", "/review"]) {
      await page.goto("/#" + route);
      await expect(page.locator("main h1")).toBeVisible();
      if (route === "/apps")
        await expect(page.locator(".rank-label")).toHaveCount(10);
      // Market signals stay visible even where the detail aside is hidden.
      if (route.startsWith("/apps/"))
        await expect(page.locator(".market-facts")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(
        results.violations.map((v) => ({
          id: v.id,
          route,
          nodes: v.nodes.map((n) => n.target),
        })),
      ).toEqual([]);
    }
  });

test("the browser sends at most two scans at once and shows the rest as waiting", async ({
  page,
}) => {
  const domains = ["Productivity", "Wellness", "Learning", "Finance"];
  let inFlight = 0;
  let peak = 0;
  const releases: (() => void)[] = [];
  await liveMarket(page, async (scan) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise<void>((resolve) => releases.push(resolve));
    inFlight--;
    return {
      status: 200,
      json: {
        result: marketResult(scan.domain, { prefix: scan.domain.toLowerCase() }),
        cached: false,
      },
    };
  });
  await start(page, { version: 1, domains, selected: {} });
  await page.goto("/#/apps");
  await expect.poll(() => releases.length).toBe(2);
  const rows = page.locator(".market-rows li");
  await expect(rows.filter({ hasText: "Scanning Google Play" })).toHaveCount(2);
  await expect(
    rows.filter({ hasText: "Waiting for another scan to finish" }),
  ).toHaveCount(2);
  // Other requests still get through while scans are pending.
  await expect(page.locator(".ai-status")).not.toHaveText("Connecting…");
  while (releases.length < 4) {
    releases.forEach((release) => release());
    await expect.poll(() => inFlight).toBeLessThanOrEqual(2);
    await page.waitForTimeout(50);
  }
  releases.forEach((release) => release());
  await expect(rows.filter({ hasText: "Top 5 of 28 ranked" })).toHaveCount(4);
  expect(peak).toBe(2);
  await expect(page.locator(".reference-card")).toHaveCount(20);
});

type FeatureRequest = {
  domain: string;
  apps: { appId: string; title: string; summary: string; description: string }[];
};
const template = "app-features@0123456789ab";
const listed = (title: string) => [
  { name: `${title} widgets`, detail: `Widgets that show ${title} on the home screen.` },
  { name: "Sync across devices", detail: "Keeps entries the same on every device." },
  { name: "Reminders", detail: "Sends reminders at chosen times." },
];
// Routes the local Claude Code API; `reply` answers each feature request.
async function liveClaude(
  page: Page,
  reply: (req: FeatureRequest, call: number) => Reply | Promise<Reply> = (req) => ({
    status: 200,
    json: {
      features: Object.fromEntries(
        req.apps.map((a) => [
          a.appId,
          {
            items: listed(a.title),
            model: "claude-haiku-5-5",
            template,
            generatedAt: new Date().toISOString(),
          },
        ]),
      ),
      template,
      model: "claude-haiku-5-5",
      cached: false,
    },
  }),
  available = true,
) {
  const requests: FeatureRequest[] = [];
  await page.route("**/api/claude/status", (r) =>
    r.fulfill({
      json: available
        ? { available: true, model: "claude-haiku-5-5", template }
        : {
            available: false,
            model: "claude-haiku-5-5",
            reason: "Claude Code is not logged in.",
          },
    }),
  );
  await page.route("**/api/claude/features", async (r) => {
    const req = r.request().postDataJSON() as FeatureRequest;
    requests.push(req);
    const { status, json } = await reply(req, requests.length);
    await r.fulfill({ status, json }).catch(() => {});
  });
  return requests;
}

test("features summarized by Claude Code become the choices on cards, the app page and the design brief", async ({
  page,
}) => {
  await liveMarket(page);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const requests = await liveClaude(page, async (req) => {
    await hold;
    return {
      status: 200,
      json: {
        features: Object.fromEntries(
          req.apps.map((a) => [
            a.appId,
            {
              items: listed(a.title),
              model: "claude-haiku-5-5",
              template,
              generatedAt: "2026-10-13T10:00:00.000Z",
            },
          ]),
        ),
      },
    };
  });
  await start(page);
  await page.getByRole("button", { name: /^Productivity/ }).click();
  await page.getByRole("button", { name: "Explore apps" }).click();
  const row = page.locator('.market-rows li[data-domain="Productivity"]');
  await expect(row).toContainText("Summarizing features with Claude Code…");
  // Each scanned listing is sent once, with its full description.
  expect(requests).toHaveLength(1);
  expect(requests[0].domain).toBe("Productivity");
  expect(requests[0].apps.map((a) => a.appId)).toEqual([
    "com.example.calendar",
    "com.example.notes",
    "com.example.colornote",
    "com.example.todo",
    "com.example.focus",
  ]);
  expect(requests[0].apps[0].description).toContain("• Calendar Pro widgets");
  await page.locator(".reference-card").first().click();
  await expect(page.locator(".listed-status")).toContainText(
    "Summarizing the store listing with Claude Code…",
  );
  // A sample feature chosen while Claude Code works is kept afterwards.
  await page.getByRole("checkbox", { name: /Simple task lists/ }).check();
  release();
  const titles = page.locator(".feature-card .feature-title");
  await expect(titles).toHaveCount(4);
  await expect(titles).toContainText([
    "Calendar Pro widgets",
    "Sync across devices",
    "Reminders",
    "Simple task lists",
  ]);
  await expect(page.getByRole("checkbox", { name: /Simple task lists/ })).toBeChecked();
  await expect(page.locator(".listed-status")).toHaveCount(0);
  await expect(page.getByText(/From Calendar Pro’s Google Play listing/)).toBeVisible();
  await expect(page.locator(".listed-source")).toContainText(
    `claude-haiku-5-5 · prompt ${template} · 2026-10-13`,
  );
  // Listing features describe what the app does; there is no sample journey.
  await expect(
    page.locator(".feature-card", { hasText: "Reminders" }).getByRole("button", {
      name: "See the user journey",
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Back to app plan" }).click();
  await expect(row).not.toContainText("Summarizing");
  await expect(
    page.locator(".reference-card").first().locator(".card-feature-tags"),
  ).toHaveText(/Calendar Pro widgets\s*Sync across devices\s*\+2/);
  await expect(
    page.getByText("Live Google Play signals · features from store listings"),
  ).toBeVisible();
  // Listing features are searchable.
  await page.getByLabel("Search apps and features").fill("color notes widgets");
  await expect(page.locator(".reference-card h3")).toHaveText(["Color Notes"]);
  await page.getByLabel("Search apps and features").fill("");

  // Chosen listing features travel into the design brief, labeled with their source.
  await page.locator(".reference-card").first().click();
  await page.getByRole("checkbox", { name: /Calendar Pro widgets/ }).check();
  await page.getByRole("button", { name: "Save & return" }).click();
  await expect(
    page.getByRole("button", { name: "Remove Calendar Pro widgets from Calendar Pro" }),
  ).toBeVisible();
  expect((await saved(page)).selected).toEqual({
    "com.example.calendar": ["tasks", "com.example.calendar:calendar-pro-widgets"],
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel(/What will you call it/).fill("Listing Test");
  await page.getByRole("button", { name: "Preview the design brief" }).click();
  const brief = page.locator(".document-body");
  await expect(brief).toContainText(
    `In the store listing (summarized by Claude Code, claude-haiku-5-5, prompt ${template}): Calendar Pro widgets; Sync across devices; Reminders`,
  );
  await expect(brief).toContainText(
    "Reference: Calendar Pro (Google Play store listing, summarized by Claude Code)",
  );
  await expect(brief).toContainText("User journey: to be designed.");
  await page.keyboard.press("Escape");
  // The demo lists the feature and says it is not built.
  await page.getByRole("button", { name: "Create my app" }).click();
  await expect(
    page.getByRole("heading", { name: "Your app is ready to try." }),
  ).toBeVisible({ timeout: 10000 });
  const app = page.frameLocator("iframe");
  await app.getByRole("button", { name: "Calendar Pro widgets" }).click();
  await expect(app.getByText("This feature comes from a store listing.")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download project" }).click();
  const zip = await JSZip.loadAsync(
    await fs.readFile((await (await downloadPromise).path())!),
  );
  expect(await zip.file("README.md")!.async("string")).toContain(
    "- Calendar Pro widgets (inspired by Calendar Pro; from the store listing, described in DESIGN.md but not built in this demo)",
  );
  // Saved with the workspace: a reload sends nothing new.
  await page.reload();
  await page.goto("/#/apps/com.example.calendar");
  await expect(page.locator(".feature-card")).toHaveCount(4);
  await expect(page.getByRole("checkbox", { name: /Calendar Pro widgets/ })).toBeChecked();
  expect(requests).toHaveLength(1);
});

test("a listing that mentions no built-in feature shows no sample features", async ({
  page,
}) => {
  await liveMarket(page, (scan) => {
    const result = marketResult(scan.domain);
    result.apps[0] = {
      ...result.apps[0],
      title: "Train Runner",
      summary: "Help the crew escape from the grumpy inspector and his dog!",
    };
    return { status: 200, json: { result, cached: false } };
  });
  await liveClaude(page, undefined, false);
  await start(page, { version: 1, domains: ["Games"], selected: {} });
  await page.goto("/#/apps");
  const card = page.locator(".reference-card", { hasText: "Train Runner" });
  await expect(card.locator(".reference-footer")).toContainText("No features yet");
  await expect(card.locator(".card-feature-tags span")).toHaveCount(0);
  await card.click();
  await expect(page.locator(".feature-card")).toHaveCount(0);
  await expect(page.getByRole("group", { name: "All app features" })).toHaveCount(0);
  await expect(page.locator(".listed-status")).toContainText("Feature summaries are off.");
  await expect(
    page.getByText("Features appear here once Claude Code summarizes the store listing."),
  ).toBeVisible();
});

test("without Claude Code the page says why, and a failed summary can be retried", async ({
  page,
}) => {
  await liveMarket(page);
  await liveClaude(page, undefined, false);
  await start(page, { version: 1, domains: ["Finance"], selected: {} });
  await page.goto("/#/apps");
  await expect(page.locator(".reference-card")).toHaveCount(5);
  await expect(page.locator(".feature-off")).toContainText(
    "Feature summaries are off. Claude Code is not logged in.",
  );
  await page.locator(".reference-card").first().click();
  await expect(page.locator(".listed-status")).toContainText(
    "Feature summaries are off. Claude Code is not logged in.",
  );
  // Sample features stay selectable either way.
  await expect(page.locator(".feature-card").first()).toBeVisible();
  await page.getByRole("button", { name: "Back to app plan" }).click();

  // Claude Code becomes available; the first request hits a usage limit.
  const requests = await liveClaude(page, (req, call) =>
    call === 1
      ? {
          status: 429,
          json: { error: "Claude Code reached a usage limit. Try again later." },
        }
      : {
          status: 200,
          json: {
            features: Object.fromEntries(
              req.apps.map((a) => [
                a.appId,
                {
                  items: listed(a.title),
                  model: "claude-haiku-5-5",
                  template,
                  generatedAt: new Date().toISOString(),
                },
              ]),
            ),
          },
        },
  );
  await page.locator(".feature-off").getByRole("button", { name: "Check again" }).click();
  const row = page.locator('.market-rows li[data-domain="Finance"]');
  await expect(row).toContainText("Claude Code reached a usage limit.");
  await expect(page.locator(".feature-off")).toHaveCount(0);
  // A failure is not retried on its own.
  await page.waitForTimeout(300);
  expect(requests).toHaveLength(1);
  await page.getByRole("button", { name: "Retry features for Finance" }).click();
  await expect(row).not.toContainText("usage limit");
  await expect(page.locator(".card-feature-tags").first()).toContainText(
    "Calendar Pro widgets",
  );
  expect(requests).toHaveLength(2);
});

for (const [field, label] of [
  ["description", "store descriptions"],
  ["iconUrl", "image links"],
])
  test(`a scan saved before apps had ${label} is rescanned once`, async ({
    page,
  }) => {
    const scans = await liveMarket(page);
    const old = JSON.parse(JSON.stringify(marketResult("Productivity")));
    for (const app of old.apps) delete app[field];
    await start(page, {
      version: 1,
      domains: ["Productivity"],
      selected: {},
      market: { Productivity: old },
    });
    await page.goto("/#/apps");
    await expect.poll(() => scans).toEqual([{ domain: "Productivity", refresh: false }]);
    await expect
      .poll(async () => (await saved(page)).market.Productivity.apps[0][field])
      .toBeTruthy();
    await page.waitForTimeout(300);
    expect(scans).toHaveLength(1);
  });

test("live apps show their Google Play icon and screenshots, with the first letter as a fallback", async ({
  page,
}) => {
  await liveMarket(page);
  const requests: { url: string; referer?: string }[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://127.0.0.1"))
      requests.push({ url: r.url(), referer: r.headers()["referer"] });
  });
  // Notes Daily's icon does not load.
  await page.route("https://play-lh.googleusercontent.com/icon1=*", (r) =>
    r.fulfill({ status: 404, body: "" }),
  );
  await start(page, { version: 1, domains: ["Productivity"], selected: {} });
  await page.goto("/#/apps");
  const icons = page.locator(".reference-card .app-icon");
  await expect(icons).toHaveCount(5);
  const first = icons.nth(0).locator("img");
  // A small copy is requested, not the 512-pixel original.
  await expect(first).toHaveAttribute(
    "src",
    "https://play-lh.googleusercontent.com/icon0=s128-rw",
  );
  await expect
    .poll(() => first.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);
  // A failed image and a missing icon both show the first letter.
  await expect(icons.nth(1).locator("img")).toHaveCount(0);
  await expect(icons.nth(1)).toHaveText("N");
  await expect(icons.nth(4).locator("img")).toHaveCount(0);
  await expect(icons.nth(4)).toHaveText("F");

  await page.locator(".reference-card").first().click();
  await expect(page.locator(".detail-title .app-icon img")).toHaveAttribute(
    "src",
    "https://play-lh.googleusercontent.com/icon0=s128-rw",
  );
  const shots = page.getByRole("region", {
    name: "Calendar Pro screenshots from Google Play",
  });
  await expect(shots.getByRole("img")).toHaveCount(2);
  await expect(
    shots.getByRole("img", { name: "Calendar Pro screenshot 1" }),
  ).toHaveAttribute("src", "https://play-lh.googleusercontent.com/shot0a=h560-rw");
  // A screenshot that fails to load is left out.
  await page.route("https://play-lh.googleusercontent.com/shot1a=*", (r) =>
    r.fulfill({ status: 404, body: "" }),
  );
  await page.getByRole("button", { name: "Back to app plan" }).click();
  await page.locator(".reference-card").nth(1).click();
  await expect(
    page.getByRole("region", { name: "Notes Daily screenshots from Google Play" }).getByRole("img"),
  ).toHaveCount(1);
  // Focus Flow has no icon but still shows its screenshots.
  await page.goto("/#/apps/com.example.focus");
  await expect(page.locator(".detail-title .app-icon")).toHaveText("F");
  // Images come only from Google Play's image server, without a referrer.
  expect(requests.length).toBeGreaterThan(0);
  for (const r of requests) {
    expect(r.url).toMatch(/^https:\/\/play-lh\.googleusercontent\.com\//);
    expect(r.referer).toBeUndefined();
  }
});

test("typed domains are kept and scanned as typed", async ({ page }) => {
  const scans = await liveMarket(page);
  await start(page);
  const input = page.getByLabel("Your domains");
  for (const text of ["health", "money", "  focus   timer ", "PRODUCTIVITY"]) {
    await input.fill(text);
    await input.press("Enter");
  }
  // Only a suggested domain's own name maps to that suggested domain.
  expect((await saved(page)).domains).toEqual([
    "health",
    "money",
    "focus timer",
    "Productivity",
  ]);
  await expect(page.getByRole("button", { name: /^Wellness/ })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByRole("button", { name: /^Productivity/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(() => scans.map((s) => s.domain).sort())
    .toEqual(["Productivity", "focus timer", "health", "money"]);
  await input.fill("Health");
  await input.press("Enter");
  await expect(page.getByText("health is already on your list.")).toBeVisible();
});
