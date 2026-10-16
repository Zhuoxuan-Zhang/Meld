// Opt-in inspection of model-derived design artifacts, not native runtime proof.
import { chromium } from "playwright";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const run = path.resolve(process.argv[2]), directory = path.join(run, "validation/wireframe-inspection");
await mkdir(directory, { recursive: true });
const html = await readFile(path.join(run, "final/wireframes.html"), "utf8"), design = JSON.parse(await readFile(path.join(run, "final/final-design.json"), "utf8"));
const browser = await chromium.launch({ executablePath: process.env.MELD_BROWSER_EXECUTABLE });
const checks = {}, problems = [];
try {
  const page = await browser.newPage();
  await page.route("http://puzzle-design.local/**", route => route.fulfill({ contentType: "text/html", body: html }));
  for (const [label, width, font] of [["desktop", 1440, 1], ["mobile", 390, 1], ["large-font", 390, 2]]) {
    await page.setViewportSize({ width, height: 1000 }); await page.goto("http://puzzle-design.local/");
    if (font === 2) await page.addStyleTag({ content: "html {font-size:200%} .screen {font-size:32px} .button,.label,.field,.note,.message {font-size:32px} .toolbar{font-size:40px}" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    checks[`${label}_no_horizontal_overflow`] = !overflow;
    if (overflow) problems.push(`${label} overflows`);
    await page.screenshot({ path: path.join(directory, `${label}.png`), fullPage: true });
    if (label === "desktop") {
      const rendered = new Set(await page.locator("article[data-page]").evaluateAll(articles => articles.map(article => article.dataset.page)));
      checks.all_pages_rendered = design.pages.every(p => rendered.has(p.id));
      for (const p of design.pages) if (!rendered.has(p.id)) problems.push(`Missing page ${p.id}`);
      checks.no_notes_context_in_game_captions = !(await page.locator("article h2 small").allTextContents()).some(text => /· Notes|· Deleted/.test(text));
      if (!checks.no_notes_context_in_game_captions) problems.push("Game wireframes contain notes-app context labels");
      for (const p of design.pages) await page.locator(`article[data-page="${p.id}"]`).first().screenshot({ path: path.join(directory, `${p.id}.png`) });
    }
  }
} finally { await browser.close(); }
await writeFile(path.join(directory, "layout-report.json"), JSON.stringify({ passed: problems.length === 0, checks, problems, screenshots: directory, wireframe_sha256: createHash("sha256").update(html).digest("hex"), scope: "Programmatic browser layout checks; manual visual inspection must be recorded separately. This is not native app runtime verification." }, null, 2));
console.log(JSON.stringify({ passed: problems.length === 0, checks, problems, directory }));
if (problems.length) process.exitCode = 1;
