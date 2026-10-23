import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { AccountService, accountApi, loginInstructions } from "../../backend/src/accounts";
import { selectedModel, modelSelectionContext } from "../../backend/src/model-selection";
import { modelJson } from "../../backend/src/model";
import { z, selectedModelConfig } from "../../pipeline/dist/src/integration.js";
import type { Middleware } from "../../backend/src/http";
import { recommendedModel } from "../../shared/model-selection";
import type { AccountStatus } from "../../shared/model-selection";

async function accountServer() {
  const directory = await mkdtemp(path.join(tmpdir(), "meld-accounts-test-"));
  let loggedIn = true;
  const children: ReturnType<typeof spawn>[] = [];
  const service = new AccountService(path.join(directory, "selection.json"), async () => ({ installed: true, loggedIn }), provider => {
    const child = spawn(process.execPath, ["-e", provider === "codex_cli" ? `console.log('https://auth.openai.com/codex/device'); console.log('ABCD-EFGH'); setTimeout(()=>process.exit(0),250);` : `console.log('https://claude.com/cai/oauth/authorize?state=test'); process.stdin.once('data',()=>process.exit(0)); setTimeout(()=>process.exit(1),20000);`], { stdio: ["pipe", "pipe", "pipe"] });
    children.push(child); return child;
  });
  let handler!: Middleware;
  accountApi(service).configureServer({ middlewares: { use: value => { handler = value; } } });
  const server = createServer((req, res) => void handler(req, res, () => {
    const selection = selectedModel();
    setTimeout(() => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ selection, current: selectedModel() })); }, 30);
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { service, address, directory, setLoggedIn(value: boolean) { loggedIn = value; }, async close() { service.close(); for (const child of children) child.kill("SIGKILL"); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); await rm(directory, { recursive: true, force: true }); } };
}

test("account settings require a real provider connection, reject foreign requests, and survive restart", async ({ request }) => {
  const api = await accountServer();
  try {
    expect((await (await request.get(api.address + "/api/account/status")).json()).selection).toBeNull();
    api.setLoggedIn(false);
    expect((await request.post(api.address + "/api/account/model", { data: recommendedModel })).status()).toBe(401);
    api.setLoggedIn(true);
    expect((await request.post(api.address + "/api/account/model", { data: { ...recommendedModel, model: "claude-sonnet-5-5" } })).status()).toBe(400);
    expect((await request.post(api.address + "/api/account/model", { data: recommendedModel, headers: { Origin: "https://foreign.example" } })).status()).toBe(403);
    expect((await request.get(api.address + "/api/account/status", { headers: { Host: "foreign.example" } })).status()).toBe(403);
    expect((await request.post(api.address + "/api/account/model", { data: recommendedModel })).status()).toBe(200);
    expect(await new AccountService(api.service.file, api.service.probe).selection()).toEqual(recommendedModel);
    const captured = await (await request.get(api.address + "/api/test-context")).json();
    expect(captured).toEqual({ selection: recommendedModel, current: recommendedModel });
    await request.post(api.address + "/api/account/disconnect", { data: {} });
    expect(await api.service.selection()).toBeNull();
  } finally { await api.close(); }
});

test("provider sign-in forwards only official links, handles codes and cancellation without returning CLI logs", async ({ request }) => {
  const api = await accountServer();
  try {
    expect(loginInstructions("codex_cli", "https://auth.openai.com.attacker.test/codex/device TOKEN=secret")).toEqual({});
    expect(loginInstructions("claude_cli", "https://foreign.example/oauth/authorize")).toEqual({});
    expect(loginInstructions("claude_cli", "https://claude.com/cai/oauth/authorize?state=test")).toEqual({ url: "https://claude.com/cai/oauth/authorize?state=test" });
    const started = await (await request.post(api.address + "/api/account/login", { data: { provider: "codex_cli" } })).json();
    expect(started.login.id).toBeTruthy();
    await expect.poll(async () => (await (await request.get(api.address + "/api/account/status")).json()).login.status).toBe("succeeded");
    await request.post(api.address + "/api/account/login", { data: { provider: "claude_cli" } });
    await expect.poll(async () => (await (await request.get(api.address + "/api/account/status")).json()).login.status).toBe("waiting");
    const status = await (await request.get(api.address + "/api/account/status")).json();
    expect(status.login.url).toBe("https://claude.com/cai/oauth/authorize?state=test");
    expect(JSON.stringify(status)).not.toContain("output");
    expect((await request.post(api.address + "/api/account/login", { data: { provider: "codex_cli" } })).status()).toBe(409);
    expect((await request.post(api.address + "/api/account/code", { data: { id: status.login.id, code: "bad\ncode" } })).status()).toBe(400);
    expect((await request.post(api.address + "/api/account/code", { data: { id: status.login.id, code: "test-authorization-code" } })).status()).toBe(200);
    await expect.poll(async () => (await (await request.get(api.address + "/api/account/status")).json()).login.status).toBe("succeeded");
    await request.post(api.address + "/api/account/login", { data: { provider: "claude_cli" } });
    await request.post(api.address + "/api/account/cancel", { data: {} });
    expect(api.service.login()?.status).toBe("cancelled");
  } finally { await api.close(); }
});

