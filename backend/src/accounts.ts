import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { IncomingMessage } from "node:http";
import { z, WorkbenchError } from "../../pipeline/dist/src/integration.js";
import { readBody, send } from "./http";
import type { ApiPlugin } from "./http";
import { modelSelectionContext, ModelSelectionInput } from "./model-selection";
import type { AccountStatus, ModelSelection, ProviderConnection, LoginAttempt } from "../../shared/model-selection";

type Provider = ModelSelection["provider"];
const ProviderInput = z.object({ provider: z.enum(["codex_cli", "claude_cli"]) }).strict();
export function providerCommand(provider: Provider) {
  return provider === "codex_cli" ? process.env.MELD_CODEX_BIN || "codex" : process.env.MELD_CLAUDE_BIN || "claude";
}
function authEnv() {
  const env: NodeJS.ProcessEnv = { ...process.env, BROWSER: "true" };
  for (const key of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|^CLAUDECODE$|^CLAUDE_CODE_SESSION/.test(key)) delete env[key];
  return env;
}
export async function probeConnection(provider: Provider): Promise<ProviderConnection> {
  return new Promise(resolve => {
    const child = spawn(providerCommand(provider), provider === "codex_cli" ? ["login", "status"] : ["auth", "status"], { env: authEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stderr.resume();
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.stdout.on("data", chunk => { if (output.length < 32000) output += chunk.toString(); });
    child.once("error", () => { clearTimeout(timer); resolve({ installed: false, loggedIn: false }); });
    child.once("close", code => {
      clearTimeout(timer);
      let loggedIn = code === 0;
      if (provider === "claude_cli") { try { loggedIn = loggedIn && JSON.parse(output).loggedIn === true; } catch { loggedIn = false; } }
      resolve({ installed: true, loggedIn });
    });
  });
}
// Only forward official HTTPS authorization links; never expose raw CLI output.
export function loginInstructions(provider: Provider, raw: string) {
  const plain = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const urls = plain.match(/https:\/\/[^\s<>"']+/g) || [];
  const url = urls.find(value => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password && (provider === "codex_cli"
        ? parsed.hostname === "auth.openai.com" && (parsed.pathname.startsWith("/codex/") || parsed.pathname.startsWith("/oauth/"))
        : ["claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com"].includes(parsed.hostname) && /^\/(?:cai\/)?oauth\/authorize$/.test(parsed.pathname));
    } catch { return false; }
  });
  return { ...(url ? { url } : {}), ...(provider === "codex_cli" && plain.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/) ? { code: plain.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)![0] } : {}) };
}
export class AccountService {
  private attempt: (LoginAttempt & { child?: ChildProcessWithoutNullStreams; timer?: ReturnType<typeof setTimeout>; output: string }) | null = null;
  constructor(readonly file: string, readonly probe = probeConnection, readonly launch = (provider: Provider) => spawn(providerCommand(provider), provider === "codex_cli" ? ["login", "--device-auth"] : ["auth", "login", "--claudeai"], { env: authEnv(), detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] })) {}
  async selection(): Promise<ModelSelection | null> {
    try { return ModelSelectionInput.parse(JSON.parse(await fs.readFile(this.file, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new WorkbenchError("model_settings", "Saved model settings could not be read. Reconnect your account.", 503); }
  }
  login(): LoginAttempt | null {
    if (!this.attempt) return null;
    const { id, provider, status, url, code, message } = this.attempt;
    return { id, provider, status, ...(url ? { url } : {}), ...(code ? { code } : {}), ...(message ? { message } : {}) };
  }
  async status(): Promise<AccountStatus> {
    const [codex, claude, selection] = await Promise.all([this.probe("codex_cli"), this.probe("claude_cli"), this.selection()]);
    return { enabled: true, mode: "local", selection: selection && (selection.provider === "codex_cli" ? codex : claude).loggedIn ? selection : null, connections: { codex_cli: codex, claude_cli: claude }, login: this.login() };
  }
  async save(input: unknown) {
    const value = ModelSelectionInput.parse(input);
    if (!(await this.probe(value.provider)).loggedIn) throw new WorkbenchError("login_required", "Finish signing in to this provider, then continue.", 401);
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomBytes(8).toString("hex")}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temp, this.file);
    return value;
  }
  async start(provider: Provider) {
    if (this.attempt && ["starting", "waiting"].includes(this.attempt.status)) throw new WorkbenchError("login_busy", "Finish or cancel the current sign-in first.", 409);
    const attempt: NonNullable<AccountService["attempt"]> = { id: randomUUID(), provider, status: "starting", output: "" };
    this.attempt = attempt;
    try {
      if (!(await this.probe(provider)).installed) throw new WorkbenchError("cli_missing", `Install ${provider === "codex_cli" ? "Codex" : "Claude Code"} on this computer, then retry.`, 503);
    } catch (error) { attempt.status = "failed"; throw error; }
    if (this.attempt !== attempt || attempt.status !== "starting") throw new WorkbenchError("login_cancelled", "Sign-in was cancelled. Start again when ready.", 409);
    let child: ChildProcessWithoutNullStreams;
    try { child = this.launch(provider); attempt.child = child; }
    catch (error) { attempt.status = "failed"; attempt.message = "The provider CLI could not start."; throw error; }
    attempt.timer = setTimeout(() => { attempt.status = "failed"; attempt.message = "Sign-in expired. Start again."; this.stopChild(attempt); }, 10 * 60 * 1000);
    attempt.timer.unref();
    const collect = (chunk: Buffer) => {
      if (!["starting", "waiting"].includes(attempt.status)) return;
      if (attempt.output.length > 64000) { attempt.status = "failed"; attempt.message = "Sign-in could not be completed. Try the terminal instructions."; this.stopChild(attempt); return; }
      attempt.output += chunk.toString();
      Object.assign(attempt, loginInstructions(provider, attempt.output));
      if (attempt.url) attempt.status = "waiting";
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.stdin.on("error", () => undefined);
    child.once("error", () => { attempt.status = "failed"; attempt.message = "The provider CLI could not start. Check its installation and retry."; this.stopChild(attempt); });
    child.once("close", async code => {
      clearTimeout(attempt.timer); attempt.output = ""; delete attempt.child;
      if (!["starting", "waiting"].includes(attempt.status)) return;
      const connected = code === 0 && (await this.probe(provider)).loggedIn;
      if (!["starting", "waiting"].includes(attempt.status)) return;
      attempt.status = connected ? "succeeded" : "failed";
      delete attempt.url; delete attempt.code;
      if (!connected) attempt.message = "Sign-in was not completed. Retry, or sign in from the terminal and check again.";
    });
    return this.login();
  }
  code(id: string, code: string) {
    const attempt = this.attempt;
    if (!attempt || attempt.id !== id || attempt.provider !== "claude_cli" || attempt.status !== "waiting" || !attempt.child?.stdin.writable) throw new WorkbenchError("login_expired", "Start a new Anthropic sign-in.", 409);
    if (!/^[A-Za-z0-9_#=./+~-]{10,2048}$/.test(code)) throw new WorkbenchError("invalid_code", "Paste the authorization code shown by Anthropic.", 400);
    attempt.child.stdin.write(`${code}\n`);
  }
  cancel() { if (this.attempt) { this.attempt.status = "cancelled"; this.stopChild(this.attempt); } }
  private stopChild(attempt: NonNullable<AccountService["attempt"]>) {
    clearTimeout(attempt.timer);
    if (attempt.child?.pid && process.platform !== "win32") { try { process.kill(-attempt.child.pid, "SIGKILL"); } catch { attempt.child.kill("SIGKILL"); } }
    else attempt.child?.kill("SIGKILL");
    attempt.output = ""; delete attempt.url; delete attempt.code;
  }
  async disconnect() { this.cancel(); await fs.rm(this.file, { force: true }); }
  close() { this.cancel(); }
}
export function localAccountRequest(request: IncomingMessage) {
  const host = new URL(`http://${request.headers.host || "invalid"}`).hostname;
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress || "");
  if (!loopback || !["localhost", "127.0.0.1", "[::1]"].includes(host)) throw new WorkbenchError("local_only", "Account connections are available only on this computer. Use localhost to connect.", 403);
  if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) throw new WorkbenchError("origin_denied", "Connect your account from Meld’s own browser address.", 403);
  if (request.headers["sec-fetch-site"] === "cross-site") throw new WorkbenchError("origin_denied", "Use Meld’s own browser address.", 403);
}
export function accountApi(service: AccountService): ApiPlugin {
  const middleware: import("./http").Middleware = async (request, response, next) => {
    if (!request.url?.startsWith("/api/")) return next();
    try {
      if (!request.url.startsWith("/api/account/")) return modelSelectionContext.run(await service.selection(), next);
      localAccountRequest(request);
      if (request.url === "/api/account/status" && request.method === "GET") return send(response, 200, await service.status());
      if (request.method !== "POST") throw new WorkbenchError("not_found", "Endpoint not found.", 404);
      const input = await readBody(request);
      if (request.url === "/api/account/login") return send(response, 202, { login: await service.start(ProviderInput.parse(input).provider) });
      if (request.url === "/api/account/model") return send(response, 200, { selection: await service.save(input) });
      if (request.url === "/api/account/code") {
        const parsed = z.object({ id: z.string().uuid(), code: z.string().min(1).max(2048) }).strict().parse(input);
        service.code(parsed.id, parsed.code); return send(response, 200, { accepted: true });
      }
      if (request.url === "/api/account/cancel") { service.cancel(); return send(response, 200, { cancelled: true }); }
      if (request.url === "/api/account/disconnect") { await service.disconnect(); return send(response, 200, { disconnected: true }); }
      throw new WorkbenchError("not_found", "Endpoint not found.", 404);
    } catch (error) {
      const e = error as WorkbenchError;
      return send(response, error instanceof z.ZodError ? 400 : e.status || 500, { error: { code: e.code || "account_failed", message: error instanceof z.ZodError ? "Choose valid account and model settings." : e.status ? e.message : "The account connection could not be completed. Retry." } });
    }
  };
  return { name: "meld-local-account", configureServer(server) { server.httpServer?.once("close", () => service.close()); server.middlewares.use(middleware); }, configurePreviewServer(server) { server.httpServer?.once("close", () => service.close()); server.middlewares.use(middleware); } };
}
