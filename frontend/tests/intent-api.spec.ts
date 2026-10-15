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

test("abandoning idea requests cancels their work and makes room for a fresh attempt", async ({ request }) => {
  const signals: AbortSignal[] = [];
  let handler!: Middleware;
  const reply = { message: "Ready to clarify.", questions: [{ id: "task", question: "What should it do?", options: [] }], plan: null };
  const plugin = intentApi("unused", async (input, signal) => {
    if (input.idea === "Fresh idea") return reply;
    signals.push(signal);
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }, () => true);
  plugin.configureServer({ middlewares: { use: h => { handler = h; } } });
  const server = createServer((req, res) => void handler(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/intent/clarify`;
  const input = { idea: "An old idea", domains: [], turns: [] };
  const controllers = [new AbortController(), new AbortController()];
  const attempts = controllers.map(controller => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: controller.signal }).catch(error => error));
  try {
    await expect.poll(() => signals.length).toBe(2);
    const busy = await request.post(url, { data: { ...input, idea: "Fresh idea" } });
    expect(busy.status()).toBe(429); expect(busy.headers()["retry-after"]).toBe("2");
    for (const controller of controllers) controller.abort();
    await Promise.all(attempts);
    await expect.poll(() => signals.every(signal => signal.aborted)).toBe(true);
    const retried = await request.post(url, { data: { ...input, idea: "Fresh idea" } });
    expect(retried.status()).toBe(200); expect(await retried.json()).toEqual(reply);
  } finally {
    for (const controller of controllers) controller.abort();
    await Promise.all(attempts);
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});
