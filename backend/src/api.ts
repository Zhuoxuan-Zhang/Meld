import path from "node:path";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import { DesignService, pipelineRoot, z, fileSha, json, WorkbenchError } from "../../pipeline/dist/src/integration.js";
import { ProjectService, CreateProject, PatchProject, Action, ChangeAction, ConfirmAction, RestoreAction, BuildAction, OutlinePatch } from "./projects";
import type { ProjectOptions } from "./projects";
import { SignalsStore } from "./adapters/signals";
import { marketOptionsFromEnv, createMarketService } from "./adapters/market";
import { researchRunner } from "./research";
import { highLevelRunner } from "./high-level";
import { BrowserEmulator, AdbEmulatorDriver, EmulatorInput } from "./emulator";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { apkAcquirer } from "./apk-download";
import { androidBuildRunner } from "./build";
import { explainConflicts } from "./choices";
import { readBody, send } from "./http";
import type { Middleware } from "./http";

export function projectOptionsFromEnv(env: Record<string, string | undefined>, frontendDir: string): ProjectOptions {
  const cache = path.join(frontendDir, ".meld-cache"), root = path.dirname(pipelineRoot);
  const sdk = env.MELD_ANDROID_SDK || env.ANDROID_HOME || env.ANDROID_SDK_ROOT || "";
  const avdHome = env.MELD_EMULATOR_AVD_HOME || path.join(tmpdir(), `meld-browser-emulator-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`, "avd"), avd = env.MELD_EMULATOR_AVD || "MeldBrowserPreview";
  const port = Number(env.MELD_EMULATOR_PORT || 5582);
  const emulator = env.MELD_EMULATOR_ENABLED !== "false" && sdk && existsSync(path.join(avdHome, `${avd}.ini`)) && Number.isInteger(port) && port >= 5554 && port <= 5584 && port % 2 === 0 ? new BrowserEmulator(() => new AdbEmulatorDriver({ sdk, avdHome, avd, port })) : undefined;
  return { emulator, directory: path.join(cache, "workflow"), designs: new DesignService(pipelineRoot, path.join(cache, "designs")), signals: new SignalsStore(path.join(cache, "signals")),
    pipeline: { directory: path.join(cache, "workflow/analysis-jobs"), apkDir: env.MELD_APK_DIR && path.resolve(env.MELD_APK_DIR), toolRoot: env.MELD_PIPELINE_TOOL_ROOT && path.resolve(env.MELD_PIPELINE_TOOL_ROOT), config: env.MELD_PIPELINE_CONFIG && path.resolve(env.MELD_PIPELINE_CONFIG), acquireApk: env.MELD_APK_AUTO_DOWNLOAD === "false" ? undefined : apkAcquirer({ aapt: env.MELD_AAPT || path.join(env.MELD_ANDROID_SDK || env.ANDROID_HOME || env.ANDROID_SDK_ROOT || "", "build-tools/35.0.0/aapt2") }) },
    highLevel: highLevelRunner, prepareReferences: env.MELD_BACKGROUND_REFERENCES !== "false", exampleId: env.MELD_DESIGN_EXAMPLE, research: researchRunner(marketOptionsFromEnv(env, frontendDir)), explainConflicts,
    build: androidBuildRunner({ sdk: env.MELD_ANDROID_SDK || env.ANDROID_HOME || env.ANDROID_SDK_ROOT || "", javaHome: env.JAVA_HOME || "/usr/lib/jvm/java-21-openjdk-amd64", templateDirectory: path.join(root, "backend/templates/android"), nativeSmoke: env.MELD_NATIVE_SMOKE_PROJECT && env.MELD_NATIVE_SMOKE_ADB ? { projectId: env.MELD_NATIVE_SMOKE_PROJECT, script: path.join(root, "frontend/tests/puzzle-native-smoke.py"), adb: env.MELD_NATIVE_SMOKE_ADB, serial: env.MELD_NATIVE_SMOKE_SERIAL || "emulator-5580", output: path.join(frontendDir, "qa-screenshots/puzzle-harbor") } : undefined }) };
}
export function projectsMiddleware(service: ProjectService, availability?: () => Promise<Record<string, unknown>>): Middleware {
  let recovering: Promise<void> | undefined;
  return async (request, response, next) => {
    if (!request.url?.startsWith("/api/projects") && !request.url?.startsWith("/api/jobs/") && request.url !== "/api/status") return next();
    try {
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) throw new WorkbenchError("origin_denied", "Use the app from its own browser address.", 403);
      await (recovering ||= service.recover());
      const url = new URL(request.url, `http://${request.headers.host}`), parts = url.pathname.slice(5).split("/").filter(Boolean).map(decodeURIComponent);
      if (request.method === "GET" && url.pathname === "/api/status") return send(response, 200, { available: true, service: "meld-project-api", backgroundReferencesAvailable: Boolean(service.options.prepareReferences), emulatorAvailable: Boolean(service.options.emulator), exampleId: service.options.exampleId || null, ...(availability ? await availability() : {}) });
      if (parts[0] === "jobs" && parts.length === 2 && request.method === "GET") return send(response, 200, await service.job(parts[1]));
      if (parts[0] === "jobs" && parts.length === 3 && parts[2] === "resume" && request.method === "POST") { await readBody(request); return send(response, 202, await service.resume(parts[1])); }
      if (parts[0] !== "projects") throw new WorkbenchError("not_found", "Endpoint not found.", 404);
      if (parts.length === 1) {
        if (request.method === "POST") return send(response, 201, await service.create(CreateProject.parse(await readBody(request))));
        if (request.method === "GET") return send(response, 200, { projects: await service.list() });
      }
      const id = parts[1]; service.projectFile(id);
      if (parts.length === 2) {
        if (request.method === "GET") return send(response, 200, await service.get(id));
        if (request.method === "PATCH") return send(response, 200, await service.patch(id, PatchProject.parse(await readBody(request))));
      }
      if (parts.length === 3 && request.method === "POST") {
        const input = await readBody(request);
        if (parts[2] === "reference-preparation") return send(response, 202, await service.prepareReferences(id));
        if (parts[2] === "research") return send(response, 202, await service.research(id, Action.parse(input)));
        if (parts[2] === "design") return send(response, 202, await service.design(id, Action.parse(input)));
        if (parts[2] === "changes") return send(response, 202, await service.change(id, ChangeAction.parse(input)));
        if (parts[2] === "restore") return send(response, 202, await service.restore(id, RestoreAction.parse(input)));
        if (parts[2] === "approve-outline") return send(response, 202, await service.detail(id, BuildAction.parse(input)));
        if (parts[2] === "builds") return send(response, 202, await service.build(id, BuildAction.parse(input)));
      }
      if (parts.length === 5 && parts[2] === "decisions" && request.method === "POST") {
        const input = await readBody(request);
        if (parts[4] === "confirm") return send(response, 202, await service.confirm(id, parts[3], ConfirmAction.parse(input)));
        if (parts[4] === "dismiss") { const expected = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(input); const p = await service.raw(id); if (p.pendingDecision?.id !== parts[3]) throw new WorkbenchError("stale_decision", "Reload the pending decision.", 409); return send(response, 200, await service.dismiss(id, expected.expectedVersion)); }
      }
      const project = await service.raw(id);
      if (parts.length === 3 && parts[2] === "latest-job" && request.method === "GET") return send(response, 200, { job: await service.latestJob(id) });
      if (parts.length === 3 && parts[2] === "build-input" && request.method === "GET") return send(response, 200, await service.buildInput(id, url.searchParams.get("revision") || undefined));
      if (parts.length === 3 && parts[2] === "high-level" && request.method === "PATCH") return send(response, 200, await service.patchOutline(id, OutlinePatch.parse(await readBody(request))));
      if (parts.length === 3 && parts[2] === "revisions" && request.method === "GET") return send(response, 200, { revisions: await service.revisions(id) });
      if (parts.length === 4 && parts[2] === "references" && request.method === "GET" && project.designId) {
        const ref = z.object({ kind: z.enum(["feature", "page", "flow", "entity", "acceptance", "decision", "color"]), id: z.string().min(1).max(96) }).parse({ kind: url.searchParams.get("kind"), id: parts[3] });
        const revision = url.searchParams.get("revision") || project.currentDesignRevision!, owner = await service.revisionOwner(project, revision);
        return send(response, 200, { references: await service.options.designs.developerReference(owner, revision, [ref]) });
      }
      if (parts.length === 5 && parts[2] === "artifacts" && request.method === "GET" && project.designId) {
        const owner = await service.revisionOwner(project, parts[3]), saved = await service.options.designs.store.revision(owner, parts[3]), name = parts[4];
        if (path.basename(name) !== name || !Object.hasOwn(saved.record.files, name)) throw new WorkbenchError("not_found", "Artifact not found.", 404);
        const mime = name.endsWith(".html") ? "text/html" : name.endsWith(".png") ? "image/png" : name.endsWith(".json") ? "application/json" : "text/plain";
        response.writeHead(200, { "Content-Type": `${mime}; charset=utf-8`, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'" }); response.end(await fs.readFile(path.join(saved.dir, name))); return;
      }
      if (parts[2] === "builds" && parts[4] === "emulator") {
        const emulator = service.options.emulator;
        if (!emulator) throw new WorkbenchError("emulator_unavailable", "Browser preview is unavailable on this server.", 503);
        const buildId = parts[3], job = await service.job(buildId);
        if (job.projectId !== id || job.type !== "build" || job.status !== "succeeded") throw new WorkbenchError("not_found", "This build is not available for preview.", 404);
        if (parts.length === 5 && request.method === "POST") {
          await readBody(request);
          if (project.needsDesign || project.currentDesignRevision !== project.latestBuild?.revision || project.latestBuild?.id !== buildId || project.latestBuild.status !== "succeeded") throw new WorkbenchError("stale_build", "Build your current approved design before previewing it.", 409);
          const artifact = project.latestBuild.artifacts.find(item => item.name.endsWith(".apk"));
          if (!artifact || path.basename(artifact.name) !== artifact.name) throw new WorkbenchError("not_found", "The APK is unavailable.", 404);
          const apk = path.join(service.options.directory, "builds", buildId, "artifacts", artifact.name);
          if ((await fs.lstat(apk)).isSymbolicLink() || await fileSha(apk) !== artifact.sha256) throw new WorkbenchError("artifact_changed", "The APK changed. Build it again before previewing.", 409);
          return send(response, 202, await emulator.start({ projectId: id, buildId, apk, apkSha256: artifact.sha256 }));
        }
        const sessionId = parts[5];
        if (parts.length === 6 && request.method === "GET") return send(response, 200, emulator.status(id, buildId, sessionId));
        if (parts.length === 6 && request.method === "DELETE") { await emulator.stop(id, buildId, sessionId); return send(response, 200, { closed: true }); }
        if (parts.length === 7 && parts[6] === "frame" && request.method === "GET") {
          const frame = await emulator.frame(id, buildId, sessionId);
          response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(frame); return;
        }
        if (parts.length === 7 && parts[6] === "input" && request.method === "POST") { await emulator.input(id, buildId, sessionId, EmulatorInput.parse(await readBody(request))); return send(response, 200, { accepted: true }); }
      }
      if (parts.length === 6 && parts[2] === "builds" && parts[4] === "artifacts" && request.method === "GET") {
        const job = await service.job(parts[3]); if (job.projectId !== id || job.type !== "build" || job.status !== "succeeded") throw new WorkbenchError("not_found", "Build artifact not found.", 404);
        const directory = path.join(service.options.directory, "builds", job.id), metadata = await json(path.join(directory, "artifacts.json"));
        const artifact = metadata.find((a: { name: string }) => a.name === parts[5]);
        if (!artifact || path.basename(parts[5]) !== parts[5]) throw new WorkbenchError("not_found", "Artifact not found.", 404);
        const file = path.join(directory, "artifacts", artifact.name);
        if ((await fs.lstat(file)).isSymbolicLink() || await fileSha(file) !== artifact.sha256) throw new WorkbenchError("artifact_changed", "The build artifact changed. Create a new build.", 409);
        response.writeHead(200, { "Content-Type": artifact.name.endsWith(".apk") ? "application/vnd.android.package-archive" : "application/json", "Content-Disposition": `attachment; filename="${artifact.name}"`, "X-Content-Type-Options": "nosniff" }); response.end(await fs.readFile(file)); return;
      }
      throw new WorkbenchError("not_found", "Endpoint not found.", 404);
    } catch (error) {
      if (error instanceof z.ZodError) return send(response, 400, { error: { code: "invalid_request", message: "Check the request fields.", details: error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`) } });
      const failure = error as WorkbenchError; send(response, failure.status || 500, { error: { code: failure.code || "request_failed", message: failure.message || "This request could not be completed." } });
    }
  };
}
function claudeCliLoggedIn() {
  const result = spawnSync("claude", ["auth", "status"], { timeout: 5000, encoding: "utf8" });
  if (result.status !== 0) return false;
  try { return JSON.parse(result.stdout).loggedIn === true; } catch { return true; }
}
export function defaultAvailability(env: Record<string, string | undefined>, frontendDir: string) {
  const market = createMarketService(marketOptionsFromEnv(env, frontendDir));
  return async () => ({ researchAvailable: await market.isAvailable(), designAvailable: claudeCliLoggedIn(), buildAvailable: await fs.access(path.join(env.MELD_ANDROID_SDK || env.ANDROID_HOME || env.ANDROID_SDK_ROOT || "", "platforms/android-35/android.jar")).then(() => true, () => false) && await fs.access(path.join(env.JAVA_HOME || "", "bin/java")).then(() => true, () => false) });
}
