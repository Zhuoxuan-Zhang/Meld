import { test, expect } from "@playwright/test";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { marketApi } from "../server/market";
import type { MarketOptions, ScanRunner } from "../server/market";
import { scannerReport } from "./market-data";

type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;

async function serve(options: Partial<MarketOptions> & { runner?: ScanRunner }) {
  const plugin = marketApi({
    python: "unused",
    scannerDir: "unused",
    probe: async () => true,
    ...options,
  });
  let middleware: Middleware;
  (plugin.configureServer as (server: unknown) => void)({
    middlewares: {
      use(handler: Middleware) {
        middleware = handler;
      },
    },
  });
  const server = createServer((req, res) =>
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  return { address, close };
}
const ok = (report: unknown) => async () => ({ code: 0, report, stderr: "" });
const domainOf = (args: string[]) =>
  args.find((a) => a.startsWith("--category="))!.slice("--category=".length);

test("feature queries span categories, preserve provenance, and use a separate cache", async ({ request }) => {
  const calls: string[][] = [];
  const cacheDir = await mkdtemp(path.join(tmpdir(), "meld-feature-search-"));
  const runner: ScanRunner = async args => { calls.push(args); return { code: 0, report: scannerReport("Notes & lists"), stderr: "" }; };
  let api = await serve({ runner, cacheDir });
  try {
    const body = { domain: "Notes & lists", queries: ["offline study notes", "plain text quick capture"] };
    const first = await (await request.post(api.address + "/api/market/scan", { data: body })).json();
    expect(first.result.queries).toEqual(body.queries);
    expect(calls[0]).toContain("--query=offline study notes");
    expect(calls[0].some(a => a.startsWith("--genre-id="))).toBe(false);
    await api.close(); api = await serve({ runner, cacheDir });
    const cached = await (await request.post(api.address + "/api/market/scan", { data: body })).json();
    expect(cached.cached).toBe(true); expect(cached.result.queries).toEqual(body.queries); expect(calls).toHaveLength(1);
    await request.post(api.address + "/api/market/scan", { data: { domain: body.domain, queries: ["flashcards"] } });
    expect(calls).toHaveLength(2);
    expect((await request.post(api.address + "/api/market/scan", { data: { ...body, queries: [42] } })).status()).toBe(400);
    expect((await request.post(api.address + "/api/market/scan", { data: { ...body, queries: [] } })).status()).toBe(400);
  } finally { await api.close(); await rm(cacheDir, { recursive: true, force: true }); }
});

test("a scan is sent with the domain's search plan and returns normalized apps, then the cache", async ({
  request,
}) => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "meld-cache-test-"));
  const calls: string[][] = [];
  const runner: ScanRunner = async (args) => {
    calls.push(args);
    return { code: 0, report: scannerReport("Productivity"), stderr: "" };
  };
  const api = await serve({ runner, cacheDir });
  try {
    const status = await request.get(api.address + "/api/market/status");
    expect(await status.json()).toEqual({
      available: true,
      source: "Google Play",
    });
    const first = await request.post(api.address + "/api/market/scan", {
      data: { domain: "productivity" },
      headers: { Origin: api.address },
    });
    expect(first.status()).toBe(200);
    const body = await first.json();
    expect(body.cached).toBe(false);
    expect(calls).toEqual([
      [
        "--category=Productivity",
        "--genre-id=PRODUCTIVITY",
        "--query=to do list",
        "--query=notes",
        "--query=focus timer",
        "--max-candidates=90",
      ],
    ]);
    expect(body.result).toMatchObject({
      domain: "Productivity",
      genreId: "PRODUCTIVITY",
      status: "complete",
      ranked: 28,
      candidates: 30,
      windowDays: 10,
    });
    expect(body.result.apps).toHaveLength(5);
    expect(body.result.apps[0]).toEqual({
      appId: "com.example.calendar",
      rank: 1,
      title: "Calendar Pro",
      developer: "Example Labs",
      storeCategory: "Productivity",
      genreId: "PRODUCTIVITY",
      summary: "Plan your day with tasks, reminders and a focus timer.",
      rating: 4.64,
      ratings: 4_864_771,
      installs: 10_322_980_403,
      offersIap: false,
      containsAds: false,
      price: 0,
      currency: "USD",
      score: 13,
      components: {
        market_scale: 1,
        quality: 0.91,
        rating_depth: 0.74,
        monetization_surface: 0.45,
        recent_review_activity: 1,
      },
      recentReviews: 100,
      storeUrl:
        "https://play.google.com/store/apps/details?id=com.example.calendar&hl=en&gl=us",
      description:
        "Plan your day with tasks, reminders and a focus timer.\n\nFeatures:\n• Calendar Pro folders\n• Works offline\n• Reminders",
      iconUrl: "https://play-lh.googleusercontent.com/icon0",
      // Only Google Play's image server is allowed.
      screenshots: [
        "https://play-lh.googleusercontent.com/shot0a",
        "https://play-lh.googleusercontent.com/shot0b",
      ],
    });
    const second = await request.post(api.address + "/api/market/scan", {
      data: { domain: "Productivity" },
    });
    expect((await second.json()).cached).toBe(true);
    expect(calls).toHaveLength(1);
    const refreshed = await request.post(api.address + "/api/market/scan", {
      data: { domain: "Productivity", refresh: true },
    });
    expect((await refreshed.json()).cached).toBe(false);
    expect(calls).toHaveLength(2);
  } finally {
    await api.close();
  }
  // A restarted server reuses the saved scan instead of contacting Google Play.
  const restarted = await serve({
    cacheDir,
    runner: async () => {
      throw new Error("must use the cache");
    },
  });
  try {
    const cached = await request.post(restarted.address + "/api/market/scan", {
      data: { domain: "Productivity" },
    });
    expect(cached.status()).toBe(200);
    expect((await cached.json()).cached).toBe(true);
  } finally {
    await restarted.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("custom domains are sent as a search topic without a genre filter", async ({
  request,
}) => {
  let sent: string[] = [];
  const api = await serve({
    runner: async (args) => {
      sent = args;
      return { code: 0, report: scannerReport("Gardening"), stderr: "" };
    },
  });
  try {
    const res = await request.post(api.address + "/api/market/scan", {
      data: { domain: "  Gardening " },
    });
    expect(res.status()).toBe(200);
    expect(sent).toEqual(["--category=Gardening", "--max-candidates=90"]);
    expect((await res.json()).result.domain).toBe("Gardening");
  } finally {
    await api.close();
  }
});

test("invalid requests are rejected before a scan starts", async ({
  request,
}) => {
  let calls = 0;
  const api = await serve({
    runner: async () => {
      calls++;
      return { code: 0, report: scannerReport("Productivity"), stderr: "" };
    },
  });
  try {
    for (const data of [{}, { domain: "" }, { domain: "x".repeat(49) }, { domain: "Finance", refresh: "yes" }, null])
      expect(
        (
          await request.post(api.address + "/api/market/scan", {
            data: JSON.stringify(data),
            headers: { "Content-Type": "application/json" },
          })
        ).status(),
      ).toBe(400);
    expect(
      (
        await request.post(api.address + "/api/market/scan", {
          data: { domain: "Finance" },
          headers: { Origin: "https://unrelated.example" },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await request.post(api.address + "/api/market/scan", {
          data: "Finance",
          headers: { "Content-Type": "text/plain" },
        })
      ).status(),
    ).toBe(415);
    expect(
      (
        await request.post(api.address + "/api/market/scan", {
          data: { domain: "Finance", padding: "x".repeat(3000) },
        })
      ).status(),
    ).toBe(413);
    expect(
      (await request.get(api.address + "/api/market/scan")).status(),
    ).toBe(404);
    expect(calls).toBe(0);
  } finally {
    await api.close();
  }
});

test("a missing scanner and scanner failures produce safe, specific errors", async ({
  request,
}) => {
  const missing = await serve({ probe: async () => false, runner: ok(null) });
  try {
    const status = await (
      await request.get(missing.address + "/api/market/status")
    ).json();
    expect(status.available).toBe(false);
    expect(status.reason).toContain("npm run setup:market");
    const scan = await request.post(missing.address + "/api/market/scan", {
      data: { domain: "Finance" },
    });
    expect(scan.status()).toBe(503);
  } finally {
    await missing.close();
  }
  const cases: [ScanRunner, number, string][] = [
    [
      async () => ({ code: 1, report: { status: "failed" }, stderr: "" }),
      502,
      "no usable apps",
    ],
    [async () => ({ code: 1, report: null, stderr: "boom" }), 502, "could not run"],
    [
      ok({ ...scannerReport("Finance"), ranking: [{ app_id: "bad id" }] }),
      502,
      "unexpected report",
    ],
    [
      async () => {
        throw Object.assign(new Error("spawn"), { code: "ENOENT" });
      },
      503,
      "could not start",
    ],
    [
      (_args, signal) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () =>
            resolve({ code: null, report: null, stderr: "" }),
          ),
        ),
      504,
      "took too long",
    ],
  ];
  for (const [runner, status, message] of cases) {
    const api = await serve({ runner, timeoutMs: 100 });
    try {
      const res = await request.post(api.address + "/api/market/scan", {
        data: { domain: "Finance" },
      });
      expect(res.status()).toBe(status);
      expect((await res.json()).error).toContain(message);
    } finally {
      await api.close();
    }
  }
  const partial = await serve({
    runner: async () => ({
      code: 2,
      report: scannerReport("Finance", { status: "insufficient_results", count: 2 }),
      stderr: "",
    }),
  });
  try {
    const res = await request.post(partial.address + "/api/market/scan", {
      data: { domain: "Finance" },
    });
    expect(res.status()).toBe(200);
    const { result } = await res.json();
    expect(result.status).toBe("insufficient_results");
    expect(result.apps).toHaveLength(2);
  } finally {
    await partial.close();
  }
});

test("only two scans run at once, and a disconnected client stops its scan", async ({
  request,
}) => {
  let active = 0;
  let peak = 0;
  const releases: (() => void)[] = [];
  const aborted: string[] = [];
  const runner: ScanRunner = (args, signal) =>
    new Promise((resolve) => {
      active++;
      peak = Math.max(peak, active);
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        active--;
        resolve({ code: 0, report: scannerReport(domainOf(args)), stderr: "" });
      };
      releases.push(done);
      signal.addEventListener("abort", () => {
        aborted.push(domainOf(args));
        done();
      });
    });
  const api = await serve({ runner });
  try {
    // A raw request that disconnects while its scan is running.
    const dropped = httpRequest(api.address + "/api/market/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    dropped.on("error", () => {});
    dropped.end(JSON.stringify({ domain: "Wellness" }));
    await expect.poll(() => active).toBe(1);
    const scans = ["Finance", "Fitness"].map((domain) =>
      request.post(api.address + "/api/market/scan", { data: { domain } }),
    );
    await expect.poll(() => active).toBe(2);
    dropped.destroy();
    await expect.poll(() => aborted).toEqual(["Wellness"]);
    await expect.poll(() => active).toBe(2);
    releases.forEach((release) => release());
    for (const res of await Promise.all(scans)) expect(res.status()).toBe(200);
    expect(peak).toBe(2);
  } finally {
    await api.close();
  }
});

test("the default runner starts the scanner module and reads its --report file", async ({
  request,
}) => {
  // A stand-in for third_parties/new_app_agent that records its arguments.
  const dir = await mkdtemp(path.join(tmpdir(), "meld-fake-scanner-"));
  await mkdir(path.join(dir, "app_market"));
  await writeFile(path.join(dir, "app_market", "__init__.py"), "");
  await writeFile(path.join(dir, "app_market", "scanner.py"), "");
  await writeFile(
    path.join(dir, "app_market", "__main__.py"),
    `import json, sys
args = sys.argv[1:]
report = json.loads(open(${JSON.stringify(path.join(dir, "report.json"))}).read())
report["category"] = next(a.split("=", 1)[1] for a in args if a.startswith("--category="))
open(args[args.index("--report") + 1], "w").write(json.dumps(report))
sys.exit(0)
`,
  );
  await writeFile(
    path.join(dir, "report.json"),
    JSON.stringify(scannerReport("Learning")),
  );
  const plugin = { python: "python3", scannerDir: dir };
  const api = await serve({ ...plugin, probe: undefined });
  try {
    expect(
      (await (await request.get(api.address + "/api/market/status")).json())
        .available,
    ).toBe(true);
    const res = await request.post(api.address + "/api/market/scan", {
      data: { domain: "Learning" },
    });
    expect(res.status()).toBe(200);
    const { result } = await res.json();
    expect(result.category).toBe("Learning");
    expect(result.apps.map((a: { title: string }) => a.title)).toEqual([
      "Calendar Pro",
      "Notes Daily",
      "Color Notes",
      "Todo Planner",
      "Focus Flow",
    ]);
  } finally {
    await api.close();
  }
  const broken = await serve({ python: "python3", scannerDir: tmpdir(), probe: undefined });
  try {
    expect(
      (await (await request.get(broken.address + "/api/market/status")).json())
        .available,
    ).toBe(false);
  } finally {
    await broken.close();
    await rm(dir, { recursive: true, force: true });
  }
});
