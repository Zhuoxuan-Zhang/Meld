import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// End to end against real Google Play through the local scanner. Opt in with
// MELD_LIVE_MARKET=1 after `npm run setup:market`; it needs network access.
test.skip(!process.env.MELD_LIVE_MARKET, "Set MELD_LIVE_MARKET=1 to run.");
test.describe.configure({ mode: "serial" });
test.setTimeout(420_000);
// Claude Code feature summaries use your subscription; they run only with
// MELD_LIVE_CLAUDE=1 as well. Otherwise a stand-in names three features per
// listing, so the rest of Meld still runs on live Google Play apps.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { (window as typeof window & { __MELD_LEGACY__?: boolean }).__MELD_LEGACY__ = true; });
  if (process.env.MELD_LIVE_CLAUDE) return;
  const source = { model: "stand-in", template: "stand-in@000000000000" };
  await page.route("**/api/claude/status", (r) =>
    r.fulfill({ json: { available: true, ...source } }),
  );
  await page.route("**/api/claude/features", (r) => {
    const { apps } = r.request().postDataJSON() as {
      apps: { appId: string; title: string }[];
    };
    return r.fulfill({
      json: {
        features: Object.fromEntries(
          apps.map((a) => [
            a.appId,
            {
              ...source,
              generatedAt: new Date().toISOString(),
              items: ["home", "sharing", "reminders"].map((n) => ({
                name: `${a.title.slice(0, 40)} ${n}`,
                detail: `The ${n} the listing describes.`,
              })),
            },
          ]),
        ),
      },
    });
  });
});

type MarketApp = {
  appId: string;
  title: string;
  rank: number;
  score: number;
  storeUrl: string;
  retained?: boolean;
  listedFeatures?: { items: { name: string }[] };
  iconUrl?: string;
  screenshots?: string[];
};
// Waits until a Google Play image has loaded in the page.
const loaded = (image: ReturnType<Page["locator"]>) =>
  expect
    .poll(() => image.evaluate((i: HTMLImageElement) => (i.complete ? i.naturalWidth : 0)), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
type Result = { domain: string; status: string; apps: MarketApp[] };
const key = "meld.workspace.v1";
const known = [
  "Productivity",
  "Wellness",
  "Learning",
  "Finance",
  "Fitness",
  "Creativity",
];

// Fails the test on any page error, console error or browser dialog.
function watch(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("dialog", (d) => {
    problems.push(`dialog: ${d.message()}`);
    d.dismiss();
  });
  return problems;
}
async function start(page: Page, domains: string[] = [], selected = {}) {
  await page.goto("/");
  await page.evaluate(
    ({ key, domains, selected }) =>
      localStorage.setItem(
        key,
        JSON.stringify({ version: 1, domains, selected }),
      ),
    { key, domains, selected },
  );
  await page.goto("/?live=1#/apps");
}
const saved = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
// Waits until every chosen domain has a finished scan in the workspace, with
// its listings summarized.
async function scanned(page: Page, domains: string[]) {
  await expect
    .poll(
      async () => {
        const d = await saved(page);
        return domains.filter((x) =>
          d.market?.[x]?.apps.every(
            (a: MarketApp) => a.listedFeatures || a.retained,
          ),
        ).length;
      },
      { timeout: 300_000, intervals: [1000] },
    )
    .toBe(domains.length);
  return (await saved(page)).market as Record<string, Result>;
}

test("live scan results reach the catalog, detail page and design brief unchanged", async ({
  page,
}) => {
  const problems = watch(page);
  const status = await (await page.request.get("/api/market/status")).json();
  expect(status.available, status.reason).toBe(true);
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: /^Finance/ }).click();
  await page.getByRole("button", { name: "Explore apps" }).click();
  await expect(page.locator(".rank-label").first()).toBeVisible({
    timeout: 180_000,
  });
  // The same request again is answered from the server cache.
  const response = await page.request.post("/api/market/scan", {
    data: { domain: "Finance" },
  });
  expect(response.status()).toBe(200);
  const { result, cached } = await response.json();
  expect(cached).toBe(true);
  expect(result.apps.length).toBeGreaterThan(0);
  expect(result.genreId).toBe("FINANCE");
  for (const app of result.apps) expect(app.genreId).toBe("FINANCE");
  await expect(page.locator(".reference-card h3")).toHaveText(
    result.apps.map((a: { title: string }) => a.title),
  );
  await expect(page.locator(".rank-label")).toHaveText(
    result.apps.map((a: { rank: number }) => `#${a.rank} · Finance`),
  );
  const top = result.apps[0];
  await page.locator(".reference-card").first().click();
  await expect(page).toHaveURL(
    new RegExp(`#/apps/${top.appId.replace(/\./g, "\\.")}$`),
  );
  await expect(
    page.getByRole("link", { name: "View on Google Play" }),
  ).toHaveAttribute("href", top.storeUrl);
  await expect(page.locator(".market-facts")).toContainText(`${top.score}/15`);
  await expect(page.locator(".feature-card").first()).toBeVisible({ timeout: 300_000 });
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Save & return" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel(/What will you call it/).fill("Live Finance");
  await page.getByRole("button", { name: "Preview the design brief" }).click();
  await expect(page.locator(".document-body")).toContainText(
    `${top.title} (${top.appId}): #${top.rank} in Finance on Google Play · opportunity ${top.score}/15`,
  );
  expect(problems).toEqual([]);
});

