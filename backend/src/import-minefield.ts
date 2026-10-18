/** Import the already verified standalone app into local web history. No model calls. */
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { DesignService, RevisionData, UserDocument, semanticHash, fileSha, json, write, exists, withLock } from "../../pipeline/dist/src/integration.js";
import { designErrors, readableErrors } from "../../pipeline/dist/src/workbench/validation.js";
import { renderDocuments } from "../../pipeline/dist/src/workbench/render.js";
import { HighLevelDocument } from "./high-level";
import type { Project, Build } from "../../shared/contracts";
import type { MarketApp, MarketResult } from "../../shared/market";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cache = path.resolve(process.env.MELD_IMPORT_CACHE || path.join(root, "frontend/.meld-cache"));
const run = path.join(root, "pipeline/runs/2026-10-16T22-29-31-419Z-96344b");
const delivery = path.join(root, "outputs/minefield-plus");
const projectId = "project-c5807b8e-f6f8-40f4-8506-966b751fe176";
const buildId = "job-072531a1-038c-42a4-ad9b-7d824b1b93ef";
const designId = "design-minefield-plus-import-v1";
const requestKey = "import-verified-minefield-plus-v1";

function alignImplementedDesign(design: any) {
  const feature = (id: string) => design.features.find((f: any) => f.id === id);
  feature("feat-flag").behavior = "Long-press a covered cell or tap in Flag mode to toggle a flag. At most ten flags; flags block reveal/flood and clear marks. Undo restores the prior mark.";
  feature("feat-undo").behavior = "Undo restores the complete board snapshot before the last reveal/flag, including seed, phase, marks and timer, then consumes the slot. Undo of a terminal move retracts that game's outcome; re-finishing records it once. Mode changes preserve undo; an annotation edit clears the older slot. Undo is disabled while paused.";
  feature("feat-pencil-mark").behavior = "Choose Pencil mode and tap a covered unflagged cell, or use Mark cell in the larger controls. Pick 1–8 or Clear mark. These are personal guesses, not hints. Editing a mark clears the previous undo slot.";
  feature("feat-restart-resume").behavior = "New Game asks confirmation; cancellation preserves the board. Publish the new board only after saving succeeds. Persist board, undo, outcomes, pause, mode and preferences atomically. Unreadable saves require Retry or explicit preserve-and-start-fresh recovery.";
  const game = design.pages.find((p: any) => p.id === "page-game");
  game.events.find((e: any) => e.id === "evt-longpress").action = "Toggle a flag only; Pencil mode or the larger Mark cell control opens the mark picker.";
  game.events.find((e: any) => e.id === "evt-pencil").action = "Set/clear mark on a covered unflagged cell, clear the older undo slot and persist the session.";
  game.events.find((e: any) => e.id === "evt-undo").action = feature("feat-undo").behavior;
  game.events.forEach((e: any) => { if (/save failure|persistence fails/i.test(e.error_recovery)) e.error_recovery = "Show the save error and Retry save; keep the pending session in memory and block further board edits. A failed new-game save retains the previous board."; });
  game.states.find((s: any) => s.kind === "unsaved_changes").message = "Progress is not saved yet. Stay and retry before leaving.";
  game.states.find((s: any) => s.kind === "error").message = "Progress isn't saved yet. Free some space, then retry.";
  game.back_behavior = "Back closes dialogs; from Game it exits after saves complete. Pending/failed saves show Stay/Retry rather than claiming exiting is safe.";
  game.components.find((c: any) => c.id === "cmp-toolbar").text = "Mines left, elapsed time, Reveal / Flag / Pencil modes, Undo, Pause/Resume and New game";
  game.components.push({ id: "cmp-pause", parent_id: "", type: "Button", text: "Pause / Resume", binding: "board.paused", event_ids: ["evt-pause"] });
  game.events.push({ id: "evt-pause", trigger: "Pause/Resume", action: "Toggle persisted pause during active play; hide board while paused. Timer also stops on other tabs, dialogs and background activity.", state_change: "paused toggled and full session saved", target_page_id: "", error_recovery: "Retain pending session and offer Retry save." });
  game.validation.push("Revealed cells flatten into the board background; covered cells retain borders.", "Larger Previous/Next and Reveal/Flag/Mark controls provide an alternative to compact grid cells.");
  design.flows.find((f: any) => f.id === "flow-annotate").steps[0].operation = "Choose Pencil mode and tap a covered unflagged cell, or choose Mark cell; select 1–8 or clear.";
  design.flows.find((f: any) => f.id === "flow-undo").completion = feature("feat-undo").behavior;
  design.flows.find((f: any) => f.id === "flow-resume").failure_recovery = "Show a load error without overwriting unreadable data. Retry loading or explicitly archive the original save and start fresh with reset statistics/settings.";
  for (const flow of design.flows) if (/retry|retries/i.test(flow.failure_recovery)) flow.failure_recovery = "Retain the pending session in memory, show the failure and offer Retry save. Do not claim persistence until commit succeeds.";
  const board = design.entities.find((e: any) => e.id === "ent-board");
  board.fields.find((f: any) => f.name === "id").validation = "Unique per-game UUID; one current board in the session file.";
  board.persistence = "AtomicFile files/session.json, version 1; complete board, undo snapshot, settings and unique game-ID outcomes commit together after actions and active timer ticks.";
  const undo = design.entities.find((e: any) => e.id === "ent-undo");
  undo.fields = [{ name: "previousBoard", type: "complete Board snapshot", nullable: true, validation: "Same game ID and seed; pre-action nonterminal board with full cells, phase and timer", default_value: "null" }];
  undo.persistence = "One embedded complete before-board snapshot; consumed on undo, cleared on new game or changed pencil mark.";
  design.entities.find((e: any) => e.id === "ent-stats").persistence = "Unique game-ID outcomes in the same atomic session file. Terminal undo removes the current result. Only completed games count; abandoned boards do not count.";
  design.pages.find((p: any) => p.id === "page-settings").components.find((c: any) => c.id === "cmp-flagdefault-toggle").text = "Start new games in Flag mode; resumed boards retain their saved mode.";
  design.visual.colors.push({ role: "Light cell border", value: "#7D8792" }, { role: "Dark cell border", value: "#7B8794" });
  design.visual.colors.find((c: any) => c.role === "Light flag").value = "#805600";
  design.visual.spacing = ["Grid cells 32–36dp, gap 2dp; narrow windows scroll horizontally", "Main page padding 16dp; compact title and metrics keep core controls visible", "Larger selected-cell controls use at least 48dp touch targets"];
  design.compose.repository_responsibilities = ["Persist one versioned atomic session after every action and active timer tick", "Serialize writes off the main thread; preserve failed edits in memory for explicit Retry", "New-game replacement publishes only after successful commit", "Recover incomplete .new/legacy .bak writes; archive unreadable saves only after explicit user confirmation", "Count outcomes by game ID; retract terminal result on undo", "ViewModel exposes StateFlow; tick only during resumed Game interaction"];
  design.compose.type_examples = ["data class Cell(val mine:Boolean=false,val revealed:Boolean=false,val flagged:Boolean=false,val mark:Int=0)", "enum class Phase { READY, PLAYING, WON, LOST }", "data class Session(val board:Board,val undo:Board?,val outcomes:List<Outcome>,val preferences:Preferences)"];
  design.assumptions.push("Imported implementation is directly authored Codex Kotlin, not a successful Claude codegen/model-review run. Clarifications reflect the verified standalone APK; original reference analysis remains static only.");
  return design;
}

