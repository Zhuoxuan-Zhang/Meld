import { test, expect } from "./fixtures";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { projectServer } from "../../frontend/tests/project-fixtures";
import { workflowApi, Handoff, importSelection } from "../server/workflow";
import { SignalsStore } from "../server/signals";
import { fromScannerReport } from "../src/market";
import { scannerReport } from "./market-data";
import type { UserDocument, Project } from "../src/workflow";
import type { Middleware } from "../../backend/src/http";
import { handoffBody } from "../src/workflow";
import { emptyDraft } from "../src/state";

const document: UserDocument = { language: "en", title: "Pocket Notes", summary: "Keep notes offline.", audience: "Students", features: [{ id: "feature-notes", title: "Quick notes", summary: "Write and save notes locally.", steps: ["Write a note", "Save and reopen it"], examples: [], caveats: [], refs: [] }], screens: [{ id: "home", title: "Home", purpose: "Open your notes.", refs: [] }], appearance: "Warm colors.", boundaries: ["One device, no account."], choices: [] };
async function integrated() {
  const received: Project[] = [];
  const upstream = await projectServer({ highLevel: async p => { received.push(structuredClone(p)); return { document: structuredClone(document), response: "Review your outline." }; } });
  const signals = new SignalsStore(path.join(upstream.root, "meld-signals"));
  const snapshot = await signals.record(fromScannerReport("Notes & lists", scannerReport("Notes & lists")));
  const scan = { ...snapshot, apps: snapshot.apps.map(a => ({ ...a, listedFeatures: { items: [{ name: "Quick notes", detail: "Write and save notes offline." }], model: "fixture", template: "fixture", generatedAt: snapshot.generatedAt } })) };
  const draft = { ...emptyDraft(), name: "Pocket Notes", domains: ["Notes & lists"], goal: "An offline student notebook", selected: { "com.example.notes": ["com.example.notes:quick-notes"] }, market: { "Notes & lists": scan } };
  let handler!: Middleware;
  workflowApi({}, path.join(upstream.root, "frontend"), signals, upstream.service).configureServer({ middlewares: { use: h => { handler = h; } } });
  const server = createServer((req, res) => void handler(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { ...upstream, signals, scan, draft, received, address: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); await upstream.close(); } };
}
test("import keeps the chosen app and exact features, rejects foreign features, and is idempotent", async () => {
  const api = await integrated();
  try {
    const body = Handoff.parse({ ...handoffBody({ ...api.draft, baseAppId: "com.example.notes" }), requestKey: randomUUID() });
    const project = await importSelection(api.service, api.signals, body);
    expect(project.needsResearch).toBe(false);
    expect(project.featurePreferences.baseAppId).toBe("com.example.notes");
    expect(Handoff.safeParse({ ...body, baseAppId: "com.example.foreign" }).success).toBe(false);
    const baseOnly = Handoff.parse({ ...handoffBody({ ...api.draft, baseAppId: "com.example.notes", selected: {} }), requestKey: randomUUID() });
    expect((await importSelection(api.service, api.signals, baseOnly)).featurePreferences).toMatchObject({ baseAppId: "com.example.notes", selections: { "com.example.notes": [] }, customRequests: [] });
    expect(Object.values(project.references).flatMap(s => s.apps.map(a => a.appId))).toEqual(["com.example.notes"]);
    expect(project.featurePreferences.customRequests).toEqual(body.references[0].features);
    expect(project.brief.input).toBe(api.draft.goal);
    const domainBody = Handoff.parse({ ...handoffBody({ ...api.draft, discoverySource: "domains", intent: {
      idea: "A workout timer", turns: [], approved: true,
      reply: { message: "Ready", questions: [], plan: { summary: "A timer for workouts", audience: "Athletes", features: [{ name: "Countdown", terms: ["timer"] }], exclusions: [], assumptions: [], topics: [{ domain: "Focus & habits", queries: ["workout timer"] }] } },
    } }), requestKey: randomUUID() });
    const domainProject = await importSelection(api.service, api.signals, domainBody);
    expect(domainProject.brief.input).toBe(api.draft.goal);
    expect(domainProject.brief.domains).toEqual(["Notes & lists"]);
    expect((await importSelection(api.service, api.signals, body)).id).toBe(project.id);
    const edited = await api.service.patch(project.id, { expectedVersion: project.version, featurePreferences: { ...project.featurePreferences, customRequests: project.featurePreferences.customRequests.map(f => ({ ...f, description: "Capture class notes locally." })) } });
    expect(edited.featurePreferences.customRequests[0].description).toBe("Capture class notes locally.");
    await expect(importSelection(api.service, api.signals, { ...body, requestKey: randomUUID(), references: [{ appId: "com.example.notes", features: [{ id: "foreign:feature", name: "Wrong feature", description: "Not owned by this app" }] }] })).rejects.toThrow("Refresh this app's feature choices");
    await expect(importSelection(api.service, api.signals, { ...body, brief: { ...body.brief, name: "Changed" } })).rejects.toThrow("already used");
  } finally { await api.close(); }
});
test("research edits keep the saved project and design history, reject stale versions, and invalidate the old delivery", async () => {
  const api = await integrated();
  try {
    const body = Handoff.parse({ ...handoffBody({ ...api.draft, baseAppId: "com.example.notes" }), requestKey: randomUUID() });
    const old = await api.service.create({ requestKey: randomUUID(), brief: body.brief, exampleId: "notes" });
    const updatedBody = Handoff.parse({ ...body, projectId: old.id, expectedVersion: old.version, brief: { ...body.brief, name: "Study Notes", input: "Revised student notebook" }, customFeatures: [{ id: "custom-pin", name: "Pin notes", description: "Pin one note locally." }] });
    const updated = await importSelection(api.service, api.signals, updatedBody);
    expect(updated.id).toBe(old.id); expect(updated.currentDesignRevision).toBe(old.currentDesignRevision);
    expect(updated.needsDesign).toBe(true); expect(updated.needsResearch).toBe(false);
    expect(updated.brief.name).toBe("Study Notes"); expect(updated.featurePreferences.customRequests).toEqual(expect.arrayContaining(updatedBody.customFeatures!));
    expect((await importSelection(api.service, api.signals, updatedBody)).version).toBe(updated.version);
    await expect(importSelection(api.service, api.signals, { ...updatedBody, requestKey: randomUUID() })).rejects.toThrow("This project changed");
    expect(await api.service.revisions(old.id)).not.toHaveLength(0);
  } finally { await api.close(); }
});
