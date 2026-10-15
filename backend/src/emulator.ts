import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { openSync, closeSync } from "node:fs";
import { z, WorkbenchError } from "../../pipeline/dist/src/integration.js";
import type { EmulatorSession } from "../../shared/contracts";

export const EmulatorInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap"), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
  z.object({ type: z.literal("swipe"), x: z.number().min(0).max(1), y: z.number().min(0).max(1), endX: z.number().min(0).max(1), endY: z.number().min(0).max(1), duration: z.number().int().min(100).max(1500) }).strict(),
  z.object({ type: z.literal("key"), key: z.enum(["back", "enter", "delete", "up", "down", "left", "right"]) }).strict(),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(300).regex(/^[\x20-\x7e]+$/, "Type English letters, numbers or punctuation.").refine(value => !value.includes("%s"), "The literal sequence %s is not supported.") }).strict(),
  z.object({ type: z.literal("restart") }).strict(),
]);
export type PreviewInput = z.infer<typeof EmulatorInput>;
export type EmulatorBinding = { projectId: string; buildId: string; apk: string; apkSha256: string };
export interface EmulatorDriver {
  install(apk: string): Promise<void>;
  launch(): Promise<void>;
  capture(): Promise<Buffer>;
  input(input: PreviewInput, width: number, height: number): Promise<void>;
  stop(): Promise<void>;
  close?(): void;
}
export function pngSize(png: Buffer) {
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new WorkbenchError("emulator_frame", "The Android screen could not be read.", 502);
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096) throw new WorkbenchError("emulator_frame", "The Android screen size is unsupported.", 502);
  return { width, height };
}

