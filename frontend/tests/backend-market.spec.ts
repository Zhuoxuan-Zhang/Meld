import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMarketService, marketApi, marketOptionsFromEnv } from "../../backend/src/adapters/market";
import { SignalsStore } from "../../backend/src/adapters/signals";
import type { Middleware } from "../../backend/src/http";
import { fromScannerReport, scanPlan } from "../../shared/market";
import { fromScannerReport as frontendReport, domainScans } from "../src/market";
import { scannerApp, scannerReport } from "./market-data";

function expandedReport() {
  const ranking = Array.from({ length: 30 }, (_, i) => scannerApp(1, i + 1, `app${i}`));
  return { ...scannerReport("Notes & lists"), top_five: ranking.slice(0, 5), ranking };
}

test("backend retains Kevin's full ranking through immutable storage, with legacy report support", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meld-expanded-market-"));
  try {
    const report = expandedReport();
    const result = fromScannerReport("Notes & lists", report);
    expect(result).toEqual(frontendReport("Notes & lists", report));
    expect(result.apps).toHaveLength(30);
    const signals = new SignalsStore(directory);
    const saved = await signals.record(result);
    expect(await signals.read(saved.scanId!)).toEqual(saved);
    const { ranking: _, ...legacy } = report;
    expect(fromScannerReport("Notes & lists", legacy).apps).toHaveLength(5);
    for (const domain of Object.keys(domainScans)) expect(scanPlan(domain)).toEqual({ category: domain, ...domainScans[domain] });
    expect(marketOptionsFromEnv({}, directory).maxCandidates).toBe(90);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("backend uses feature queries and expanded candidates, preserving them across disk cache reloads", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "meld-expanded-cache-"));
  const calls: string[][] = [];
  const options = { python: "unused", scannerDir: "unused", cacheDir, probe: async () => true, runner: async (args: string[]) => {
    calls.push(args);
    return { code: 0, stderr: "", report: expandedReport() };
  } };
  const queries = ["offline study notes", "quick note capture"];
  try {
    const first = await createMarketService(options).scan("Notes & lists", false, new AbortController().signal, queries);
    expect(first.result.apps).toHaveLength(30);
    expect(first.result.queries).toEqual(queries);
    expect(calls[0]).toContain("--max-candidates=90");
    expect(calls[0]).toContain("--query=offline study notes");
    expect(calls[0].some(arg => arg.startsWith("--genre-id="))).toBe(false);
    const cached = await createMarketService(options).scan("Notes & lists", false, new AbortController().signal, queries);
    expect(cached.cached).toBe(true);
    expect(cached.result).toEqual(first.result);
    expect(calls).toHaveLength(1);
    await createMarketService(options).scan("Notes & lists", false, new AbortController().signal);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("--genre-id=PRODUCTIVITY");
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test("backend endpoint rejects invalid search phrases and returns the full ranking", async ({ request }) => {
  let handler!: Middleware;
  let calls = 0;
  marketApi({ python: "unused", scannerDir: "unused", probe: async () => true, runner: async () => {
    calls++;
    return { code: 0, stderr: "", report: expandedReport() };
  } }).configureServer({ middlewares: { use: value => { handler = value; } } });
  const server = createServer((req, res) => void handler(req, res, () => res.end()));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/market/scan`;
  try {
    for (const queries of [[], [42], [""], Array(5).fill("notes")]) {
      expect((await request.post(url, { data: { domain: "Notes & lists", queries } })).status()).toBe(400);
    }
    expect(calls).toBe(0);
    const response = await request.post(url, { data: { domain: "Notes & lists", queries: ["offline notes"] } });
    expect(response.status()).toBe(200);
    const { result } = await response.json();
    expect(result.apps).toHaveLength(30);
    expect(result.queries).toEqual(["offline notes"]);
  } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
});
