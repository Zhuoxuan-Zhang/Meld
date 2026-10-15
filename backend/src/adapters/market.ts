import { detachedProcessGroup, stopProcessOnAbort } from "../../../shared/processes";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ApiPlugin as Plugin } from "../http";
import { canonicalDomain } from "../../../shared/catalog";
import { fromScannerReport, scanPlan } from "../../../shared/market";
import type { MarketResult } from "../../../shared/market";

export type ScanOutcome = {
  code: number | null;
  report: unknown;
  stderr: string;
};
// Runs `python -m app_market scan <args>` and returns the saved --report.
export type ScanRunner = (
  args: string[],
  signal: AbortSignal,
) => Promise<ScanOutcome>;
export type MarketOptions = {
  onResult?: (result: MarketResult) => Promise<MarketResult>;
  python: string;
  scannerDir: string;
  cacheDir?: string;
  cacheHours?: number;
  maxCandidates?: number;
  timeoutMs?: number;
  runner?: ScanRunner;
  probe?: () => Promise<boolean>;
};

// Defaults: the scanner repository this folder sits in (new_app_agent/frontend),
// or else the one checked out in ../third_parties/new_app_agent, with its own
// virtual environment (see `npm run setup:market`).
export function marketOptionsFromEnv(
  env: Record<string, string | undefined>,
  frontendDir: string,
): MarketOptions {
  const enclosing = existsSync(path.join(frontendDir, "..", "app_market"));
  const scannerDir = path.resolve(
    frontendDir,
    env.MELD_MARKET_DIR || (enclosing ? ".." : "../third_parties/new_app_agent"),
  );
  const venvPython =
    process.platform === "win32"
      ? path.join(scannerDir, ".venv", "Scripts", "python.exe")
      : path.join(scannerDir, ".venv", "bin", "python");
  const number = (v: string | undefined, fallback: number) =>
    v && Number.isFinite(Number(v)) ? Number(v) : fallback;
  return {
    python: env.MELD_MARKET_PYTHON || venvPython,
    scannerDir,
    cacheDir: path.join(frontendDir, ".meld-cache", "market"),
    cacheHours: number(env.MELD_MARKET_CACHE_HOURS, 24),
    maxCandidates: Math.min(
      200,
      Math.max(5, Math.round(number(env.MELD_MARKET_CANDIDATES, 30))),
    ),
  };
}

