import { test, expect } from "./fixtures";
import { assessFit, featureFitsScope, fitsFilter, recommendedDomains } from "../src/feasibility";
import { unsummarized } from "../src/useFeatures";
import { fromScannerReport, scanPlan } from "../src/market";
import { catalog, emptyDraft, loadDraft } from "../src/state";
import { scannerApp, scannerReport } from "./market-data";
import { designServer } from "./design-fixtures";
import { randomUUID } from "node:crypto";
import { DesignInput, scopedCoreTasks } from "../server/pipeline";
import { fixtureData } from "../../pipeline/tests/fixtures/workbench";
import { validateDesign } from "../../pipeline/dist/src/validate.js";

test("timer and habit briefs do not inherit note tasks from package names or unselected features", () => {
  const feature = { id: "org.notes.app:countdown", name: "Countdown timer", description: "Start, pause and reset a local session." };
  const input = DesignInput.parse({ request_key: randomUUID(), scan_ids: ["scan-" + "a".repeat(64)], brief: { name: "Focus", audience: "Me", purpose: "Focus", goal: "Focus", style: "sage" }, preferences: [{ app_id: "org.notes.app", feature_ids: [feature.id] }], feature_requests: [feature, { id: "unused", name: "Notes", description: "Save notes" }] });
  const tasks = scopedCoreTasks(input);
  expect(tasks).toContain("pause");
  expect(tasks).not.toContain("edit");
  expect(tasks).not.toContain("find");
  const habits = scopedCoreTasks({ ...input, preferences: [{ app_id: "org.notes.app", feature_ids: ["habits"] }], feature_requests: [] });
  expect(habits).toContain("check in");
  expect(habits).not.toContain("reopen");

  const fixture = fixtureData();
  fixture.brief.core_tasks = tasks;
  fixture.design.scope.core_tasks = [...tasks];
  fixture.design.pages[0].states = fixture.design.pages[0].states.filter(s => ["normal", "empty", "error"].includes(s.kind));
  expect(validateDesign(fixture.design, fixture.brief, fixture.decisions, [])).toEqual([]);
  fixture.design.scope.core_tasks = tasks.filter(task => task !== "pause");
  expect(validateDesign(fixture.design, fixture.brief, fixture.decisions, [])).toContain("Missing core task pause");
});

test("full ranking survives the five-app API, storage, filtering and deduplication", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ ...scannerApp(1, i + 1), app_id: `org.notes.app${i}` }));
  rows[0].title = "AI note assistant";
  const result = fromScannerReport("Notes & lists", { ...scannerReport("Notes & lists"), ranking: rows, top_five: rows.slice(0, 5) });
  expect(result.apps).toHaveLength(40);
  const draft = { ...emptyDraft(), domains: ["Notes & lists"], market: { "Notes & lists": result } };
  expect(catalog(draft)).toHaveLength(39);
  expect(catalog(draft).some(a => a.id === "org.notes.app39")).toBe(true);
  const storage = { getItem: () => JSON.stringify(draft) };
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  try { expect(loadDraft().market?.["Notes & lists"].apps).toHaveLength(40); }
  finally { Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous }); }
  expect(catalog({ ...draft, domains: ["Notes & lists", "Focus & habits"], market: { ...draft.market, "Focus & habits": { ...result, domain: "Focus & habits" } } })).toHaveLength(39);
});

test("complex dependencies are excluded and missing evidence needs review", () => {
  for (const text of ["AI notes", "Collaborative notes", "Notes with handwriting recognition", "Notes with bank sync", "Notes with video editor", "Notes with Bluetooth"]) {
    expect(assessFit({ title: text, summary: "Notes for everyone" }).level, text).toBe("complex");
  }
  expect(assessFit({ title: "Notion", summary: "Write notes" }).level).toBe("complex");
  expect(assessFit({ title: "Cloud Notes", summary: "Sync notes across devices" }).level).toBe("review");
  expect(assessFit({ title: "Calm Timer", summary: "An offline timer" }).level).toBe("complex");
  expect(assessFit({ title: "Tiny Timer", summary: "Stay calm with an offline timer. No account required." }).level).toBe("simple");
  expect(assessFit({ title: "Unknown App", summary: "Great app" }).level).toBe("review");
  expect(assessFit({ title: "Notes", summary: "Local notes" }, "Focus & habits").level).toBe("review");
  expect(featureFitsScope("AI summary", "Generate a summary")).toBe(false);
  expect(featureFitsScope("Cloud sync", "Sync across devices")).toBe(false);
  expect(featureFitsScope("Local search", "Find saved notes")).toBe(true);
});

