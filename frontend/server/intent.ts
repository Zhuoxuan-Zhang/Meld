import path from "node:path";
import { readFile } from "node:fs/promises";
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
  const run: Clarify = clarify || (async input => {
    const instructions = await readFile(new URL("../prompts/idea-clarification/prompt.md", import.meta.url), "utf8");
    return modelJson(path.join(directory, "intent"), "clarify", instructions, input, IntentOutput, 2500, "low", 120000);
  });
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
