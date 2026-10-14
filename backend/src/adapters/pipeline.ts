import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { DesignService, pipelineRoot, z, json, write, exists, fileSha, semanticHash, WorkbenchError, withLock, checkApk, Decisions, validateDecisions } from "../../../pipeline/dist/src/integration.js";
import type { PipelineProgress } from "../../../shared/contracts";
import type { ApkAcquirer } from "../apk-download";
import { featureById } from "../../../shared/catalog";
import { SignalsStore } from "./signals";
import type { MarketApp, MarketResult } from "../../../shared/market";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
export const DesignInput = z.object({
  request_key: identifier,
  scan_ids: z.array(z.string().regex(/^scan-[a-f\d]{64}$/)).min(1).max(8),
  brief: z.object({ name: z.string().trim().min(1).max(60), audience: z.string().max(600), purpose: z.string().max(600), goal: z.string().max(600), style: z.enum(["warm", "sage", "ink"]), coreTasks: z.array(z.string().min(1).max(80)).min(1).max(12).optional(), requiredStates: z.array(z.enum(["normal", "empty", "no_results", "error", "delete_confirmation", "unsaved_changes"])).min(1).max(6).optional() }).strict(),
  preferences: z.array(z.object({ app_id: z.string().regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/), feature_ids: z.array(z.string().min(1).max(240)).max(20) }).strict()).max(40),
  requested_features: z.array(z.string().min(1).max(240)).max(100).default([]),
  feature_requests: z.array(z.object({ id: z.string().min(1).max(240), name: z.string().trim().min(1).max(120), description: z.string().max(1000) }).strict()).max(100).default([]),
}).strict();
export type DesignInputValue = z.infer<typeof DesignInput>;
export type PipelineJob = { id: string; design_id: string; input: DesignInputValue; signature: string;
  status: "queued" | "running" | "waiting_inputs" | "waiting_user" | "succeeded" | "failed"; phase: string;
  created_at: string; updated_at: string; reference_apps: { appId: string; title: string; rank: number }[];
  progress?: PipelineProgress; missing_apps?: string[]; comparison_hash?: string; conflicts?: unknown[]; result?: Awaited<ReturnType<DesignService["get"]>>; error?: { code: string; message: string }; cli_exit_code?: number | null };
export type PipelineRunner = (request: { run: string; brief: string; market: string; config: string; apks: string[]; pauseForDecisions?: boolean }) => Promise<number | null>;
export type PipelineOptions = { directory: string; apkDir?: string; toolRoot?: string; config?: string; runner?: PipelineRunner; pauseForDecisions?: boolean; acquireApk?: ApkAcquirer };