for (const domain of known)
  test(`${domain} on its own: every app opens, and an example plan builds a demo`, async ({
    page,
  }) => {
    const problems = watch(page);
    await start(page, [domain]);
    const market = await scanned(page, [domain]);
    const apps = market[domain].apps;
    expect(market[domain].status).not.toBe("insufficient_results");
    expect(apps.length).toBeGreaterThan(0);
    await expect(page.locator(".reference-card h3")).toHaveText(
      apps.map((a) => a.title),
    );
    for (const app of apps) {
      await page.goto(`/?live=1#/apps/${app.appId}`);
      await expect(page.locator(".market-facts")).toContainText(
        `${app.score}/15`,
      );
      await expect(
        page.getByRole("link", { name: "View on Google Play" }),
      ).toHaveAttribute("href", app.storeUrl);
      // The real icon and screenshots load from Google Play's image server.
      expect(app.iconUrl).toMatch(/^https:\/\/play-lh\.googleusercontent\.com\//);
      await loaded(page.locator(".detail-title .app-icon img"));
      if (app.screenshots?.length) {
        const shot = page.locator(".app-screenshots img").first();
        await shot.scrollIntoViewIfNeeded();
        await loaded(shot);
      }
      // The listing's features are the choices.
      const listed = app.listedFeatures!.items.map((f) => f.name);
      if (listed.length)
        await expect(page.locator(".feature-card .feature-title")).toContainText(listed);
    }
    await page.goto("/?live=1#/apps");
    await page.getByRole("button", { name: "Try an example", exact: true }).click();
    await expect(page.getByText("EXAMPLE PLAN", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Use this plan" }).click();
    const draft = await saved(page);
    const chosen = Object.keys(draft.selected);
    expect(chosen.length).toBeGreaterThanOrEqual(2);
    for (const id of chosen) expect(apps.map((a) => a.appId)).toContain(id);
    await page.getByRole("button", { name: "Review app", exact: true }).click();
    await page.getByRole("button", { name: "Create my app" }).click();
    await expect(
      page.getByRole("heading", { name: "Your app is ready to try." }),
    ).toBeVisible({ timeout: 15_000 });
    const demo = page.frameLocator("iframe");
    await expect(demo.locator("body")).toContainText(draft.name);
    expect(problems).toEqual([]);
  });

test("all six domains together: every filter shows its own top apps", async ({
  page,
}) => {
  const problems = watch(page);
  await start(page, known);
  const market = await scanned(page, known);
  const unique = new Set(known.flatMap((d) => market[d].apps.map((a) => a.appId)));
  await expect(page.locator(".reference-card")).toHaveCount(unique.size);
  await expect(page.locator(".market-rows li")).toHaveCount(6);
  for (const domain of known) {
    await page.getByRole("button", { name: domain, exact: true }).click();
    const ids = await page
      .locator(".reference-card")
      .evaluateAll((cards) => cards.length);
    expect(ids, domain).toBe(market[domain].apps.length);
  }
  await page.getByRole("button", { name: "All interests", exact: true }).click();
  expect(problems).toEqual([]);
});

test("overlapping domains share apps, and removing one keeps a choice that is still shown", async ({
  page,
}) => {
  const problems = watch(page);
  const domains = ["Fitness", "Health & Fitness"];
  await start(page, domains);
  const market = await scanned(page, domains);
  const fitness = new Set(market.Fitness.apps.map((a) => a.appId));
  const shared = market["Health & Fitness"].apps.filter((a) => fitness.has(a.appId));
  test.skip(!shared.length, "Google Play currently returns no shared app.");
  const row = page.locator('.market-rows li[data-domain="Health & Fitness"]');
  await expect(row).toContainText(`${shared.length} also under Fitness`);
  await page.getByRole("button", { name: "Health & Fitness", exact: true }).click();
  await expect(page.locator(".reference-card")).toHaveCount(
    market["Health & Fitness"].apps.length,
  );
  // Choose a feature from an app listed under Fitness, then remove Fitness.
  await page.goto(`/?live=1#/apps/${shared[0].appId}`);
  await page.getByRole("checkbox").first().check();
  await page.goto("/?live=1#/domains");
  await page.getByRole("button", { name: "Remove Fitness", exact: true }).click();
  expect(Object.keys((await saved(page)).selected)).toEqual([shared[0].appId]);
  await page.getByRole("button", { name: "Explore apps" }).click();
  await expect(
    page.locator(".reference-card", { hasText: shared[0].title }),
  ).toContainText("Health & Fitness");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator(".review-app h3")).toHaveText([shared[0].title]);
  expect(problems).toEqual([]);
});

test("eight domains at once, including unusual custom ones, all finish without errors", async ({
  page,
}) => {
  const problems = watch(page);
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  for (const name of ["Productivity", "Wellness", "Learning", "Finance"])
    await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  const custom = ["<script>alert(1)</script>", "日本語", "😀", "--help"];
  for (const name of custom) {
    await page.getByLabel("Your domains").fill(name);
    await page.getByLabel("Your domains").press("Enter");
  }
  const domains = [...["Productivity", "Wellness", "Learning", "Finance"], ...custom];
  expect((await saved(page)).domains).toEqual(domains);
  await page.getByRole("button", { name: "Explore apps" }).click();
  // The AI status check is not starved by the scans in flight.
  await expect(page.locator(".ai-status")).not.toHaveText("Connecting…", {
    timeout: 10_000,
  });
  const market = await scanned(page, domains);
  await expect(page.locator(".market-rows li")).toHaveCount(8);
  for (const domain of domains) {
    const row = page.locator(".market-rows li").filter({ hasText: domain }).first();
    await expect(row).not.toContainText("Scanning");
    await expect(row.locator(".market-state")).not.toHaveClass(/failed/);
    expect(market[domain].apps.length, domain).toBeGreaterThan(0);
  }
  // Custom names stay plain text everywhere.
  await expect(
    page.getByRole("button", { name: "<script>alert(1)</script>", exact: true }),
  ).toBeVisible();
  expect(problems).toEqual([]);
});

test("quick toggling and a reload during a scan end in a consistent workspace", async ({
  page,
}) => {
  const problems = watch(page);
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const tile = page.getByRole("button", { name: /^Creativity/ });
  for (let i = 0; i < 5; i++) await tile.click();
  // Five clicks leave Creativity chosen, with one finished scan.
  await scanned(page, ["Creativity"]);
  expect((await saved(page)).domains).toEqual(["Creativity"]);
  await page.getByLabel("Your domains").fill("pottery");
  await page.getByLabel("Your domains").press("Enter");
  await page.reload();
  const market = await scanned(page, ["Creativity", "pottery"]);
  expect(Object.keys(market).sort()).toEqual(["Creativity", "pottery"]);
  await page.getByRole("button", { name: "Explore apps" }).click();
  await expect(page.locator(".market-rows li")).toHaveCount(2);
  expect(problems).toEqual([]);
});

test("a free-text domain is scanned as typed, and Claude Code summarizes every listing", async ({
  page,
}) => {
  test.skip(!process.env.MELD_LIVE_CLAUDE, "Set MELD_LIVE_CLAUDE=1 to run Claude Code.");
  const problems = watch(page);
  const status = await (await page.request.get("/api/claude/status")).json();
  expect(status.available, status.reason).toBe(true);
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByLabel("Your domains").fill("  habit   tracker ");
  await page.getByLabel("Your domains").press("Enter");
  expect((await saved(page)).domains).toEqual(["habit tracker"]);
  await page.getByRole("button", { name: "Explore apps" }).click();
  type Listed = { appId: string; title: string; retained?: boolean; listedFeatures?: { items: { name: string }[]; model: string; template: string } };
  await expect
    .poll(
      async () => {
        const apps: Listed[] = (await saved(page)).market?.["habit tracker"]?.apps || [];
        return apps.length > 0 && apps.every((a) => a.listedFeatures);
      },
      { timeout: 300_000, intervals: [1000] },
    )
    .toBe(true);
  const result = (await saved(page)).market["habit tracker"];
  expect(result.genreId).toBeNull();
  expect(result.queries).toEqual([]);
  const apps: Listed[] = result.apps;
  expect(apps.filter((a) => a.listedFeatures!.items.length >= 3).length).toBeGreaterThanOrEqual(
    apps.length - 1,
  );
  for (const app of apps) {
    expect(app.listedFeatures!.template).toBe(status.template);
    expect(app.listedFeatures!.model).toContain("claude");
  }
  await expect(page.locator(".market-rows li")).not.toContainText("Summarizing");
  await page.locator(".reference-card").first().click();
  // The listing features are the app's choices.
  await expect(page.locator(".feature-card .feature-title")).toContainText(
    apps[0].listedFeatures!.items.map((f) => f.name),
  );
  await expect(page.locator(".feature-card")).toHaveCount(
    apps[0].listedFeatures!.items.length,
  );
  expect(problems).toEqual([]);
});