test("classic games qualify without mistaking absent features or pricing for complexity", () => {
  for (const title of ["Minesweeper", "Minesweeper Classic: Offline", "Sudoku", "2048", "Tic-tac-toe"]) {
    expect(assessFit({ title, summary: "A classic puzzle with local stats." }, "Puzzle games").level, title).toBe("simple");
  }
  const infinity = assessFit({ title: "Infinity Sweep: Minesweeper", summary: "Endless minesweeper, infinite zones. No pop-up ads, no timers—sweep forever." }, "Minesweeper games");
  expect(infinity.level).toBe("simple");
  expect(infinity.scope).toEqual(["Reveal cells, flag mines and track wins locally"]);
  for (const description of ["Reveal a bomb hidden with 3D Touch.", "Beveled 3D cells and traditionally colored numbers.", "No multiplayer. Play offline.", "Optional items require payment. Payment will be charged to your account."]) {
    expect(assessFit({ title: "Minesweeper", summary: "A classic puzzle", description }).level, description).toBe("simple");
  }
  for (const summary of ["Online multiplayer matches", "Explore a 3D world", "Accept payments from players"]) {
    expect(assessFit({ title: "Minesweeper", summary }).level, summary).toBe("complex");
  }
  expect(assessFit({ title: "Puzzle Fun", summary: "Funny puzzles", description: "Optional items require payment." }).level).toBe("review");
  expect(assessFit({ title: "Wallet", summary: "Manage payments" }).level).toBe("complex");
  expect(assessFit({ title: "Business app", summary: "Run your business", description: "Accept payments from customers." }).level).toBe("complex");
  expect(featureFitsScope("Tile style", "Beveled 3D cells")).toBe(true);
  expect(featureFitsScope("Accept payments", "Charge players for items")).toBe(false);
  expect(featureFitsScope("Multiplayer", "Play online with friends")).toBe(false);
});

test("unknown workflows remain visible and get summaries unless the user chooses simple only", () => {
  const review = assessFit({ title: "Puzzle Fun", summary: "Funny puzzles" });
  expect(review.level).toBe("review");
  expect(fitsFilter(review)).toBe(true);
  expect(fitsFilter(review, "simple")).toBe(false);
  const rows = [
    { ...scannerApp(0), title: "Puzzle Fun", store_summary: "Funny puzzles", store_description: "Solve a puzzle" },
    { ...scannerApp(1), title: "Minesweeper", store_summary: "A classic puzzle", store_description: "Reveal cells and flag mines" },
    { ...scannerApp(2), title: "Online Puzzle", store_summary: "Multiplayer battles", store_description: "Play online" },
  ];
  const result = fromScannerReport("Puzzle games", { ...scannerReport("Puzzle games"), ranking: rows });
  expect(unsummarized(result).map(a => a.title)).toEqual(["Puzzle Fun", "Minesweeper"]);
  expect(unsummarized(result, false).map(a => a.title)).toEqual(["Minesweeper"]);
  const previous = globalThis.localStorage;
  try {
    for (const complexity of [undefined, "simple", "review"] as const) {
      const draft = { ...emptyDraft(), domains: ["Puzzle games"], market: { "Puzzle games": result }, complexity };
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => JSON.stringify(draft) } });
      const loaded = loadDraft();
      expect(loaded.complexity).toBe(complexity || "review");
      expect(catalog(loaded)).toHaveLength(complexity === "simple" ? 1 : 2);
    }
  } finally { Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous }); }
});

