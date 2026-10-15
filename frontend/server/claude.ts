import { detachedProcessGroup, stopProcessOnAbort } from "../../shared/processes";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import type { Plugin } from "vite";
import { packageId, plainLine } from "../src/market";
import type { ListedFeatures } from "../src/market";

export type ClaudeRun = { code: number | null; stdout: string; stderr: string };
// Runs the Claude Code CLI with `args`, writing `input` to its standard input.
export type ClaudeRunner = (
  args: string[],
  input: string,
  signal: AbortSignal,
) => Promise<ClaudeRun>;
// null when the CLI is not installed.
export type ClaudeAuth = () => Promise<{ loggedIn: boolean } | null>;
export type ClaudeOptions = {
  locate: () => string | null;
  env: NodeJS.ProcessEnv;
  model: string;
  templateDir: string;
  workDir: string;
  cacheDir?: string;
  timeoutMs?: number;
  runner?: ClaudeRunner;
  auth?: ClaudeAuth;
};

const NOT_FOUND =
  "Claude Code was not found. Install it, or set MELD_CLAUDE_BIN in frontend/.env.local, then check again.";
const NOT_LOGGED_IN =
  "Claude Code is not logged in. Run claude in Terminal and log in, or set MELD_CLAUDE_CONFIG_DIR in frontend/.env.local to the folder of a logged-in account, then check again.";

// Variables that mark a running Claude Code session. They are dropped so a
// Meld server started from inside Claude Code still runs a fresh CLI.
const sessionVariable =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|SESSION_ATTENDED|SSE_PORT|CHILD_SESSION|EXECPATH|MESSAGING_\w+))$/;
const expandHome = (p: string) =>
  p === "~" || p.startsWith("~/") ? path.join(homedir(), p.slice(1)) : p;

// Settings: MELD_CLAUDE_BIN (the CLI), MELD_CLAUDE_CONFIG_DIR (which login;
// the CLI's CLAUDE_CONFIG_DIR) and MELD_CLAUDE_MODEL.
export function claudeOptionsFromEnv(
  env: Record<string, string | undefined>,
  frontendDir: string,
): ClaudeOptions {
  const child: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!sessionVariable.test(key)) child[key] = value;
  const configDir = env.MELD_CLAUDE_CONFIG_DIR?.trim();
  if (configDir) child.CLAUDE_CONFIG_DIR = path.resolve(expandHome(configDir));
  return {
    locate: () => findClaude(env.MELD_CLAUDE_BIN, child.PATH),
    env: child,
    model: env.MELD_CLAUDE_MODEL?.trim() || "claude-haiku-5-5",
    templateDir: path.join(frontendDir, "prompts", "app-features"),
    workDir: path.join(frontendDir, ".meld-cache", "claude-workdir"),
    cacheDir: path.join(frontendDir, ".meld-cache", "features"),
  };
}

function executable(file: string) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
// The CLI from MELD_CLAUDE_BIN, PATH, or a usual install location (including
// nvm, which a minimal PATH such as a double-clicked script's can miss).
export function findClaude(explicit: string | undefined, searchPath = "") {
  if (explicit?.trim()) {
    const file = path.resolve(expandHome(explicit.trim()));
    return executable(file) ? file : null;
  }
  const home = homedir();
  const nvm = path.join(process.env.NVM_DIR || path.join(home, ".nvm"), "versions", "node");
  let nvmBins: string[] = [];
  try {
    const version = (v: string) => v.replace(/^v/, "").split(".").map(Number);
    nvmBins = readdirSync(nvm)
      .sort((a, b) => {
        const [x, y] = [version(a), version(b)];
        return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
      })
      .map((v) => path.join(nvm, v, "bin"));
  } catch {
    /* No nvm. */
  }
  const dirs = [
    ...searchPath.split(path.delimiter).filter(Boolean),
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    ...nvmBins,
  ];
  for (const dir of dirs) {
    const file = path.join(dir, "claude");
    if (executable(file)) return file;
  }
  return null;
}

