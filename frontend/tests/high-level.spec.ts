import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { HighLevelDocument } from "../../backend/src/high-level";
import { z } from "../../pipeline/dist/src/integration.js";
import { projectServer, idea } from "./project-fixtures";
import type { ProjectTestServer } from "./project-fixtures";
import type { Project, Job, UserDocument } from "../../shared/contracts";
const document: UserDocument = { language: "en", title: "Pocket Notes", summary: "Capture and find your ideas on your phone.", audience: "People keeping personal notes", features: [{ id: "feature-write", title: "Quick notes", summary: "Write and save notes offline.", steps: ["Open a new note", "Write and save"], examples: [], caveats: [], refs: [] }], screens: [{ id: "page-home", title: "Home", purpose: "Find and open notes.", refs: [] }], choices: [], appearance: "Calm green accents on a light background.", boundaries: ["Offline personal use" ] };
async function call<T>(api: ProjectTestServer, suffix: string, body?: unknown, method = body ? "POST" : "GET"): Promise<T> {
  const response = await fetch(api.address + suffix, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); if (!response.ok) throw new Error(await response.text()); return response.json();
}
const action = (project: Project) => ({ requestKey: randomUUID(), expectedVersion: project.version });
async function wait(api: ProjectTestServer, job: Job) { await expect.poll(async () => (await api.service.job(job.id)).status).not.toMatch(/^(queued|running)$/); return api.service.job(job.id); }
async function createOutline(api: ProjectTestServer) {
  let project = await call<Project>(api, "/api/projects", { requestKey: randomUUID(), brief: idea });
  await wait(api, await call<Job>(api, `/api/projects/${project.id}/research`, action(project))); project = await api.service.get(project.id);
  await wait(api, await call<Job>(api, `/api/projects/${project.id}/design`, action(project))); return api.service.get(project.id);
}
test("one short outline precedes APK analysis; saved approval is forwarded and automatically starts a build", async () => {
  let calls = 0;
  const api = await projectServer({ highLevel: async () => { calls++; return { document: structuredClone(document), response: "Ready to review." }; } });
  try {
    let project = await createOutline(api); expect(calls).toBe(1); expect(api.counts()).toEqual({ analysisCalls: 0, buildCalls: 0 }); expect(project.designId).toBeNull(); expect(project.highLevelDesign!.document.features[0].refs).toEqual([]);
    const oldRevision = project.highLevelDesign!.revision, changed = structuredClone(document); changed.features[0].summary = "Save notes with a single action.";
    project = await call<Project>(api, `/api/projects/${project.id}/high-level`, { expectedVersion: project.version, baseRevision: oldRevision, document: changed }, "PATCH");
    expect(project.highLevelDesign!.version).toBe(2); expect(calls).toBe(1);
    const stale = await fetch(api.address + `/api/projects/${project.id}/approve-outline`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...action(project), revision: oldRevision }) });
    const staleTask: Job = await stale.json(); expect((await wait(api, staleTask)).status).toBe("failed"); expect(api.counts().analysisCalls).toBe(0);
    project = await api.service.get(project.id); const approvedRevision = project.highLevelDesign!.revision;
    const task = await call<Job>(api, `/api/projects/${project.id}/approve-outline`, { ...action(project), revision: approvedRevision }); const finished = await wait(api, task); expect(finished.status, JSON.stringify(finished.error)).toBe("succeeded");
    await expect.poll(async () => (await api.service.get(project.id)).latestBuild?.status).toBe("succeeded");
    const stored = await api.service.storedJob(task.id), pipeline = await api.service.pipeline.get(stored.pipelineJobId!);
    expect(pipeline.input.approved_outline).toEqual({ revision: approvedRevision, document: changed }); expect(pipeline.input.requested_features).toEqual(["feature-write"]);
    const delivered = await api.service.get(project.id); expect(delivered.highLevelDesign!.approvedRevision).toBe(approvedRevision); expect(delivered.highLevelDesign!.developerRevision).toBe(delivered.currentDesignRevision); expect(api.counts()).toEqual({ analysisCalls: 1, buildCalls: 1 });
  } finally { await api.close(); }
});
test("free-text previews do not overwrite the outline; apply versions it and stale edits are rejected", async () => {
  const api = await projectServer({ highLevel: async (_project, _directory, request) => ({ document: request ? { ...structuredClone(request.document), appearance: "Blue accents on a light background." } : structuredClone(document), response: request ? "Change the accent to blue." : "Ready." }) });
  try {
    let project = await createOutline(api), baseline = project.highLevelDesign!;
    await wait(api, await call<Job>(api, `/api/projects/${project.id}/changes`, { ...action(project), baseRevision: baseline.revision, text: "Make it blue", edits: [] }));
    project = await api.service.get(project.id); expect(project.highLevelDesign!.revision).toBe(baseline.revision); expect(project.pendingDecision?.kind).toBe("high_level_changes");
    await wait(api, await call<Job>(api, `/api/projects/${project.id}/decisions/${project.pendingDecision!.id}/confirm`, { ...action(project), baseRevision: baseline.revision }));
    project = await api.service.get(project.id); expect(project.highLevelDesign!.version).toBe(2); expect(project.highLevelDesign!.document.appearance).toContain("Blue"); expect(api.counts().analysisCalls).toBe(0);
    const stale = await fetch(api.address + `/api/projects/${project.id}/high-level`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: project.version, baseRevision: baseline.revision, document }) }); expect(stale.status).toBe(409);
  } finally { await api.close(); }
});
test("browser edits the fast design and reaches the app without waiting for a developer document first", async ({ page }) => {
  test.setTimeout(60000);
  const api = await projectServer({ highLevel: async (_project, _directory, request) => ({ document: request ? { ...structuredClone(request.document), appearance: "Blue accents." } : structuredClone(document), response: "Ready to review." }) });
  try {
    await page.route("**/api/**", async route => { const request = route.request(), url = new URL(request.url()); const response = await page.request.fetch(api.address + url.pathname + url.search, { method: request.method(), headers: { "Content-Type": "application/json", Origin: api.address }, data: request.postData() || undefined }); await route.fulfill({ response }); });
    await page.goto("/"); await page.getByLabel("Describe your app", { exact: true }).fill(idea.input); await page.getByText("A few preferences, if you have them").click(); await page.getByLabel("Search topic", { exact: true }).fill("Productivity"); await page.getByRole("button", { name: "Explore ideas", exact: true }).click(); await page.getByRole("button", { name: "Confirm features and generate design" }).click();
    await expect(page.getByLabel("High-level design")).toBeVisible(); expect(api.counts().analysisCalls).toBe(0);
    const title = page.getByRole("button", { name: "Edit App title", exact: true });
    await title.click(); await expect(page.getByLabel("App title", { exact: true })).toHaveCount(0);
    await title.dblclick(); await page.getByLabel("App title", { exact: true }).fill("Cancelled title"); await page.getByLabel("App title", { exact: true }).press("Escape");
    await expect(title).toHaveText("Pocket Notes"); await expect(page.getByRole("button", { name: "Save design edits" })).toHaveCount(0);
    await title.focus(); await title.press("F2"); await expect(page.getByLabel("App title", { exact: true })).toBeFocused(); await page.getByLabel("App title", { exact: true }).press("Escape");
    await title.dblclick(); await page.getByLabel("App title", { exact: true }).fill("My Notebook"); await page.getByLabel("App title", { exact: true }).press("Enter"); await expect(page.getByRole("button", { name: "Approve design and build app" })).toBeDisabled(); await page.getByRole("button", { name: "Save design edits" }).click();
    await page.getByLabel("What would you like to change?", { exact: true }).fill("Make it blue"); await page.getByRole("button", { name: "Preview design changes" }).click(); await expect(page.getByRole("heading", { name: "Review your changes." })).toBeVisible(); await page.getByRole("button", { name: "Apply design changes" }).click();
    await page.reload(); await expect(page.getByLabel("High-level design")).toBeVisible(); await page.getByRole("button", { name: "Approve design and build app" }).click(); await expect(page.getByRole("heading", { name: "Your Android app is ready." })).toBeVisible(); expect(api.counts()).toEqual({ analysisCalls: 1, buildCalls: 1 });
  } finally { await page.unrouteAll({ behavior: "wait" }).catch(() => undefined); await api.close(); }
});

test("high-level structured output uses a supported reference schema while rejecting premature developer refs", () => {
  const schema = z.toJSONSchema(HighLevelDocument);
  expect(JSON.stringify(schema)).not.toContain('"not":');
  expect(HighLevelDocument.safeParse({ ...document, features: [{ ...document.features[0], refs: [{ kind: "feature", id: "invented-developer-reference" }] }] }).success).toBe(false);
});