function processRunner(python: string, cwd: string): ScanRunner {
  return async (args, signal) => {
    const dir = await mkdtemp(path.join(tmpdir(), "meld-market-"));
    const reportPath = path.join(dir, "report.json");
    try {
      const { code, stderr } = await new Promise<{
        code: number | null;
        stderr: string;
      }>((resolve, reject) => {
        signal.throwIfAborted();
        const child = spawn(
          python,
          ["-m", "app_market", "scan", ...args, "--report", reportPath],
          { cwd, detached: detachedProcessGroup, stdio: ["ignore", "ignore", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          if (stderr.length < 4000) stderr += chunk.toString();
        });
        stopProcessOnAbort(child, signal);
        child.on("error", reject);
        child.on("close", (code) => {
          resolve({ code, stderr });
        });
      });
      let report: unknown = null;
      try {
        report = JSON.parse(await readFile(reportPath, "utf8"));
      } catch {
        /* No report: the scanner rejected its options or was stopped. */
      }
      return { code, report, stderr };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

function processProbe(python: string, cwd: string) {
  return () =>
    new Promise<boolean>((resolve) => {
      const child = spawn(python, ["-c", "import app_market.scanner"], {
        cwd,
        stdio: "ignore",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.on("error", () => resolve(false));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
}

export class ScanError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createMarketService(options: MarketOptions) {
  const runner = options.runner || processRunner(options.python, options.scannerDir);
  const probe = options.probe || processProbe(options.python, options.scannerDir);
  const cacheMs = (options.cacheHours ?? 24) * 3_600_000;
  const maxCandidates = options.maxCandidates ?? 30;
  const timeoutMs = options.timeoutMs ?? 150_000;
  const memory = new Map<string, MarketResult>();
  // A positive probe is kept; a negative one is retried so a later
  // `npm run setup:market` is picked up without restarting Meld.
  let installed = false;
  let probing: Promise<boolean> | null = null;
  let probedAt = 0;
  const isAvailable = async () => {
    if (installed) return true;
    if (!probing || Date.now() - probedAt > 10_000) {
      probedAt = Date.now();
      probing = probe();
    }
    installed = await probing;
    return installed;
  };
  // At most two scans run at once; later requests wait their turn.
  let running = 0;
  const waiting: (() => void)[] = [];
  const acquire = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (running >= 2) {
      if (waiting.length >= 8)
        throw new ScanError(429, "Too many scans are waiting. Try again shortly.");
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal.removeEventListener("abort", cancel);
          running++;
          resolve();
        };
        const cancel = () => {
          const index = waiting.indexOf(ready);
          if (index !== -1) waiting.splice(index, 1);
          reject(new ScanError(499, "Scan canceled."));
        };
        waiting.push(ready);
        signal.addEventListener("abort", cancel, { once: true });
      });
    } else running++;
  };
  const release = () => {
    running--;
    waiting.shift()?.();
  };
  const cacheFile = (key: string) =>
    options.cacheDir &&
    path.join(
      options.cacheDir,
      createHash("sha256").update(key).digest("hex").slice(0, 24) + ".json",
    );
  const fresh = (r: MarketResult | undefined) =>
    r && Date.now() - Date.parse(r.generatedAt) < cacheMs ? r : undefined;
  const cached = async (key: string) => {
    const hit = fresh(memory.get(key));
    if (hit) return hit;
    const file = cacheFile(key);
    if (!file) return undefined;
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      const result = fresh(
        fromScannerReport(saved.domain, saved.report),
      );
      if (result) memory.set(key, result);
      return result;
    } catch {
      return undefined;
    }
  };
  async function scan(domain: string, refresh: boolean, signal: AbortSignal) {
    const plan = scanPlan(domain);
    // `--name=value` keeps a value such as "-x" or "--help" from being read as an option.
    const args = [
      `--category=${plan.category}`,
      ...(plan.genreId ? [`--genre-id=${plan.genreId}`] : []),
      ...plan.queries.map((q) => `--query=${q}`),
      `--max-candidates=${maxCandidates}`,
    ];
    // v3: reports carry store descriptions and image links.
    const key = JSON.stringify(["v3", domain, args]);
    if (!refresh) {
      const hit = await cached(key);
      if (hit) return { result: hit, cached: true };
    }
    if (!(await isAvailable()))
      throw new ScanError(503, "Market signals are not set up. Run npm run setup:market, then try again.");
    await acquire(signal);
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const timer = setTimeout(stop, timeoutMs);
    let outcome: ScanOutcome;
    try {
      controller.signal.throwIfAborted();
      outcome = await runner(args, controller.signal);
    } catch {
      if (signal.aborted) throw new ScanError(499, "Scan canceled.");
      if (controller.signal.aborted) throw new ScanError(504, "The market scan took too long. Please try again.");
      throw new ScanError(503, "The market scanner could not start. Run npm run setup:market, then try again.");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      release();
    }
    if (signal.aborted) throw new ScanError(499, "Scan canceled.");
    if (controller.signal.aborted)
      throw new ScanError(504, "The market scan took too long. Please try again.");
    if (outcome.code !== 0 && outcome.code !== 2)
      throw new ScanError(
        502,
        outcome.report
          ? "Google Play returned no usable apps for this domain. Check your connection or try a broader domain."
          : "The market scan could not run. Please try again.",
      );
    let result: MarketResult;
    try {
      result = fromScannerReport(domain, outcome.report);
    } catch {
      throw new ScanError(502, "The market scanner returned an unexpected report.");
    }
    memory.set(key, result);
    const file = cacheFile(key);
    if (file)
      await mkdir(path.dirname(file), { recursive: true })
        .then(() =>
          writeFile(file, JSON.stringify({ domain, report: outcome.report })),
        )
        .catch(() => {
          /* The cache is an optimization; a failed write keeps the result. */
        });
    return { result, cached: false };
  }
  return { scan, isAvailable };
}

export function marketApi(options: MarketOptions): Plugin {
  const { scan, isAvailable } = createMarketService(options);
  const send = (res: ServerResponse, status: number, data: object) => {
    if (res.destroyed || res.headersSent) return;
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  const middleware = async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => {
    if (!req.url?.startsWith("/api/market/")) return next();
    if (req.url === "/api/market/status" && req.method === "GET") {
      const ok = await isAvailable();
      return send(res, 200, {
        available: ok,
        source: "Google Play",
        ...(ok
          ? {}
          : {
              reason:
                "The market scanner is not installed. Run npm run setup:market in the frontend folder, then check again.",
            }),
      });
    }
    if (req.url !== "/api/market/scan" || req.method !== "POST")
      return send(res, 404, { error: "Endpoint not found." });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
      return send(res, 403, { error: "Use Meld from its local browser address." });
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return send(res, 415, { error: "Send a JSON request." });
    let input: { domain?: unknown; refresh?: unknown };
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 2_000)
          return send(res, 413, { error: "Your request is too long." });
      }
      input = JSON.parse(body);
    } catch {
      return send(res, 400, { error: "The request could not be read." });
    }
    if (
      !input ||
      typeof input.domain !== "string" ||
      !input.domain.trim() ||
      input.domain.length > 48 ||
      (input.refresh !== undefined && typeof input.refresh !== "boolean")
    )
      return send(res, 400, { error: "Send one domain of up to 48 characters." });
    const domain = canonicalDomain(input.domain);
    if (res.destroyed) return;
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.on("close", onClose);
    try {
      const output = await scan(domain, input.refresh === true, controller.signal);
      controller.signal.throwIfAborted();
      send(res, 200, { ...output, result: options.onResult ? await options.onResult(output.result) : output.result });
    } catch (error) {
      if (error instanceof ScanError) send(res, error.status, { error: error.message });
      else send(res, 500, { error: "The market scan failed unexpectedly." });
    } finally {
      res.off("close", onClose);
    }
  };
  return {
    name: "meld-market-signals",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
