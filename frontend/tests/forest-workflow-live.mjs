// Opt-in, real model/Android workflow. Run from frontend/. No mocked workers.
// Usage: node tests/forest-workflow-live.mjs status|extend|confirm|approve|resume|repair|retry|watch|download|provenance CASE [feedback-file]
// CASE: forest-core, forest-two, forest-five. Later cases require a passing
// emulator report for the preceding case, bound to its exact delivered APK.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const base = process.env.MELD_BASE_URL || "http://127.0.0.1:4173";
const output = path.resolve(process.env.MELD_FOREST_QA_OUTPUT || "qa-screenshots/forest-cases");
await mkdir(output, { recursive: true });
const registry = path.join(output, "cases.json");
const report = await readFile(registry, "utf8").then(JSON.parse).catch(() => ({ createdAt: new Date().toISOString(), baseAppId: "cc.forestapp", cases: [] }));
const [command = "status", caseId = "forest-core"] = process.argv.slice(2);
const ids = ["forest-core", "forest-two", "forest-five"];
const index = ids.indexOf(caseId);
if (index < 0) throw new Error("Choose forest-core, forest-two or forest-five.");
const directory = path.join(output, caseId);
await mkdir(directory, { recursive: true });
const save = () => writeFile(registry, JSON.stringify(report, null, 2));
const request = async (route, body, method = body ? "POST" : "GET") => {
  const response = await fetch(base + route, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
  return value;
};
const additions = [
  { id: "custom-session-checklist", name: "Session task checklist", description: "Create, edit, check and delete simple tasks for the upcoming focus session. Preserve the checklist with that session in history, including on an abandoned session. Reject blank tasks. Keep task checks independent from timer completion." },
  { id: "custom-session-notes", name: "Session reflection notes", description: "Add and edit a plain-text reflection on a completed or abandoned focus session. Save notes locally with the correct session and retain them across app restarts. Empty notes are allowed and remove the previous note." },
  { id: "custom-daily-goal", name: "Daily focus goal", description: "Set a daily goal from 1 to 480 minutes. Show today's successfully completed focus minutes and progress toward that goal. Failed or active sessions contribute zero. Count each success once on its completion date in the device's local time zone. Persist the goal and recompute progress from saved sessions." },
  { id: "custom-timer-presets", name: "Named timer presets", description: "Save, rename, select and delete named focus-duration presets, each from 1 to 120 minutes. Selecting a preset sets up the timer without starting it. Reject empty names and invalid durations. Preserve presets after restart and prevent preset changes from replacing an active session." },
  { id: "custom-history-search", name: "Search session history", description: "Search history by session notes and task text, case-insensitively. Show matching sessions with their outcomes. Clearing the search restores the full history. Show an explicit empty state for no matches. Searching never changes session data." },
];
const core = "Build the small offline core of Forest: a configurable 1–120 minute focus timer, a visibly drawn tree with trunk and leaves that grows during the session, a withered tree when a session is abandoned, a garden of earned trees, and saved session history. Keep success and failure results visible. Include Give up with Keep focusing and confirm actions. Reject invalid durations and duplicate starts. Screen lock, rotation and internal navigation keep the timer running; deliberately switching to another app before time ends fails the session, including after unlocking. Recover state and history safely after process restarts. Keep controls readable and reachable on small screens and in landscape. No accounts, social rooms, real-tree donations, purchases, app-blocker permissions or unrelated features.";
let item = report.cases.find(value => value.id === caseId);

if (command === "extend") {
  if (!index) throw new Error("The baseline must be built before extending it.");
  const prior = report.cases.find(value => value.id === ids[index - 1]);
  const verified = JSON.parse(await readFile(path.join(output, ids[index - 1], "runtime-report.json"), "utf8"));
  if (!prior?.apkSha256 || verified.passed !== true || verified.apkSha256 !== prior.apkSha256 || verified.projectId !== prior.projectId) throw new Error("Verify the preceding delivered APK on Android first.");
  if (item?.changeJobId) throw new Error("This change was already requested. Inspect the saved project before repeating it.");
  const current = await request(`/api/projects/${prior.projectId}`);
  if (current.activeJobId || current.latestBuild?.id !== prior.buildId || current.latestBuild.status !== "succeeded") throw new Error("Extend the exact verified, idle preceding build.");
  const features = additions.slice(0, index === 1 ? 2 : 5);
  const newFeatures = index === 1 ? features : features.slice(2);
  const change = `Keep this verified Forest core and every existing feature. Preserve saved sessions, earned trees, task lists and notes when upgrading the app. Add exactly these ${newFeatures.length} simple features, integrated into the existing focus workflow: ${newFeatures.map(f => `${f.name}: ${f.description}`).join(" ")} Preserve visible tree growth and success/failure outcomes, Give up confirmation, valid durations, screen-lock/rotation/internal-navigation behavior and safe process restart. Keep everything offline and single-user. Do not add unrelated features. Group related features if needed without dropping any behavior.`;
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    await page.goto(`${base}/?project=${current.id}`);
    await page.getByRole("button", { name: "Back to your design" }).click();
    await page.getByLabel("What would you like to change?", { exact: true }).fill(change);
    await page.screenshot({ path: path.join(directory, "feature-request.png"), fullPage: true });
    const response = page.waitForResponse(r => r.url().endsWith("/changes") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Preview design changes" }).click();
    const r = await response, job = await r.json();
    if (!r.ok()) throw new Error(JSON.stringify(job));
    item ||= { id: caseId };
    if (!report.cases.includes(item)) report.cases.push(item);
    Object.assign(item, { projectId: current.id, previousBuildId: prior.buildId, features, changeRequest: change, changeJobId: job.id, status: "ui-feature-change-requested" });
    await save(); console.log(JSON.stringify(item));
  } finally { await browser.close(); }
  process.exit(0);
}

if (command === "create") {
  if (item?.projectId) { console.log(JSON.stringify(item)); process.exit(0); }
  if (index) {
    const prior = report.cases.find(value => value.id === ids[index - 1]);
    const verified = JSON.parse(await readFile(path.join(output, ids[index - 1], "runtime-report.json"), "utf8"));
    if (!prior?.apkSha256 || verified.passed !== true || verified.apkSha256 !== prior.apkSha256 || verified.projectId !== prior.projectId) throw new Error("The preceding case must pass emulator checks on its exact delivered APK first.");
  }
  const referenceId = process.env.MELD_FOREST_REFERENCE_PROJECT || report.cases[0]?.projectId;
  if (!referenceId) throw new Error("Set MELD_FOREST_REFERENCE_PROJECT to a saved project with the Forest reference.");
  const reference = await request(`/api/projects/${referenceId}`);
  const scan = Object.values(reference.references).find(scan => scan.apps.some(app => app.appId === "cc.forestapp"));
  if (!scan?.scanId) throw new Error("The reference project has no saved Forest scan.");
  const features = additions.slice(0, index === 1 ? 2 : index === 2 ? 5 : 0);
  item ||= { id: caseId, requestKey: randomUUID() };
  if (!report.cases.includes(item)) report.cases.push(item);
  item.features = features; await save();
  const project = await request("/api/workflow/import", { requestKey: item.requestKey, baseAppId: "cc.forestapp", scanIds: [scan.scanId], references: [{ appId: "cc.forestapp", features: [] }], customFeatures: features, brief: {
    name: index ? `Forest Plus ${features.length} QA` : "Forest Core QA", input: core + (features.length ? " Add exactly the requested enhancements within this focus workflow: " + features.map(f => `${f.name}: ${f.description}`).join(" ") : " No enhancements in this baseline."),
    purpose: "Preserve Forest's focus, tree-growing, garden and history loop.", goal: "Verify the base and each explicitly requested addition in a real Android build.", audience: "One person focusing without phone distractions.", style: "warm", domains: [scan.domain],
  } });
  item.projectId = project.id; item.status = "imported"; await save();
  console.log(JSON.stringify(item));
  process.exit(0);
}
if (!item?.projectId) throw new Error("Create this case first.");
let project = await request(`/api/projects/${item.projectId}`);
if (command === "status") {
  const latest = await request(`/api/projects/${project.id}/latest-job`);
  console.log(JSON.stringify({ case: caseId, projectId: project.id, outline: project.highLevelDesign?.revision, preparation: project.referencePreparation, latestJob: latest.job, build: project.latestBuild }, null, 2));
} else if (command === "outline") {
  if (project.activeJobId) throw new Error("A job is already active.");
  const job = await request(`/api/projects/${project.id}/design`, { requestKey: randomUUID(), expectedVersion: project.version });
  item.outlineJobId = job.id; item.status = "outline-running"; await save(); console.log(JSON.stringify(job));
} else if (command === "rebuild") {
  if (project.activeJobId || !project.currentDesignRevision || project.needsDesign) throw new Error("The approved design must be ready and idle before rebuilding.");
  const job = await request(`/api/projects/${project.id}/builds`, { requestKey: randomUUID(), expectedVersion: project.version, revision: project.currentDesignRevision });
  item.buildJobId = job.id; item.status = "building"; await save(); console.log(JSON.stringify(job));
} else if (command === "resume") {
  if (project.activeJobId) throw new Error("Wait for the current job to finish.");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    await page.goto(`${base}/?project=${project.id}`);
    const response = page.waitForResponse(r => r.url().endsWith("/resume") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Continue from saved progress", exact: true }).click();
    const r = await response, job = await r.json();
    if (!r.ok()) throw new Error(JSON.stringify(job));
    (item.recoveryJobs ||= []).push(job.id); item.status = "ui-resumed";
    await save(); console.log(JSON.stringify(job));
  } finally { await browser.close(); }
} else if (command === "repair" || command === "retry") {
  if (project.activeJobId) throw new Error("Wait for the current job to finish.");
  const feedback = command === "repair" ? (await readFile(process.argv[4], "utf8")).trim() : "";
  if (command === "repair" && (!feedback || feedback.length > 3000)) throw new Error("Supply 1–3000 characters of observed device findings.");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    await page.goto(`${base}/?project=${project.id}`);
    if (command === "repair") {
      await page.getByLabel("What needs fixing?", { exact: true }).fill(feedback);
      await page.screenshot({ path: path.join(directory, `repair-request-${Date.now()}.png`), fullPage: true });
    }
    const response = page.waitForResponse(r => r.url().endsWith("/builds") && r.request().method() === "POST");
    await page.getByRole("button", { name: command === "repair" ? "Repair and rebuild" : "Retry build", exact: true }).click();
    const r = await response, job = await r.json();
    if (!r.ok()) throw new Error(JSON.stringify(job));
    item.buildJobId = job.id; item.status = "ui-repair-running";
    (item.repairs ||= []).push({ jobId: job.id, ...(feedback ? { feedback } : { retry: true }) });
    await save(); console.log(JSON.stringify(job));
  } finally { await browser.close(); }
} else if (command === "watch") {
  let last = "";
  while (true) {
    const latest = await request(`/api/projects/${project.id}/latest-job`);
    project = await request(`/api/projects/${project.id}`);
    const state = { job: latest.job?.id, type: latest.job?.type, status: latest.job?.status, phase: latest.job?.phase, build: project.latestBuild?.status };
    const text = JSON.stringify(state);
    if (text !== last) console.log(JSON.stringify({ time: new Date().toISOString(), ...state }));
    last = text;
    if (latest.job?.status === "failed" || latest.job?.status === "cancelled") { console.log(JSON.stringify(latest.job)); process.exitCode = 1; break; }
    if (latest.job?.status === "succeeded" && !project.activeJobId) break;
    await new Promise(resolve => setTimeout(resolve, 4000));
  }
} else if (command === "confirm") {
  if (project.pendingDecision?.kind !== "high_level_changes" || project.activeJobId) throw new Error("Review the completed proposed feature changes first.");
  await writeFile(path.join(directory, "proposed-outline.json"), JSON.stringify(project.pendingDecision, null, 2));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    await page.goto(`${base}/?project=${project.id}`);
    await expect(page.getByText("Loading your app…", { exact: true })).toBeHidden();
    await page.getByRole("button", { name: "2 Review and customize", exact: true }).click();
    const button = page.getByRole("button", { name: "Apply design changes", exact: true });
    await expect(button).toBeEnabled();
    await page.screenshot({ path: path.join(directory, "review-feature-changes.png"), fullPage: true });
    const response = page.waitForResponse(r => r.url().endsWith("/confirm") && r.request().method() === "POST");
    await button.click(); const r = await response, job = await r.json();
    if (!r.ok()) throw new Error(JSON.stringify(job));
    item.confirmJobId = job.id; item.status = "ui-feature-changes-confirmed"; await save(); console.log(JSON.stringify(job));
  } finally { await browser.close(); }
} else if (command === "approve") {
  if (!project.highLevelDesign || project.activeJobId) throw new Error("Review the completed outline before approving.");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    await page.goto(`${base}/?project=${project.id}`);
    const button = page.getByRole("button", { name: "Approve design and build app", exact: true });
    await expect(button).toBeEnabled();
    await page.screenshot({ path: path.join(directory, "approved-outline.png"), fullPage: true });
    await writeFile(path.join(directory, "approved-outline.json"), JSON.stringify(project.highLevelDesign, null, 2));
    const response = page.waitForResponse(r => r.url().endsWith("/approve-outline") && r.request().method() === "POST");
    await button.click(); const r = await response; const job = await r.json();
    if (!r.ok()) throw new Error(JSON.stringify(job));
    item.detailJobId = job.id; item.status = "preparing-design-and-build"; await save(); console.log(JSON.stringify(job));
  } finally { await browser.close(); }
} else if (command === "provenance") {
  if (!item.buildId || !item.apkSha256) throw new Error("Download the delivered build first.");
  const buildDirectory = path.resolve(".meld-cache/workflow/builds", item.buildId);
  const modelDirectory = path.join(buildDirectory, "model");
  const outputs = (await readdir(modelDirectory)).filter(name => /^implementation-\d+\.json$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const latest = outputs.at(-1);
  if (!latest) throw new Error("The saved model implementation is missing.");
  const implementation = JSON.parse(await readFile(path.join(modelDirectory, latest), "utf8"));
  const expected = new Set(implementation.files.map(file => file.path));
  const actual = [];
  async function walk(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), name);
      else if (entry.name.endsWith(".kt")) actual.push(name);
    }
  }
  await walk(path.join(buildDirectory, "source/app/src"), "app/src");
  if (actual.length !== expected.size || actual.some(name => !expected.has(name))) throw new Error("Compiled Kotlin file set differs from the agent implementation.");
  const files = [];
  for (const file of implementation.files) {
    const content = await readFile(path.join(buildDirectory, "source", file.path), "utf8");
    if (content !== file.content) throw new Error(`Compiled source differs from model output: ${file.path}`);
    files.push({ path: file.path, sha256: createHash("sha256").update(content).digest("hex") });
  }
  const provenance = { buildId: item.buildId, apkSha256: item.apkSha256,
    modelOutput: path.relative(process.cwd(), path.join(modelDirectory, latest)),
    allCompiledKotlinMatchesModelOutput: true, files };
  await writeFile(path.join(directory, "source-provenance.json"), JSON.stringify(provenance, null, 2));
  console.log(JSON.stringify({ case: caseId, buildId: item.buildId, verifiedAgentFiles: files.length }));
} else if (command === "download") {
  const build = project.latestBuild;
  if (build?.status !== "succeeded" || build.revision !== project.currentDesignRevision || project.needsDesign) throw new Error("The current design has no successful build.");
  const artifact = build.artifacts.find(a => a.name.endsWith(".apk"));
  const response = await fetch(base + artifact.url); if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer()); const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== artifact.sha256) throw new Error("Downloaded APK hash does not match the delivered build.");
  await writeFile(path.join(directory, "app.apk"), bytes);
  await writeFile(path.join(directory, "generation-report.json"), JSON.stringify({ projectId: project.id, revision: project.currentDesignRevision, build, apkSha256: sha, runtimeVerified: false }, null, 2));
  item.apkSha256 = sha; item.buildId = build.id; item.status = "built-awaiting-runtime-checks"; await save(); console.log(JSON.stringify({ case: caseId, projectId: item.projectId, buildId: item.buildId, apkSha256: sha, status: item.status }));
} else throw new Error("Unknown command.");