test("selected provider, model and effort reach generation and detailed synthesis without leaking across jobs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meld-model-routing-"));
  const prior = process.env.MELD_CODEX_BIN;
  try {
    const fake = path.join(directory, "fake-codex");
    await writeFile(fake, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{ require('node:fs').writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],JSON.stringify({ok:true})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({ok:true})}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}})); });\n`, { mode: 0o700 });
    process.env.MELD_CODEX_BIN = fake;
    const choices = [recommendedModel, { ...recommendedModel, model: "gpt-6-luna", effort: "low" as const }];
    const results = await Promise.allSettled(choices.map((choice, i) => modelSelectionContext.run(choice, async () => {
      expect(selectedModelConfig({ provider: "claude_cli", model: "old", max_calls: 10 })).toMatchObject({ provider: choice.provider, model: choice.model, design_model: choice.model, reasoning_effort: choice.effort });
      expect(await modelJson(path.join(directory, String(i)), "test", "Return JSON", {}, z.object({ ok: z.boolean() }).strict())).toEqual({ ok: true });
      const { readdir } = await import("node:fs/promises");
      const calls = await readdir(path.join(directory, String(i)));
      const request = JSON.parse(await readFile(path.join(directory, String(i), calls[0], "request.json"), "utf8"));
      expect(request).toMatchObject({ model: choice.model, reasoning_effort: choice.effort });
    })));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    expect(selectedModel()).toBeNull();
  } finally { if (prior === undefined) delete process.env.MELD_CODEX_BIN; else process.env.MELD_CODEX_BIN = prior; await rm(directory, { recursive: true, force: true }); }
});

function mockAccount(): AccountStatus {
  return { enabled: true, mode: "local", selection: null, connections: { codex_cli: { installed: true, loggedIn: true }, claude_cli: { installed: true, loggedIn: true } }, login: null };
}
test("login page recommends Sol Medium, saves provider choices, and reopens settings in the studio", async ({ page }) => {
  const status = mockAccount();
  let selection: unknown;
  await page.route("**/api/account/**", async route => {
    if (route.request().url().endsWith("/model")) { selection = route.request().postDataJSON(); status.selection = selection as AccountStatus["selection"]; await route.fulfill({ json: { selection } }); }
    else await route.fulfill({ json: status });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Connect your account" })).toBeVisible();
  await expect(page.getByText("Recommended for a balance of performance and cost.")).toBeVisible();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("gpt-6.1-sol");
  await expect(page.getByLabel("Reasoning", { exact: true })).toHaveValue("medium");
  await page.getByRole("button", { name: "Continue to Meld" }).click();
  await expect(page.getByRole("heading", { name: /What would you love/ })).toBeVisible();
  expect(selection).toEqual(recommendedModel);
  await page.getByRole("button", { name: "Account and model settings" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Anthropic.*Claude Code/ }).click();
  await dialog.getByLabel("Model", { exact: true }).selectOption("claude-opus-5-5");
  await dialog.getByRole("button", { name: "Save model choice" }).click();
  expect(selection).toEqual({ provider: "claude_cli", model: "claude-opus-5-5", effort: "medium" });
  await expect(page.getByRole("button", { name: "Account and model settings" })).toContainText("Claude Opus 5.5");
});

test("mobile login stays readable and sign-in failure can be retried", async ({ page }) => {
  const status = mockAccount(); status.connections.codex_cli.loggedIn = false;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/account/**", async route => {
    if (route.request().url().endsWith("/login")) { await route.fulfill({ status: 503, json: { error: { code: "cli_missing", message: "Install Codex on this computer, then retry." } } }); }
    else await route.fulfill({ json: status });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with OpenAI" }).click();
  await expect(page.getByRole("alert")).toContainText("Install Codex");
  await expect(page.getByRole("button", { name: "Sign in with OpenAI" })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
