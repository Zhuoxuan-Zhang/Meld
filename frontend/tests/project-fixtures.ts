import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { DesignService, pipelineRoot, write, json, fileSha, exists } from "../../pipeline/dist/src/integration.js";
import { ProjectService } from "../../backend/src/projects";
import { projectsMiddleware } from "../../backend/src/api";
import { SignalsStore } from "../../backend/src/adapters/signals";
import { FixtureModel, sourceFixture, fixtureData } from "../../pipeline/tests/fixtures/workbench";
import { scannerReport } from "./market-data";
import { fromScannerReport } from "../../shared/market";
import type { ProjectOptions, BuildRunner } from "../../backend/src/projects";
import type { HighLevelRunner } from "../../backend/src/high-level";
import type { ApkAcquirer } from "../../backend/src/apk-download";
import type { ApiHost } from "../../backend/src/http";

export const idea = { name: "Pocket Notes", input: "An offline notebook for capturing and finding ideas.", audience: "People keeping personal notes", purpose: "Capture and find ideas offline", goal: "Keep ideas close", style: "sage", domains: ["Productivity"] };
export class ProjectModel extends FixtureModel {
  constructor() {
    super(); this.plan.changes[0].title = "Rename the writing feature"; this.plan.changes[0].before = "Write notes"; this.plan.changes[0].after = "Capture ideas"; this.plan.changes[0].operations[0].value_json = JSON.stringify("Capture ideas");
    this.plan.changes[1].title = "Use a green accent"; this.plan.changes[1].before = "Blue"; this.plan.changes[1].after = "Green";
  }
  async ask<T>(...args: Parameters<FixtureModel["ask"]>): Promise<T> {
    const result: any = await super.ask(...args);
    if (args[0] === "workbench-explain") { result.language = "en"; result.summary = "A personal notebook that keeps ideas offline."; result.audience = "People keeping personal notes"; result.appearance = "A clean notebook with the approved accent color."; result.boundaries = ["Offline personal use"]; for (const f of result.features) { f.summary = "Capture a note and keep it on your phone."; f.steps = ["Open a note", "Write and save"]; } }
    if (result.disposition === "clarification") { result.response = "Please choose what you would like to change."; result.questions = [{ id: "question-style", question: "Which part?", options: ["Color", "Features"] }]; }
    if (result.disposition === "no_change") result.response = "This request does not change the app design.";
    return result as T;
  }
}
export async function notebookFixture(dir: string) {
  const data = await sourceFixture(dir); data.design.title = "Pocket Notes"; data.design.features[0].title = "Write notes"; await write(path.join(dir, "final/final-design.json"), data.design); return data;
}
export async function projectServer({ apks = true, buildFailure = false, listedFeatures = false, acquireApk, analysisFailure = false, highLevel, prepareReferences = false }: { apks?: boolean; buildFailure?: boolean; listedFeatures?: boolean; acquireApk?: ApkAcquirer; analysisFailure?: boolean; highLevel?: HighLevelRunner; prepareReferences?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "meld-project-test-")), model = new ProjectModel(), designs = new DesignService(pipelineRoot, path.join(root, "designs"), model), signals = new SignalsStore(path.join(root, "signals"));
  await notebookFixture(path.join(root, "example")); await designs.initialize("notes", path.join(root, "example"), {});
  const apkDir = path.join(root, "apks"); if (apks) {
    await mkdir(apkDir); for (const app of fromScannerReport("Productivity", scannerReport("Productivity")).apps) zipApk(path.join(apkDir, `${app.appId}.apk`));
  }
  let analysisCalls = 0, buildCalls = 0;
  const build: BuildRunner = async input => {
    buildCalls++; if (buildFailure) throw new Error("Synthetic build failure");
    const dir = path.join(input.directory, "artifacts"); await mkdir(dir, { recursive: true }); zipApk(path.join(dir, "app.apk"));
    const metadata = [{ name: "app.apk", url: `/api/projects/${input.project.id}/builds/${path.basename(input.directory)}/artifacts/app.apk`, sha256: await fileSha(path.join(dir, "app.apk")) }];
    await write(path.join(input.directory, "artifacts.json"), metadata);
    return { artifacts: metadata, validation: { build: true, unitTests: true, lint: true, runtimeVerified: false, limitations: ["Synthetic worker fixture, not Android compilation or runtime evidence."] } };
  };
  const options: ProjectOptions = { directory: path.join(root, "workflow"), designs, signals, exampleId: "notes", build, highLevel, prepareReferences,
    research: async brief => {
      const scan = fromScannerReport("Productivity", scannerReport("Productivity"));
      if (listedFeatures) for (const app of scan.apps) app.listedFeatures = { items: [{ name: "Quick notes", detail: "Capture ideas quickly." }, { name: "Find notes", detail: "Find an existing note." }, { name: "Organize notes", detail: "Keep related notes together." }], model: "synthetic-fixture", template: "fixture", generatedAt: scan.generatedAt };
      return { brief, references: [scan] };
    },
    pipeline: { directory: path.join(root, "pipeline"), apkDir, acquireApk, runner: async task => {
      analysisCalls++; const market = await json(task.market);
      if (analysisFailure && task.basis !== "market") { await write(path.join(task.run, "run.json"), { status: "partial", stages: {}, calls: [], error: "Synthetic incomplete static analysis" }); return 1; }
       const locked = market.apps.map((a: any, i: number) => ({ id: `app${i + 1}`, package_name: a.appId, sha256: a.apk_sha256 }));
      if (task.pauseForDecisions === false && !(await exists(path.join(task.run, "apps.lock.json")))) {
        await notebookFixture(task.run); await write(path.join(task.run, "apps.lock.json"), locked);
        for (const app of locked) await write(path.join(task.run, "apps", app.id, "app-spec.json"), { app_id: app.id, package_name: app.package_name, features: [] });
      }
      if (task.pauseForDecisions !== false && !(await exists(path.join(task.run, "human-decisions.json")))) {
        await notebookFixture(task.run); await write(path.join(task.run, "apps.lock.json"), locked);
        for (const app of locked) await write(path.join(task.run, "apps", app.id, "app-spec.json"), { app_id: app.id, package_name: app.package_name, features: [] });
        await rm(path.join(task.run, "final"), { recursive: true }); await write(path.join(task.run, "run.json"), { status: "waiting_user", human_decisions: true }); return 0;
      }
      const data = fixtureData(); data.design.title = "Pocket Notes"; data.design.features[0].title = "Write notes";
      const decisions = task.pauseForDecisions === false ? fixtureData().decisions : await json(path.join(task.run, "human-decisions.json")); data.design.decisions = decisions.selections.map((s: any) => s.option_id);
      await write(path.join(task.run, "synthesis/decisions.json"), decisions); await write(path.join(task.run, "final/final-design.json"), data.design);
      await write(path.join(task.run, "synthesis/design-review.json"), { passed: true, issues: [], limitations: ["Synthetic downstream fixture"] }); return 0;
    } } };
  const service = new ProjectService(options), middleware = projectsMiddleware(service, async () => ({ researchAvailable: true, designAvailable: true, buildAvailable: true }));
  const server = createServer((request, response) => { void middleware(request, response, () => { response.writeHead(404); response.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { root, address, model, designs, service, options, counts: () => ({ analysisCalls, buildCalls }), close: async () => { await service.idle(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}
export function zipApk(file: string) { execFileSync("python3", ["-c", "import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('AndroidManifest.xml','synthetic');z.writestr('classes.dex','synthetic')", file]); }
export type ProjectTestServer = Awaited<ReturnType<typeof projectServer>>;
