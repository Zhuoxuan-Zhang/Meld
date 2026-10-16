// Opt-in real Codex and Android build through the browser. Publishes an owned
// example project, confirms a color change and consumes model/build resources.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
const base = process.env.MELD_BASE_URL || "http://127.0.0.1:4173", directory = "qa-screenshots/project-flow";
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.MELD_BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = []; page.on("pageerror", error => errors.push(error.message));
try {
  const resumeProject = process.env.MELD_LIVE_PROJECT;
  await page.goto(resumeProject ? `${base}/?project=${resumeProject}` : base);
  if (!resumeProject) { await page.getByRole("button", { name: "Try the Notes example" }).waitFor();
  await page.screenshot({ path: `${directory}/01-describe.png`, fullPage: true });
  await page.getByRole("button", { name: "Try the Notes example" }).click();
  }
  if (resumeProject) { await page.getByRole("complementary").getByRole("heading", { name: "Offline Notes", exact: true }).waitFor(); await page.getByRole("button", { name: /Review and customize/ }).click(); }
  await page.getByRole("heading", { name: "Your app, in plain language." }).waitFor();
  const id = new URL(page.url()).searchParams.get("project");
  if (!id) throw new Error("No server-owned project ID");
  const read = async () => { const response = await page.request.get(`${base}/api/projects/${id}`); if (!response.ok()) throw new Error(await response.text()); return response.json(); };
  const waitProject = async (predicate, timeout) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const p = await read(); if (predicate(p)) return p; await new Promise(resolve => setTimeout(resolve, 1000)); }
    throw new Error("Project state did not reach the expected state");
  };
  const before = await read();
  await page.screenshot({ path: `${directory}/02-review-before.png`, fullPage: true });
  if (!resumeProject) {
  await page.getByLabel("What would you like to change?", { exact: true }).fill("Use warm brown #7B4D21 as the main accent color. Preserve every current feature, saving rule and deletion behavior.");
  await page.getByRole("button", { name: "Review suggested changes" }).click();
  console.log("Waiting for the real model proposal…");
  await page.getByRole("heading", { name: "Choose what to keep." }).waitFor({ timeout: 600000 });
  if ((await read()).currentDesignRevision !== before.currentDesignRevision) throw new Error("The proposal changed the design before confirmation");
  await page.screenshot({ path: `${directory}/03-proposal.png`, fullPage: true });
  await page.getByRole("button", { name: "Confirm selected changes" }).click();
  await waitProject(p => p.currentDesignRevision !== before.currentDesignRevision && !p.activeJobId, 600000);
  }
  await page.reload(); if (resumeProject) { await page.getByRole("complementary").getByRole("heading", { name: "Offline Notes", exact: true }).waitFor(); await page.getByRole("button", { name: /Review and customize/ }).click(); } await page.getByRole("heading", { name: "Your app, in plain language." }).waitFor();
  const after = await read();
  const inputResponse = await page.request.get(`${base}/api/projects/${id}/build-input`), input = await inputResponse.json();
  const primary = input.developer_design.visual.colors.find(c => c.role === "primary").value;
  if (primary.toUpperCase() !== "#7B4D21") throw new Error(`Unexpected primary ${primary}`);
  await page.screenshot({ path: `${directory}/04-review-confirmed.png`, fullPage: true });
  for (const width of [390, 320]) { await page.setViewportSize({ width, height: 1000 }); if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Overflow at ${width}`); await page.screenshot({ path: `${directory}/review-${width}.png`, fullPage: true }); }
  await page.setViewportSize({ width: 1440, height: 1100 });
  console.log(`Building project ${id} from ${after.currentDesignRevision}…`);
  if (after.latestBuild?.status !== "running") {
    await page.getByRole("button", { name: "Approve and build" }).click();
    await waitProject(p => p.latestBuild?.id && p.latestBuild.id !== after.latestBuild?.id, 30000);
  }
  const deadline = Date.now() + 2400000;
  let finished;
  while (Date.now() < deadline) {
    finished = await read();
    if (finished.latestBuild?.status === "failed") throw new Error(`Real build failed: ${finished.latestBuild.id}`);
    if (finished.latestBuild?.status === "succeeded") break;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  if (finished?.latestBuild?.status !== "succeeded") throw new Error("Android build timed out");
  await page.getByRole("heading", { name: "Your Android app is ready." }).waitFor();
  const complete = await read();
  if (complete.latestBuild.revision !== after.currentDesignRevision || complete.approvedRevision !== after.currentDesignRevision) throw new Error("Build/revision mismatch");
  await page.screenshot({ path: `${directory}/05-get-app.png`, fullPage: true });
  const download = page.waitForEvent("download"); await page.getByRole("link", { name: "Download Android app" }).click(); const apk = await download; await apk.saveAs(`${directory}/generated-notes.apk`);
  await page.reload(); await page.getByRole("heading", { name: "Your Android app is ready." }).waitFor();
  const report = { passed: true, mode: "Actual React UI + project backend + real Codex + Gradle; scripted confirmation", projectId: id, url: `${base}/?project=${id}`, before: before.currentDesignRevision, after: after.currentDesignRevision, buildId: complete.latestBuild.id, build: complete.latestBuild, primary, browserErrors: errors, freshTopFiveAnalysisPerformed: false, source: "Fork of the real existing Notes analysis; original workspace preserved" };
  if (errors.length) throw new Error(errors.join("; "));
  await writeFile(`${directory}/live-report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
