// Adapted from Zhuoxuan-Zhang/new_app_agent@937eee7.
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiPlugin as Plugin } from "./design-http";
import { DesignService, DesignJobs, pipelineRoot, ChangeRequest, ApplyRequest, RestoreRequest, Reference, WorkbenchError, exists, json, semanticHash, z, checkApk } from "../../pipeline/dist/src/integration.js";
import type { DesignView } from "../../pipeline/dist/src/integration.js";
import { SignalsStore } from "./signals";
import { DesignInput, PipelineJobs } from "./pipeline";
import type { PipelineOptions } from "./pipeline";

export type DesignApiOptions = { root: string; signals: SignalsStore; pipeline: PipelineOptions; exampleId?: string; service?: DesignService; available?: boolean };
type Runtime = { service: DesignService; changes: DesignJobs; pipeline: PipelineJobs; recovery?: Promise<void> };
const runtimeGlobal = globalThis as typeof globalThis & { meldDesignRuntimes?: Map<string, Runtime> };
const runtimes = runtimeGlobal.meldDesignRuntimes ||= new Map<string, Runtime>();
const apiView = (view: DesignView) => ({ ...view, artifacts: view.artifacts.map(artifact => ({ ...artifact, url: `/api/design${artifact.url}` })) });
async function readBody(request: IncomingMessage) {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new WorkbenchError("content_type", "Send a JSON request.", 415);
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 65536) throw new WorkbenchError("body_too_large", "This request is too long.", 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new WorkbenchError("invalid_json", "The request could not be read."); }
}
export function designApi(options: DesignApiOptions): Plugin {
  const key = path.resolve(options.root);
  let runtime = !options.service ? runtimes.get(key) : undefined;
  if (!runtime) {
    const service = options.service || new DesignService(pipelineRoot, options.root);
    runtime = { service, changes: new DesignJobs(service), pipeline: new PipelineJobs(service, options.signals, options.pipeline) };
    if (!options.service) runtimes.set(key, runtime);
  }
  const { service, changes, pipeline } = runtime;
  let available: boolean | undefined = options.available;
  const ready = () => runtime.recovery ||= Promise.all([changes.recover(), pipeline.recover()]).then(() => undefined);
  const modelAvailable = () => {
    if (available !== undefined) return available;
    const result = spawnSync("claude", ["auth", "status"], { timeout: 5000, encoding: "utf8" });
    if (result.status !== 0) { available = false; return available; }
    try { available = JSON.parse(result.stdout).loggedIn === true; } catch { available = true; }
    return available;
  };
  const send = (response: ServerResponse, status: number, data: unknown) => {
    if (response.destroyed || response.headersSent) return;
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(JSON.stringify(data));
  };
  const middleware = async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (!request.url?.startsWith("/api/design/")) return next();
    try {
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) throw new WorkbenchError("origin_denied", "Use Meld from its local browser address.", 403);
      await ready();
      const url = new URL(request.url, `http://${request.headers.host}`);
      const parts = url.pathname.slice("/api/design/".length).split("/").filter(Boolean).map(decodeURIComponent);
      if (request.method === "POST" && parts.length === 4 && parts[0] === "pipeline" && parts[2] === "references") {
        const job = await pipeline.get(parts[1]);
        const appId = parts[3];
        if (job.status !== "waiting_inputs" || !job.missing_apps?.includes(appId)) throw new WorkbenchError("invalid_reference", "Choose a missing reference from this saved job.", 409);
        if (!options.pipeline.apkDir) throw new WorkbenchError("missing_directory", "Configure the reference file directory.", 503);
        if (request.headers["content-type"] !== "application/octet-stream") throw new WorkbenchError("content_type", "Send the APK file.", 415);
        const limit = 128 * 1024 * 1024;
        if (Number(request.headers["content-length"]) > limit) throw new WorkbenchError("file_too_large", "Use an APK smaller than 128 MB.", 413);
        await fs.mkdir(options.pipeline.apkDir, { recursive: true });
        const temporary = path.join(options.pipeline.apkDir, `${randomUUID()}.upload.apk`);
        const evidence = `${temporary}.check.json`;
        const handle = await fs.open(temporary, "wx");
        try {
          let bytes = 0;
          for await (const chunk of request) {
            bytes += chunk.length;
            if (bytes > limit) throw new WorkbenchError("file_too_large", "Use an APK smaller than 128 MB.", 413);
            await handle.writeFile(chunk);
          }
          await handle.close();
          try { await checkApk(temporary, evidence); }
          catch { throw new WorkbenchError("invalid_apk", "Use a complete standalone APK with a manifest and classes.dex.", 400); }
          await fs.rename(temporary, path.join(options.pipeline.apkDir, `${appId}.apk`));
          return send(response, 200, { saved: true, appId });
        } finally {
          await handle.close().catch(() => undefined);
          await fs.rm(temporary, { force: true });
          await fs.rm(evidence, { force: true });
        }
      }
      if (request.method === "GET" && parts.join("/") === "status") {
        const exampleId = options.exampleId && await exists(path.join(service.store.directory(options.exampleId), "manifest.json")) ? options.exampleId : null;
        return send(response, 200, { available: modelAvailable(), provider: "Claude Code CLI", model: process.env.MELD_CLAUDE_MODEL || "claude-sonnet-5", exampleId, referenceFilesConfigured: Boolean(options.pipeline.apkDir) });
      }
      if (request.method === "POST" && parts.join("/") === "pipeline") {
        if (!modelAvailable()) throw new WorkbenchError("model_unavailable", "The design model is not connected. Your market choices are saved.", 503);
        return send(response, 202, await pipeline.submit(DesignInput.parse(await readBody(request))));
      }
      if (request.method === "POST" && parts.length === 3 && parts[0] === "pipeline" && parts[2] === "resume") {
        await readBody(request); return send(response, 202, await pipeline.resume(parts[1]));
      }
      if (request.method === "GET" && parts.length === 2 && parts[0] === "jobs") {
        const job = parts[1].startsWith("pipeline-") ? await pipeline.get(parts[1]) : await changes.get(parts[1]);
        return send(response, 200, { ...job, ...(job.result?.document ? { result: apiView(job.result) } : {}) });
      }
      if (parts[0] !== "designs" || parts.length < 2) throw new WorkbenchError("not_found", "Endpoint not found.", 404);
      const id = parts[1]; service.store.directory(id);
      if (request.method === "POST" && await exists(path.join(service.store.directory(id), "project-owner.json"))) throw new WorkbenchError("project_api_required", "Edit this design through its project API so the app profile stays consistent.", 409);
      if (request.method === "GET" && parts.length === 2) return send(response, 200, apiView(await service.get(id, url.searchParams.get("revision") || undefined)));
      if (request.method === "GET" && parts.length === 3 && parts[2] === "revisions") return send(response, 200, { revisions: await service.revisions(id) });
      if (request.method === "GET" && parts.length === 4 && parts[2] === "changes") return send(response, 200, await service.proposal(id, parts[3]));
      if (request.method === "GET" && parts.length === 4 && parts[2] === "references") {
        const revision = url.searchParams.get("revision") || (await service.store.manifest(id)).current_revision;
        return send(response, 200, { references: await service.developerReference(id, revision, [Reference.parse({ kind: url.searchParams.get("kind"), id: parts[3] })]) });
      }
      if (request.method === "GET" && parts.length === 3 && parts[2] === "build-input") {
        const revision = await service.store.revision(id, url.searchParams.get("revision") || undefined);
        const marketFile = path.join(service.store.directory(id), "market-handoff.json");
        return send(response, 200, { version: 1, target: "android-kotlin-compose", design_id: id, revision: revision.record.id, developer_design_hash: semanticHash(revision.data.design),
          developer_design: revision.data.design, brief: revision.data.brief, decisions: revision.data.decisions,
          market: await exists(marketFile) ? await json(marketFile) : null,
          implementation: (await service.get(id, revision.record.id)).implementation });
      }
      if (request.method === "GET" && parts.length === 6 && parts[2] === "revisions" && parts[4] === "artifacts") {
        const revision = await service.store.revision(id, parts[3]), name = parts[5];
        if (path.basename(name) !== name || !Object.hasOwn(revision.record.files, name)) throw new WorkbenchError("not_found", "Artifact not found.", 404);
        const mime = name.endsWith(".html") ? "text/html" : name.endsWith(".png") ? "image/png" : name.endsWith(".json") ? "application/json" : "text/plain";
        response.writeHead(200, { "Content-Type": `${mime}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'" });
        response.end(await fs.readFile(path.join(revision.dir, name))); return;
      }
      if (request.method === "POST") {
        if (!modelAvailable() && parts[2] !== "restore") throw new WorkbenchError("model_unavailable", "Connect the design model before proposing a change.", 503);
        if (parts.length === 3 && parts[2] === "changes") return send(response, 202, await changes.submit(id, "propose", ChangeRequest.parse(await readBody(request))));
        if (parts.length === 5 && parts[2] === "changes" && parts[4] === "apply") return send(response, 202, await changes.submit(id, "apply", ApplyRequest.parse(await readBody(request)), parts[3]));
        if (parts.length === 3 && parts[2] === "restore") return send(response, 202, await changes.submit(id, "restore", RestoreRequest.parse(await readBody(request))));
      }
      throw new WorkbenchError("not_found", "Endpoint not found.", 404);
    } catch (error) {
      if (error instanceof z.ZodError) send(response, 400, { error: { code: "invalid_request", message: "Check the request fields and try again.", details: error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`) } });
      else { const failure = error as WorkbenchError; send(response, failure.status || 500, { error: { code: failure.code || "design_error", message: failure.message || "The design request failed." } }); }
    }
  };
  return { name: "meld-design-doc", configureServer(server) { server.middlewares.use(middleware); }, configurePreviewServer(server) { server.middlewares.use(middleware); } };
}