export class BrowserEmulator {
  private current?: { view: EmulatorSession; binding: EmulatorBinding; driver: EmulatorDriver; expires: number; frame?: Buffer; captured: number; capturing?: Promise<Buffer> };
  private tail: Promise<unknown> = Promise.resolve();
  private drivers = new Set<EmulatorDriver>();
  private warmTimer?: ReturnType<typeof setTimeout>;
  private timer: ReturnType<typeof setInterval>;
  constructor(readonly createDriver: () => EmulatorDriver, readonly idleMs = 10 * 60 * 1000) {
    this.timer = setInterval(() => { const session = this.current; if (session && session.expires < Date.now()) void this.stop(session.binding.projectId, session.binding.buildId, session.view.id).catch(() => undefined); }, 30000); this.timer.unref();
  }
  private find(projectId: string, buildId: string, id: string) {
    const session = this.current;
    if (!session || session.view.id !== id || session.binding.projectId !== projectId || session.binding.buildId !== buildId || session.expires < Date.now()) throw new WorkbenchError("emulator_expired", "This preview ended. Open it again to continue.", 404);
    session.expires = Date.now() + this.idleMs; return session;
  }
  async start(binding: EmulatorBinding): Promise<EmulatorSession> {
    clearTimeout(this.warmTimer);
    if (this.current && this.current.expires < Date.now()) await this.stop(this.current.binding.projectId, this.current.binding.buildId, this.current.view.id);
    if (this.current) {
      if (this.current.binding.projectId === binding.projectId && this.current.binding.buildId === binding.buildId && this.current.binding.apkSha256 === binding.apkSha256 && this.current.view.status !== "failed") { this.current.expires = Date.now() + this.idleMs; return this.current.view; }
      throw new WorkbenchError("emulator_busy", "Another app is using the browser preview. Close that preview, then try again.", 409);
    }
    const session = { view: { id: `emulator-${randomUUID()}`, projectId: binding.projectId, buildId: binding.buildId, apkSha256: binding.apkSha256, status: "starting" as EmulatorSession["status"], phase: "Starting your Android phone…", width: 0, height: 0 }, binding, driver: this.createDriver(), expires: Date.now() + this.idleMs, captured: 0, frame: undefined as Buffer | undefined };
    this.drivers.add(session.driver); this.current = session;
    this.tail = this.tail.then(async () => {
      try {
        if (this.current !== session) return;
        await session.driver.install(binding.apk); session.view.phase = "Opening your app…"; await session.driver.launch();
        const frame = await session.driver.capture(); Object.assign(session.view, pngSize(frame)); session.frame = frame; session.captured = Date.now(); session.view.status = "ready"; session.view.phase = "Your Android app is running.";
      } catch { session.view.status = "failed"; session.view.phase = "The Android preview could not start. Close it and try again."; }
    });
    return session.view;
  }
  status(projectId: string, buildId: string, id: string) { return this.find(projectId, buildId, id).view; }
  async frame(projectId: string, buildId: string, id: string) {
    const session = this.find(projectId, buildId, id);
    if (session.view.status !== "ready") throw new WorkbenchError("emulator_starting", session.view.phase, 409);
    if (session.frame && Date.now() - session.captured < 250) return session.frame;
    if (!session.capturing) session.capturing = session.driver.capture().then(frame => { Object.assign(session.view, pngSize(frame)); session.frame = frame; session.captured = Date.now(); return frame; }).finally(() => { session.capturing = undefined; });
    return session.capturing;
  }
  async input(projectId: string, buildId: string, id: string, input: PreviewInput) {
    const session = this.find(projectId, buildId, id);
    if (session.view.status !== "ready") throw new WorkbenchError("emulator_starting", session.view.phase, 409);
    // Serialize input and lifecycle work; arbitrary adb or shell commands are never accepted.
    const task = this.tail.then(async () => { if (this.current !== session) throw new WorkbenchError("emulator_expired", "This preview ended.", 404); if (input.type === "restart") await session.driver.launch(); else await session.driver.input(input, session.view.width, session.view.height); session.captured = 0; });
    this.tail = task.catch(() => undefined); await task;
  }
  async stop(projectId: string, buildId: string, id: string) {
    const session = this.current;
    if (!session || session.view.id !== id || session.binding.projectId !== projectId || session.binding.buildId !== buildId) throw new WorkbenchError("emulator_expired", "This preview already ended.", 404);
    // Reserve the device until cleanup finishes, including an in-flight installation.
    const task = this.tail.then(() => session.driver.stop()).finally(() => {
      if (this.current === session) this.current = undefined;
      this.warmTimer = setTimeout(() => { if (!this.current) { for (const driver of this.drivers) driver.close?.(); this.drivers.clear(); } }, this.idleMs); this.warmTimer.unref();
    });
    this.tail = task.catch(() => undefined); await task;
  }
  close() { clearInterval(this.timer); clearTimeout(this.warmTimer); for (const driver of this.drivers) driver.close?.(); this.drivers.clear(); this.current = undefined; }
}