async function main() {
  const receipt = await json(path.join(delivery, "release-v1.json"));
  const runtime = await json(path.join(delivery, "runtime-report.json"));
  const gesture = await json(path.join(delivery, "gesture-report.json"));
  const apk = path.join(delivery, "minefield-plus-v1.apk"), digest = await fileSha(apk);
  if (digest !== receipt.apkSha256 || digest !== runtime.apkSha256 || digest !== gesture.apkSha256 || !runtime.passed || !gesture.passed || runtime.packageId !== "com.meld.minefield" || gesture.packageId !== runtime.packageId || runtime.cases.length < 11 || runtime.cases.some((c: any) => c.passed !== true) || receipt.checks.jvmTests.count < 37 || !receipt.checks.jvmTests.passed || !receipt.checks.androidLint.passed) throw new Error("Verified delivery receipts do not match the APK");
  const service = new DesignService(path.join(root, "pipeline"), path.join(cache, "designs"));
  const workflow = path.join(cache, "workflow"), projectFile = path.join(workflow, "projects", `${projectId}.json`);
  await withLock(path.join(workflow, "minefield-import.lock"), async () => {
    if (await exists(projectFile)) {
      const project = await json(projectFile);
      if (project.latestBuild?.id !== buildId || project.latestBuild?.artifacts.find((a: any) => a.name === "app.apk")?.sha256 !== digest) throw new Error("Existing import changed; refusing to overwrite it");
      if (await fileSha(path.join(workflow, "builds", buildId, "artifacts/app.apk")) !== digest) throw new Error("Imported APK changed; refusing to overwrite it");
      await service.get(designId);
      console.log(JSON.stringify({ projectId, buildId, revision: project.currentDesignRevision, reused: true, url: `http://127.0.0.1:4173/?project=${projectId}` }));
      return;
    }
    const brief = await json(path.join(run, "brief.json")), decisions = await json(path.join(run, "synthesis/decisions.json"));
    const data = RevisionData.parse({ design: alignImplementedDesign(await json(path.join(run, "synthesis/design-draft-1792190960620.json"))), brief, decisions });
    const comparison = await json(path.join(run, "synthesis/comparison.json"));
    const specs = await Promise.all(["app1", "app2", "app3"].map(app => json(path.join(run, "apps", app, "app-spec.json"))));
    const errors = designErrors(data, comparison, specs);
    if (errors.length) throw new Error(errors.join("\n"));
    const summaries = [
      ["经典扫雷", "以 Antimine 为基础，9×9 棋盘、10 颗雷，首击安全并自动展开相连空白区域。", ["点击格子翻开；数字表示相邻地雷数量。", "打开全部 71 个安全格获胜；踩雷后可撤销或开始新局。"]],
      ["插旗", "长按插旗，也可选择 Flag 模式点击。", ["在未打开格子上放置或移除旗帜。", "较大的选格控制也提供翻格、插旗和数字标记入口。"]],
      ["单步撤销 · 借鉴 2048", "撤回上一次翻格或插旗，恢复棋盘、标记和当时计时。", ["点击 Undo 撤回一步；用过后等待下一次翻格或插旗。", "撤回胜负结果时同步撤回该局统计。"]],
      ["数字标记 · 借鉴 LibreSudoku", "将数独的铅笔标记交互改成扫雷中的个人数字备注。", ["选择 Pencil 模式并点击未打开、未插旗的格子。", "选择 1–8 或清除；这只是自己的猜测，不是系统提示。"]],
      ["存档、暂停与新游戏", "自动保存完整进度，支持暂停、重启恢复、统计和深浅主题。", ["新游戏需确认，取消保留当前棋盘；失败时可重试保存。", "统计记录完成局数、胜率和最佳用时；设置支持浅色、深色及跟随系统。"]]
    ] as const;
    const document = UserDocument.parse({
      language: "zh-CN", title: "Minefield Plus", audience: "希望离线玩经典扫雷，并使用撤销和数字备注的玩家。",
      summary: "以 Antimine 为基础的离线扫雷，借鉴 2048 的单步撤销及 LibreSudoku 的铅笔标记。已直接实现并完成 Android 测试，导入网页供查看、下载和预览。",
      features: data.design.features.map((f, i) => ({ id: f.id, title: summaries[i][0], summary: summaries[i][1], steps: [...summaries[i][2]], examples: [], caveats: i === 3 ? ["编辑数字标记会清除较早的撤销记录。"] : [], refs: [{ kind: "feature", id: f.id }] })),
      screens: data.design.pages.map(p => ({ id: p.id, title: ({ "page-game": "Game · 扫雷", "page-stats": "Statistics · 统计", "page-settings": "Settings · 设置" } as Record<string, string>)[p.id], purpose: p.purpose, refs: [{ kind: "page", id: p.id }] })),
      choices: decisions.selections.map((s: any, i: number) => ({ id: s.conflict_id, title: ["基础 App 与插旗", "借鉴 2048：撤销", "保存策略"][i], selected: ["Antimine 扫雷核心，长按和 Flag 模式均可插旗。", "撤销最后一次翻格或插旗；数字标记单独编辑。", "每次操作保存完整进度，失败可重试，损坏存档可先保留再重建。"][i], reason: s.reason, refs: [{ kind: "decision", id: s.conflict_id }] })),
      appearance: "浅色蓝色强调与深色主题；已展开格子融入棋盘底色，未打开格子保留边框。提供较大的操作按钮及格子状态朗读。",
      boundaries: ["纯离线扫雷；2048 和数独仅提供交互借鉴，不增加其他游戏模式。", "原参考 APK 仅做静态分析；运行验证针对这份新 App。", "此版本由 Codex 根据已有设计直接实现；未声称原模型流水线成功完成。", "37 项单元测试、11 组 Android 13 模拟器回归及真实长按检查通过。", "当前为调试签名测试 APK；尚未做应用商店发布或完整真机兼容性验证。"]
    });
    const readable = readableErrors(document, data); if (readable.length) throw new Error(readable.join("\n"));
    const dir = service.store.directory(designId), source = path.join(dir, "source");
    await fs.mkdir(source, { recursive: true });
    const sourceFiles: Record<string, string> = {};
    for (const [name, value] of Object.entries({ "baseline.json": data, "comparison.json": comparison, "specs.json": specs })) { await write(path.join(source, name), value); sourceFiles[name] = await fileSha(path.join(source, name)); }
    await write(path.join(source, "source.json"), { run_id: path.basename(run), source_path: path.join(run, "synthesis/design-draft-1792190960620.json"), source_sha256: await fileSha(path.join(run, "synthesis/design-draft-1792190960620.json")), baseline_data_hash: semanticHash(data), files: sourceFiles, classification: "Imported verified standalone app; author-reconciled design, not independent model review", apk_sha256: digest });
    await write(path.join(dir, "settings.json"), await json(path.join(root, "pipeline/config/runtime.workbench.json")));
    const revision = await service.store.commit(designId, null, requestKey, semanticHash(data), async (staging, record) => {
      for (const [name, input] of Object.entries({ "game.png": "10-playing.png", "stats.png": "03-statistics.png", "settings.png": "05-settings-dark.png" })) await fs.copyFile(path.join(delivery, "screenshots", input), path.join(staging, `screenshot-${name}`));
      await renderDocuments(staging, document, data, record.version, true);
      await fs.copyFile(path.join(root, "minefield-plus-android/docs/design-decisions.md"), path.join(staging, "implementation-decisions.md"));
      await write(path.join(staging, "validation.json"), { schema: "passed", references: "passed", author_reconciliation: "passed", independent_model_review: "not_performed", original_pipeline_completed: false, app_build_performed: true, apk_sha256: digest });
      await write(path.join(staging, "provenance.json"), { ...record, files: undefined, source_run: path.basename(run), implementation_authorship: "Direct Codex Kotlin implementation", import_authorization: "User requested web integration of the existing verified app", apk_sha256: digest });
    }, { kind: "import", change_id: null, selected_change_ids: [], data_hash: semanticHash(data), semantic_hash: semanticHash(data.design), changed_features: [], authorship: { actor: "imported_app", request: "Import the existing verified Minefield Plus app into web history", scope: "Reconcile the saved design to the tested implementation; no model calls or APK rebuild; preserve original pipeline status" } }, { revision: "", semantic_hash: semanticHash(data.design), source_sha256: digest, app_name: document.title });
    const time = new Date().toISOString(), domain = "Minesweeper";
    const contributions = [
      ["dev.lucanlm.antimine", "Antimine", "Minesweeper core", "Reveal cells, count adjacent mines, expand empty areas, flag cells and restart."],
      ["org.andstatus.game2048", "2048 Open Fun Game", "One-step undo", "Adapt its undo/history interaction to the most recent Minesweeper reveal or flag."],
      ["com.kaajjo.libresudoku", "LibreSudoku", "Pencil marks", "Adapt its pencil-mark interaction to personal 1–8 annotations on covered Minesweeper cells."]
    ];
    const apps: MarketApp[] = contributions.map(([appId, title, name, detail], i) => ({ appId, title, rank: i + 1, developer: "Selected APK reference", storeCategory: "Puzzle", genreId: "GAME_PUZZLE", summary: detail, rating: null, ratings: 0, installs: 0, offersIap: false, containsAds: false, price: 0, currency: null, score: 0, components: {}, recentReviews: 0, storeUrl: `https://play.google.com/store/apps/details?id=${appId}`, provenance: "curated_apk", listedFeatures: { items: [{ name, detail }], model: "author-curated", template: "saved-apk-contributions-v1", generatedAt: time } }));
    const references: MarketResult = { domain, category: domain, genreId: "GAME_PUZZLE", queries: [], country: "us", language: "en", status: "partial", generatedAt: time, apps, warnings: ["Curated APK references from saved analysis; not a fresh market ranking. Numeric market metrics are unavailable and hidden."], candidates: 3, ranked: 0, failedRequests: 0, windowDays: 0 };
    const buildDir = path.join(workflow, "builds", buildId), artifactsDir = path.join(buildDir, "artifacts"); await fs.mkdir(artifactsDir, { recursive: true });
    await fs.copyFile(apk, path.join(artifactsDir, "app.apk"));
    for (const name of ["runtime-report.json", "gesture-report.json", "release-v1.json"]) await fs.copyFile(path.join(delivery, name), path.join(artifactsDir, name));
    await write(path.join(artifactsDir, "approved-design.json"), { developer_design: data.design, brief: data.brief, decisions: data.decisions });
    const validation = { build: true, unitTests: true, lint: true, runtimeVerified: true, limitations: ["Imported directly authored standalone app; original Claude pipeline remains incomplete.", "Debug-signed development APK; runtime checks on Android 13 emulator only; reference APK runtime behavior not verified."] };
    await write(path.join(artifactsDir, "build-report.json"), { ...validation, import: true, apkSha256: digest, unitTestCount: 37, nativeCases: runtime.cases, supplementalGesture: gesture, receipt, sourceProject: "minefield-plus-android" });
    const artifacts = await Promise.all((await fs.readdir(artifactsDir)).sort().map(async name => ({ name, url: `/api/projects/${projectId}/builds/${buildId}/artifacts/${name}`, sha256: await fileSha(path.join(artifactsDir, name)) })));
    await write(path.join(buildDir, "artifacts.json"), artifacts);
    const build: Build = { id: buildId, revision, designHash: semanticHash(data.design), status: "succeeded", artifacts, validation };
    const outline = HighLevelDocument.parse({ ...document, features: document.features.map(f => ({ ...f, refs: [] })), screens: document.screens.map(p => ({ ...p, refs: [] })), choices: document.choices.map(c => ({ ...c, refs: [] })) });
    const project: Project = { id: projectId, version: 1, createdAt: time, updatedAt: time,
      brief: { name: "Minefield Plus", input: "Import the verified offline Minesweeper app into web history, including reference choices, design, APK download and browser Android preview.", audience: document.audience, purpose: document.summary, goal: "Antimine 扫雷核心 + 2048 单步撤销 + LibreSudoku 数字标记", style: "ink", domains: [domain], coreTasks: brief.core_tasks, requiredStates: brief.required_states },
      references: { [domain]: references }, featurePreferences: { baseAppId: apps[0].appId, selections: Object.fromEntries(apps.map((a, i) => [a.appId, [`${a.appId}:${["minesweeper-core", "one-step-undo", "pencil-marks"][i]}`]])), customRequests: [] },
      designId, currentDesignRevision: revision, approvedRevision: revision, pendingDecision: null, activeJobId: null, lastJobId: buildId, latestBuild: build, lastDeliveredBuild: build, needsResearch: false, needsDesign: false,
      highLevelVersion: 1, highLevelDesign: { revision: "hl-minefield-import-v1", version: 1, document: outline, createdAt: time, approvedRevision: "hl-minefield-import-v1", developerRevision: revision } };
    await write(path.join(workflow, "jobs", `${buildId}.json`), { id: buildId, projectId, projectVersion: 1, request: { requestKey, source: "verified standalone delivery" }, signature: digest, type: "build", status: "succeeded", phase: "Imported verified standalone APK.", createdAt: time, updatedAt: time, result: build });
    await write(path.join(dir, "project-owner.json"), { projectId });
    await write(path.join(workflow, "profiles", projectId, `${revision}.json`), { brief: project.brief, references: project.references, featurePreferences: project.featurePreferences, needsResearch: false });
    await write(projectFile, project); // Publish only after every artifact and immutable design revision exists.
    await service.get(designId);
    console.log(JSON.stringify({ projectId, buildId, revision, apkSha256: digest, url: `http://127.0.0.1:4173/?project=${projectId}` }));
  }, 2000);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
