import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { ProjectService, BriefInput } from "../../backend/src/projects";
import { projectsMiddleware, projectOptionsFromEnv, defaultAvailability } from "../../backend/src/api";
import { readBody, send } from "../../backend/src/http";
import { z, WorkbenchError, withLock, semanticHash, exists, json, write } from "../../pipeline/dist/src/integration.js";
import { SignalsStore } from "./signals";
import { assessFit } from "../src/feasibility";
import type { ApiPlugin } from "./design-http";

const Feature = z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,239}$/), name: z.string().trim().min(1).max(120), description: z.string().max(1000) }).strict();
export const Handoff = z.object({ requestKey: z.string().uuid(), projectId: z.string().regex(/^project-[a-f\d-]{36}$/).optional(), expectedVersion: z.number().int().positive().optional(), baseAppId: z.string().min(1).max(240).optional(), brief: BriefInput, scanIds: z.array(z.string().regex(/^scan-[a-f\d]{64}$/)).min(1).max(2), references: z.array(z.object({ appId: z.string().regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/), features: z.array(Feature).max(6) }).strict()).min(1).max(5), customFeatures: z.array(Feature).max(20).optional() }).strict().refine(input => {
  const ids = [...input.references.flatMap(app => app.features.map(f => f.id)), ...(input.customFeatures || []).map(f => f.id)];
  return ids.length <= 20 && new Set(ids).size === ids.length && Boolean(input.projectId) === (input.expectedVersion !== undefined);
}, "Choose up to 20 distinct features.").refine(input => (!input.baseAppId || input.references.some(app => app.appId === input.baseAppId)) && input.references.every(app => app.features.length > 0 || app.appId === input.baseAppId), "Choose a base from your reference apps and features for each enhancement app.");

// Imported listings always come from immutable server snapshots. Feature text
// is saved separately as explicit user preferences, never as APK evidence.
export async function importSelection(service: ProjectService, signals: SignalsStore, input: z.infer<typeof Handoff>) {
  const file = path.join(service.options.directory, "meld-handoffs", `${input.requestKey}.json`);
  return withLock(`${file}.lock`, async () => {
    const signature = semanticHash(input);
    if (await exists(file)) {
      const receipt = await json(file);
      if (receipt.signature !== signature) throw new WorkbenchError("idempotency_conflict", "This request was already used for other choices.", 409);
      return service.get(receipt.id);
    }
    const scans = await Promise.all(input.scanIds.map(id => signals.read(id)));
    if (new Set(input.references.map(a => a.appId)).size !== input.references.length) throw new WorkbenchError("invalid_reference", "Choose each reference app once.", 400);
    for (const selected of input.references) {
      const scan = scans.find(s => s.apps.some(a => a.appId === selected.appId && !a.retained));
      const app = scan?.apps.find(a => a.appId === selected.appId);
      if (!scan || !app || !input.brief.domains.includes(scan.domain)) throw new WorkbenchError("stale_reference", "Refresh the market scan for your selected apps.", 409);
      if (assessFit(app, scan.domain).level === "complex") throw new WorkbenchError("complex_reference", "Choose smaller reference apps before building.", 422);
      if (selected.features.some(f => !f.id.startsWith(`${app.appId}:`)) || new Set(selected.features.map(f => f.id)).size !== selected.features.length) throw new WorkbenchError("invalid_feature", "Refresh this app's feature choices.", 400);
    }
    const project = input.projectId ? await service.get(input.projectId) : await service.create({ requestKey: input.requestKey, brief: input.brief });
    // Upstream accepts five references. Keep all chosen references and their
    // source snapshots; do not rerun research and replace the user's choices.
    const references: typeof project.references = {};
    for (const scan of scans) {
      const apps = scan.apps.filter(a => input.references.some(r => r.appId === a.appId));
      if (apps.length) references[scan.domain] = await service.options.signals.record({ ...scan, apps });
    }
    await service.mutate(project.id, async p => {
      if (p.activeJobId) throw new WorkbenchError("busy", "Wait for the current task before changing its reference apps.", 409);
      await service.snapshotProfile(p);
      p.brief = input.brief; p.references = references; p.needsResearch = false; p.needsDesign = true; p.pendingDecision = null; p.approvedRevision = null;
      delete p.highLevelDesign; delete p.highLevelFeedback; delete p.referencePreparationId; delete p.referencePreparation;
      p.featurePreferences = { ...(input.baseAppId ? { baseAppId: input.baseAppId } : {}), selections: Object.fromEntries(input.references.map(a => [a.appId, a.features.map(f => f.id)])), customRequests: [...input.references.flatMap(a => a.features), ...(input.customFeatures || [])] };
      p.version++;
    }, input.expectedVersion ?? project.version);
    await write(file, { signature, id: project.id });
    return service.get(project.id);
  }, 2000);
}

export function workflowApi(env: Record<string, string>, frontendDir: string, signals: SignalsStore, supplied?: ProjectService): ApiPlugin {
  const sdk = path.join(os.homedir(), "Library/Android/sdk"), java = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
  const configured = { ...env, MELD_ANDROID_SDK: env.MELD_ANDROID_SDK || env.ANDROID_HOME || env.ANDROID_SDK_ROOT || (existsSync(sdk) ? sdk : ""), JAVA_HOME: env.JAVA_HOME || (existsSync(java) ? java : ""), MELD_APK_DIR: env.MELD_APK_DIR || path.join(frontendDir, ".meld-cache/apks") };
  const options = projectOptionsFromEnv(configured, frontendDir);
  const service = supplied || new ProjectService(options);
  const route = projectsMiddleware(service, defaultAvailability(configured, frontendDir));
  const install: ApiPlugin["configureServer"] = server => { server.httpServer?.once("close", () => service.options.emulator?.close()); server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/workflow/import") return route(req, res, next);
    try {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new WorkbenchError("origin_denied", "Use Meld from its own browser address.", 403);
      if (req.method !== "POST") throw new WorkbenchError("not_found", "Endpoint not found.", 404);
      const input = Handoff.parse(await readBody(req));
      return send(res, 201, await importSelection(service, signals, input));
    } catch (error) {
      const e = error as WorkbenchError;
      send(res, error instanceof z.ZodError ? 400 : e.status || 500, { error: { code: e.code || "handoff_failed", message: error instanceof z.ZodError ? "Choose one to five live reference apps with completed feature summaries." : e.message } });
    }
  }); };
  return { name: "meld-build-workflow", configureServer: install, configurePreviewServer: install };
}
