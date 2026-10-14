import { designServer } from "./design-fixtures";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DesignService, pipelineRoot, write, json } from "@meld/design-pipeline";
import { designApi } from "../server/design";
import { SignalsStore } from "../server/signals";
import { fromScannerReport } from "../src/market";
import { FixtureModel, sourceFixture } from "../../pipeline/tests/fixtures/workbench";
import { scannerReport } from "./market-data";
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
test("market handoff retains all five server snapshots and waits honestly for reference APKs", async ({ request }) => {
  const api = await designServer();
  try {
    const scan = await api.signals.record(fromScannerReport("Productivity", scannerReport("Productivity")));
    const body = input(scan.scanId!); const response = await request.post(api.address + "/api/design/pipeline", { data: body });
    const job = await wait(api.address, (await response.json()).id); expect(job.status).toBe("waiting_inputs"); expect(job.missing_apps).toHaveLength(5);
    const saved = await json(path.join(api.root, "pipeline", job.id, "market.json")); expect(saved.apps).toHaveLength(5); expect(saved.scans[0].scanId).toBe(scan.scanId); expect(saved.classification).toBe("market_signals");
    const retried = await request.post(api.address + "/api/design/pipeline", { data: body }); expect((await retried.json()).id).toBe(job.id); expect(api.model.calls).toHaveLength(2);
    expect((await request.post(api.address + "/api/design/pipeline", { data: { ...body, brief: { ...body.brief, name: "Different" } } })).status()).toBe(409);
  } finally { await api.close(); }
});
test("APK-ready handoff feeds every ranked package into the runner and imports its design (synthetic downstream)", async ({ request }) => {
  const apkDir = await mkdtemp(path.join(tmpdir(), "meld-apk-fixture-")); let received: string[] = [];
  const api = await designServer({ apkDir, runner: async task => {
    const market = await json(task.market); received = market.apps.map((app: { appId: string }) => app.appId);
    expect(task.apks).toHaveLength(5); await sourceFixture(task.run);
    await write(path.join(task.run, "synthesis/design-review.json"), { passed: true, issues: [], limitations: ["Synthetic downstream fixture, not REA verification"] });
    const locked = market.apps.map((app: { appId: string; apk_sha256: string }, index: number) => ({ id: `app${index + 1}`, package_name: app.appId, sha256: app.apk_sha256 }));
    await write(path.join(task.run, "apps.lock.json"), locked);
    for (const app of locked) await write(path.join(task.run, "apps", app.id, "app-spec.json"), { app_id: app.id, package_name: app.package_name, features: [] });
    return 0;
  } });
  try {
    const scan = await api.signals.record(fromScannerReport("Productivity", scannerReport("Productivity")));
    for (const app of scan.apps) execFileSync("python3", ["-c", "import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('AndroidManifest.xml','synthetic');z.writestr('classes.dex','synthetic')", path.join(apkDir, `${app.appId}.apk`)]);
    const response = await request.post(api.address + "/api/design/pipeline", { data: input(scan.scanId!) });
    const result = await wait(api.address, (await response.json()).id); expect(result.status).toBe("succeeded"); expect(new Set(received)).toEqual(new Set(scan.apps.map(a => a.appId)));
    const build = await (await request.get(`${api.address}/api/design/designs/${result.design_id}/build-input`)).json(); expect(build.market.apps).toHaveLength(5); expect(build.market.apps.every((a: { apk_sha256: string }) => a.apk_sha256.length === 64)).toBe(true); expect(build.implementation.status).toBe("untracked");
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