test("six domain choices allow two selections and never show samples offline", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".studio-domain-grid button")).toHaveCount(recommendedDomains.length);
  await page.getByRole("button", { name: /^Notes & lists/ }).click();
  await page.getByRole("button", { name: /^Focus & habits/ }).click();
  await page.getByLabel("Enter a domain").fill("Video editing");
  await page.getByLabel("Enter a domain").press("Enter");
  await expect(page.getByRole("alert")).toContainText("up to two domains");
  await page.getByRole("button", { name: "Explore selected domains" }).click();
  await expect(page.getByText("Disabled for this test.", { exact: false })).toBeVisible();
  await expect(page.locator(".studio-reference-card")).toHaveCount(0);
  await expect(page.getByLabel("App complexity")).toHaveValue("review");
  await page.reload();
  await expect(page.getByLabel("App complexity")).toHaveValue("review");
  await expect(page.locator(".studio-reference-card")).toHaveCount(0);
});

const addedDomains = [
  { domain: "Journals & diaries", title: "Pocket Diary", summary: "Write and search private diary entries offline.", genre: "LIFESTYLE", complex: "Shared diary for couples with real-time entries" },
  { domain: "Flashcards", title: "Pocket Flashcards", summary: "Create your own flash cards and review them offline.", genre: "EDUCATION", complex: "Generate flashcards with AI" },
  { domain: "Reading lists", title: "Pocket Books", summary: "A local reading list and book tracker. Add books manually and mark them read.", genre: "BOOKS_AND_REFERENCE", complex: "Read ebooks and listen to audiobooks from an online library" },
  { domain: "Counters & tallies", title: "Pocket Counter", summary: "Tap to increment or reset multiple counters offline.", genre: "TOOLS", complex: "Object detection for automatic counting with the camera" },
];

