import path from "node:path";
import { spawnSync } from "node:child_process";
import { z, WorkbenchError } from "../../pipeline/dist/src/integration.js";
import { modelJson } from "../../backend/src/model";
import { readBody, send } from "../../backend/src/http";
import type { ApiPlugin } from "./design-http";
import type { IntentReply } from "../src/intent";
import { canonicalDomain } from "../src/data";

const text = z.string().trim().min(1).max(600);
export const IntentInput = z.object({ idea: z.string().trim().min(3).max(3000), domains: z.array(z.string().min(1).max(48)).max(2), turns: z.array(z.object({ question: text, answer: z.string().trim().min(1).max(1200) }).strict()).max(9) }).strict();
export const IntentOutput = z.object({
  message: text,
  questions: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), question: text, options: z.array(z.string().min(1).max(160)).max(3) }).strict()).max(3),
  plan: z.object({ summary: text, audience: text, features: z.array(z.object({ name: z.string().min(1).max(120), terms: z.array(z.string().min(2).max(80)).min(1).max(5) }).strict()).min(1).max(5), exclusions: z.array(text).max(6), assumptions: z.array(text).max(6), topics: z.array(z.object({ domain: z.string().trim().min(1).max(48), queries: z.array(z.string().trim().min(2).max(120)).min(1).max(4) }).strict()).min(1).max(2) }).strict().nullable(),
}).strict();
type Clarify = (input: z.infer<typeof IntentInput>) => Promise<IntentReply>;
export function intentApi(directory: string, clarify?: Clarify, probe = () => spawnSync("codex", ["login", "status"], { timeout: 5000, stdio: "ignore" }).status === 0): ApiPlugin {
  let active = 0;
  const run: Clarify = clarify || (input => modelJson(path.join(directory, "intent"), "clarify", `Help the user define a NEW custom Android app that Meld will design and build for them. Google Play search finds reference apps whose features can inform that new app; it is not a recommendation service for choosing an existing app to install. This build intent is already established: do not ask the user to choose between building and finding an existing app, and never put an assumption that they want an existing app instead of a new build in the plan. Ask one or two focused questions at a time, at most three. Resolve who it is for, the main task, desired feature behavior and essential scope limits. Build on previous answers; never repeat an answered question unless a later answer creates a material contradiction. Resolve conflicting audience or task answers with a short follow-up instead of treating an ambiguous latest answer as confirmation. A vague topic such as gaming needs clarification; a precise brief can go straight to a plan. After two rounds prefer a concrete small scope with explicit assumptions unless a material contradiction remains. Never perform a search or invent apps/evidence. Questions have short optional choices, but free text is always allowed. Return either questions with plan=null, or no questions and a plan for the USER TO CONFIRM. The plan must preserve explicit wishes and note unsupported complex requirements in exclusions/assumptions for confirmation. Favor local single-user workflows; do not silently turn multiplayer or cloud requests into offline apps. Use one or two focused domain labels (reuse the supplied domains where relevant), and 2–4 varied English Google Play queries per topic based on concrete desired features, not just categories. Each feature needs 2–5 specific listing search terms/synonyms for transparent local relevance ranking. Do not use generic terms like app, easy, best, user, tool as match terms.`, input, IntentOutput, 2500, "low", 120000));
  const install: ApiPlugin["configureServer"] = server => { server.middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/intent/")) return next();
    try {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new WorkbenchError("origin_denied", "Use Meld from its own browser address.", 403);
      if (req.url === "/api/intent/status" && req.method === "GET") return send(res, 200, { available: probe() });
      if (req.url !== "/api/intent/clarify" || req.method !== "POST") throw new WorkbenchError("not_found", "Endpoint not found.", 404);
      const input = IntentInput.parse(await readBody(req));
      if (active >= 2) throw new WorkbenchError("busy", "Two idea reviews are running. Try again shortly.", 429);
      active++;
      try {
        const result = IntentOutput.parse(await run(input));
        if (!!result.plan === !!result.questions.length || new Set(result.questions.map(q => q.id)).size !== result.questions.length) throw new WorkbenchError("invalid_reply", "The agent returned an incomplete search plan. Retry your idea.", 502);
        if (result.plan) {
          result.plan.topics = result.plan.topics.map(t => ({ ...t, domain: canonicalDomain(t.domain), queries: [...new Set(t.queries)] }));
          if (new Set(result.plan.topics.map(t => t.domain.toLowerCase())).size !== result.plan.topics.length) throw new WorkbenchError("invalid_reply", "The agent repeated a domain. Retry your idea.", 502);
        }
        send(res, 200, result);
      } finally { active--; }
    } catch (error) {
      const e = error as WorkbenchError;
      send(res, error instanceof z.ZodError ? 400 : e.status || 502, { error: { code: e.code || "intent_failed", message: error instanceof z.ZodError ? "Check your idea and answers, then retry." : e.message || "The idea review failed. Your text is saved; retry." } });
    }
  }); };
  return { name: "meld-intent", configureServer: install, configurePreviewServer: install };
}