export function processPipelineRunner(toolRoot?: string): PipelineRunner {
  return async input => {
    const output = path.join(path.dirname(input.run), "execution.log");
    const handle = await fs.open(output, "a");
    const command = await exists(path.join(input.run, "run.json")) ? ["resume", "--run", input.run]
      : ["run", "--run", input.run, "--apks", ...input.apks, "--brief", input.brief, "--config", input.config, "--market-input", input.market, ...(input.pauseForDecisions ? ["--pause-for-decisions"] : [])];
    try {
      return await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...command], {
          cwd: pipelineRoot, env: { ...process.env, ...(toolRoot ? { MELD_PIPELINE_TOOL_ROOT: toolRoot } : {}) }, stdio: ["ignore", handle.fd, handle.fd],
        });
        // A server shutdown stops the owned pipeline, not unrelated processes.
        const stop = () => child.kill("SIGTERM");
        process.once("SIGTERM", stop); process.once("SIGINT", stop);
        child.once("error", error => { process.off("SIGTERM", stop); process.off("SIGINT", stop); reject(error); });
        child.once("close", code => { process.off("SIGTERM", stop); process.off("SIGINT", stop); resolve(code); });
      });
    } finally { await handle.close(); }
  };
}
export class PipelineJobs {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly service: DesignService, readonly signals: SignalsStore, readonly options: PipelineOptions) {}
  file(id: string) {
    if (!/^pipeline-[a-f\d-]{36}$/.test(id)) throw new WorkbenchError("invalid_job", "Invalid pipeline job.");
    return path.join(this.options.directory, `${id}.json`);
  }
  async get(id: string): Promise<PipelineJob> {
    try {
      const job: PipelineJob = await json(this.file(id));
      const run = path.join(this.options.directory, id, "analysis");
      if (job.progress && await exists(path.join(run, "run.json"))) {
        const state = await json(path.join(run, "run.json")), locks = await exists(path.join(run, "apps.lock.json")) ? await json(path.join(run, "apps.lock.json")) : [];
        const stages = state.stages || {}, active = state.active_stage;
        job.progress.modelCalls = state.calls?.length || 0;
        for (const app of job.progress.apps) {
          const engine = locks.find((lock: any) => lock.package_name === app.appId), key = engine && `analyze-${engine.id}`;
          app.analysis = key && stages[key] ? "completed" : key && active === key ? (["partial", "blocked", "interrupted"].includes(state.status) ? "failed" : "running") : "pending";
        }
        const analyzed = job.progress.apps.filter(app => app.analysis === "completed").length;
        const analyzing = job.progress.apps.find(app => app.analysis === "running");
        const phase = active === "compare" ? "compare" : ["decide", "design"].includes(active) ? "merge" : "analysis";
        if (!["document", "complete"].includes(job.progress.stage)) job.progress.stage = phase;
        for (const step of job.progress.steps) {
          if (step.id === "analysis") step.status = analyzed === job.progress.apps.length ? "completed" : "running";
          if (step.id === "compare") step.status = stages.compare ? "completed" : active === "compare" ? "running" : "pending";
          if (step.id === "merge") step.status = stages.design ? "completed" : state.status === "waiting_user" ? "waiting" : ["decide", "design"].includes(active) ? "running" : "pending";
        }
        if (job.status === "running" && !["document", "complete"].includes(job.progress.stage)) job.phase = phase === "analysis" ? `Analyzing reference apps (${analyzed}/${job.progress.apps.length} completed)${analyzing ? ` — ${analyzing.title}` : ""}…` : phase === "compare" ? "Comparing reference features and identifying conflicts…" : "Merging your selected features into a detailed design…";
      }
      return job;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkbenchError("not_found", "This design request was not found.", 404); throw error; }
  }
  async recover() {
    await fs.mkdir(this.options.directory, { recursive: true });
    for (const file of await fs.readdir(this.options.directory)) {
      if (!/^pipeline-[a-f\d-]{36}\.json$/.test(file)) continue;
      const job = await this.get(file.slice(0, -5));
      if (!["queued", "running"].includes(job.status)) continue;
      if (await exists(path.join(this.service.store.directory(job.design_id), "manifest.json"))) {
        job.result = await this.service.get(job.design_id); job.status = "succeeded"; job.phase = "Your design is ready.";
      } else { job.status = "failed"; job.error = { code: "interrupted", message: "The design request was interrupted. Your choices are saved; retry to continue." }; }
      job.updated_at = new Date().toISOString(); await write(this.file(job.id), job);
    }
  }
  async submit(input: DesignInputValue) {
    const scans = await Promise.all(input.scan_ids.map(id => this.signals.read(id)));
    if (new Set(input.scan_ids).size !== input.scan_ids.length) throw new WorkbenchError("invalid_input", "Choose each scan only once.");
    const all = new Map<string, MarketApp>();
    for (const scan of scans) for (const app of scan.apps) if (!app.retained && (!all.has(app.appId) || app.score > all.get(app.appId)!.score)) all.set(app.appId, app);
    const preferences = new Map(input.preferences.map(p => [p.app_id, p.feature_ids]));
    if (preferences.size !== input.preferences.length) throw new WorkbenchError("invalid_input", "Choose each reference app only once.");
    const described = new Map(input.feature_requests.map(feature => [feature.id, feature]));
    if (described.size !== input.feature_requests.length) throw new WorkbenchError("invalid_feature", "Describe each requested feature only once.");
    const hasFeature = (id: string, appId?: string) => Object.hasOwn(featureById, id) || (described.has(id) && (!appId || id.startsWith(`${appId}:`)));
    if (input.requested_features.some(id => !hasFeature(id))) throw new WorkbenchError("invalid_feature", "A requested feature is no longer available.");
    for (const preference of input.preferences) {
      if (!all.has(preference.app_id)) throw new WorkbenchError("stale_reference", "A selected app is outside these market results. Refresh your app selection.", 409);
      if (preference.feature_ids.some(id => !hasFeature(id, preference.app_id))) throw new WorkbenchError("invalid_feature", "A selected feature is no longer available.");
    }
    if (preferences.size > 5) throw new WorkbenchError("too_many_references", "Choose features from at most five reference apps.");
    const apps = [...all.values()].sort((a, b) => Number(preferences.has(b.appId)) - Number(preferences.has(a.appId)) || b.score - a.score || a.rank - b.rank || a.appId.localeCompare(b.appId)).slice(0, 5);
    if (!apps.length) throw new WorkbenchError("missing_signals", "Collect reference apps before creating a design.");
    return withLock(path.join(this.options.directory, "submit.lock"), async () => {
      const indexFile = path.join(this.options.directory, "index.json"); const index = await exists(indexFile) ? await json(indexFile) : {};
      const signature = semanticHash(input);
      if (Object.hasOwn(index, input.request_key)) {
        if (index[input.request_key].signature !== signature) throw new WorkbenchError("idempotency_conflict", "This request ID was used for different choices.", 409);
        return this.get(index[input.request_key].id);
      }
      const job: PipelineJob = { id: `pipeline-${randomUUID()}`, design_id: `design-${randomUUID()}`, input, signature,
        status: "queued", phase: "Preparing your reference apps…", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), reference_apps: apps.map(a => ({ appId: a.appId, title: a.title, rank: a.rank })) };
      await write(this.file(job.id), job); await write(path.join(this.options.directory, job.id, "market.json"), { classification: "market_signals", scans, apps, preferences: input.preferences, feature_requests: input.feature_requests, limitations: ["Store metadata is not APK behavior evidence.", "User feature choices and descriptions are preferences, not REA findings."] });
      index[input.request_key] = { signature, id: job.id }; await write(indexFile, index);
      this.enqueue(job, scans, apps); return job;
    }, 1000);
  }
  async resume(id: string) {
    return withLock(path.join(this.options.directory, "resume.lock"), async () => {
      const job = await this.get(id);
      if (!["waiting_inputs", "waiting_user", "failed"].includes(job.status)) return job;
      const market = await json(path.join(this.options.directory, job.id, "market.json"));
      job.status = "queued"; job.phase = "Checking reference files…"; delete job.error; await write(this.file(id), job);
      this.enqueue(job, market.scans, market.apps); return job;
    }, 1000);
  }
  async confirm(id: string, comparisonHash: string, selections: { conflict_id: string; option_id: string }[]) {
    const job = await this.get(id);
    if (job.status !== "waiting_user") throw new WorkbenchError("stale_decision", "These choices are no longer waiting for confirmation.", 409);
    const run = path.join(this.options.directory, id, "analysis"), comparison = await json(path.join(run, "synthesis/comparison.json"));
    if (semanticHash(comparison) !== comparisonHash || comparisonHash !== job.comparison_hash) throw new WorkbenchError("stale_decision", "The reference choices changed. Reload the project.", 409);
    if (selections.length !== comparison.conflicts.length || new Set(selections.map(s => s.conflict_id)).size !== selections.length) throw new WorkbenchError("invalid_decision", "Choose one option for each product decision.", 422);
    const decisions = Decisions.parse({ chosen_by: "user", selections: selections.map(selection => {
      const conflict = comparison.conflicts.find((c: { id: string }) => c.id === selection.conflict_id);
      if (!conflict?.options.some((o: { id: string }) => o.id === selection.option_id)) throw new WorkbenchError("invalid_decision", "Choose an option from the saved product decisions.", 422);
      return { ...selection, reason: "Explicitly selected by the user in the project workspace.", assumptions: [], sources: conflict.sources,
        rejected: conflict.options.filter((o: { id: string }) => o.id !== selection.option_id).map((o: { id: string }) => ({ option_id: o.id, reason: "User selected the other option." })) };
    }), global_consistency: { offline: true, features_within_limit: true, navigation_within_limit: true, compatible: true, explanation: "User choices validated for option dependencies; the resulting design must pass scope and whole-design validation." } });
    const apps = await json(path.join(run, "apps.lock.json"));
    const specs = await Promise.all(apps.map((app: { id: string }) => json(path.join(run, "apps", app.id, "app-spec.json"))));
    const errors = validateDecisions(decisions, comparison, specs); if (errors.length) throw new WorkbenchError("invalid_decision", errors.join("; "), 422);
    const file = path.join(run, "human-decisions.json");
    if (await exists(file) && semanticHash(await json(file)) !== semanticHash(decisions)) throw new WorkbenchError("stale_decision", "Different choices were already recorded.", 409);
    await write(file, decisions); return this.resume(id);
  }
  private enqueue(job: PipelineJob, scans: MarketResult[], apps: MarketApp[]) {
    this.tail = this.tail.then(() => this.run(job, scans, apps)).catch(() => undefined);
  }
  private async run(job: PipelineJob, scans: MarketResult[], apps: MarketApp[]) {
    job.status = "running"; job.phase = "Checking reference files…"; delete job.missing_apps; await write(this.file(job.id), job);
    try {
      const missing: string[] = [], apks: string[] = [], locks: { appId: string; apk_sha256: string }[] = [];
      job.progress = { stage: "download", apps: apps.map(app => ({ appId: app.appId, title: app.title, download: { status: "pending", bytes: 0 }, analysis: "pending" })), steps: [{ id: "download", label: "Download reference APKs", status: "running" }, { id: "analysis", label: "Analyze each app", status: "pending" }, { id: "compare", label: "Compare features", status: "pending" }, { id: "merge", label: "Merge the design", status: "pending" }, { id: "document", label: "Write your design document", status: "pending" }] };
      const persist = async () => { job.updated_at = new Date().toISOString(); await write(this.file(job.id), job); };
      for (const app of apps) {
        const entry = job.progress.apps.find(value => value.appId === app.appId)!;
        const local = this.options.apkDir && path.join(this.options.apkDir, `${app.appId}.apk`), cached = path.join(this.options.directory, job.id, "apks", `${app.appId}.apk`);
        let file = local && await exists(local) ? local : await exists(cached) ? cached : undefined;
        job.phase = `Getting APK ${apks.length + missing.length + 1}/${apps.length} — ${app.title}…`; await persist();
        if (!file && this.options.acquireApk) {
          try { file = await this.options.acquireApk(app.appId, cached, async state => { entry.download = state; await persist(); }); }
          catch (error) { entry.download.status = "failed"; entry.download.message = (error as Error).message; }
        }
        if (!file) { missing.push(app.appId); entry.download.status = "failed"; entry.download.message ||= "No local APK is available and automatic acquisition is not configured."; await persist(); continue; }
        try {
          if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("Reference APK symlinks are not supported.");
          await checkApk(file, path.join(this.options.directory, job.id, `${app.appId}-check.json`));
          const digest = await fileSha(file);
          if (file === cached) { const provenance = await json(`${cached}.provenance.json`); if (provenance.packageId !== app.appId || provenance.sha256 !== digest) throw new Error("Cached APK changed; remove it and retry acquisition."); }
          apks.push(file); locks.push({ appId: app.appId, apk_sha256: digest });
          entry.download = { ...entry.download, status: "completed", bytes: (await fs.stat(file)).size, message: "APK ready for static analysis." }; await persist();
        } catch (error) { missing.push(app.appId); entry.download = { ...entry.download, status: "failed", message: (error as Error).message }; await persist(); }
      }
      if (missing.length) {
        job.status = "waiting_inputs"; job.phase = `APKs ready: ${apks.length}/${apps.length}. ${missing.length} reference download${missing.length === 1 ? "" : "s"} need attention.`; job.missing_apps = missing; job.progress.steps[0].status = "failed"; return;
      }
      delete job.missing_apps;
      job.progress.steps[0].status = "completed"; job.progress.steps[1].status = "running"; job.progress.stage = "analysis"; await persist();
      const directory = path.join(this.options.directory, job.id), run = path.join(directory, "analysis");
      const described = new Map((job.input.feature_requests || []).map(feature => [feature.id, feature]));
      const preferences = [...job.input.requested_features, ...job.input.preferences.flatMap(p => p.feature_ids)].map(id => {
        if (Object.hasOwn(featureById, id)) return featureById[id].name;
        const feature = described.get(id);
        if (!feature) throw new WorkbenchError("invalid_feature", "Refresh your feature choices before resuming.");
        return `${feature.name}: ${feature.description}`;
      });
      const brief = { project_name: job.input.brief.name, target_users: job.input.brief.audience || "Personal use", core_tasks: job.input.brief.coreTasks || ["create", "edit", "save", "find", "reopen"], ...(job.input.brief.requiredStates ? { required_states: job.input.brief.requiredStates } : {}), max_features: 5, max_navigation: 3, offline_only: true,
        implementation: "Android Kotlin / Jetpack Compose", excluded: ["accounts", "cloud sync"],
        scope: `${job.input.brief.purpose || job.input.brief.goal}. User-selected feature preferences: ${[...new Set(preferences)].join(", ")}. Visual preference: ${job.input.brief.style}. Preferences are product requests, not verified source-app behaviors.`,
        market_signals: { scans, selected_package_ids: apps.map(a => a.appId), classification: "market_signals" } };
      const market = await json(path.join(directory, "market.json"));
      for (const app of market.apps) if (app.apk_sha256 && app.apk_sha256 !== locks.find(l => l.appId === app.appId)!.apk_sha256) throw new WorkbenchError("reference_changed", "Reference files changed; create a new design request.", 409);
      market.apps = market.apps.map((app: MarketApp) => ({ ...app, apk_sha256: locks.find(l => l.appId === app.appId)!.apk_sha256 })); await write(path.join(directory, "market.json"), market);
      await write(path.join(directory, "brief.json"), brief); const config = this.options.config || path.join(pipelineRoot, "config/runtime.pipeline.json");
      job.phase = "Analyzing reference apps and combining the design…"; await write(this.file(job.id), job);
      // An interrupted run resumes in-place with the engine's fingerprint checks.
      const runner = this.options.runner || processPipelineRunner(this.options.toolRoot);
      job.cli_exit_code = await runner({ run, apks, brief: path.join(directory, "brief.json"), market: path.join(directory, "market.json"), config, pauseForDecisions: this.options.pauseForDecisions });
      if (!(await exists(path.join(run, "final/final-design.json"))) && await exists(path.join(run, "synthesis/comparison.json")) && this.options.pauseForDecisions) {
        const state = await json(path.join(run, "run.json"));
        if (state.status === "waiting_user") {
          const comparison = await json(path.join(run, "synthesis/comparison.json"));
          job.status = "waiting_user"; job.phase = "Choose how your app should work."; job.conflicts = comparison.conflicts; job.comparison_hash = semanticHash(comparison); return;
        }
      }
      if (!(await exists(path.join(run, "final/final-design.json")))) throw new WorkbenchError("analysis_failed", "Reference analysis did not finish. Your choices and diagnostics are saved.", 502);
      const review = await json(path.join(run, "synthesis/design-review.json"));
      if (!review.passed || review.issues.some((issue: { severity: string }) => issue.severity === "blocking")) throw new WorkbenchError("analysis_failed", "The detailed design did not pass its review.", 422);
      const actualPackages = (await json(path.join(run, "apps.lock.json"))).map((app: { package_name: string }) => app.package_name);
      if (actualPackages.length !== apps.length || apps.some(a => !actualPackages.includes(a.appId))) throw new WorkbenchError("wrong_references", "Analyzed apps do not match this market request.", 422);
      job.progress.stage = "document"; job.progress.apps.forEach(app => { app.analysis = "completed"; }); job.progress.steps.forEach(step => { step.status = step.id === "document" ? "running" : "completed"; }); job.phase = "Writing a clear, readable design…"; await write(this.file(job.id), job);
      job.result = await this.service.initialize(job.design_id, run, await json(config));
      await write(path.join(this.service.store.directory(job.design_id), "market-handoff.json"), market);
      job.status = "succeeded"; job.phase = "Your design is ready."; job.progress.stage = "complete"; job.progress.steps.forEach(step => { step.status = "completed"; }); delete job.missing_apps;
    } catch (error) {
      try { const latest = await this.get(job.id); job.progress = latest.progress; job.phase = latest.phase; } catch { /* Preserve the last available checkpoint when diagnostics cannot be read. */ }
      job.status = "failed"; job.error = { code: (error as WorkbenchError).code || "pipeline_error", message: (error as Error).message };
      if (job.progress) { const step = job.progress.steps.find(step => step.id === job.progress!.stage); if (step) step.status = "failed"; }
    } finally { job.updated_at = new Date().toISOString(); await write(this.file(job.id), job); }
  }
  async idle() { await this.tail; }
}
