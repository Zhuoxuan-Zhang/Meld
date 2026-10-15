import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { write } from "../../pipeline/dist/src/integration.js";
import { PipelineJobs } from "../../backend/src/adapters/pipeline";
import type { PipelineProgress } from "../../shared/contracts";

test("public pipeline progress follows persisted analysis, comparison and merge checkpoints", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meld-progress-")), id = `pipeline-${randomUUID()}`, run = path.join(directory, id, "analysis");
  const progress: PipelineProgress = { stage: "analysis", apps: [1, 2, 3].map(n => ({ appId: `com.example.app${n}`, title: `Reference ${n}`, download: { status: "completed", bytes: 1024 }, analysis: "pending" })), steps: ["download", "analysis", "compare", "merge", "document"].map(id => ({ id, label: id, status: id === "download" ? "completed" : "pending" })) };
  const jobs = new PipelineJobs({} as any, {} as any, { directory });
  try {
    await write(path.join(directory, `${id}.json`), { id, status: "running", phase: "Starting analysis", progress });
    await write(path.join(run, "apps.lock.json"), [1, 2, 3].map(n => ({ id: `app${n}`, package_name: `com.example.app${n}` })));
    const state: any = { status: "running", active_stage: "analyze-app3", stages: { "analyze-app1": {}, "analyze-app2": {} }, calls: [] };
    await write(path.join(run, "run.json"), state);
    let job = await jobs.get(id);
    expect(job.progress!.apps.map(app => app.analysis)).toEqual(["completed", "completed", "running"]); expect(job.phase).toBe("Analyzing reference apps…");
    state.stages["analyze-app3"] = {}; state.active_stage = "compare"; await write(path.join(run, "run.json"), state);
    job = await jobs.get(id); expect(job.progress!.stage).toBe("compare"); expect(job.progress!.steps.find(step => step.id === "analysis")!.status).toBe("completed"); expect(job.progress!.steps.find(step => step.id === "compare")!.status).toBe("running");
    state.stages.compare = {}; state.active_stage = "design"; await write(path.join(run, "run.json"), state);
    job = await jobs.get(id); expect(job.progress!.stage).toBe("merge"); expect(job.progress!.steps.find(step => step.id === "merge")!.status).toBe("running"); expect(job.phase).toContain("Merging");
    state.calls = [{ stage: "design-text-repair-14" }]; await write(path.join(run, "run.json"), state);
    expect((await jobs.get(id)).phase).toBe("Refining your detailed design…");
    await write(path.join(directory, `${id}.json`), { id, status: "failed", phase: "Design stopped", progress });
    expect((await jobs.get(id)).progress!.steps.find(step => step.id === "merge")!.status).toBe("failed");
    await write(path.join(directory, `${id}.json`), { id, status: "running", phase: "Starting analysis", progress });
    state.status = "waiting_user"; await write(path.join(run, "run.json"), state);
    expect((await jobs.get(id)).progress!.steps.find(step => step.id === "merge")!.status).toBe("waiting");
    state.status = "failed"; await write(path.join(run, "run.json"), state);
    await write(path.join(directory, `${id}.json`), { ...job, status: "failed" });
    expect((await jobs.get(id)).progress!.steps.find(step => step.id === "merge")!.status).toBe("failed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