// The CLI's own folder goes first on PATH: an npm install starts with
// `#!/usr/bin/env node` and needs the node next to it.
function cliEnv(bin: string, env: NodeJS.ProcessEnv) {
  return {
    ...env,
    PATH: [path.dirname(bin), env.PATH].filter(Boolean).join(path.delimiter),
  };
}
function processRunner(options: ClaudeOptions): ClaudeRunner {
  return async (args, input, signal) => {
    const bin = options.locate();
    if (!bin) throw new Error("not found");
    await mkdir(options.workDir, { recursive: true });
    signal.throwIfAborted();
    return new Promise<ClaudeRun>((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: options.workDir,
        detached: detachedProcessGroup,
        env: cliEnv(bin, options.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      // Decoded as a stream, so a character split across chunks stays intact.
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stdout.length < 2_000_000) stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 4000) stderr += chunk;
      });
      stopProcessOnAbort(child, signal);
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ code, stdout, stderr });
      });
      // The CLI may exit before reading everything; that is reported by `close`.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  };
}
function processAuth(options: ClaudeOptions): ClaudeAuth {
  return async () => {
    const bin = options.locate();
    if (!bin) return null;
    return new Promise((resolve) => {
      const child = spawn(bin, ["auth", "status"], {
        env: cliEnv(bin, options.env),
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (out += chunk));
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.on("error", () => resolve(null));
      child.on("close", () => {
        clearTimeout(timer);
        try {
          resolve({ loggedIn: JSON.parse(out).loggedIn === true });
        } catch {
          // An older CLI without `auth status`: a feature run will tell.
          resolve({ loggedIn: true });
        }
      });
    });
  };
}

export type Template = {
  id: string;
  system: string;
  prompt: string;
  schema: string;
};
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
// A prompt template is a folder with system.md, prompt.md and schema.json. Its
// id names the folder and a hash of all three files, so any edit is a new
// template and earlier results stay traceable to the exact text they used.
export async function loadTemplate(dir: string): Promise<Template> {
  const [system, prompt, schema] = await Promise.all(
    ["system.md", "prompt.md", "schema.json"].map((f) =>
      readFile(path.join(dir, f), "utf8"),
    ),
  );
  const parsed = JSON.parse(schema);
  if (!prompt.includes("{{apps}}")) throw new Error("prompt.md needs {{apps}}");
  return {
    id: `${path.basename(dir)}@${sha256([system, prompt, schema].join("\0")).slice(0, 12)}`,
    system: system.trim(),
    prompt,
    schema: JSON.stringify(parsed),
  };
}
// One pass, so text inside the values is never treated as a placeholder.
export function renderPrompt(template: Template, values: Record<string, string>) {
  return template.prompt.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? values[key] : match,
  );
}
// The fixed command. Claude gets no tools; --safe-mode leaves out hooks,
// plugins, MCP servers and CLAUDE.md, and no settings files are read (a
// user's effort or model settings would otherwise apply), so the answer
// depends only on the template, the listings and the model. Low effort skips
// extended thinking, which this extraction does not need. The login still
// comes from CLAUDE_CONFIG_DIR.
export function claudeArgs(template: Template, model: string) {
  return [
    "-p",
    "--safe-mode",
    "--setting-sources",
    "",
    "--tools",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--model",
    model,
    "--effort",
    "low",
    "--system-prompt",
    template.system,
    "--json-schema",
    template.schema,
  ];
}

class ClaudeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
type InputApp = { app_id: string; title: string; summary: string; description: string };
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function parseApps(value: unknown): InputApp[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8)
    throw new Error("apps");
  const ids = new Set<string>();
  return value.map((a) => {
    if (
      !isRecord(a) ||
      typeof a.appId !== "string" ||
      !packageId.test(a.appId) ||
      a.appId.length > 160 ||
      ids.has(a.appId) ||
      typeof a.title !== "string" ||
      !a.title.trim() ||
      a.title.length > 120 ||
      (a.summary !== undefined && (typeof a.summary !== "string" || a.summary.length > 1000)) ||
      typeof a.description !== "string" ||
      a.description.length > 4000
    )
      throw new Error("apps");
    ids.add(a.appId);
    return {
      app_id: a.appId,
      title: a.title.trim(),
      summary: typeof a.summary === "string" ? a.summary.trim() : "",
      description: a.description.trim(),
    };
  });
}
function cleanFeatures(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .filter(isRecord)
    .map((f) => ({ name: plainLine(f.name, 60), detail: plainLine(f.detail, 200) }))
    .filter((f) => {
      const key = f.name.toLowerCase();
      const fresh = !!f.name && !seen.has(key);
      seen.add(key);
      return fresh;
    })
    .slice(0, 6);
}
// Errors the CLI reports in its JSON result or on stderr.
function failure(message: string, model: string) {
  if (/not logged in|log ?in|authenticat|oauth|credential|invalid api key/i.test(message))
    return new ClaudeError(503, NOT_LOGGED_IN);
  if (/usage limit|rate.?limit|limit reached|quota|overloaded|\b429\b/i.test(message))
    return new ClaudeError(429, "Claude Code reached a usage limit. Try again later.");
  if (/model/i.test(message) && /not found|invalid|unknown|not available|does not exist/i.test(message))
    return new ClaudeError(502, `Claude Code could not use the model ${model}. Check MELD_CLAUDE_MODEL.`);
  return new ClaudeError(502, "Claude Code could not summarize these listings. Please try again.");
}

