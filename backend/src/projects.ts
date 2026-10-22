import { readBaseUiEvidence } from "./base-ui";
import type { BaseUiResolver } from "./base-ui";
import { currentWorker, workerIsAlive, type WorkerOwner } from "./worker";
import { assessFit } from "../../frontend/src/feasibility";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { DesignService, z, json, write, exists, withLock, semanticHash, fileSha, WorkbenchError, ChangeRequest, ApplyRequest, RestoreRequest } from "../../pipeline/dist/src/integration.js";
import type { BrowserEmulator } from "./emulator";
import { PipelineJobs, DesignInput } from "./adapters/pipeline";
import type { PipelineOptions } from "./adapters/pipeline";
import { SignalsStore } from "./adapters/signals";
import { buildCatalog } from "../../shared/market";
import type { MarketResult } from "../../shared/market";
import { HighLevelDocument } from "./high-level";
import type { HighLevelRunner } from "./high-level";
import type { Project, Job, Brief, ChangeProposal, Build, Conflict } from "../../shared/contracts";

const key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
export const BriefInput = z.object({ name: z.string().max(60).default(""), input: z.string().trim().min(1).max(6000), audience: z.string().max(600).default(""), purpose: z.string().max(600).default(""), goal: z.string().max(600).default(""), style: z.enum(["warm", "sage", "ink"]).default("warm"), domains: z.array(z.string().trim().min(1).max(48)).max(8).default([]), coreTasks: z.array(z.string().trim().min(1).max(80)).min(1).max(12).optional(), requiredStates: z.array(z.enum(["normal", "empty", "no_results", "error", "delete_confirmation", "unsaved_changes"])).min(1).max(6).optional() }).strict();
export const CreateProject = z.object({ requestKey: key, brief: BriefInput, exampleId: key.optional() }).strict();
export const FeaturePreferences = z.object({ baseAppId: z.string().min(1).max(240).optional(), selections: z.record(z.string().min(1).max(240), z.array(z.string().min(1).max(240)).max(20)), customRequests: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,239}$/), name: z.string().trim().min(1).max(120), description: z.string().max(1000) }).strict()).max(20) }).strict();
export const PatchProject = z.object({ expectedVersion: z.number().int().positive(), brief: BriefInput.optional(), featurePreferences: FeaturePreferences.optional() }).strict();
export const Action = z.object({ requestKey: key, expectedVersion: z.number().int().positive() }).strict();
export const ChangeAction = Action.extend({ baseRevision: key, text: z.string().max(6000).default(""), edits: ChangeRequest.shape.edits });
export const ConfirmAction = Action.extend({ baseRevision: key.optional(), selectedChangeIds: z.array(key).max(8).optional(), selections: z.array(z.object({ conflict_id: z.string().min(1).max(96), option_id: z.string().min(1).max(96) }).strict()).max(30).optional() });
export const RestoreAction = Action.extend({ baseRevision: key, targetRevision: key });
export const OutlinePatch = z.object({ expectedVersion: z.number().int().positive(), baseRevision: key, document: HighLevelDocument }).strict();
export const BuildAction = Action.extend({ revision: key, feedback: z.object({ buildId: key, description: z.string().trim().min(1).max(3000) }).strict().optional() });
type StoredJob = Job & { worker?: WorkerOwner; projectVersion: number; request: Record<string, unknown>; signature: string; pipelineJobId?: string };
export type ResearchRunner = (brief: Brief, directory: string, progress: (phase: string) => Promise<void>) => Promise<{ brief: Brief; references: MarketResult[] }>;
export type BuildRunner = (input: { project: Project; revision: string; design: unknown; designHash: string; directory: string; progress: (phase: string) => Promise<void> }) => Promise<Omit<Build, "id" | "revision" | "designHash" | "status">>;
export type ProjectOptions = { directory: string; designs: DesignService; signals: SignalsStore; pipeline: PipelineOptions; research: ResearchRunner; highLevel?: HighLevelRunner; baseUi?: BaseUiResolver; prepareReferences?: boolean; emulator?: BrowserEmulator; build?: BuildRunner; exampleId?: string; featuredProjectId?: string; featuredProjectIds?: string[]; explainConflicts?: (conflicts: Conflict[], brief: Brief, directory: string) => Promise<Conflict[]> };
const publicProposal = (proposal: Awaited<ReturnType<DesignService["createProposal"]>>): ChangeProposal => ({ id: proposal.id, base_revision: proposal.base_revision, request_text: proposal.request_text, plan: { ...proposal.plan, changes: proposal.plan.changes.map(({ operations: _operations, ...change }) => change) } });
const publicDesign = (view: Awaited<ReturnType<DesignService["get"]>>, projectId: string) => ({ ...view, artifacts: view.artifacts.map(artifact => ({ ...artifact, url: `/api/projects/${projectId}/artifacts/${view.revision}/${encodeURIComponent(artifact.name)}` })) });

