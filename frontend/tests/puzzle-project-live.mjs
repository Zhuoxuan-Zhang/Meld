// Opt-in real design import -> project API -> Android worker -> browser download.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { DesignService, pipelineRoot } from "../../pipeline/dist/src/integration.js";
import { validateRun } from "../../pipeline/dist/src/validate.js";
import { ProjectService } from "../../backend/src/projects.ts";
import { projectOptionsFromEnv } from "../../backend/src/api.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), frontend = path.join(root, "frontend");
process.loadEnvFile(path.join(frontend, ".env.local"));
const run = path.resolve(process.argv[2]), base = process.env.MELD_BASE_URL || "http://127.0.0.1:4173", directory = path.join(frontend, "qa-screenshots/puzzle-harbor");
await mkdir(directory, { recursive: true });
const verified = await validateRun(run); if (!verified.passed) throw new Error(`Analysis checks remain: ${verified.errors.join("; ")}`);
const options = projectOptionsFromEnv(process.env, frontend), sourceId = "puzzle-source-20261014";
const designs = new DesignService(pipelineRoot, options.designs.store.root);
const config = JSON.parse(await readFile(path.join(pipelineRoot, "config/runtime.workbench.json"), "utf8")); config.model_timeout_ms = 600000;
await designs.initialize(sourceId, run, config);
options.exampleId = sourceId; options.designs = designs;
const brief = JSON.parse(await readFile(path.join(run, "brief.json"), "utf8"));
const service = new ProjectService(options);
const project = await service.create({ requestKey: "puzzle-harbor-20261014", exampleId: sourceId, brief: { name: "Puzzle Harbor", input: "An offline puzzle arcade with 2048, Minesweeper and Sudoku, reliable saved progress and shared statistics/settings.", audience: brief.target_users, purpose: "Play three classic logic games in one consistent Android app.", goal: "Enjoy different puzzles while keeping progress safely on your phone.", style: "ink", domains: [], coreTasks: brief.core_tasks, requiredStates: brief.required_states } });
const url = `${base}/?project=${project.id}`;
await writeFile(path.join(directory, "project.json"), JSON.stringify({ projectId: project.id, url, sourceRun: run, sourceDesignId: sourceId }, null, 2));
console.log(`Project ${project.id}: ${url}`);
const browser = await chromium.launch({ executablePath: process.env.MELD_BROWSER_EXECUTABLE || "/home/zhuoxuan/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome" });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); page.on("pageerror", error => errors.push(error.message));
  await page.goto(url); await page.getByRole("complementary").getByRole("heading", { name: project.brief.name, exact: true }).waitFor();
  await page.getByRole("button", { name: /Review and customize/ }).click(); await page.getByRole("heading", { name: "Your app, in plain language." }).waitFor();
  await page.screenshot({ path: path.join(directory, "design-desktop.png"), fullPage: true });
  const read = async () => { const response = await page.request.get(`${base}/api/projects/${project.id}`); if (!response.ok()) throw new Error(await response.text()); return response.json(); };
  let saved = await read();
  const text = JSON.stringify(saved.design.document);
  for (const mode of ["2048", "Minesweeper", "Sudoku"]) if (!text.includes(mode)) throw new Error(`Readable document omits ${mode}`);
  await page.setViewportSize({ width: 390, height: 1000 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Review workspace overflows");
  await page.screenshot({ path: path.join(directory, "design-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1050 });
  if (saved.latestBuild?.status !== "running" && saved.latestBuild?.status !== "succeeded") await page.getByRole("button", { name: "Approve and build" }).click();
  const deadline = Date.now() + 7200000; let started = false;
  while (Date.now() < deadline) {
    saved = await read();
    started ||= Boolean(saved.latestBuild?.id && saved.latestBuild.id !== project.latestBuild?.id) || saved.latestBuild?.status === "running" || saved.latestBuild?.status === "succeeded";
    if (started && saved.latestBuild?.status === "failed") throw new Error(`Build failed: ${saved.latestBuild.id}`);
    if (saved.latestBuild?.status === "succeeded") break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (saved.latestBuild?.status !== "succeeded") throw new Error("Build timed out");
  if (saved.latestBuild.revision !== saved.currentDesignRevision || saved.approvedRevision !== saved.currentDesignRevision) throw new Error("APK revision differs from approved design");
  await page.reload(); await page.getByRole("heading", { name: "Your Android app is ready." }).waitFor();
  await page.screenshot({ path: path.join(directory, "delivery.png"), fullPage: true });
  const download = page.waitForEvent("download"); await page.getByRole("link", { name: "Download Android app" }).click(); await (await download).saveAs(path.join(directory, "puzzle-harbor.apk"));
  if (errors.length) throw new Error(errors.join("; "));
  await writeFile(path.join(directory, "generation-report.json"), JSON.stringify({ passed: true, sourceRun: run, projectId: project.id, url, revision: saved.currentDesignRevision, build: saved.latestBuild, browserErrors: errors, scope: "Actual APK analysis/model design, real readable-document generation, project API, Android code generation/Gradle and browser download. Native device interaction is checked separately." }, null, 2));
  console.log(JSON.stringify({ passed: true, projectId: project.id, revision: saved.currentDesignRevision, buildId: saved.latestBuild.id, apk: path.join(directory, "puzzle-harbor.apk") }));
} finally { await browser.close(); }
