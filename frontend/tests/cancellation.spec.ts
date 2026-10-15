import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { marketApi } from "../server/market";
import { claudeApi } from "../server/claude";
import { marketApi as backendMarketApi } from "../../backend/src/adapters/market";
import { claudeApi as backendClaudeApi } from "../../backend/src/adapters/claude";
import type { Middleware } from "../../backend/src/http";
import { scannerReport } from "./market-data";

const providers = [
  { name: "studio search", kind: "market", factory: marketApi },
  { name: "backend search", kind: "market", factory: backendMarketApi },
  { name: "studio summaries", kind: "claude", factory: claudeApi },
  { name: "backend summaries", kind: "claude", factory: backendClaudeApi },
] as const;
const input = { domain: "Notes & lists", apps: [{ appId: "com.example.notes", title: "Notes", summary: "Keep notes offline.", description: "Write and save notes." }] };
const outcome = (kind: string) => kind === "market"
  ? { code: 0, stderr: "", report: scannerReport("Notes & lists") }
  : { code: 0, stderr: "", stdout: JSON.stringify({ structured_output: { apps: [{ app_id: "com.example.notes", features: [] }] } }) };

async function serve(provider: typeof providers[number], overrides: Record<string, unknown>) {
  let middleware!: Middleware, received = 0, disconnected = 0;
  const plugin = (provider.factory as (options: any) => any)({
    python: "unused", scannerDir: tmpdir(), probe: async () => true,
    locate: () => "unused", env: process.env, model: "fixture", templateDir: path.resolve("prompts/app-features"), workDir: tmpdir(), auth: async () => ({ loggedIn: true }),
    ...overrides,
  });
  plugin.configureServer({ middlewares: { use: (handler: Middleware) => { middleware = handler; } } });
  const server = createServer((req, res) => {
    received++;
    res.once("close", () => { if (!res.writableEnded) disconnected++; });
    void middleware(req, res, () => { res.writeHead(404); res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/${provider.kind === "market" ? "market/scan" : "claude/features"}`;
  return {
    counts: () => ({ received, disconnected }),
    post: (signal?: AbortSignal) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, refresh: true }), signal }),
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

for (const provider of providers) {
  test(`${provider.name}: cancellation during availability checks never starts a worker`, async () => {
    let release!: () => void, checking = false, calls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const available = async () => { checking = true; await gate; return true; };
    const api = await serve(provider, {
      probe: available, auth: async () => ({ loggedIn: await available() }),
      runner: async () => { calls++; return outcome(provider.kind); },
    });
    const controller = new AbortController();
    const abandoned = api.post(controller.signal).catch(error => error);
    try {
      await expect.poll(() => checking).toBe(true);
      controller.abort(); await abandoned;
      await expect.poll(() => api.counts().disconnected).toBe(1);
      release();
      expect((await api.post()).status).toBe(200);
      expect(calls).toBe(1);
    } finally { controller.abort(); release(); await abandoned; await api.close(); }
  });

  test(`${provider.name}: cancelled queued work never runs and slots remain reusable`, async () => {
    let calls = 0, released = false;
    const releases: (() => void)[] = [];
    const runner = (...args: any[]) => new Promise(resolve => {
      calls++;
      const signal: AbortSignal = args.at(-1);
      const done = () => resolve(outcome(provider.kind));
      releases.push(done);
      if (released || signal.aborted) done();
      else signal.addEventListener("abort", done, { once: true });
    });
    const api = await serve(provider, { runner });
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const pending = controllers.slice(0, 2).map(controller => api.post(controller.signal).catch(error => error));
    try {
      await expect.poll(() => calls).toBe(2);
      pending.push(api.post(controllers[2].signal).catch(error => error));
      await expect.poll(() => api.counts().received).toBe(3);
      controllers[2].abort(); await pending[2];
      await expect.poll(() => api.counts().disconnected).toBe(1);
      released = true; releases.forEach(done => done());
      expect((await pending[0]).status).toBe(200);
      expect((await pending[1]).status).toBe(200);
      expect((await api.post()).status).toBe(200);
      expect(calls).toBe(3);
    } finally {
      released = true; controllers.forEach(controller => controller.abort()); releases.forEach(done => done());
      await Promise.all(pending); await api.close();
    }
  });

  test(`${provider.name}: disconnect stops the real launcher and its child`, async () => {
    test.skip(process.platform === "win32", "The app's process group cleanup uses POSIX signals.");
    const directory = await mkdtemp(path.join(tmpdir(), "meld-cancel-worker-"));
    const bin = path.join(directory, "worker"), started = path.join(directory, "started.json");
    await writeFile(bin, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'inherit' });
fs.writeFileSync(${JSON.stringify(started)}, JSON.stringify([process.pid, child.pid]));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    const api = await serve(provider, { python: bin, locate: () => bin, workDir: directory });
    const controller = new AbortController();
    const abandoned = api.post(controller.signal).catch(error => error);
    let pids: number[] = [];
    try {
      await expect.poll(async () => { try { pids = JSON.parse(await readFile(started, "utf8")); return pids.length; } catch { return 0; } }).toBe(2);
      controller.abort(); await abandoned;
      await expect.poll(() => pids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } })).toBe(true);
    } finally {
      controller.abort(); await abandoned; await api.close();
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ } }
      await rm(directory, { recursive: true, force: true });
    }
  });
}