export function claudeApi(options: ClaudeOptions): Plugin {
  const runner = options.runner || processRunner(options);
  const auth = options.auth || processAuth(options);
  const timeoutMs = options.timeoutMs ?? 180_000;
  // A positive check is kept until a run reports a login problem; a negative
  // one is retried, so installing or logging in needs no restart.
  let ready = false;
  let probing: Promise<{ available: boolean; reason?: string }> | null = null;
  let probedAt = 0;
  const availability = async () => {
    if (ready) return { available: true };
    if (!probing || Date.now() - probedAt > 10_000) {
      probedAt = Date.now();
      probing = auth()
        .catch(() => null)
        .then((status) =>
          !status
            ? { available: false, reason: NOT_FOUND }
            : status.loggedIn
              ? { available: true }
              : { available: false, reason: NOT_LOGGED_IN },
        );
    }
    const result = await probing;
    ready = result.available;
    return result;
  };
  // After a login or install problem, the next check asks the CLI again.
  const recheck = () => {
    ready = false;
    probing = null;
  };
  // At most two Claude Code runs at once; later requests wait their turn.
  let running = 0;
  const waiting: (() => void)[] = [];
  const acquire = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (running >= 2) {
      if (waiting.length >= 8)
        throw new ClaudeError(429, "Too many feature requests are waiting. Try again shortly.");
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal.removeEventListener("abort", cancel);
          running++;
          resolve();
        };
        const cancel = () => {
          const index = waiting.indexOf(ready);
          if (index !== -1) waiting.splice(index, 1);
          reject(new ClaudeError(499, "Request canceled."));
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
  const recordFile = (key: string) =>
    options.cacheDir && path.join(options.cacheDir, `${key}.json`);

  async function extract(
    domain: string,
    apps: InputApp[],
    refresh: boolean,
    signal: AbortSignal,
  ) {
    let template: Template;
    try {
      template = await loadTemplate(options.templateDir);
    } catch {
      throw new ClaudeError(500, "The feature prompt template is missing or invalid.");
    }
    const input = { domain, apps };
    const args = claudeArgs(template, options.model);
    // The same template, command, model and listings give the saved result back.
    const key = sha256(JSON.stringify([template.id, args, input])).slice(0, 24);
    const file = recordFile(key);
    if (!refresh && file) {
      try {
        const saved = JSON.parse(await readFile(file, "utf8"));
        if (isRecord(saved.features) && isRecord(saved.output) && Array.isArray(saved.output.apps) && apps.every(app => saved.output.apps.some((entry: unknown) => isRecord(entry) && entry.app_id === app.app_id && Array.isArray(entry.features))))
          return { features: saved.features, template: template.id, cached: true };
      } catch {
        /* Not saved yet. */
      }
    }
    const generatedAt = new Date().toISOString();
    const empty = (model: string) =>
      Object.fromEntries(
        apps.map((a) => [a.app_id, { items: [], model, template: template.id, generatedAt }]),
      );
    if (apps.every((a) => !a.description && !a.summary))
      return { features: empty(options.model), template: template.id, cached: false };
    const status = await availability();
    if (!status.available) throw new ClaudeError(503, status.reason || NOT_FOUND);
    // `<` is escaped so listing text cannot close the <apps> block.
    const prompt = renderPrompt(template, {
      domain: plainLine(domain, 48),
      apps: JSON.stringify(apps, null, 2).replace(/</g, "\\u003c"),
    });
    await acquire(signal);
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const timer = setTimeout(stop, timeoutMs);
    const started = Date.now();
    let run: ClaudeRun;
    try {
      controller.signal.throwIfAborted();
      run = await runner(args, prompt, controller.signal);
    } catch {
      if (signal.aborted) throw new ClaudeError(499, "Request canceled.");
      if (controller.signal.aborted) throw new ClaudeError(504, "Claude Code took too long. Please try again.");
      recheck();
      throw new ClaudeError(503, NOT_FOUND);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      release();
    }
    if (signal.aborted) throw new ClaudeError(499, "Request canceled.");
    if (controller.signal.aborted)
      throw new ClaudeError(504, "Claude Code took too long. Please try again.");
    let result: Record<string, unknown>;
    try {
      const parsed = JSON.parse(run.stdout);
      if (!isRecord(parsed)) throw new Error("result");
      result = parsed;
    } catch {
      const error = failure(run.stderr, options.model);
      if (error.status === 503) recheck();
      throw error;
    }
    if (result.is_error === true || run.code !== 0) {
      const error = failure(`${result.result ?? ""} ${run.stderr}`, options.model);
      if (error.status === 503) recheck();
      throw error;
    }
    const output = result.structured_output;
    if (!isRecord(output) || !Array.isArray(output.apps))
      throw new ClaudeError(502, "Claude Code returned features Meld could not use. Please try again.");
    const used = isRecord(result.modelUsage) ? Object.keys(result.modelUsage)[0] : undefined;
    const model = plainLine(used, 80) || options.model;
    const features: Record<string, ListedFeatures> = {};
    const requested = new Set(apps.map(app => app.app_id));
    const answered = new Set<string>();
    for (const entry of output.apps)
      if (
        isRecord(entry) &&
        typeof entry.app_id === "string" &&
        requested.has(entry.app_id) &&
        Array.isArray(entry.features) &&
        !answered.has(entry.app_id)
      ) {
        answered.add(entry.app_id);
        features[entry.app_id] = { items: cleanFeatures(entry.features), model, template: template.id, generatedAt };
      }
    if (file && answered.size === apps.length)
      // The record holds everything needed to repeat or audit this run.
      await mkdir(path.dirname(file), { recursive: true })
        .then(() =>
          writeFile(
            file,
            JSON.stringify(
              {
                kind: "meld.app-features",
                template: template.id,
                templateDir: path.relative(process.cwd(), options.templateDir) || options.templateDir,
                model: options.model,
                resolvedModel: model,
                createdAt: generatedAt,
                durationMs: Date.now() - started,
                command: [
                  "claude",
                  ...args.map((a) =>
                    a === template.system ? "<system.md>" : a === template.schema ? "<schema.json>" : a,
                  ),
                ],
                system: template.system,
                prompt,
                input,
                output,
                features,
              },
              null,
              2,
            ),
          ),
        )
        .catch(() => {
          /* The record is an optimization; a failed write keeps the result. */
        });
    return { features, template: template.id, cached: false };
  }

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
    if (!req.url?.startsWith("/api/claude/")) return next();
    if (req.url === "/api/claude/status" && req.method === "GET") {
      const status = await availability();
      let template: string | undefined;
      try {
        template = (await loadTemplate(options.templateDir)).id;
      } catch {
        /* Reported below. */
      }
      return send(res, 200, {
        available: status.available && !!template,
        model: options.model,
        ...(template ? { template } : {}),
        ...(status.reason || !template
          ? { reason: status.reason || "The feature prompt template is missing or invalid." }
          : {}),
      });
    }
    if (req.url !== "/api/claude/features" || req.method !== "POST")
      return send(res, 404, { error: "Endpoint not found." });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
      return send(res, 403, { error: "Use Meld from its local browser address." });
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return send(res, 415, { error: "Send a JSON request." });
    let domain: string;
    let refresh: boolean;
    let apps: InputApp[];
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64_000) return send(res, 413, { error: "Your request is too long." });
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !isRecord(input) ||
        typeof input.domain !== "string" ||
        !input.domain.trim() ||
        input.domain.length > 48 ||
        (input.refresh !== undefined && typeof input.refresh !== "boolean")
      )
        throw new Error("input");
      domain = input.domain.trim();
      refresh = input.refresh === true;
      apps = parseApps(input.apps);
    } catch {
      return send(res, 400, {
        error: "Send one domain and up to eight apps with their store listings.",
      });
    }
    if (res.destroyed) return;
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.on("close", onClose);
    try {
      const result = await extract(domain, apps, refresh, controller.signal);
      send(res, 200, { ...result, model: options.model });
    } catch (error) {
      if (error instanceof ClaudeError) send(res, error.status, { error: error.message });
      else send(res, 500, { error: "Feature extraction failed unexpectedly." });
    } finally {
      res.off("close", onClose);
    }
  };
  return {
    name: "meld-claude-features",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
