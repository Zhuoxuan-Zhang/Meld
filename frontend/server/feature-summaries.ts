import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseListedFeatures } from "../src/market";
import type { ListedFeatures, MarketResult } from "../src/market";

// Recover completed listing summaries from the server's extraction records.
// Match the exact listing input, not just its package ID: an older summary
// must not be attached to a changed listing. These remain listing leads, not
// verified APK behavior. The browser cannot replace the stored market evidence.
export async function withSavedFeatureSummaries(scans: MarketResult[], directory: string): Promise<MarketResult[]> {
  const key = (domain: string, app: { app_id: string; title: string; summary: string; description: string }) =>
    JSON.stringify([domain, app.app_id, app.title.trim(), app.summary.trim(), app.description.trim()]);
  const appKey = (scan: MarketResult, app: MarketResult["apps"][number]) =>
    key(scan.domain, { app_id: app.appId, title: app.title, summary: app.summary || "", description: app.description || "" });
  const wanted = new Set(scans.flatMap(scan => scan.apps.filter(app => !app.listedFeatures).map(app => appKey(scan, app))));
  if (!wanted.size) return scans;
  let files: string[];
  try { files = await readdir(directory); } catch { return scans; }
  const summaries = new Map<string, ListedFeatures>();
  for (const file of files) {
    if (!/^[a-f\d]{24}\.json$/.test(file)) continue;
    try {
      const record = JSON.parse(await readFile(path.join(directory, file), "utf8"));
      if (record.kind !== "meld.app-features" || !Array.isArray(record.input?.apps) || !Array.isArray(record.output?.apps)) continue;
      for (const app of record.input.apps) {
        const id = key(record.input.domain, app);
        if (!wanted.has(id)) continue;
        const output = record.output.apps.find((entry: { app_id: string }) => entry.app_id === app.app_id);
        const saved = record.features?.[app.app_id];
        if (!Array.isArray(output?.features) || !saved) continue;
        const summary = parseListedFeatures({ ...saved, items: output.features });
        if (!summary || JSON.stringify(summary) !== JSON.stringify(parseListedFeatures(saved))) continue;
        const previous = summaries.get(id);
        if (!previous || Date.parse(summary.generatedAt) > Date.parse(previous.generatedAt)) summaries.set(id, summary);
      }
    } catch { /* A missing or corrupt extraction record cannot supply features. */ }
  }
  return scans.map(scan => ({ ...scan, apps: scan.apps.map(app => {
    const listedFeatures = app.listedFeatures || summaries.get(appKey(scan, app));
    return listedFeatures ? { ...app, listedFeatures } : app;
  }) }));
}