type AndroidPreviewOptions = { sdk: string; avdHome: string; avd: string; port: number };
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export class AdbEmulatorDriver implements EmulatorDriver {
  private owned?: ChildProcess;
  private closed = false;
  private packageId?: string;
  private component?: string;
  private get serial() { return `emulator-${this.options.port}`; }
  constructor(readonly options: AndroidPreviewOptions) {}
  private environment() {
    const env: NodeJS.ProcessEnv = { ...process.env, ANDROID_AVD_HOME: this.options.avdHome, ANDROID_HOME: this.options.sdk, ANDROID_SDK_ROOT: this.options.sdk };
    for (const key of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN/.test(key)) delete env[key];
    return env;
  }
  private command(file: string, args: string[], timeout = 15000): Promise<Buffer> {
    if (this.closed) return Promise.reject(new WorkbenchError("emulator_closed", "The Android phone was closed.", 404));
    const env = this.environment();
    return new Promise((resolve, reject) => execFile(file, args, { env, timeout, maxBuffer: 12 * 1024 * 1024, encoding: "buffer" }, (error, stdout) => error ? reject(new WorkbenchError("emulator_device", "The Android preview device did not respond. Try again.", 502)) : resolve(stdout)));
  }
  private adb(args: string[], timeout?: number) { return this.command(path.join(this.options.sdk, "platform-tools/adb"), ["-s", this.serial, ...args], timeout); }
  private async boot() {
    let existing = "";
    try { existing = (await this.adb(["emu", "avd", "name"], 3000)).toString().split(/\r?\n/)[0].trim(); } catch { /* Start the dedicated preview AVD. */ }
    if (existing && existing !== this.options.avd) throw new WorkbenchError("emulator_port_busy", "This preview port belongs to another Android device. Choose a different MELD_EMULATOR_PORT.", 409);
    if (existing && (await this.adb(["shell", "getprop", "sys.boot_completed"], 3000)).toString().trim() === "1") return;
    const log = openSync(path.join(this.options.avdHome, "emulator-runtime.log"), "a", 0o600);
    this.owned = spawn(path.join(this.options.sdk, "emulator/emulator"), ["-avd", this.options.avd, "-port", String(this.options.port), "-no-window", "-no-audio", "-no-snapshot", "-no-boot-anim", "-gpu", "swiftshader_indirect"], { env: this.environment(), stdio: ["ignore", log, log] }); closeSync(log);
    let failed = false; this.owned.once("error", () => { failed = true; }); this.owned.once("exit", () => { failed = true; });
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline && !failed && !this.closed) { try { if ((await this.adb(["shell", "getprop", "sys.boot_completed"], 3000)).toString().trim() === "1") { await this.adb(["shell", "input", "keyevent", "82"]); return; } } catch { /* Poll during boot. */ } await new Promise(resolve => setTimeout(resolve, 1000)); }
    throw new WorkbenchError("emulator_boot", "The Android phone could not start.", 503);
  }
  async install(apk: string) {
    const badging = (await this.command(path.join(this.options.sdk, "build-tools/35.0.0/aapt2"), ["dump", "badging", apk])).toString();
    const packageId = badging.match(/^package: name='([^']+)'/m)?.[1], activity = badging.match(/^launchable-activity: name='([^']+)'/m)?.[1];
    if (!packageId || !/^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(packageId) || !activity || !/^[A-Za-z.][\w.$]*$/.test(activity)) throw new WorkbenchError("emulator_apk", "This APK does not have a supported launch activity.", 422);
    this.packageId = packageId; this.component = `${packageId}/${activity}`;
    await this.boot();
    await this.adb(["uninstall", packageId], 30000).catch(() => undefined);
    const installed = await this.adb(["install", "-r", apk], 90000);
    if (!installed.toString().includes("Success")) throw new WorkbenchError("emulator_install", "The APK could not be installed.", 502);
  }
  async launch() { if (!this.component || !this.packageId) throw new Error("No preview app"); await this.adb(["shell", "am", "force-stop", this.packageId]); const result = await this.adb(["shell", "am", "start", "-W", "-n", shellQuote(this.component)], 30000); if (/Error:|Exception/.test(result.toString())) throw new Error("Launch failed"); }
  capture() { return this.adb(["exec-out", "screencap", "-p"]); }
  async input(input: PreviewInput, width: number, height: number) {
    const x = (value: number) => String(Math.round(value * (width - 1))), y = (value: number) => String(Math.round(value * (height - 1)));
    if (input.type === "tap") await this.adb(["shell", "input", "tap", x(input.x), y(input.y)]);
    if (input.type === "swipe") await this.adb(["shell", "input", "swipe", x(input.x), y(input.y), x(input.endX), y(input.endY), String(input.duration)]);
    if (input.type === "key") await this.adb(["shell", "input", "keyevent", String({ back: 4, enter: 66, delete: 67, up: 19, down: 20, left: 21, right: 22 }[input.key])]);
    if (input.type === "text") await this.adb(["shell", "input", "text", shellQuote(input.text.replaceAll(" ", "%s"))]);
  }
  async stop() { if (this.packageId) await this.adb(["uninstall", this.packageId], 30000).catch(() => undefined); }
  close() { this.closed = true; this.owned?.kill("SIGTERM"); this.owned = undefined; }
}
