// Run from repository root with the pipeline tsx loader. Uses real model stages.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ProjectService, CreateProject } from "../../backend/src/projects";
import { projectOptionsFromEnv } from "../../backend/src/api";
import { androidBuildRunner } from "../../backend/src/build";
import { fromScannerReport } from "../../shared/market";

process.loadEnvFile(path.resolve("frontend/.env.local"));
const directory = path.resolve("outputs/budget-example");
await mkdir(directory, { recursive: true });
const options = projectOptionsFromEnv(process.env, path.resolve("frontend"));
options.prepareReferences = false;
options.pipeline.acquireApk = undefined;
const nativeScript = path.resolve("frontend/tests/budget-native.py");
const feedbackIndex = process.argv.indexOf("--feedback");
const feedbackText = feedbackIndex >= 0 ? (await readFile(process.argv[feedbackIndex + 1], "utf8")).trim() : null;
let projectId = await readFile(path.join(directory, "run.json"), "utf8").then(JSON.parse).then(run => run.projectId).catch(() => null);
const service = new ProjectService(options);
if (!projectId) {
  const report = JSON.parse(await readFile(path.join(directory, "selected-reference-report.json"), "utf8"));
  const scan = await options.signals.record(fromScannerReport("Budget & expenses", report));
  const project = await service.create(CreateProject.parse({
    requestKey: `pocket-ledger-${randomUUID()}`,
    brief: {
      name: "Pocket Ledger", style: "warm", domains: ["Budget & expenses"],
      input: "Build a polished offline budget app using Cashew (com.budget.tracker_app) as the sole UI foundation. Preserve its rounded colorful Material surfaces, prominent money totals, category icons, chart-led overview, compact transaction rows, bottom navigation and quick-add flow. References: Money Manager calendar drill-down and Wallet budget breakdown inform implementation. Cashew already has budgets, calendars, scheduled transactions and goals: do not describe those as novel. Add a dedicated purchase sandbox: preview a hypothetical expense's impact on category budget and remaining daily allowance without saving a transaction; explicitly confirm to record it once. Build a working Android demo and make it available in our website.",
      audience: "People who track everyday spending and want to check a purchase before committing.",
      purpose: "A Cashew-inspired local expense tracker with a purchase sandbox that makes budget tradeoffs visible before recording an expense.",
      goal: "Record expenses, review the month and category budgets, then preview a potential purchase before deciding whether to record it.",
      coreTasks: ["Add, edit and delete income or expenses.", "Review spending by date and category.", "Set monthly category budgets.", "Try a purchase without changing the ledger.", "Explicitly record an affordable or over-budget purchase."],
      requiredStates: ["normal", "empty", "error", "delete_confirmation", "unsaved_changes"],
    },
  }));
  projectId = project.id;
  await service.mutate(project.id, p => {
    p.references = { "Budget & expenses": scan }; p.needsResearch = false;
    p.featurePreferences = {
      baseAppId: "com.budget.tracker_app",
      selections: { "com.budget.tracker_app": [], "com.realbyteapps.moneymanagerfree": ["com.realbyteapps.moneymanagerfree:calendar"], "com.droid4you.application.wallet": ["com.droid4you.application.wallet:budget-breakdown"] },
      customRequests: [
        { id: "com.realbyteapps.moneymanagerfree:calendar", name: "Calendar transaction drill-down", description: "Adapt Money Manager's month calendar to browse local transactions by day with visible daily income/expense totals. Cashew already has calendar views; this is a reference for interaction detail, not a unique addition. Use Cashew visual language throughout." },
        { id: "com.droid4you.application.wallet:budget-breakdown", name: "Clear category budget breakdown", description: "Adapt Wallet's clear spent, remaining and over-budget status by category. Cashew already supports category budgets; this is refinement and foundation for purchase preview, not novelty. Show numerical status as well as color." },
        { id: "custom-purchase-sandbox", name: "Try a purchase before recording", description: "A dedicated Try a purchase action accepts title, category and a positive USD amount. Preview current remaining budget versus after-purchase remaining and current versus projected daily allowance for remaining days inclusive in the current month; show the formula and a clear deficit if negative. No preview interaction writes a transaction or changes totals. Cancel leaves ledger unchanged. Record purchase explicitly persists exactly one expense with a durable unique ID, then updates home, budget and date views. Repeated taps/rotation must not duplicate it. Missing category budget prompts setup instead of implying affordability. This is this demo's proposed integrated workflow, not a claim of global market novelty." },
        { id: "custom-local-ledger", name: "Reliable offline ledger and month budgets", description: "Persist all data locally across process restart. Use integer cents and strict decimal parsing (positive amounts, max two decimals, bounded values), never floats for money. Provide amount/title/category/date fields and income/expense type; date picker defaults today and cancellation preserves edits. Expenses count in their saved local calendar month; incomes do not reduce expense budget consumption. Food, Shopping, Transport, Other defaults; editable monthly category limits. Empty initial state, no invented history. Editing/deleting updates every view; delete requires confirmation. Expose accessible control names. Full operation offline, USD only, no bank sync/account login/cloud services." },
        { id: "custom-visual-quality", name: "Cashew-led finished visual design", description: "Use actual base screenshot references: spacious rounded cards, deliberate lavender/pastel color system, chart, icons and typography, small informative transaction rows, floating add button, bottom navigation. Avoid generic identical form-card stacks. Home first viewport must show prominent monthly overview, Try a purchase entry, recent transactions and add button. Keep editor insets/IME correct; support rotation and narrow screens. Purchase preview should be a cohesive purposeful comparison layout, with before/after money amounts. Bundle original simple vector category icons. Plan meaningful JVM tests for ledger arithmetic, month boundaries, invalid amounts, pure preview, duplicate confirm and durable reconstruction." },
      ],
    };
  });
  await writeFile(path.join(directory, "run.json"), JSON.stringify({ projectId, baseAppId: "com.budget.tracker_app", referenceAppIds: scan.apps.map(a => a.appId), createdAt: new Date().toISOString() }, null, 2));
}
options.build = androidBuildRunner({
  sdk: path.resolve("pipeline/tools/android-sdk"), javaHome: process.env.JAVA_HOME || "/usr/lib/jvm/java-21-openjdk-amd64",
  templateDirectory: path.resolve("backend/templates/android"),
  ...(process.argv.includes("--native") ? { nativeSmoke: { projectId, script: nativeScript, adb: path.resolve("pipeline/tools/android-sdk/platform-tools/adb"), serial: "emulator-5580", output: path.join(directory, "device") } } : {}),
});
let last = "";
const timer = setInterval(async () => {
  const p = await service.raw(projectId), j = p.activeJobId ? await service.job(p.activeJobId) : await service.latestJob(p.id);
  if (j && `${j.id}:${j.phase}` !== last) { last = `${j.id}:${j.phase}`; console.log(JSON.stringify({ time: new Date().toISOString(), jobId: j.id, status: j.status, phase: j.phase })); }
}, 5000);
try {
  let p = await service.get(projectId);
  if (!p.highLevelDesign) {
    await service.outline(p.id, { requestKey: randomUUID(), expectedVersion: p.version }); await service.idle();
    p = await service.get(p.id); if (!p.highLevelDesign) throw Error(JSON.stringify(await service.latestJob(p.id)));
  }
  await writeFile(path.join(directory, "approved-outline.json"), JSON.stringify(p.highLevelDesign, null, 2));
  if (process.argv.includes("--outline-only")) { console.log(JSON.stringify({ projectId, outline: p.highLevelDesign.revision })); }
  else {
    if (!p.currentDesignRevision || p.needsDesign) await service.detail(p.id, { requestKey: randomUUID(), expectedVersion: p.version, revision: p.highLevelDesign.revision });
    else if (p.latestBuild?.status !== "succeeded" || process.argv.includes("--native") || feedbackText) await service.build(p.id, { requestKey: randomUUID(), expectedVersion: p.version, revision: p.currentDesignRevision, ...(feedbackText ? { feedback: { buildId: p.latestBuild!.id, description: feedbackText } } : {}) });
    await service.idle();
    p = await service.get(p.id);
    const job = await service.latestJob(p.id);
    await writeFile(path.join(directory, "result.json"), JSON.stringify({ project: p, lastJob: job }, null, 2));
    console.log(JSON.stringify({ projectId, build: p.latestBuild, error: job?.error }));
    if (p.latestBuild?.status !== "succeeded") process.exitCode = 1;
  }
} catch (error) { console.error(error); process.exitCode = 1; }
finally { clearInterval(timer); options.emulator?.close(); }
