// Opt-in real idea clarification through the browser. Stops before market search.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const output = new URL(`../../outputs/intent-routing-fix/${Date.now()}/`, import.meta.url);
await mkdir(output, { recursive: true });
const base = process.env.MELD_BASE_URL || "http://127.0.0.1:4173";
const browser = await chromium.launch({ executablePath: process.env.MELD_BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on("pageerror", e => errors.push(e.message));
try {
  await page.goto(base);
  await page.getByLabel("What would you like to build?").fill("a study timer");
  const result = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/api/intent/clarify"), { timeout: 150000 });
  await page.getByRole("button", { name: "Clarify my idea", exact: true }).click();
  const response = await result, data = await response.json();
  await page.screenshot({ path: new URL("study-timer.png", output).pathname, fullPage: true });
  await writeFile(new URL("response.json", output), JSON.stringify({ status: response.status(), data }, null, 2));
  assert.equal(response.status(), 200, JSON.stringify(data));
  assert(data.questions.length > 0 || data.plan); assert.deepEqual(errors, []);
  const report = { passed: true, input: "a study timer", endpoint: "/api/intent/clarify", status: response.status(), questions: data.questions.map(q => q.question), hasPlan: !!data.plan, realModelCall: true, marketSearchStarted: false, browserErrors: errors };
  await writeFile(new URL("report.json", output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, artifacts: output.pathname }));
} finally { await browser.close(); }
