// Real backend/model verification, with scripted confirmation. Opt-in only.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const base = process.env.MELD_LIVE_URL || "http://127.0.0.1:4173";
const id = process.env.MELD_LIVE_DESIGN || "notes";
const output = "qa-screenshots/design";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.MELD_BROWSER_EXECUTABLE ? { executablePath: process.env.MELD_BROWSER_EXECUTABLE } : { channel: "chrome" }) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const problems = [];
page.on("pageerror", error => problems.push(error.message));
const api = async path => { const response = await fetch(base + path); assert.equal(response.ok, true); return response.json(); };
try {
  const before = await api(`/api/design/designs/${id}`);
  await page.goto(`${base}/?design=${encodeURIComponent(id)}#/review`);
  const panel = page.getByRole("region", { name: "Interactive design document" });
  await panel.locator(".design-version").waitFor();
  await page.screenshot({ path: `${output}/notes-before.png`, fullPage: true });
  await panel.getByLabel("What would you like to change?").fill("Use deep green #246B4A as the main accent color. Preserve every current feature, saving rule and deletion behavior.");
  await panel.getByRole("button", { name: "Suggest changes" }).click();
  console.log("Waiting for a real model proposal…");
  await panel.getByRole("heading", { name: "Choose what to keep", exact: true }).waitFor({ timeout: 900000 });
  assert.equal((await api(`/api/design/designs/${id}`)).revision, before.revision);
  await panel.locator(".design-proposal").screenshot({ path: `${output}/notes-live-proposal.png` });
  await panel.getByRole("button", { name: "Confirm selected changes" }).click();
  console.log("Confirming the precompiled changes; waiting for validation and explanation…");
  await page.waitForFunction(version => document.querySelector(".design-version")?.textContent !== `Design v${version}`, before.version, { timeout: 900000 });
  const after = await api(`/api/design/designs/${id}`), build = await api(`/api/design/designs/${id}/build-input`);
  assert.equal(after.version, before.version + 1); assert.equal(after.implementation.status, "pending_update");
  assert.equal(build.developer_design.visual.colors.find(color => color.role === "primary").value.toLowerCase(), "#246b4a");
  await page.screenshot({ path: `${output}/notes-after-desktop.png`, fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${output}/notes-after-${width}.png`, fullPage: true });
  }
  assert.deepEqual(problems, []);
  await writeFile(`${output}/live-report.json`, JSON.stringify({ passed: true, mode: "Real Codex calls through the actual React UI and backend; scripted confirmation", before: before.revision, after: after.revision, implementation: after.implementation, primary_color: build.developer_design.visual.colors.find(color => color.role === "primary").value, browser_errors: problems }, null, 2));
  console.log(JSON.stringify({ passed: true, revision: after.revision, implementation: after.implementation }, null, 2));
} finally { await browser.close(); }
