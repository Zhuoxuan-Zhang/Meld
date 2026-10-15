import { designServer } from "./design-fixtures";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DesignService, pipelineRoot, write, json } from "../../pipeline/dist/src/integration.js";
import { designApi } from "../server/design";
import { SignalsStore } from "../server/signals";
import { fromScannerReport } from "../src/market";
import { FixtureModel, sourceFixture } from "../../pipeline/tests/fixtures/workbench";
import { scannerReport } from "./market-data";
import { DesignInput, renderSelectionScope } from "../server/pipeline";
import type { PipelineRunner } from "../server/pipeline";

async function wait(address: string, id: string) {
  let result: any;
  await expect.poll(async () => { result = await (await fetch(`${address}/api/design/jobs/${id}`)).json(); return ["succeeded", "failed", "waiting_inputs"].includes(result.status); }).toBe(true);
  return result;
}
const input = (scan: string) => ({ request_key: randomUUID(), scan_ids: [scan], brief: { name: "My notes", audience: "People who want a simple notebook", purpose: "Keep and find notes offline", goal: "A useful notebook", style: "sage" }, preferences: [{ app_id: "com.example.notes", feature_ids: ["notes"] }] });
test("real API contracts: readable doc, selected changes, raw build input and restore", async ({ request }) => {
  const api = await designServer();
  try {
    const before = await (await request.get(api.address + "/api/design/designs/notes")).json();
    const body = { base_revision: before.revision, idempotency_key: randomUUID(), text: "change", edits: [] };
    const pending = await request.post(api.address + "/api/design/designs/notes/changes", { data: body }); expect(pending.status()).toBe(202);
    const id = (await pending.json()).id; const duplicate = await request.post(api.address + "/api/design/designs/notes/changes", { data: body }); expect((await duplicate.json()).id).toBe(id);
    const proposed = await wait(api.address, id); expect(proposed.status).toBe("succeeded"); expect((await api.service.get("notes")).revision).toBe(before.revision);
    const applied = await request.post(`${api.address}/api/design/designs/notes/changes/${proposed.result.id}/apply`, { data: { base_revision: before.revision, idempotency_key: randomUUID(), selected_change_ids: ["change-color"] } });
    const after = await wait(api.address, (await applied.json()).id); expect(after.status).toBe("succeeded");
    const raw = await (await request.get(api.address + "/api/design/designs/notes/build-input")).json();
    expect(raw.developer_design.visual.colors[0].value).toBe("#246B4A"); expect(raw.developer_design.features[0].title).toBe("写笔记"); expect(raw.implementation.status).toBe("pending_update");
    const reference = await request.get(`${api.address}/api/design/designs/notes/references/primary?kind=color`); expect((await reference.json()).references[0].value.value).toBe("#246B4A");
    expect((await request.get(api.address + after.result.artifacts.find((a: { name: string }) => a.name === "user-doc.md").url)).status()).toBe(200);
    const callCount = api.model.calls.length;
    const restored = await request.post(api.address + "/api/design/designs/notes/restore", { data: { base_revision: after.result.revision, target_revision: before.revision, idempotency_key: randomUUID() } });
    const finished = await wait(api.address, (await restored.json()).id); expect(finished.result.version).toBe(3); expect(finished.result.implementation.status).toBe("in_sync"); expect(api.model.calls).toHaveLength(callCount);
  } finally { await api.close(); }
});
test("API rejects untrusted origins, arbitrary scans, oversized bodies and stale confirmations", async ({ request }) => {
  const api = await designServer();
  try {
    expect((await request.get(api.address + "/api/design/status", { headers: { Origin: "https://outside.example" } })).status()).toBe(403);
    expect((await request.post(api.address + "/api/design/pipeline", { data: input("scan-" + "a".repeat(64)) })).status()).toBe(409);
    expect((await request.post(api.address + "/api/design/designs/notes/changes", { data: { text: "x".repeat(70000) } })).status()).toBe(413);
    const stale = await request.post(api.address + "/api/design/designs/notes/changes", { data: { base_revision: "v0000-old", idempotency_key: randomUUID(), text: "change" } });
    const failed = await wait(api.address, (await stale.json()).id); expect(failed.error.code).toBe("stale_revision"); expect((await api.service.get("notes")).version).toBe(1);
  } finally { await api.close(); }
});
test("market handoff retains the selected server snapshot and waits honestly for reference APKs", async ({ request }) => {
  const api = await designServer();
  try {
    const scan = await api.signals.record(fromScannerReport("Productivity", scannerReport("Productivity")));
    const body = input(scan.scanId!); const response = await request.post(api.address + "/api/design/pipeline", { data: body });
    const job = await wait(api.address, (await response.json()).id); expect(job.status).toBe("waiting_inputs"); expect(job.missing_apps).toHaveLength(1);
    const saved = await json(path.join(api.root, "pipeline", job.id, "market.json")); expect(saved.apps).toHaveLength(1); expect(saved.scans[0].scanId).toBe(scan.scanId); expect(saved.classification).toBe("market_signals");
    const retried = await request.post(api.address + "/api/design/pipeline", { data: body }); expect((await retried.json()).id).toBe(job.id); expect(api.model.calls).toHaveLength(2);
    expect((await request.post(api.address + "/api/design/pipeline", { data: { ...body, brief: { ...body.brief, name: "Different" } } })).status()).toBe(409);
  } finally { await api.close(); }
});
test("store-listing feature choices survive the handoff as user preferences", async ({ request }) => {
  const api = await designServer();
  try {
    const scan = await api.signals.record(fromScannerReport("Productivity", scannerReport("Productivity")));
    const feature = { id: "com.example.notes:organize-with-long-descriptive-feature-name", name: "Organize with folders", description: "Keep personal notes in named folders." };
    const body = { ...input(scan.scanId!), requested_features: [feature.id], preferences: [{ app_id: "com.example.notes", feature_ids: [feature.id] }], feature_requests: [feature] };
    const response = await request.post(api.address + "/api/design/pipeline", { data: body });
    expect(response.status()).toBe(202);
    const job = await wait(api.address, (await response.json()).id);
    expect(job.status).toBe("waiting_inputs");
    const saved = await json(path.join(api.root, "pipeline", job.id, "market.json"));
    expect(saved.feature_requests).toEqual([feature]);
    expect(saved.scans[0].apps[0].listedFeatures).toBeUndefined();
    const wrongApp = await request.post(api.address + "/api/design/pipeline", { data: { ...body, request_key: randomUUID(), preferences: [{ app_id: "com.example.calendar", feature_ids: [feature.id] }] } });
    expect(wrongApp.status()).toBe(400);
    const missing = await request.post(api.address + "/api/design/pipeline", { data: { ...body, request_key: randomUUID(), feature_requests: [] } });
    expect(missing.status()).toBe(400);
  } finally { await api.close(); }
});
test("selection template preserves exact choices as JSON and reads edits for new requests", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meld-selection-prompt-"));
  const file = path.join(directory, "prompt.md");
  try {
    const chosen = { id: "com.example.notes:quick-notes", name: 'Notes with "quotes"', description: "Keep $& and {{selection_json}} as literal text.\nA second line." };
    const ignored = { id: "com.example.notes:unused", name: "Unselected feature", description: "Not part of this request." };
    const body = DesignInput.parse({ ...input("scan-" + "a".repeat(64)), requested_features: [chosen.id], preferences: [{ app_id: "com.example.notes", feature_ids: [chosen.id] }], feature_requests: [chosen, ignored] });
    const apps = fromScannerReport("Productivity", scannerReport("Productivity")).apps.filter(app => app.appId === "com.example.notes");
    await write(file, "{{selection_json}}");
    const selection = JSON.parse(await renderSelectionScope(body, apps, file));
    expect(selection.app).toEqual(body.brief);
    expect(selection.selected_features).toEqual([{ ...chosen, reference_package_ids: ["com.example.notes"] }]);
    expect(selection.selected_reference_apps.map((app: { package_id: string }) => app.package_id)).toEqual(["com.example.notes"]);
    await write(file, "Updated guidance\n{{selection_json}}");
    expect(await renderSelectionScope(body, apps, file)).toMatch(/^Updated guidance\n/);
    await write(file, "Missing placeholder");
    await expect(renderSelectionScope(body, apps, file)).rejects.toThrow("exactly one");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("APK-ready handoff preserves selected packages and the prompt through retry, import and export (synthetic downstream)", async ({ request }) => {
  const apkDir = await mkdtemp(path.join(tmpdir(), "meld-apk-fixture-")); let received: string[] = [], deliveredScope = "", attempts = 0;
  const feature = { id: "com.example.notes:quick-notes", name: "Quick notes", description: "Keep personal notes on this device. " .repeat(25) };
  const api = await designServer({ apkDir, runner: async task => {
    const market = await json(task.market); received = market.apps.map((app: { appId: string }) => app.appId);
    const brief = await json(task.brief);
    expect(brief.scope).toContain(feature.id); expect(brief.scope).toContain(feature.description);
    expect(brief.scope.length).toBeGreaterThan(1200);
    if (++attempts === 1) { deliveredScope = brief.scope; throw new Error("Synthetic interruption after saving the prompt"); }
    expect(brief.scope).toBe(deliveredScope);
    expect(task.apks).toHaveLength(1); await sourceFixture(task.run);
    await write(path.join(task.run, "brief.json"), brief);
    await write(path.join(task.run, "synthesis/design-review.json"), { passed: true, issues: [], limitations: ["Synthetic downstream fixture, not REA verification"] });
    const locked = market.apps.map((app: { appId: string; apk_sha256: string }, index: number) => ({ id: `app${index + 1}`, package_name: app.appId, sha256: app.apk_sha256 }));
    await write(path.join(task.run, "apps.lock.json"), locked);
    for (const app of locked) await write(path.join(task.run, "apps", app.id, "app-spec.json"), { app_id: app.id, package_name: app.package_name, features: [] });
    return 0;
  } });
  try {
    const scan = await api.signals.record(fromScannerReport("Productivity", scannerReport("Productivity")));
    for (const app of scan.apps) execFileSync("python3", ["-c", "import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('AndroidManifest.xml','synthetic');z.writestr('classes.dex','synthetic')", path.join(apkDir, `${app.appId}.apk`)]);
    const body = { ...input(scan.scanId!), requested_features: [feature.id], preferences: [{ app_id: "com.example.notes", feature_ids: [feature.id] }], feature_requests: [feature] };
    const response = await request.post(api.address + "/api/design/pipeline", { data: body });
    const failed = await wait(api.address, (await response.json()).id); expect(failed.status).toBe("failed");
    const resumed = await request.post(`${api.address}/api/design/pipeline/${failed.id}/resume`, { data: {} });
    const result = await wait(api.address, (await resumed.json()).id); expect(result.status).toBe("succeeded"); expect(new Set(received)).toEqual(new Set(["com.example.notes"]));
    const build = await (await request.get(`${api.address}/api/design/designs/${result.design_id}/build-input`)).json(); expect(build.market.apps).toHaveLength(1); expect(build.market.apps.every((a: { apk_sha256: string }) => a.apk_sha256.length === 64)).toBe(true); expect(build.implementation.status).toBe("untracked");
    expect(build.brief.scope).toBe(deliveredScope); expect(attempts).toBe(2);
  } finally { await api.close(); await rm(apkDir, { recursive: true, force: true }); }
});
test("changed signal snapshots and references outside the scan cannot become APK evidence", async ({ request }) => {
  const api = await designServer();
  try {
    const scan = await api.signals.record(fromScannerReport("Productivity", scannerReport("Productivity")));
    expect((await request.post(api.address + "/api/design/pipeline", { data: { ...input(scan.scanId!), preferences: [{ app_id: "com.invented.app", feature_ids: ["notes"] }] } })).status()).toBe(409);
    await write(path.join(api.root, "signals", `${scan.scanId}.json`), { ...scan, status: "partial" });
    expect((await request.post(api.address + "/api/design/pipeline", { data: input(scan.scanId!) })).status()).toBe(409);
  } finally { await api.close(); }
});

test("missing references accept a bounded standalone APK and reject unrelated uploads", async ({ request }) => {
  const apkDir = await mkdtemp(path.join(tmpdir(), "meld-upload-test-"));
  const api = await designServer({ apkDir });
  try {
    const scan = await api.signals.record(fromScannerReport("Productivity", scannerReport("Productivity")));
    const response = await request.post(api.address + "/api/design/pipeline", { data: input(scan.scanId!) });
    const job = await wait(api.address, (await response.json()).id);
    const url = `${api.address}/api/design/pipeline/${job.id}/references/com.example.notes`;
    const headers = { "Content-Type": "application/octet-stream" };
    expect((await request.post(url, { headers, data: Buffer.from("not an apk") })).status()).toBe(400);
    const file = path.join(apkDir, "fixture.apk");
    execFileSync("python3", ["-c", "import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('AndroidManifest.xml','synthetic');z.writestr('classes.dex','synthetic')", file]);
    const bytes = await readFile(file);
    expect((await request.post(url, { headers, data: bytes })).status()).toBe(200);
    expect(await readFile(path.join(apkDir, "com.example.notes.apk"))).toEqual(bytes);
    expect((await request.post(url.replace("com.example.notes", "com.other.app"), { headers, data: bytes })).status()).toBe(409);
    expect((await request.post(url, { headers: { ...headers, Origin: "https://outside.example" }, data: bytes })).status()).toBe(403);
  } finally { await api.close(); await rm(apkDir, { recursive: true, force: true }); }
});