export class ProjectService {
  pipeline: PipelineJobs;
  private tasks = new Set<Promise<unknown>>();
  constructor(readonly options: ProjectOptions) { this.pipeline = new PipelineJobs(options.designs, options.signals, { ...options.pipeline, pauseForDecisions: true }); }
  projectFile(id: string) {
    if (!/^project-[a-f\d-]{36}$/.test(id)) throw new WorkbenchError("invalid_project", "Invalid project ID.");
    return path.join(this.options.directory, "projects", `${id}.json`);
  }
  jobFile(id: string) {
    if (!/^job-[a-f\d-]{36}$/.test(id)) throw new WorkbenchError("invalid_job", "Invalid job ID.");
    return path.join(this.options.directory, "jobs", `${id}.json`);
  }
  async raw(id: string): Promise<Project> {
    try { return await json(this.projectFile(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkbenchError("not_found", "This project was not found.", 404); throw error; }
  }
  async get(id: string): Promise<Project> {
    const project = await this.raw(id);
    if (project.referencePreparationId) {
      const preparation = await this.pipeline.get(project.referencePreparationId);
      project.referencePreparation = { id: preparation.id, status: preparation.status, phase: preparation.phase, progress: preparation.progress };
    }
    if (project.designId && project.currentDesignRevision) project.design = publicDesign(await this.options.designs.get(project.designId, project.currentDesignRevision), id);
    if (project.design && project.latestBuild?.status === "succeeded" && project.latestBuild.revision === project.currentDesignRevision && !project.needsDesign) {
      project.design.implementation = { status: "in_sync", revision: project.currentDesignRevision, app_name: project.brief.name };
    }
    return project;
  }
  async revisionOwner(project: Project, revision: string) {
    for (const id of [...new Set([project.designId, ...(project.designHistory || []).map(item => item.designId)].filter((id): id is string => Boolean(id)))]) {
      if ((await this.options.designs.revisions(id)).some(record => record.id === revision)) return id;
    }
    throw new WorkbenchError("not_found", "This design version does not belong to the project.", 404);
  }
  async revisions(id: string) {
    const project = await this.raw(id), ids = [...new Set([project.designId, ...(project.designHistory || []).map(item => item.designId)].filter((id): id is string => Boolean(id)))];
    return (await Promise.all(ids.map(async designId => (await this.options.designs.revisions(designId)).map(record => ({ ...record, designId }))))).flat().sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  async featuredExample(id = this.options.featuredProjectId) {
    if (!id) return null;
    try {
      const project = await this.raw(id), build = project.latestBuild;
      if (project.needsDesign || build?.status !== "succeeded" || build.revision !== project.currentDesignRevision || !build.validation?.build || !build.validation.unitTests || !build.validation.lint) return null;
      const apk = build.artifacts.find(artifact => artifact.name === "app.apk");
      if (!apk || !await exists(path.join(this.options.directory, "builds", build.id, "artifacts", "app.apk"))) return null;
      const base = Object.values(project.references).flatMap(scan => scan.apps).find(app => app.appId === project.featurePreferences.baseAppId);
      return { id: project.id, name: project.brief.name, summary: project.brief.purpose || project.brief.input, baseAppName: base?.title || null };
    } catch { return null; }
  }
  async featuredExamples() {
    const ids = [...new Set([this.options.featuredProjectId, ...(this.options.featuredProjectIds || [])].filter((id): id is string => Boolean(id)))].slice(0, 8);
    const examples = await Promise.all(ids.map(id => this.featuredExample(id)));
    return examples.filter((example): example is NonNullable<typeof example> => example !== null);
  }
  async list() {
    const dir = path.join(this.options.directory, "projects"); await fs.mkdir(dir, { recursive: true });
    return (await Promise.all((await fs.readdir(dir)).filter(n => /^project-[a-f\d-]{36}\.json$/.test(n)).map(n => this.raw(n.slice(0, -5))))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(p => ({ id: p.id, name: p.brief.name || "Your app", input: p.brief.input, updatedAt: p.updatedAt }));
  }
  async mutate(id: string, work: (project: Project) => void | Promise<void>, expectedVersion?: number) {
    return withLock(`${this.projectFile(id)}.lock`, async () => {
      const project = await this.raw(id);
      if (expectedVersion !== undefined && project.version !== expectedVersion) throw new WorkbenchError("stale_project", "This project changed. Reload it before continuing.", 409);
      await work(project); project.updatedAt = new Date().toISOString(); await write(this.projectFile(id), project); return project;
    }, 2000);
  }
  async snapshotProfile(project: Project) {
    if (!project.currentDesignRevision) return;
    const file = path.join(this.options.directory, "profiles", project.id, `${project.currentDesignRevision}.json`);
    if (!(await exists(file))) await write(file, { brief: project.brief, references: project.references, featurePreferences: project.featurePreferences, baseUiReference: project.baseUiReference, needsResearch: project.needsResearch });
  }
  async create(input: z.infer<typeof CreateProject>) {
    const indexFile = path.join(this.options.directory, "create-index.json");
    return withLock(`${indexFile}.lock`, async () => {
      const signature = semanticHash(input), index = await exists(indexFile) ? await json(indexFile) : {};
      if (index[input.requestKey]) { if (index[input.requestKey].signature !== signature) throw new WorkbenchError("idempotency_conflict", "This request key was used for another project.", 409); return this.get(index[input.requestKey].id); }
      const time = new Date().toISOString(), id = `project-${randomUUID()}`;
      const project: Project = { id, version: 1, createdAt: time, updatedAt: time, brief: input.brief, references: {}, featurePreferences: { selections: {}, customRequests: [] }, designId: null, currentDesignRevision: null, approvedRevision: null, pendingDecision: null, activeJobId: null, latestBuild: null, needsResearch: true, needsDesign: true };
      if (input.exampleId) {
        if (input.exampleId !== this.options.exampleId) throw new WorkbenchError("invalid_example", "Choose an available example.");
        const original = await this.options.designs.store.revision(input.exampleId); await this.options.designs.store.source(input.exampleId);
        const designId = `design-${randomUUID()}`, dir = this.options.designs.store.directory(designId);
        await fs.mkdir(dir, { recursive: true });
        await fs.cp(path.join(this.options.designs.store.directory(input.exampleId), "source"), path.join(dir, "source"), { recursive: true });
        await fs.cp(path.join(this.options.designs.store.directory(input.exampleId), "revisions"), path.join(dir, "revisions"), { recursive: true });
        await fs.copyFile(path.join(this.options.designs.store.directory(input.exampleId), "settings.json"), path.join(dir, "settings.json"));
        await write(path.join(dir, "manifest.json"), { ...original.manifest, id: designId, receipts: {} });
        await write(path.join(dir, "project-owner.json"), { projectId: id });
        project.designId = designId; project.currentDesignRevision = original.record.id; project.needsResearch = false; project.needsDesign = false;
        project.brief = { ...project.brief, name: original.document.title.slice(0, 60), purpose: original.document.summary.slice(0, 600), audience: original.document.audience.slice(0, 600) };
        await write(path.join(dir, "example-origin.json"), { sourceDesignId: input.exampleId, sourceRevision: original.record.id, classification: "Imported example; separate from fresh market research" });
      }
      await this.snapshotProfile(project); await write(this.projectFile(id), project); index[input.requestKey] = { id, signature }; await write(indexFile, index); return this.get(id);
    }, 2000);
  }
  async patch(id: string, input: z.infer<typeof PatchProject>) {
    await this.mutate(id, async project => {
      if (project.activeJobId) {
        const active = await this.storedJob(project.activeJobId);
        if (["queued", "running"].includes(active.status)) throw new WorkbenchError("busy", "Wait for the current step before changing your app profile.", 409);
        active.status = "failed"; active.error = { code: "stale_project", message: "The app profile changed; start a new task." }; await this.saveJob(active);
      }
      if (input.featurePreferences) {
        const catalog = buildCatalog(project.brief.domains, project.references, {});
        const apps = new Map(catalog.map(app => [app.id, app]));
        if (input.featurePreferences.baseAppId && input.featurePreferences.baseAppId !== project.featurePreferences.baseAppId && !catalog.some(app => app.id === input.featurePreferences!.baseAppId && app.market && !app.market.retained && assessFit(app.market, app.domain).level !== "complex")) throw new WorkbenchError("invalid_base_app", "Choose an eligible base app from your current references.", 422);
        for (const [appId, ids] of Object.entries(input.featurePreferences.selections)) if (!apps.has(appId) || ids.some(id => !apps.get(appId)!.features.some(f => f.id === id) && !input.featurePreferences!.customRequests.some(f => f.id === id && id.startsWith(`${appId}:`)))) throw new WorkbenchError("invalid_feature", "Choose features from this project's reference apps.", 422);
        if (Object.values(input.featurePreferences.selections).flat().length > 100 || new Set(input.featurePreferences.customRequests.map(f => f.id)).size !== input.featurePreferences.customRequests.length) throw new WorkbenchError("invalid_feature", "Keep feature choices unique and within the project limit.", 422);
        if (project.featurePreferences.baseAppId !== input.featurePreferences.baseAppId) delete project.baseUiReference;
        project.featurePreferences = input.featurePreferences; delete project.highLevelDesign; delete project.highLevelFeedback;
      }
      if (input.brief) {
        if (semanticHash(project.brief.domains) !== semanticHash(input.brief.domains) || project.brief.input !== input.brief.input) { project.needsResearch = true; project.references = {}; delete project.baseUiReference; delete project.referencePreparationId; delete project.referencePreparation; project.featurePreferences.selections = {}; delete project.featurePreferences.baseAppId; }
        project.brief = input.brief; delete project.highLevelDesign; delete project.highLevelFeedback;
      }
      project.version++; project.needsDesign = true; project.approvedRevision = null; project.pendingDecision = null; project.activeJobId = null;
    }, input.expectedVersion); return this.get(id);
  }
  async storedJob(id: string): Promise<StoredJob> {
    try { return await json(this.jobFile(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkbenchError("not_found", "This task was not found.", 404); throw error; }
  }
  async saveJob(job: StoredJob) { job.updatedAt = new Date().toISOString(); await write(this.jobFile(job.id), job); }
  async job(id: string): Promise<Job> { const stored = await this.storedJob(id); if (stored.pipelineJobId && !["succeeded", "failed"].includes(stored.status)) { const current = await this.pipeline.get(stored.pipelineJobId); stored.progress = current.progress; stored.phase = current.phase; } const { request: _request, signature: _signature, projectVersion: _version, pipelineJobId: _pipeline, internalJobId: _internal, worker: _worker, ...job } = stored; let resumable = false; if (stored.status === "failed" && stored.pipelineJobId) { const project = await this.raw(stored.projectId); resumable = ["detail", "design"].includes(stored.type) && !project.activeJobId && project.lastJobId === id && project.version === stored.projectVersion + 1; } return { ...job, resumable }; }
  launch(work: () => Promise<void>) { const task = Promise.resolve().then(work); this.tasks.add(task); void task.finally(() => this.tasks.delete(task)).catch(() => undefined); }
  async idle() { while (this.tasks.size) await Promise.allSettled([...this.tasks]); await this.pipeline.idle(); }
  async start(id: string, type: Job["type"], input: z.infer<typeof Action> & Record<string, unknown>, work: (job: StoredJob) => Promise<void>) {
    const file = path.join(this.options.directory, "job-index.json");
    return withLock(`${file}.lock`, async () => {
      const index = await exists(file) ? await json(file) : {}, indexKey = `${id}:${input.requestKey}`, signature = semanticHash({ type, input });
      if (index[indexKey]) { if (index[indexKey].signature !== signature) throw new WorkbenchError("idempotency_conflict", "This request key was used for different choices.", 409); return this.job(index[indexKey].id); }
      const now = new Date().toISOString(), job: StoredJob = { id: `job-${randomUUID()}`, projectId: id, type, status: "queued", phase: "Preparing your app…", createdAt: now, updatedAt: now, projectVersion: 0, worker: currentWorker(), request: input, signature };
      await this.mutate(id, async project => {
        if (project.activeJobId) { const active = await this.storedJob(project.activeJobId); if (["queued", "running", "waiting_inputs", "waiting_user"].includes(active.status)) throw new WorkbenchError("busy", "Finish or resume the current step before starting another.", 409); }
        project.version++; project.activeJobId = job.id; project.lastJobId = job.id; job.projectVersion = project.version; await this.saveJob(job);
      }, input.expectedVersion);
      index[indexKey] = { id: job.id, signature }; await write(file, index);
      this.launch(() => this.run(job, work)); return this.job(job.id);
    }, 2000);
  }
  async progress(job: StoredJob, phase: string) {
    const project = await this.raw(job.projectId);
    if (project.activeJobId !== job.id || project.version !== job.projectVersion) throw new WorkbenchError("stale_project", "This task was replaced or interrupted. Continue from the current project step.", 409);
    job.phase = phase; await this.saveJob(job);
  }
  async publish(job: StoredJob, work: (project: Project) => void | Promise<void>) {
    return this.mutate(job.projectId, async project => {
      if (project.version !== job.projectVersion || project.activeJobId !== job.id) throw new WorkbenchError("stale_project", "The project changed while this task was running.", 409);
      await work(project);
    });
  }
  async finish(job: StoredJob, work: (project: Project) => void | Promise<void>) {
    await this.publish(job, async project => { await work(project); await this.snapshotProfile(project); project.activeJobId = null; project.version++; });
    job.status = "succeeded"; job.phase = "Ready."; await this.saveJob(job);
  }
  async run(job: StoredJob, work: (job: StoredJob) => Promise<void>) {
    job.worker = currentWorker(); job.status = "running"; await this.saveJob(job);
    try { await work(job); }
    catch (error) {
      job.status = "failed"; job.error = { code: (error as WorkbenchError).code || "task_failed", message: (error as Error).message }; await this.saveJob(job);
      await this.mutate(job.projectId, project => { if (project.activeJobId === job.id) { project.activeJobId = null; project.version++; if (project.latestBuild?.id === job.id) project.latestBuild.status = "failed"; } }).catch(() => undefined);
    }
  }
  research(id: string, input: z.infer<typeof Action>) {
    return this.start(id, "research", input, async job => {
      const project = await this.raw(id);
      const result = await this.options.research(project.brief, path.join(this.options.directory, "runs", job.id), phase => this.progress(job, phase));
      const references: Record<string, MarketResult> = {};
      for (const scan of result.references) references[scan.domain] = await this.options.signals.record(scan);
      if (!Object.values(references).some(scan => scan.apps.length)) throw new WorkbenchError("no_references", "No reference apps matched. Try a broader description.", 422);
      await this.finish(job, async p => {
        delete p.baseUiReference; p.brief = result.brief; p.references = references; p.needsResearch = false; p.needsDesign = true; p.approvedRevision = null; p.pendingDecision = null; p.featurePreferences.selections = {}; delete p.featurePreferences.baseAppId; delete p.referencePreparationId; delete p.referencePreparation;
        if (this.options.prepareReferences) await this.prepareReferencesFor(p);
      });
    });
  }
  async prepareReferencesFor(project: Project) {
    if (project.referencePreparationId) return;
    const scans = Object.values(project.references).map(scan => scan.scanId);
    const preparation = await this.pipeline.submit(DesignInput.parse({ request_key: `references-${project.id}-${semanticHash(scans).slice(0, 12)}`, scan_ids: scans, brief: { name: "Reference research", audience: "Source-app analysis", purpose: "Inspect representative local behavior from the reference listings. Do not design a new application.", goal: "Collect static reference evidence", style: "warm", coreTasks: ["reference_behavior"] }, preferences: [], requested_features: [], feature_requests: [] }), { referenceOnly: true });
    project.referencePreparationId = preparation.id;
  }
  async prepareReferences(id: string) {
    if (!this.options.prepareReferences) throw new WorkbenchError("preparation_unavailable", "Background reference preparation is disabled.", 503);
    await this.mutate(id, async project => {
      if (project.needsResearch || !Object.values(project.references).some(scan => scan.apps.length)) throw new WorkbenchError("research_required", "Collect reference apps first.", 409);
      await this.prepareReferencesFor(project);
    });
    return this.get(id);
  }
  async saveOutline(project: Project, document: unknown, baseUiMapping?: import("../../pipeline/dist/src/integration.js").BaseUiMappingT) {
    const parsed = HighLevelDocument.parse(document), version = (project.highLevelVersion || project.highLevelDesign?.version || 0) + 1;
    const outline = { revision: `hl-v${String(version).padStart(4, "0")}-${semanticHash(parsed).slice(0, 12)}`, version, document: parsed, ...(baseUiMapping ? { baseUiMapping } : {}), ...(project.baseUiReference ? { baseUiReference: project.baseUiReference } : {}), createdAt: new Date().toISOString() };
    await write(path.join(this.options.directory, "high-level", project.id, outline.revision, "document.json"), outline);
    project.brief.name = parsed.title; project.brief.audience = parsed.audience; project.brief.purpose = parsed.summary; project.highLevelVersion = version; project.highLevelDesign = outline; project.needsDesign = true; project.pendingDecision = null; project.approvedRevision = null;
    return outline;
  }
  async patchOutline(id: string, input: z.infer<typeof OutlinePatch>) {
    await this.mutate(id, async project => {
      if (project.activeJobId) throw new WorkbenchError("busy", "Wait for the current task before editing the design.", 409);
      if (project.highLevelDesign?.revision !== input.baseRevision || project.needsResearch) throw new WorkbenchError("stale_revision", "Edit the current high-level design.", 409);
      await this.saveOutline(project, input.document); delete project.highLevelFeedback; project.version++;
    }, input.expectedVersion); return this.get(id);
  }
  outline(id: string, input: z.infer<typeof Action>) {
    return this.start(id, "design", input, async job => {
      const project = await this.raw(id);
      if (project.needsResearch || !this.options.highLevel) throw new WorkbenchError("research_required", "Review reference features before generating your design.", 422);
      await this.progress(job, "Writing your high-level design…");
      const started = Date.now();
      const baseUi = await this.options.baseUi?.(project, phase => this.progress(job, phase));
      if (baseUi) { project.baseUiReference = baseUi.reference; await this.publish(job, p => { p.baseUiReference = baseUi.reference; }); }
      await this.progress(job, "Writing your high-level design…");
      const result = await this.options.highLevel(project, path.join(this.options.directory, "runs", job.id), undefined, baseUi);
      if (!result.document) throw new WorkbenchError("design_incomplete", result.response, 422);
      job.result = { elapsedMs: Date.now() - started, stage: "high_level" };
      await this.finish(job, async project => { await this.saveOutline(project, result.document, result.baseUiMapping); project.highLevelFeedback = result.response; });
    });
  }
  detail(id: string, input: z.infer<typeof BuildAction>) {
    return this.start(id, "detail", input, async job => {
      const project = await this.raw(id);
      if (project.needsResearch || project.pendingDecision || project.highLevelDesign?.revision !== input.revision) throw new WorkbenchError("stale_revision", "Approve the current saved high-level design.", 409);
      await this.publish(job, project => { project.highLevelDesign!.approvedRevision = input.revision; });
      await this.submitPipeline(job, { revision: input.revision, document: project.highLevelDesign!.document });
    });
  }
  design(id: string, input: z.infer<typeof Action>) {
    if (this.options.highLevel) return this.outline(id, input);
    return this.start(id, "design", input, job => this.submitPipeline(job));
  }
  async submitPipeline(job: StoredJob, approvedOutline?: { revision: string; document: unknown }) {
      const project = await this.raw(job.projectId);
      if (project.needsResearch) throw new WorkbenchError("research_required", "Explore reference ideas before generating a design.", 422);
      const catalog = buildCatalog(project.brief.domains, project.references, project.featurePreferences.selections);
      const chosen = catalog.flatMap(app => app.features.filter(f => project.featurePreferences.selections[app.id]?.includes(f.id))).map(({ id, name, description }) => ({ id, name, description }));
      const approved = approvedOutline ? HighLevelDocument.parse(approvedOutline.document) : null;
      const approvedFeatures = approved?.features.map(feature => ({ id: feature.id, name: feature.title, description: feature.summary })) || [];
      const featureRequests = [...new Map([...chosen, ...project.featurePreferences.customRequests, ...approvedFeatures].map(feature => [feature.id, feature])).values()];
      const pipeline = await this.pipeline.submit(DesignInput.parse({ request_key: job.id, scan_ids: Object.values(project.references).map(scan => scan.scanId), brief: { name: project.brief.name || "My app", audience: project.brief.audience, purpose: project.brief.purpose || project.brief.input.slice(0, 600), goal: project.brief.goal, style: project.brief.style, coreTasks: project.brief.coreTasks, requiredStates: project.brief.requiredStates },
        base_app_id: project.featurePreferences.baseAppId, preferences: Object.entries(project.featurePreferences.selections).filter(([, ids]) => ids.length).map(([app_id, feature_ids]) => ({ app_id, feature_ids })), requested_features: (approved ? approvedFeatures : featureRequests).map(f => f.id), feature_requests: featureRequests, ...(approvedOutline ? { approved_outline: approvedOutline } : {}) }), { ...(project.referencePreparationId ? { referenceJobId: project.referencePreparationId } : {}), ...(project.highLevelDesign?.baseUiReference ? { baseUi: await readBaseUiEvidence(this.options.directory, project.id, project.highLevelDesign.baseUiReference.id) } : {}) });
      job.pipelineJobId = pipeline.id; await this.saveJob(job); await this.watchPipeline(job);
  }
  async watchPipeline(job: StoredJob) {
    while (true) {
      const pipeline = await this.pipeline.get(job.pipelineJobId!); job.status = pipeline.status; job.phase = pipeline.phase; job.progress = pipeline.progress; job.missingInputs = pipeline.missing_apps;
      if (pipeline.status === "failed") throw new WorkbenchError(pipeline.error?.code || "analysis_failed", pipeline.error?.message || "The reference analysis did not finish.", 502);
      if (pipeline.status === "waiting_user") {
        let conflicts = pipeline.conflicts as Conflict[];
        if (this.options.explainConflicts) {
          job.status = "running"; await this.progress(job, "Explaining the choices that shape your app…");
          try { conflicts = await this.options.explainConflicts(conflicts, (await this.raw(job.projectId)).brief, path.join(this.options.directory, "runs", job.id)); } catch { /* Saved source choices remain available when their readable projection fails. */ }
        }
        await this.publish(job, project => { project.pendingDecision = { id: `decision-${job.id}`, kind: "merge_choices", jobId: job.id, comparisonHash: pipeline.comparison_hash!, conflicts }; });
        job.status = "waiting_user";
      }
      if (pipeline.status === "succeeded") {
        await write(path.join(this.options.designs.store.directory(pipeline.design_id), "project-owner.json"), { projectId: job.projectId });
        await this.finish(job, project => {
          if (project.designId && project.currentDesignRevision) project.designHistory = [...(project.designHistory || []), { designId: project.designId, revision: project.currentDesignRevision }];
          project.designId = pipeline.design_id; project.currentDesignRevision = pipeline.result!.revision; project.needsDesign = false; project.approvedRevision = null; project.pendingDecision = null;
          if (job.type === "detail" && project.highLevelDesign && project.highLevelDesign.approvedRevision === job.request.revision) project.highLevelDesign.developerRevision = pipeline.result!.revision;
          project.brief.name = pipeline.result!.document.title.slice(0, 60); project.brief.audience = pipeline.result!.document.audience.slice(0, 600); project.brief.purpose = pipeline.result!.document.summary.slice(0, 600);
        });
        if (job.type === "detail") { const saved = await this.raw(job.projectId); await this.build(saved.id, { requestKey: `${job.id}-build`, expectedVersion: saved.version, revision: saved.currentDesignRevision! }); }
        return;
      }
      await this.saveJob(job);
      if (["waiting_inputs", "waiting_user"].includes(pipeline.status)) return;
      await new Promise(resolve => setTimeout(resolve, 600));
    }
  }
  async latestJob(projectId: string): Promise<Job | null> {
    await this.raw(projectId);
    const directory = path.join(this.options.directory, "jobs");
    if (!await exists(directory)) return null;
    const jobs = await Promise.all((await fs.readdir(directory)).filter(name => /^job-[a-f\d-]{36}\.json$/.test(name)).map(name => this.storedJob(name.slice(0, -5))));
    const latest = jobs.filter(job => job.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return latest ? this.job(latest.id) : null;
  }
  async resume(id: string) {
    const job = await this.storedJob(id), project = await this.raw(job.projectId);
    if (job.status === "failed" && job.pipelineJobId && ["detail", "design"].includes(job.type)) {
      if (project.activeJobId || project.lastJobId !== id || project.version !== job.projectVersion + 1 || job.type === "detail" && (project.highLevelDesign?.revision !== job.request.revision || project.highLevelDesign?.approvedRevision !== job.request.revision)) throw new WorkbenchError("stale_project", "The app profile or approved design changed. Start a new task.", 409);
      return this.start(job.projectId, job.type, { ...job.request, requestKey: `${job.id}-resume-${project.version}`, expectedVersion: project.version }, async retry => {
        retry.pipelineJobId = job.pipelineJobId; await this.saveJob(retry);
        await this.pipeline.resume(job.pipelineJobId!); await this.watchPipeline(retry);
      });
    }
    if (project.version !== job.projectVersion || project.activeJobId !== id) throw new WorkbenchError("stale_project", "The app profile changed. Start a new task.", 409);
    if (job.status !== "waiting_inputs" || !job.pipelineJobId) throw new WorkbenchError("invalid_resume", "This task is not waiting for reference files.", 409);
    await this.pipeline.resume(job.pipelineJobId); job.status = "queued"; await this.saveJob(job); this.launch(() => this.run(job, j => this.watchPipeline(j))); return this.job(id);
  }
  async confirm(id: string, decisionId: string, input: z.infer<typeof ConfirmAction>) {
    const project = await this.raw(id), decision = project.pendingDecision;
    if (!decision || decision.id !== decisionId) {
      const indexFile = path.join(this.options.directory, "job-index.json"), index = await exists(indexFile) ? await json(indexFile) : {};
      const receipt = index[`${id}:${input.requestKey}`]; if (receipt && receipt.signature === semanticHash({ type: "confirm", input: { ...input, decisionId } })) return this.job(receipt.id);
      throw new WorkbenchError("stale_decision", "This decision is no longer pending. Reload your app.", 409);
    }
    if (decision.kind === "high_level_changes") {
      return this.start(id, "confirm", { ...input, decisionId }, async job => {
        await this.finish(job, async project => { if (project.highLevelDesign?.revision !== decision.baseRevision || input.baseRevision !== decision.baseRevision) throw new WorkbenchError("stale_revision", "Review changes for the current design.", 409); await this.saveOutline(project, decision.document, decision.baseUiMapping); project.highLevelFeedback = decision.response; });
      });
    }
    if (decision.kind === "merge_choices") {
      const file = path.join(this.options.directory, "job-index.json");
      return withLock(`${file}.lock`, async () => {
        const index = await exists(file) ? await json(file) : {}, indexKey = `${id}:${input.requestKey}`, signature = semanticHash({ type: "confirm", input: { ...input, decisionId } });
        if (index[indexKey]) { if (index[indexKey].signature !== signature) throw new WorkbenchError("idempotency_conflict", "This request key was used for other choices.", 409); return this.job(index[indexKey].id); }
        const current = await this.raw(id);
        if (current.version !== input.expectedVersion || current.pendingDecision?.id !== decisionId) throw new WorkbenchError("stale_project", "Reload your app before confirming.", 409);
        const job = await this.storedJob(decision.jobId);
        await this.pipeline.confirm(job.pipelineJobId!, decision.comparisonHash, input.selections || []);
        index[indexKey] = { id: job.id, signature }; await write(file, index);
        await this.publish(job, p => { p.pendingDecision = null; }); job.status = "queued"; await this.saveJob(job); this.launch(() => this.run(job, j => this.watchPipeline(j))); return this.job(job.id);
      }, 2000);
    }
    // A proposal awaiting confirmation is not an active model job.
    return this.start(id, "confirm", { ...input, decisionId }, async job => {
      const p = await this.raw(id);
      const applied = await this.options.designs.apply(p.designId!, decision.proposal.id, ApplyRequest.parse({ base_revision: input.baseRevision, idempotency_key: input.requestKey, selected_change_ids: input.selectedChangeIds }));
      await this.finish(job, p => { p.currentDesignRevision = applied.revision; p.pendingDecision = null; p.approvedRevision = null; p.needsDesign = false; p.brief.name = applied.document.title.slice(0, 60); p.brief.audience = applied.document.audience.slice(0, 600); p.brief.purpose = applied.document.summary.slice(0, 600); });
    });
  }
  change(id: string, input: z.infer<typeof ChangeAction>) {
    return this.start(id, "change", input, async job => {
      const project = await this.raw(id);
      if (project.highLevelDesign && this.options.highLevel) {
        if (project.highLevelDesign.revision !== input.baseRevision) throw new WorkbenchError("stale_revision", "Use the current high-level design.", 409);
        await this.progress(job, "Previewing your design changes…");
        const result = await this.options.highLevel(project, path.join(this.options.directory, "runs", job.id), { text: input.text, document: project.highLevelDesign.document }, project.highLevelDesign.baseUiReference ? await readBaseUiEvidence(this.options.directory, project.id, project.highLevelDesign.baseUiReference.id) : undefined);
        const document = result.document ? HighLevelDocument.parse(result.document) : null;
        await this.finish(job, project => { project.highLevelFeedback = result.response; project.pendingDecision = document ? { id: `outline-${job.id}`, kind: "high_level_changes", baseUiMapping: result.baseUiMapping, baseRevision: input.baseRevision, document, response: result.response } : null; }); return;
      }
      if (!project.designId || project.needsDesign) throw new WorkbenchError("design_required", "Generate a design matching the app profile before requesting changes.", 422);
      const proposal = await this.options.designs.createProposal(project.designId, ChangeRequest.parse({ base_revision: input.baseRevision, idempotency_key: input.requestKey, text: input.text, edits: input.edits }), job.id);
      await this.finish(job, p => { p.pendingDecision = { id: proposal.id, kind: "design_changes", proposal: publicProposal(proposal) }; });
    });
  }
  async dismiss(id: string, expectedVersion: number) {
    await this.mutate(id, p => { if (!["design_changes", "high_level_changes"].includes(p.pendingDecision?.kind || "")) throw new WorkbenchError("invalid_decision", "Resolve the initial product choices to continue.", 409); p.pendingDecision = null; p.version++; }, expectedVersion); return this.get(id);
  }
  restore(id: string, input: z.infer<typeof RestoreAction>) {
    return this.start(id, "restore", input, async job => { const project = await this.raw(id); if (!project.designId) throw new WorkbenchError("design_required", "Create a design first.", 422);
      if (input.baseRevision !== project.currentDesignRevision) throw new WorkbenchError("stale_revision", "Restore from your current design revision.", 409);
      const owner = await this.revisionOwner(project, input.targetRevision), current = await this.options.designs.get(owner);
      job.request.designOwner = owner; await this.saveJob(job);
      const restored = await this.options.designs.restore(owner, RestoreRequest.parse({ base_revision: current.revision, target_revision: input.targetRevision, idempotency_key: input.requestKey }));
      const snapshotFile = path.join(this.options.directory, "profiles", id, `${input.targetRevision}.json`), snapshot = await exists(snapshotFile) ? await json(snapshotFile) : null;
      await this.finish(job, p => { if (p.designId !== owner && p.designId && p.currentDesignRevision) p.designHistory = [...(p.designHistory || []), { designId: p.designId, revision: p.currentDesignRevision }]; p.designId = owner; p.currentDesignRevision = restored.revision; p.pendingDecision = null; p.approvedRevision = null; p.needsDesign = false; if (snapshot) { p.brief = snapshot.brief; p.references = snapshot.references; p.featurePreferences = snapshot.featurePreferences; p.baseUiReference = snapshot.baseUiReference; p.needsResearch = snapshot.needsResearch; } p.brief.name = restored.document.title.slice(0, 60); p.brief.audience = restored.document.audience.slice(0, 600); p.brief.purpose = restored.document.summary.slice(0, 600); }); });
  }
  async buildInput(id: string, revision?: string) {
    const project = await this.raw(id); if (!project.designId || project.needsDesign) throw new WorkbenchError("design_required", "Generate the design for your current app profile first.", 422);
    const target = revision || project.currentDesignRevision!, owner = await this.revisionOwner(project, target);
    const saved = await this.options.designs.store.revision(owner, target);
    return { projectId: id, revision: saved.record.id, designHash: saved.record.semantic_hash, developer_design: saved.data.design, brief: saved.data.brief, decisions: saved.data.decisions };
  }
  build(id: string, input: z.infer<typeof BuildAction>) {
    return this.start(id, "build", input, async job => {
      const project = await this.raw(id);
      if (project.pendingDecision || input.revision !== project.currentDesignRevision) throw new WorkbenchError("unapproved_revision", "Confirm pending changes and build the current design.", 409);
      const buildInput = await this.buildInput(id, input.revision);
      const directory = path.join(this.options.directory, "builds", job.id);
      await write(path.join(directory, "input.json"), { ...buildInput, projectProfile: project.brief });
      if (input.feedback) {
        const delivered = project.latestBuild?.status === "succeeded" ? project.latestBuild : project.lastDeliveredBuild;
        if (!delivered || delivered.id !== input.feedback.buildId || delivered.revision !== input.revision || delivered.designHash !== buildInput.designHash) throw new WorkbenchError("stale_build", "Report a problem with the app built from your current design. Reload the project before continuing.", 409);
        const owner = await this.storedJob(delivered.id);
        if (owner.projectId !== id || owner.type !== "build" || owner.status !== "succeeded") throw new WorkbenchError("stale_build", "This app build is not available for repair.", 409);
        const artifact = delivered.artifacts.find(item => item.name.endsWith(".apk"));
        if (!artifact || path.basename(artifact.name) !== artifact.name) throw new WorkbenchError("artifact_missing", "The app download is unavailable. Build the app again.", 409);
        const previousDirectory = path.join(this.options.directory, "builds", delivered.id), apk = path.join(previousDirectory, "artifacts", artifact.name);
        if ((await fs.lstat(apk)).isSymbolicLink() || await fileSha(apk) !== artifact.sha256) throw new WorkbenchError("artifact_changed", "The app download changed. Build the app again before requesting a repair.", 409);
        const findings = { apkSha256: artifact.sha256, issues: [input.feedback.description] };
        await write(path.join(previousDirectory, "runtime-findings.json"), findings);
        await write(path.join(directory, "user-feedback.json"), { sourceBuildId: delivered.id, ...findings });
      }
      await this.publish(job, p => { p.approvedRevision = input.revision; p.latestBuild = { id: job.id, revision: input.revision, designHash: buildInput.designHash, status: "running", artifacts: [] }; });
      if (!this.options.build) throw new WorkbenchError("build_unavailable", "The Android build environment is not configured.", 503);
      const result = await this.options.build({ project, revision: input.revision, design: buildInput, designHash: buildInput.designHash, directory, progress: phase => this.progress(job, phase) });
      await this.finish(job, p => { p.latestBuild = { ...result, id: job.id, revision: input.revision, designHash: buildInput.designHash, status: "succeeded" }; p.lastDeliveredBuild = p.latestBuild; });
    });
  }
  async recover() {
    await this.pipeline.recover();
    for (const saved of await this.list()) {
      const project = await this.raw(saved.id);
      for (const owner of new Set([project.designId, ...(project.designHistory || []).map(item => item.designId)])) {
        if (owner) await write(path.join(this.options.designs.store.directory(owner), "project-owner.json"), { projectId: project.id });
      }
    }
    const dir = path.join(this.options.directory, "jobs"); await fs.mkdir(dir, { recursive: true });
    for (const name of await fs.readdir(dir)) {
      if (!/^job-[a-f\d-]{36}\.json$/.test(name)) continue; const job = await this.storedJob(name.slice(0, -5));
      if (!["running", "queued"].includes(job.status) || workerIsAlive(job.worker)) continue;
      if (job.pipelineJobId) { this.launch(() => this.run(job, j => this.watchPipeline(j))); continue; }
      // Reconcile an already-published project before marking an unfinished task failed.
      const project = await this.raw(job.projectId);
      if (project.activeJobId !== job.id && project.version > job.projectVersion) { job.status = "succeeded"; job.phase = "Ready."; await this.saveJob(job); continue; }
      if (project.designId && ["confirm", "restore"].includes(job.type)) {
        const owner = String(job.request.designOwner || project.designId), manifest = await this.options.designs.store.manifest(owner), receipt = manifest.receipts[String(job.request.requestKey)];
        if (receipt) {
          const view = await this.options.designs.get(owner, receipt.revision);
          const snapshotFile = path.join(this.options.directory, "profiles", project.id, `${job.request.targetRevision}.json`);
          const snapshot = job.type === "restore" && await exists(snapshotFile) ? await json(snapshotFile) : null;
          await this.finish(job, p => {
            if (p.designId !== owner && p.designId && p.currentDesignRevision) p.designHistory = [...(p.designHistory || []), { designId: p.designId, revision: p.currentDesignRevision }];
            p.designId = owner; p.currentDesignRevision = view.revision; p.pendingDecision = null; p.approvedRevision = null; p.needsDesign = false;
            if (snapshot) { p.brief = snapshot.brief; p.references = snapshot.references; p.featurePreferences = snapshot.featurePreferences; p.baseUiReference = snapshot.baseUiReference; p.needsResearch = snapshot.needsResearch; }
            p.brief.name = view.document.title.slice(0, 60); p.brief.audience = view.document.audience.slice(0, 600); p.brief.purpose = view.document.summary.slice(0, 600);
          }); continue;
        }
      }
      if (project.designId && job.type === "change") {
        const dir = path.join(this.options.designs.store.directory(project.designId), "proposals");
        let found: Awaited<ReturnType<DesignService["createProposal"]>> | null = null;
        if (await exists(dir)) for (const name of await fs.readdir(dir)) if (/^change-[a-f\d-]{36}\.json$/.test(name)) { const proposal = await json(path.join(dir, name)); if (proposal.source_job_id === job.id) found = await this.options.designs.proposal(project.designId, proposal.id); }
        if (found) { const proposal = found; await this.finish(job, p => { p.pendingDecision = { id: proposal.id, kind: "design_changes", proposal: publicProposal(proposal) }; }); continue; }
      }
      job.status = "failed"; job.error = { code: "interrupted", message: "This task was interrupted. Saved research and design revisions are preserved; retry the step." }; await this.saveJob(job);
      await this.mutate(job.projectId, p => { if (p.activeJobId === job.id) { p.activeJobId = null; p.version++; if (p.latestBuild?.id === job.id) p.latestBuild.status = "failed"; } });
    }
  }
}
