import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Middleware } from "../../backend/src/http";
import { intentApi } from "../server/intent";

test("clarification validates inputs, grounds each round in answers, and rejects incomplete plans", async ({ request }) => {
  const calls: any[] = [];
  let malformed = false, handler!: Middleware;
  const plugin = intentApi("unused", async input => { calls.push(input); return { message: "A little more detail.", questions: malformed ? [] : [{ id: "task", question: "Which task matters most?", options: ["Take notes", "Review cards"] }], plan: null }; }, () => true);
  plugin.configureServer({ middlewares: { use: h => { handler = h; } } });
  const server = createServer((req, res) => void handler(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const input = { idea: "A study app", domains: ["Flashcards"], turns: [{ question: "Who is it for?", answer: "One student" }] };
    const response = await request.post(base + "/api/intent/clarify", { data: input });
    expect(response.status()).toBe(200); expect(calls).toEqual([input]); expect((await response.json()).plan).toBeNull();
    expect((await request.post(base + "/api/intent/clarify", { data: { ...input, turns: [{ question: "Who?", answer: "" }] } })).status()).toBe(400);
    expect((await request.post(base + "/api/intent/clarify", { data: input, headers: { Origin: "https://unrelated.example" } })).status()).toBe(403);
    expect(calls).toHaveLength(1);
    malformed = true;
    expect((await request.post(base + "/api/intent/clarify", { data: input })).status()).toBe(502);
  } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
});
