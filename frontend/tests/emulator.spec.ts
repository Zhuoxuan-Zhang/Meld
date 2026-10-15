import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendFile } from "node:fs/promises";
import { BrowserEmulator, AdbEmulatorDriver, EmulatorInput } from "../../backend/src/emulator";
import type { EmulatorDriver, PreviewInput } from "../../backend/src/emulator";
import { projectServer, idea } from "./project-fixtures";
import type { Project, Job } from "../../shared/contracts";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
class FixtureDriver implements EmulatorDriver {
  inputs: PreviewInput[] = []; installs = 0; stops = 0; captures = 0;
  async install() { this.installs++; } async launch() {} async capture() { this.captures++; return png; }
  async input(input: PreviewInput) { this.inputs.push(input); } async stop() { this.stops++; }
}
const binding = { projectId: "project-fixture", buildId: "job-fixture", apk: "fixture.apk", apkSha256: "a".repeat(64) };
test("emulator sessions isolate projects, deduplicate starts, serialize input and release the phone", async () => {
  const driver = new FixtureDriver(), emulator = new BrowserEmulator(() => driver);
  try {
    const session = await emulator.start(binding); expect((await emulator.start(binding)).id).toBe(session.id);
    await expect.poll(() => emulator.status(binding.projectId, binding.buildId, session.id).status).toBe("ready");
    await expect(emulator.start({ ...binding, projectId: "another-project" })).rejects.toThrow("Another app");
    expect(() => emulator.status("another-project", binding.buildId, session.id)).toThrow("ended");
    await emulator.input(binding.projectId, binding.buildId, session.id, { type: "tap", x: .5, y: .4 });
    await Promise.all([emulator.frame(binding.projectId, binding.buildId, session.id), emulator.frame(binding.projectId, binding.buildId, session.id)]);
    expect(driver.installs).toBe(1); expect(driver.captures).toBe(2); expect(driver.inputs).toEqual([{ type: "tap", x: .5, y: .4 }]);
    await emulator.stop(binding.projectId, binding.buildId, session.id); expect(driver.stops).toBe(1);
    expect(() => emulator.status(binding.projectId, binding.buildId, session.id)).toThrow("ended");
    expect((await emulator.start({ ...binding, projectId: "another-project" })).id).not.toBe(session.id);
  } finally { emulator.close(); }
});
test("emulator input accepts bounded gestures and quotes text without offering arbitrary commands", async () => {
  expect(EmulatorInput.safeParse({ type: "tap", x: -1, y: .5 }).success).toBe(false);
  expect(EmulatorInput.safeParse({ type: "shell", command: "anything" }).success).toBe(false);
  expect(EmulatorInput.safeParse({ type: "text", text: "你好" }).success).toBe(false);
  const driver = new AdbEmulatorDriver({ sdk: "unused", avdHome: "unused", avd: "preview", port: 5582 });
  const calls: string[][] = []; (driver as any).adb = async (args: string[]) => { calls.push(args); return Buffer.alloc(0); };
  await driver.input({ type: "tap", x: 1, y: .5 }, 720, 1280);
  await driver.input({ type: "text", text: "hello '; $(touch /tmp/not-run)" }, 720, 1280);
  expect(calls[0]).toEqual(["shell", "input", "tap", "719", "640"]);
  expect(calls[1].slice(0, 3)).toEqual(["shell", "input", "text"]); expect(calls[1][3]).toBe("'hello%s'\\'';%s$(touch%s/tmp/not-run)'");
});
test("delivery opens and operates the exact built APK in a browser; changed APKs are rejected", async ({ page }) => {
  test.setTimeout(60000);
  const api = await projectServer(); const driver = new FixtureDriver(), emulator = new BrowserEmulator(() => driver); api.options.emulator = emulator;
  try {
    const create = await fetch(api.address + "/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestKey: randomUUID(), brief: idea, exampleId: "notes" }) }); const project: Project = await create.json();
    const build = await api.service.build(project.id, { requestKey: randomUUID(), expectedVersion: project.version, revision: project.currentDesignRevision! }); await api.service.idle();
    const complete: Job = await api.service.job(build.id); expect(complete.status).toBe("succeeded");
    await page.route("**/api/**", async route => { const request = route.request(), url = new URL(request.url()); const response = await page.request.fetch(api.address + url.pathname + url.search, { method: request.method(), headers: { Origin: api.address, ...(request.postData() ? { "Content-Type": "application/json" } : {}) }, data: request.postData() || undefined }); await route.fulfill({ response }); });
    await page.goto(`/?project=${project.id}`); await page.getByRole("button", { name: "Try app in browser" }).click();
    const screen = page.getByAltText("Interactive Android screen"); await expect(screen).toBeVisible(); await screen.click();
    const response = await fetch(api.address + `/api/projects/${project.id}/builds/${build.id}/emulator/not-this-session`); expect(response.status).toBe(404);

    await expect.poll(() => driver.inputs.some(input => input.type === "tap")).toBe(true);
    const bounds = await screen.boundingBox();
    await page.mouse.move(bounds!.x + bounds!.width * .5, bounds!.y + bounds!.height * .8); await page.mouse.down();
    await page.mouse.move(bounds!.x + bounds!.width * .5, bounds!.y + bounds!.height * .2, { steps: 8 }); await page.mouse.up();
    await expect.poll(() => driver.inputs.some(input => input.type === "swipe" && input.endY < input.y)).toBe(true);

    await page.getByLabel("Type into the app", { exact: true }).fill("Hello Android"); await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => driver.inputs.some(input => input.type === "text" && input.text === "Hello Android")).toBe(true);
    await page.getByRole("button", { name: "Back", exact: true }).click(); await expect.poll(() => driver.inputs.some(input => input.type === "key" && input.key === "back")).toBe(true);
    await page.getByRole("button", { name: "Close preview" }).click(); await expect(screen).toHaveCount(0); expect(driver.stops).toBe(1);
    await appendFile(path.join(api.options.directory, "builds", build.id, "artifacts/app.apk"), "changed");
    const changedResponse = await fetch(api.address + `/api/projects/${project.id}/builds/${build.id}/emulator`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); expect(changedResponse.status).toBe(409); expect((await changedResponse.json()).error.code).toBe("artifact_changed");
    expect(driver.installs).toBe(1);
  } finally { await page.unrouteAll({ behavior: "wait" }).catch(() => undefined); emulator.close(); await api.close(); }
});
