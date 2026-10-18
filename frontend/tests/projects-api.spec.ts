import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { write, json, semanticHash, fileSha } from "../../pipeline/dist/src/integration.js";
import { ProjectService } from "../../backend/src/projects";
import { projectServer, idea, zipApk } from "./project-fixtures";
import type { ProjectTestServer } from "./project-fixtures";
import type { Project, Job } from "../../shared/contracts";

async function call<T>(api: ProjectTestServer, suffix: string, body?: unknown, method = body ? "POST" : "GET"): Promise<T> {
  const response = await fetch(api.address + suffix, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`); return response.json() as Promise<T>;
}
async function wait(api: ProjectTestServer, job: Job) { await expect.poll(async () => (await call<Job>(api, `/api/jobs/${job.id}`)).status, { timeout: 15000 }).not.toMatch(/^(queued|running)$/); return call<Job>(api, `/api/jobs/${job.id}`); }
const action = (p: Project) => ({ requestKey: randomUUID(), expectedVersion: p.version });
async function create(api: ProjectTestServer, example = false) { return call<Project>(api, "/api/projects", { requestKey: randomUUID(), brief: idea, ...(example ? { exampleId: "notes" } : {}) }); }
async function research(api: ProjectTestServer, p: Project) { await wait(api, await call<Job>(api, `/api/projects/${p.id}/research`, action(p))); return call<Project>(api, `/api/projects/${p.id}`); }
test("server-owned profiles persist, reject stale updates and deduplicate retries", async () => {
  const api = await projectServer();
  try {
    const body = { requestKey: randomUUID(), brief: idea }, p = await call<Project>(api, "/api/projects", body);
    expect((await call<Project>(api, "/api/projects", body)).id).toBe(p.id);
    const duplicate = await fetch(api.address + "/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, brief: { ...idea, name: "Other" } }) }); expect(duplicate.status).toBe(409);
    const updated = await call<Project>(api, `/api/projects/${p.id}`, { expectedVersion: p.version, brief: { ...idea, name: "Updated" } }, "PATCH"); expect(updated.version).toBe(p.version + 1);
    const stale = await fetch(api.address + `/api/projects/${p.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: p.version, brief: idea }) }); expect(stale.status).toBe(409);
    const reloaded = new ProjectService(api.options); expect((await reloaded.get(p.id)).brief.name).toBe("Updated");
  } finally { await api.close(); }
});
test("missing APKs preserve all Top 5 market references and continue to a proposed design", async () => {
  const api = await projectServer({ apks: false });
  try {
    const p = await research(api, await create(api)); expect(p.references.Productivity.apps).toHaveLength(5); expect(p.references.Productivity.scanId).toMatch(/^scan-/);
    const body = action(p), submitted = await call<Job>(api, `/api/projects/${p.id}/design`, body), waiting = await wait(api, submitted);
    expect(waiting.status).toBe("waiting_user"); expect(waiting.missingInputs).toBeUndefined();
    expect(waiting.progress!.apps.every(app => app.analysis === "skipped")).toBe(true);
    expect((await call<Job>(api, `/api/projects/${p.id}/design`, body)).id).toBe(submitted.id);
    expect((await call<Project>(api, `/api/projects/${p.id}`)).designId).toBeNull(); expect(api.counts().analysisCalls).toBe(1);
    const saved = await call<Project>(api, `/api/projects/${p.id}`); if (saved.pendingDecision?.kind !== "merge_choices") throw new Error("Missing product choice");
    await wait(api, await call<Job>(api, `/api/projects/${p.id}/decisions/${saved.pendingDecision.id}/confirm`, { ...action(saved), selections: [{ conflict_id: "choice-save", option_id: "option-save-explicit" }] }));
    expect((await call<Project>(api, `/api/projects/${p.id}`)).design).toBeDefined(); expect((await call<Project>(api, `/api/projects/${p.id}`)).latestBuild).toBeNull();
  } finally { await api.close(); }
});
test("initial conflicts require explicit valid user choices before a design exists", async () => {
  const api = await projectServer();
  try {
    let p = await research(api, await create(api)); const waiting = await wait(api, await call<Job>(api, `/api/projects/${p.id}/design`, action(p)));
    expect(waiting.status).toBe("waiting_user"); p = await call<Project>(api, `/api/projects/${p.id}`); expect(p.designId).toBeNull(); expect(p.pendingDecision?.kind).toBe("merge_choices");
    if (p.pendingDecision?.kind !== "merge_choices") throw new Error("Missing conflicts");
    const decision = p.pendingDecision, route = `/api/projects/${p.id}/decisions/${decision.id}/confirm`;
    const invalid = await fetch(api.address + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...action(p), selections: [{ conflict_id: "choice-save", option_id: "unknown" }] }) }); expect(invalid.status).toBe(422);
    const body = { ...action(p), selections: [{ conflict_id: "choice-save", option_id: "option-save-explicit" }] }, resumed = await call<Job>(api, route, body);
    expect((await wait(api, resumed)).status).toBe("succeeded"); expect((await call<Job>(api, route, body)).id).toBe(resumed.id);
    p = await call<Project>(api, `/api/projects/${p.id}`); const input: any = await call(api, `/api/projects/${p.id}/build-input`);
    expect(p.needsDesign).toBe(false); expect(input.decisions.chosen_by).toBe("user"); expect(input.developer_design.decisions).toEqual(["option-save-explicit"]);
    expect(api.counts().analysisCalls).toBe(2);
  } finally { await api.close(); }
});
test("failed analysis resumes the same checkpoint and rejects changed profiles", async () => {
  const api = await projectServer();
  try {
    const runner = api.service.pipeline.options.runner!;
    api.service.pipeline.options.runner = async () => { throw new Error("Temporary analysis failure"); };
    let p = await research(api, await create(api));
    const failed = await wait(api, await call<Job>(api, `/api/projects/${p.id}/design`, action(p)));
    expect(failed.status).toBe("failed"); expect(failed.resumable).toBe(true);
    const checkpoint = (await api.service.storedJob(failed.id)).pipelineJobId;
    api.service.pipeline.options.runner = runner;
    const resumed = await wait(api, await call<Job>(api, `/api/jobs/${failed.id}/resume`, {}));
    expect(resumed.status).toBe("waiting_user"); expect(resumed.id).not.toBe(failed.id); expect((await api.service.storedJob(failed.id)).status).toBe("failed");
    expect((await api.service.storedJob(resumed.id)).pipelineJobId).toBe(checkpoint);
    api.service.pipeline.options.runner = async () => { throw new Error("Temporary analysis failure"); };
    p = await research(api, await create(api));
    const stale = await wait(api, await call<Job>(api, `/api/projects/${p.id}/design`, action(p)));
    p = await call<Project>(api, `/api/projects/${p.id}`);
    await call(api, `/api/projects/${p.id}`, { expectedVersion: p.version, brief: { ...idea, input: "A different scope" } }, "PATCH");
    expect((await call<Job>(api, `/api/jobs/${stale.id}`)).resumable).toBe(false);
    expect((await fetch(api.address + `/api/jobs/${stale.id}/resume`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(409);
  } finally { await api.close(); }
});
test("a failed generator cannot publish an older valid design file", async () => {
  const api = await projectServer();
  try {
    const runner = api.service.pipeline.options.runner!;
    api.service.pipeline.options.runner = async task => { await runner({ ...task, pauseForDecisions: false }); return 1; };
    const p = await research(api, await create(api));
    const job = await wait(api, await call<Job>(api, `/api/projects/${p.id}/design`, action(p)));
    expect(job.status).toBe("failed"); expect(job.error?.message).toContain("another repair pass");
    expect((await call<Project>(api, `/api/projects/${p.id}`)).designId).toBeNull();
  } finally { await api.close(); }
});
test("changes are public proposals, selected confirmation preserves the source and supports restore", async () => {
  const api = await projectServer();
  try {
    let p = await create(api, true); const original = p.currentDesignRevision!; const source = await api.designs.get("notes");
    await wait(api, await call<Job>(api, `/api/projects/${p.id}/changes`, { ...action(p), baseRevision: original, text: "change", edits: [] }));
    p = await call<Project>(api, `/api/projects/${p.id}`); expect(p.currentDesignRevision).toBe(original);
    if (p.pendingDecision?.kind !== "design_changes") throw new Error("Missing proposal");
    expect(JSON.stringify(p.pendingDecision)).not.toContain('"operations"');
    const body = { ...action(p), baseRevision: original, selectedChangeIds: ["change-color"] }, route = `/api/projects/${p.id}/decisions/${p.pendingDecision.id}/confirm`;
    const confirmed = await call<Job>(api, route, body); await wait(api, confirmed); expect((await call<Job>(api, route, body)).id).toBe(confirmed.id);
    p = await call<Project>(api, `/api/projects/${p.id}`); const input: any = await call(api, `/api/projects/${p.id}/build-input`);
    expect(input.developer_design.visual.colors[0].value).toBe("#246B4A"); expect(input.developer_design.features[0].title).toBe("Write notes"); expect((await api.designs.get("notes")).revision).toBe(source.revision);
    await wait(api, await call<Job>(api, `/api/projects/${p.id}/restore`, { ...action(p), baseRevision: p.currentDesignRevision, targetRevision: original }));
    p = await call<Project>(api, `/api/projects/${p.id}`); expect(p.currentDesignRevision).not.toBe(original); expect((await api.service.buildInput(p.id)).developer_design.visual.colors[0].value).toBe("#315DA8");
  } finally { await api.close(); }
});
test("clarification and unrelated input preserve revisions; profile changes prevent stale builds", async () => {
  const api = await projectServer();
  try {
    let p = await create(api, true); const revision = p.currentDesignRevision;
    for (const text of ["vague", "unrelated"]) {
      await wait(api, await call<Job>(api, `/api/projects/${p.id}/changes`, { ...action(p), baseRevision: revision, text, edits: [] })); p = await call<Project>(api, `/api/projects/${p.id}`);
      expect(p.pendingDecision?.kind).toBe("design_changes"); expect(p.currentDesignRevision).toBe(revision);
      p = await call<Project>(api, `/api/projects/${p.id}/decisions/${p.pendingDecision!.id}/dismiss`, { expectedVersion: p.version });
    }
    p = await call<Project>(api, `/api/projects/${p.id}`, { expectedVersion: p.version, brief: { ...idea, input: "A different app idea" } }, "PATCH");
    const build = await wait(api, await call<Job>(api, `/api/projects/${p.id}/builds`, { ...action(p), revision })); expect(build.status).toBe("failed"); expect(api.counts().buildCalls).toBe(0);
  } finally { await api.close(); }
});
test("builds use an exact approved revision and downloads verify ownership and hashes (synthetic worker)", async () => {
  const api = await projectServer();
  try {
    let p = await create(api, true); const body = { ...action(p), revision: p.currentDesignRevision }, build = await call<Job>(api, `/api/projects/${p.id}/builds`, body);
    expect((await wait(api, build)).status).toBe("succeeded"); expect((await call<Job>(api, `/api/projects/${p.id}/builds`, body)).id).toBe(build.id);
    p = await call<Project>(api, `/api/projects/${p.id}`); expect(p.approvedRevision).toBe(p.currentDesignRevision); expect(p.latestBuild?.designHash).toBe((await api.service.buildInput(p.id)).designHash);
    const artifact = p.latestBuild!.artifacts[0], response = await fetch(api.address + artifact.url); expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("android.package");
    const other = await create(api, true); expect((await fetch(api.address + artifact.url.replace(p.id, other.id))).status).toBe(404);
    api.options.build = async () => { throw new Error("fixture retry failure"); };
    const retry = await wait(api, await call<Job>(api, `/api/projects/${p.id}/builds`, { ...action(p), revision: p.currentDesignRevision })); expect(retry.status).toBe("failed");
    const retried = await api.service.get(p.id); expect(retried.lastDeliveredBuild?.id).toBe(build.id); expect(retried.lastDeliveredBuild?.status).toBe("succeeded");
    await write(path.join(api.root, "workflow/builds", build.id, "artifacts/app.apk"), "changed"); expect((await fetch(api.address + artifact.url)).status).toBe(409);
    const saved = await json(path.join(api.root, "workflow/builds", build.id, "input.json")); expect(saved.revision).toBe(p.currentDesignRevision); expect(semanticHash(saved.developer_design)).toBe(p.latestBuild!.designHash);
  } finally { await api.close(); }
});
test("failed builds preserve approved designs and committed revisions reconcile after interruption", async () => {
  const api = await projectServer({ buildFailure: true });
  try {
    let p = await create(api, true); const build = await wait(api, await call<Job>(api, `/api/projects/${p.id}/builds`, { ...action(p), revision: p.currentDesignRevision })); expect(build.status).toBe("failed");
    p = await call<Project>(api, `/api/projects/${p.id}`); expect(p.latestBuild?.status).toBe("failed"); expect(p.currentDesignRevision).toBe(p.approvedRevision);
    const proposal = await api.designs.createProposal(p.designId!, { base_revision: p.currentDesignRevision!, idempotency_key: randomUUID(), text: "change", edits: [] });
    const requestKey = randomUUID(), jobId = `job-${randomUUID()}`, applied = await api.designs.apply(p.designId!, proposal.id, { base_revision: p.currentDesignRevision!, idempotency_key: requestKey, selected_change_ids: ["change-color"] });
    await api.service.mutate(p.id, project => { project.version++; project.activeJobId = jobId; }); p = await api.service.raw(p.id);
    await write(api.service.jobFile(jobId), { id: jobId, projectId: p.id, projectVersion: p.version, type: "confirm", status: "running", phase: "confirm", createdAt: "", updatedAt: "", request: { requestKey }, signature: "fixture" });
    await new ProjectService(api.options).recover(); p = await api.service.get(p.id); expect(p.currentDesignRevision).toBe(applied.revision); expect(p.activeJobId).toBeNull(); expect((await api.service.job(jobId)).status).toBe("succeeded");
    const interruptedId = `job-${randomUUID()}`;
    await api.service.mutate(p.id, project => { project.version++; project.activeJobId = interruptedId; project.latestBuild = { id: interruptedId, revision: project.currentDesignRevision!, designHash: "fixture", status: "running", artifacts: [] }; });
    p = await api.service.raw(p.id);
    await write(api.service.jobFile(interruptedId), { id: interruptedId, projectId: p.id, projectVersion: p.version, type: "build", status: "running", phase: "build", createdAt: "", updatedAt: "", request: { requestKey: randomUUID() }, signature: "fixture" });
    await new ProjectService(api.options).recover(); p = await api.service.get(p.id);
    expect(p.latestBuild?.status).toBe("failed"); expect(p.activeJobId).toBeNull(); expect((await api.service.job(interruptedId)).error?.code).toBe("interrupted");
    const stale = await api.service.storedJob(interruptedId);
    await expect(api.service.progress({ ...stale, status: "running" }, "Late old worker update")).rejects.toThrow("replaced or interrupted");
    expect((await api.service.job(interruptedId)).error?.code).toBe("interrupted");
  } finally { await api.close(); }
});

test("UI repair feedback is bound to the delivered app and retries preserve the approved design", async () => {
  const api = await projectServer();
  try {
    let p = await create(api, true);
    const initial = await wait(api, await call<Job>(api, `/api/projects/${p.id}/builds`, { ...action(p), revision: p.currentDesignRevision }));
    p = await api.service.get(p.id);
    const revision = p.currentDesignRevision, preferences = p.featurePreferences, artifact = p.latestBuild!.artifacts[0];
    const body = { ...action(p), revision, feedback: { buildId: initial.id, description: "Screen lock incorrectly abandons the timer." } };
    const repaired = await wait(api, await call<Job>(api, `/api/projects/${p.id}/builds`, body));
    expect(repaired.status).toBe("succeeded");
    expect((await call<Job>(api, `/api/projects/${p.id}/builds`, body)).id).toBe(repaired.id);
    const feedback = await json(path.join(api.root, "workflow/builds", initial.id, "runtime-findings.json"));
    expect(feedback).toEqual({ apkSha256: artifact.sha256, issues: [body.feedback.description] });
    p = await api.service.get(p.id); expect(p.currentDesignRevision).toBe(revision); expect(p.featurePreferences).toEqual(preferences);
    const stale = await wait(api, await call<Job>(api, `/api/projects/${p.id}/builds`, { ...action(p), revision, feedback: body.feedback }));
    expect(stale.error?.code).toBe("stale_build");
    p = await api.service.get(p.id);
    expect(p.lastDeliveredBuild?.id).toBe(repaired.id);
    const invalid = await fetch(api.address + `/api/projects/${p.id}/builds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...action(p), revision, feedback: { buildId: repaired.id, description: " " } }) });
    expect(invalid.status).toBe(400);
  } finally { await api.close(); }
});
test("project API rejects foreign origins, oversized input and fabricated research snapshots", async () => {
  const api = await projectServer();
  try {
    expect((await fetch(api.address + "/api/projects", { headers: { Origin: "https://foreign.example" } })).status).toBe(403);
    const response = await fetch(api.address + "/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestKey: randomUUID(), brief: idea, references: {} }) }); expect(response.status).toBe(400); expect((await response.json()).error.code).toBe("invalid_request");
    const huge = await fetch(api.address + "/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "x".repeat(70000) }) }); expect(huge.status).toBe(413);
  } finally { await api.close(); }
});

test("partial APK acquisition automatically continues and preserves its reference set through confirmation (synthetic downloads)", async () => {
  const calls: string[] = []; let firstFailure = true;
  const api = await projectServer({ apks: false, acquireApk: async (packageId, file, progress) => {
    calls.push(packageId); await progress({ status: "running", bytes: 128, totalBytes: 256, source: "Synthetic fixture" });
    if (firstFailure) { firstFailure = false; throw new Error("Fixture provider has no downloadable APK."); }
    await mkdir(path.dirname(file), { recursive: true }); zipApk(file); await write(`${file}.provenance.json`, { packageId, sha256: await fileSha(file) });
    await progress({ status: "completed", bytes: 256 }); return file;
  } });
  try {
    const p = await research(api, await create(api)), started = await call<Job>(api, `/api/projects/${p.id}/design`, action(p)), blocked = await wait(api, started);
    expect(blocked.status).toBe("waiting_user"); expect(blocked.progress!.apps.filter(app => app.download.status === "completed")).toHaveLength(4);
    expect(blocked.progress!.apps.find(app => app.download.status === "failed")!.download.message).toContain("Fixture provider"); expect(api.counts().analysisCalls).toBe(1); expect(blocked.missingInputs).toBeUndefined();
    const saved = await call<Project>(api, `/api/projects/${p.id}`); if (saved.pendingDecision?.kind !== "merge_choices") throw new Error("Missing choice");
    const continued = await wait(api, await call<Job>(api, `/api/projects/${p.id}/decisions/${saved.pendingDecision.id}/confirm`, { ...action(saved), selections: [{ conflict_id: "choice-save", option_id: "option-save-explicit" }] }));
    expect(continued.status).toBe("succeeded"); expect(calls).toHaveLength(5);
    expect(continued.progress!.steps.find(step => step.id === "download")!.status).toBe("completed"); expect(continued.progress!.apps.filter(app => app.download.status === "completed")).toHaveLength(4);
  } finally { await api.close(); }
});

test("incomplete APK analysis automatically falls back to a market-assisted design without rewriting the static attempt", async () => {
  const api = await projectServer({ analysisFailure: true });
  try {
    const p = await research(api, await create(api)), task = await wait(api, await call<Job>(api, `/api/projects/${p.id}/design`, action(p)));
    expect(task.status).toBe("waiting_user"); expect(api.counts().analysisCalls).toBe(2);
    const source = await api.service.storedJob(task.id), pipeline = await api.service.pipeline.get(source.pipelineJobId!);
    expect(pipeline.execution).toBe("market"); expect(task.progress!.apps.every(app => app.analysis === "skipped")).toBe(true);
    const original = await json(path.join(api.options.pipeline.directory, pipeline.id, "analysis/run.json")); expect(original.status).toBe("partial"); expect(original.error).toContain("incomplete static analysis");
    const saved = await call<Project>(api, `/api/projects/${p.id}`); if (saved.pendingDecision?.kind !== "merge_choices") throw new Error("Missing choice");
    await wait(api, await call<Job>(api, `/api/projects/${p.id}/decisions/${saved.pendingDecision.id}/confirm`, { ...action(saved), selections: [{ conflict_id: "choice-save", option_id: "option-save-explicit" }] }));
    expect((await call<Project>(api, `/api/projects/${p.id}`)).design).toBeDefined(); expect(await json(path.join(api.options.pipeline.directory, pipeline.id, "analysis/run.json"))).toEqual(original);
  } finally { await api.close(); }
});

test("another server's recovery preserves a live build worker", async () => {
  const api = await projectServer();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const build = api.options.build!;
  api.options.build = async input => { started(); await blocked; return build(input); };
  try {
    const project = await create(api, true);
    const job = await api.service.build(project.id, { ...action(project), revision: project.currentDesignRevision! });
    await entered;
    await new ProjectService(api.options).recover();
    expect((await api.service.raw(project.id)).activeJobId).toBe(job.id);
    expect((await api.service.job(job.id)).status).toBe("running");
    release();
    expect((await wait(api, job)).status).toBe("succeeded");
  } finally { release(); await api.close(); }
});

test("another server's recovery preserves a live pipeline producer and its watcher", async () => {
  const api = await projectServer({ apks: false });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const runner = api.service.pipeline.options.runner!;
  api.service.pipeline.options.runner = async input => { started(); await blocked; return runner(input); };
  try {
    const project = await research(api, await create(api));
    const job = await api.service.design(project.id, action(project));
    await entered;
    const pipelineId = (await api.service.storedJob(job.id)).pipelineJobId!;
    await new ProjectService(api.options).recover();
    expect((await api.service.pipeline.get(pipelineId)).status).toBe("running");
    expect((await api.service.raw(project.id)).activeJobId).toBe(job.id);
    release();
    expect((await wait(api, job)).status).toBe("waiting_user");
  } finally { release(); await api.close(); }
});