for (const example of addedDomains) {
  test(`${example.domain}: local workflows pass, unrelated and complex apps do not`, () => {
    expect(recommendedDomains).toContain(example.domain);
    expect(scanPlan(example.domain).genreId).toBe(example.genre);
    expect(assessFit({ title: example.title, summary: example.summary }, example.domain).level).toBe("simple");
    expect(assessFit({ title: example.title, summary: example.summary, description: example.complex }, example.domain).level).toBe("complex");
    expect(assessFit({ title: "Focus Timer", summary: "A simple local pomodoro timer" }, example.domain).level).toBe("review");
    expect(assessFit({ title: example.title, summary: example.summary.replace(/offline|local/g, ""), description: "Account required. Cloud sync." }, example.domain).level).toBe("review");
  });

  test(`${example.domain}: discovery, filtering, card selection and reload work`, async ({ page }) => {
    const rows = [
      { ...scannerApp(1), title: example.title, store_summary: example.summary, store_description: example.summary },
      { ...scannerApp(0), title: "Focus Timer", store_summary: "An offline timer", store_description: "An offline timer" },
      { ...scannerApp(2), title: example.title + " Plus", store_summary: example.summary, store_description: example.complex },
    ];
    const result = fromScannerReport(example.domain, { ...scannerReport(example.domain), ranking: rows });
    result.apps[0].listedFeatures = { items: [{ name: "Local entries", detail: example.summary }], model: "test", template: "test", generatedAt: new Date().toISOString() };
    await page.route("**/api/market/status", r => r.fulfill({ json: { available: true } }));
    await page.route("**/api/market/scan", r => {
      expect(r.request().postDataJSON().domain).toBe(example.domain);
      return r.fulfill({ json: { result } });
    });
    await page.goto("/");
    await page.getByRole("button", { name: new RegExp(`^${example.domain}`) }).click();
    await page.getByRole("button", { name: "Explore selected domains" }).click();
    await expect(page.locator(".studio-reference-card")).toHaveCount(2);
    await expect(page.locator(".studio-reference-card", { hasText: "Focus Timer" })).toContainText("Needs review:");
    await page.getByLabel("App complexity").selectOption("simple");
    await expect(page.locator(".studio-reference-card")).toHaveCount(1);
    await expect(page.locator(".studio-reference-card h3")).toHaveText(example.title);
    const select = page.getByRole("button", { name: `Select all features from ${example.title}`, exact: true });
    await select.click();
    await expect(page.getByRole("button", { name: `Clear all features from ${example.title}`, exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(page.getByLabel("App complexity")).toHaveValue("simple");
    await expect(page.getByRole("button", { name: `Clear all features from ${example.title}`, exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByLabel("App complexity").selectOption("review");
    await expect(page.locator(".studio-reference-card")).toHaveCount(2);
    await expect(page.locator(".studio-reference-card", { hasText: example.title + " Plus" })).toHaveCount(0);
  });
}

test("new domains keep shared journals, reading services and fixed course decks out", () => {
  expect(assessFit({ title: "Waffle: Shared Journal", summary: "Shared journaling for couples and friends" }, "Journals & diaries").level).toBe("complex");
  expect(assessFit({ title: "ABC Flash Cards", summary: "Flash cards for toddlers", description: "Learn the alphabet with our ready-made cards." }, "Flashcards").level).toBe("review");
  expect(assessFit({ title: "ABC Flash Cards", summary: "Flash cards for toddlers", description: "Games designed to make learning enjoyable." }, "Flashcards").level).toBe("review");
  expect(assessFit({ title: "Quizlet: More than Flashcards", summary: "Create flashcards and practice tests" }, "Flashcards").level).toBe("complex");
  expect(assessFit({ title: "Reading Tracker", summary: "A book club and social reading community" }, "Reading lists").level).toBe("complex");
  expect(assessFit({ title: "Reading Tracker", summary: "Track books offline", description: "Email sign-in and cloud sync." }, "Reading lists").level).toBe("review");
  expect(featureFitsScope("Online book recommendations", "Find books in the online library")).toBe(false);
  expect(assessFit({ title: "Counter", summary: "Track things" }, "Counters & tallies").level).toBe("review");
  expect(assessFit({ title: "Step Counter", summary: "Tap to start tracking steps" }, "Counters & tallies").level).toBe("complex");
  expect(assessFit({ title: "Auto Tally Counter", summary: "Tap or auto counting" }, "Counters & tallies").level).toBe("complex");
  expect(assessFit({ title: "Counter", summary: "Count by NFC with webhooks" }, "Counters & tallies").level).toBe("complex");
  expect(featureFitsScope("Automatic counting", "Detect objects using a camera")).toBe(false);
});

test("catalog filter never lets a complex app into the simple selection", async ({ page }) => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ ...scannerApp(1, i + 1), app_id: `org.test.notes${i}`, title: `Local Notes ${i}` }));
  rows[0].title = "AI Notes";
  rows[1].store_description = "Sync notes across devices";
  const result = { ...fromScannerReport("Notes & lists", { ...scannerReport("Notes & lists"), ranking: rows }), scanId: "scan-" + "a".repeat(64) };
  await page.route("**/api/market/status", r => r.fulfill({ json: { available: true } }));
  await page.route("**/api/market/scan", r => r.fulfill({ json: { result } }));
  await page.goto("/");
  await page.getByRole("button", { name: /^Notes & lists/ }).click();
  await page.getByRole("button", { name: "Explore selected domains" }).click();
  await expect(page.locator(".studio-reference-card")).toHaveCount(11);
  await page.getByLabel("App complexity").selectOption("simple");
  await expect(page.locator(".studio-reference-card")).toHaveCount(10);
  await page.getByLabel("App complexity").selectOption("review");
  await expect(page.locator(".studio-reference-card")).toHaveCount(11);
  await expect(page.locator(".studio-reference-card", { hasText: "AI Notes" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("App complexity")).toHaveValue("review");
});

test("backend rejects complex apps and too many features even if the browser is bypassed", async ({ request }) => {
  const api = await designServer();
  try {
    const report = scannerReport("Notes & lists"); report.ranking[0].title = "AI Notes";
    const scan = await api.signals.record(fromScannerReport("Notes & lists", report));
    const body = { request_key: randomUUID(), scan_ids: [scan.scanId], brief: { name: "Notes", audience: "Me", purpose: "Notes", goal: "Notes", style: "warm" }, preferences: [{ app_id: "com.example.calendar", feature_ids: ["notes"] }] };
    const response = await request.post(api.address + "/api/design/pipeline", { data: body });
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe("complex_reference");
    const tooBig = await request.post(api.address + "/api/design/pipeline", { data: { ...body, preferences: [{ app_id: "com.example.notes", feature_ids: ["notes"] }], requested_features: ["notes", "tasks", "timer", "habits", "journal", "insights"] } });
    expect(tooBig.status()).toBe(400);
    expect((await tooBig.json()).error.code).toBe("scope_limit");
  } finally { await api.close(); }
});
