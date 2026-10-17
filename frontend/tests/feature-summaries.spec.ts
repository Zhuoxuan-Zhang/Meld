import { test, expect } from "./fixtures";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withSavedFeatureSummaries } from "../server/feature-summaries";
import { fromScannerReport } from "../src/market";
import { scannerReport } from "./market-data";

test("saved summaries require the same domain and listing, and malformed records supply no features", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-feature-records-"));
  try {
    const scan = fromScannerReport("Notes & lists", scannerReport("Notes & lists"));
    const app = scan.apps[0];
    const summary = { items: [{ name: "Quick notes", detail: "Save a short note." }], generatedAt: scan.generatedAt, model: "fixture", template: "fixture" };
    const file = path.join(directory, "a".repeat(24) + ".json");
    await writeFile(file, JSON.stringify({ kind: "meld.app-features", input: { domain: scan.domain, apps: [{ app_id: app.appId, title: app.title, summary: app.summary || "", description: app.description || "" }] }, output: { apps: [{ app_id: app.appId, features: summary.items }] }, features: { [app.appId]: summary } }));
    expect((await withSavedFeatureSummaries([scan], directory))[0].apps[0].listedFeatures).toEqual(summary);
    expect(scan.apps[0].listedFeatures).toBeUndefined();
    for (const changed of [{ ...scan, domain: "Flashcards" }, { ...scan, apps: [{ ...app, description: "A different listing." }] }])
      expect((await withSavedFeatureSummaries([changed], directory))[0].apps[0].listedFeatures).toBeUndefined();
    await writeFile(file, "{broken");
    expect((await withSavedFeatureSummaries([scan], directory))[0].apps[0].listedFeatures).toBeUndefined();
    expect(await withSavedFeatureSummaries([scan], path.join(directory, "missing"))).toEqual([scan]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
