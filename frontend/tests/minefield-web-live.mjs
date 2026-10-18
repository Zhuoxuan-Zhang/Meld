// Opt-in verification of the imported Minefield Plus project. No model calls.
// Opening preview installs the verified APK into the dedicated browser-preview AVD.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.MELD_BASE_URL || "http://127.0.0.1:4173";
const projectId = "project-c5807b8e-f6f8-40f4-8506-966b751fe176";
const output = new URL("../../outputs/minefield-plus-web/", import.meta.url);
await mkdir(output, { recursive: true });
const receipt = JSON.parse(await readFile(new URL("../../outputs/minefield-plus/release-v1.json", import.meta.url)));
const browser = await chromium.launch({ executablePath: process.env.MELD_BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  const projectResponse = await page.request.get(`${base}/api/projects/${projectId}`);
  assert.equal(projectResponse.status(), 200);
  const project = await projectResponse.json();
  assert.equal(project.featurePreferences.baseAppId, "dev.lucanlm.antimine");
  assert.deepEqual(project.featurePreferences.selections["org.andstatus.game2048"], ["org.andstatus.game2048:one-step-undo"]);
  assert.deepEqual(project.featurePreferences.selections["com.kaajjo.libresudoku"], ["com.kaajjo.libresudoku:pencil-marks"]);
  assert.equal(project.latestBuild.status, "succeeded");
  assert.equal(project.latestBuild.revision, project.currentDesignRevision);
  assert.equal(project.latestBuild.validation.runtimeVerified, true);
  const list = await (await page.request.get(`${base}/api/projects`)).json();
  assert(list.projects.some(p => p.id === projectId && p.name === "Minefield Plus"));
  await page.goto(`${base}/?project=${projectId}`);
  await page.getByRole("heading", { name: "Your Android app is ready." }).waitFor();
  await page.locator(".studio-base-summary").getByText("Antimine", { exact: true }).waitFor();
  await page.screenshot({ path: new URL("01-web-delivery.png", output).pathname, fullPage: true });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download Android app" }).click();
  const download = await downloadPromise;
  const target = new URL("downloaded-app.apk", output).pathname;
  await download.saveAs(target);
  assert.equal(createHash("sha256").update(await readFile(target)).digest("hex"), receipt.apkSha256);
  const developer = project.design.artifacts.find(a => a.name === "developer.html");
  const developerResponse = await page.request.get(base + developer.url);
  assert.equal(developerResponse.status(), 200);
  assert((await developerResponse.text()).includes("feat-pencil-mark"));
  await page.getByRole("button", { name: "Back to your design" }).click();
  await page.getByRole("heading", { name: "Your app, in plain language." }).waitFor();
  await page.getByText("单步撤销 · 借鉴 2048", { exact: true }).first().waitFor();
  await page.getByText("数字标记 · 借鉴 LibreSudoku", { exact: true }).first().waitFor();
  await page.screenshot({ path: new URL("02-web-design.png", output).pathname, fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Overflow at ${width}`);
    await page.screenshot({ path: new URL(`03-web-mobile-${width}.png`, output).pathname, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.reload();
  await page.getByRole("heading", { name: "Your Android app is ready." }).waitFor();
  const start = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/emulator"));
  await page.getByRole("button", { name: "Try app in browser" }).click();
  const response = await start;
  assert.equal(response.status(), 202, await response.text());
  const session = await response.json();
  const sessionUrl = `${base}/api/projects/${projectId}/builds/${project.latestBuild.id}/emulator/${session.id}`;
  console.log("Waiting for browser Android preview…");
  const image = page.getByRole("img", { name: "Interactive Android screen. Click or swipe to use the app." });
  await image.waitFor({ timeout: 240000 });
  const current = await (await page.request.get(sessionUrl)).json();
  assert.equal(current.status, "ready"); assert.equal(current.apkSha256, receipt.apkSha256);
  await image.click({ position: { x: (await image.boundingBox()).width / 2, y: (await image.boundingBox()).height * .48 } });
  await page.waitForTimeout(1500);
  const frame = await page.request.get(sessionUrl + "/frame");
  assert.equal(frame.status(), 200);
  await writeFile(new URL("04-android-preview.png", output), await frame.body());
  await page.screenshot({ path: new URL("05-web-preview.png", output).pathname, fullPage: true });
  await page.getByRole("button", { name: "Close preview" }).click();
  assert.deepEqual(errors, []);
  const report = { passed: true, projectId, buildId: project.latestBuild.id, revision: project.currentDesignRevision, apkSha256: receipt.apkSha256, url: `${base}/?project=${projectId}`, checks: ["History entry", "Antimine base and borrowed feature selections", "Readable and developer designs", "Browser APK download exact hash", "390/320px layout", "Reload persistence", "Real browser Android preview and pointer input"], browserErrors: errors, modelCalls: 0, originalPipelineMarkedSuccessful: false };
  await writeFile(new URL("web-report.json", output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({ path: new URL("failure.png", output).pathname, fullPage: true }).catch(() => {});
  throw error;
} finally { await browser.close(); }
