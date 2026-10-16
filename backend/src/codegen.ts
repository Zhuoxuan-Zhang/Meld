import { z, write, exists, json, WorkbenchError } from "../../pipeline/dist/src/integration.js";
import path from "node:path";
import { promises as fs } from "node:fs";
import { parseCodex } from "../../pipeline/dist/src/codex.js";
import { fileSha } from "../../pipeline/dist/src/integration.js";
import { modelJson } from "./model";

export const SourceFile = z.object({ path: z.string().max(240), content: z.string().min(1).max(120000) }).strict();
export const SourceEdits = z.object({ path: z.string().max(240), edits: z.array(z.object({ find: z.string().min(1).max(120000), replace: z.string().max(120000) }).strict()).min(1).max(30) }).strict();
export function applySourceEdits(original: z.infer<typeof SourceFile>, patch: z.infer<typeof SourceEdits>) {
  if (patch.path !== original.path) throw new WorkbenchError("invalid_code", "The edited file does not match its planned module.", 422);
  checkSourcePaths([original]);
  let content = original.content;
  for (const edit of patch.edits) {
    const at = content.indexOf(edit.find);
    if (at < 0 || content.indexOf(edit.find, at + 1) >= 0) throw new WorkbenchError("invalid_code", "A source edit must match exactly one current text segment.", 422);
    content = content.slice(0, at) + edit.replace + content.slice(at + edit.find.length);
  }
  return SourceFile.parse({ path: original.path, content });
}
export const SourceFiles = z.object({ files: z.array(SourceFile).min(1).max(20), explanation: z.string().max(3000) }).strict();
const PatchPlan = z.object({ interfaces: z.array(z.string().max(2000)).max(40), files: z.array(z.object({ path: z.string().max(240), responsibility: z.string().max(2000) }).strict()).min(1).max(20) }).strict();
const Plan = z.object({ interfaces: z.array(z.string().max(2000)).max(40), files: z.array(z.object({ path: z.string().max(240), responsibility: z.string().max(2000) }).strict()).min(2).max(16) }).strict();
export type Sources = z.infer<typeof SourceFiles>;
export function checkSourcePaths(files: Sources["files"]) {
  if (new Set(files.map(file => file.path)).size !== files.length) throw new WorkbenchError("invalid_code", "Generated source paths must be unique.", 422);
  for (const file of files) if (!/^app\/src\/(main|test)\/java\/generated\/[A-Za-z0-9_/-]+\.kt$/.test(file.path) || file.path.includes("..")) throw new WorkbenchError("invalid_code", "Generated source paths are outside the app contract.", 422);
}

// Bound each response to one file. Repairs return patches rather than another
// full application, preserving unchanged files and the complete attempt history.
export async function generateSources(directory: string, round: number, instructions: string, data: Record<string, unknown>, prior: Sources | null, issues: string[], progress: (phase: string) => Promise<void>, ask: typeof modelJson = modelJson): Promise<Sources> {
  if (prior) {
    const checkpoint = path.join(directory, `repair-checkpoint-${round}.json`);
    const resumed = await exists(checkpoint) ? z.object({ plan: PatchPlan, files: z.array(SourceFile).max(20) }).strict().parse(await json(checkpoint)) : null;
    const plan = resumed?.plan || await ask(directory, `repair-plan-${round}`, instructions + " Plan complete repairs for all supplied compiler/review findings. Return the ordered manifest of changed or added Kotlin files and exact changed shared signatures. Preserve unaffected modules. Include meaningful test changes where needed. Split oversized files into focused modules when necessary; the combined application may contain at most 20 Kotlin files. Each planned file will be generated in its own response. Do not defer known findings merely to limit the number of files in one response.", { ...data, prior, issues }, PatchPlan, 6000, "medium", 900000);
    checkSourcePaths(plan.files.map(file => ({ path: file.path, content: "planned" })));
    const merged = new Map(prior.files.map(file => [file.path, file]));
    const completed = resumed?.files || [];
    checkSourcePaths(completed);
    if (completed.some((file, index) => file.path !== plan.files[index]?.path)) throw new WorkbenchError("invalid_code", "The repair checkpoint does not match its ordered plan.", 422);
    for (const file of completed) merged.set(file.path, file);
    for (const [index, file] of plan.files.entries()) {
      if (index < completed.length) continue;
      await progress(`Applying app corrections ${index + 1} of ${plan.files.length}…`);
      const existing = merged.get(file.path), context = { ...data, issues, plan, requestedFile: file, currentFiles: [...merged.values()] };
      const generated = existing
        ? applySourceEdits(existing, await ask(directory, `repair-file-${round}-${index}`, instructions + " Repair only the requested existing Kotlin file using minimal exact text replacements. Each find string must occur exactly once in that file's current contents; edits apply in order. Use short unique anchors when adding tests or helpers. Return only changed text, never the entire unchanged file. Preserve existing functionality and tests. Follow the complete repair plan and exact shared signatures. Do not emit Markdown fences.", context, SourceEdits, 12000, "medium", 600000))
        : await ask(directory, `repair-file-${round}-${index}`, instructions + " Generate only the requested new Kotlin file according to the complete repair plan. Return its full contents. Follow the agreed shared signatures and current application declarations. Keep the module concise and complete. Do not emit Markdown fences.", context, SourceFile, 12000, "medium", 900000);
      if (generated.path !== file.path) throw new WorkbenchError("invalid_code", "The repaired file does not match its planned module.", 422);
      checkSourcePaths([generated]); merged.set(generated.path, generated); completed.push(generated);
      await write(checkpoint, { plan, files: completed });
    }
    const result = SourceFiles.parse({ files: [...merged.values()], explanation: "Applied the complete repair plan one module at a time." });
    await write(path.join(directory, `implementation-${round}.json`), result);
    return result;
  }
  const checkpoint = path.join(directory, "generation-checkpoint.json");
  const resumed = await exists(checkpoint) ? z.object({ plan: Plan, files: z.array(SourceFile).max(16) }).strict().parse(await json(checkpoint)) : null;
  const plan = resumed?.plan || await ask(directory, "source-plan", instructions + " Plan a small implementation with 10–16 focused Kotlin files. Keep each file small enough to generate reliably: aim for 800–1800 output tokens and roughly 80–160 lines. Split a large coordinator into focused helpers and UI into small tool panels rather than putting every event and operation into one reducer. Return the ordered file manifest and exact shared type/function signatures. Put common pure types first, game engines next, storage/coordinator after them, UI last, and meaningful pure JUnit tests after implementations. MainActivity.kt must be present. Split large UI implementations into separate feature screens or panels. Include every approved feature and the base app’s primary workflow. Avoid speculative abstractions and dependencies unavailable in the supplied Gradle configuration.", data, Plan, 6000, "medium");
  checkSourcePaths(plan.files.map(file => ({ path: file.path, content: "planned" })));
  if (!plan.files.some(file => file.path === "app/src/main/java/generated/MainActivity.kt") || !plan.files.some(file => file.path.startsWith("app/src/test/"))) throw new WorkbenchError("invalid_code", "The source plan must include a launcher and tests.", 422);
  const files: Sources["files"] = resumed?.files || [];
  checkSourcePaths(files);
  if (files.some((file, index) => file.path !== plan.files[index]?.path)) throw new WorkbenchError("invalid_code", "The generation checkpoint does not match its ordered module plan.", 422);
  for (const [index, file] of plan.files.entries()) {
    if (index < files.length) continue;
    await progress(`Implementing app module ${index + 1} of ${plan.files.length}…`);
    const moduleInstructions = instructions + " Generate only the requested Kotlin file. Follow the exact agreed interfaces and already generated declarations; do not redefine types belonging to other files. Implement complete logic for this module with no TODO placeholders. Pure tests must exercise the app’s domain rules and recovery as applicable, not merely assert constants. Keep this file concise, aiming for 800–1800 output tokens. Do not emit Markdown fences.";
    const context = { ...data, plan, requestedFile: file, generatedFiles: files };
    let generated: z.infer<typeof SourceFile>;
    try {
      generated = await ask(directory, `file-${index}`, moduleInstructions, context, SourceFile, 12000, "medium", 360000);
    } catch (error) {
      if ((error as WorkbenchError).code !== "model_output") throw error;
      // Keep the failed raw response. Retry only this unsaved module, leaving
      // the ordered checkpoint and completed modules untouched.
      await progress(`Retrying app module ${index + 1} of ${plan.files.length} with a smaller response…`);
      generated = await ask(directory, `file-${index}-retry`, moduleInstructions + " The previous response did not complete or validate. Return a compact implementation with minimal commentary and no duplicated helpers. Preserve every required behavior and exact shared signature; use existing modules rather than restating them.", context, SourceFile, 12000, "low", 360000);
    }
    if (generated.path !== file.path) throw new WorkbenchError("invalid_code", "The generated file does not match its planned module.", 422);
    checkSourcePaths([generated]); files.push(generated);
    await write(path.join(directory, "generation-checkpoint.json"), { plan, files });
  }
  const result = SourceFiles.parse({ files, explanation: "Generated the planned modules individually from the approved design." });
  await write(path.join(directory, `implementation-${round}.json`), result);
  return result;
}

// Older workers emitted a batch of full files under a 14k post-response budget.
// A successful, tool-free completed response may be replayed under the explicit
// 24k recovery budget. Keep its original failure and raw artifacts unchanged;
// the resumed job must still compile, test, lint and independently review it.
export async function recoverCompletedBatch(modelDirectory: string, prior: Sources) {
  const names = (await fs.readdir(modelDirectory)).filter(name => /^repair-\d+-\d+$/.test(name)).sort((a, b) => Number(b.split("-").at(-1)) - Number(a.split("-").at(-1)));
  for (const name of names) {
    const responseFile = path.join(modelDirectory, name, "response.json");
    if (!(await exists(responseFile)) || await exists(path.join(modelDirectory, name, "parsed.json"))) continue;
    const response = await json(responseFile);
    if (!(response.usage?.output_tokens > 14000 && response.usage.output_tokens <= 24000)) continue;
    let patch: Sources;
    try { patch = parseCodex(response, SourceFiles, 24000); checkSourcePaths(patch.files); }
    catch { continue; }
    const merged = new Map(prior.files.map(file => [file.path, file]));
    for (const file of patch.files) merged.set(file.path, file);
    return { sources: SourceFiles.parse({ files: [...merged.values()], explanation: patch.explanation }), responseFile, responseSha256: await fileSha(responseFile), outputTokens: response.usage.output_tokens, recoveryOutputLimit: 24000 };
  }
  return null;
}

// Reconstruct an interrupted repair from its actual recorded model plan and
// completed responses. The caller also verifies the approved design/profile.
export async function recoverRepairPrefix(modelDirectory: string) {
  const names = (await fs.readdir(modelDirectory)).filter(name => /^repair-plan-\d+-\d+$/.test(name)).sort((a, b) => Number(b.split("-").at(-1)) - Number(a.split("-").at(-1)));
  for (const name of names) {
    const planFile = path.join(modelDirectory, name, "response.json"), prompt = path.join(modelDirectory, name, "prompt.txt");
    if (!(await exists(planFile)) || !(await exists(prompt))) continue;
    try {
      const plan = PatchPlan.parse(parseCodex(await json(planFile), PatchPlan, 6000));
      checkSourcePaths(plan.files.map(file => ({ path: file.path, content: "planned" })));
      const data = JSON.parse((await fs.readFile(prompt, "utf8")).trim().split("\n").at(-1)!);
      const prior = SourceFiles.parse(data.prior); checkSourcePaths(prior.files);
      const issues = z.array(z.string()).parse(data.issues), round = name.split("-")[2];
      const all = await fs.readdir(modelDirectory), files: Sources["files"] = [], calls: { path: string; sha256: string }[] = [];
      for (const [index, file] of plan.files.entries()) {
        const candidate = all.filter(dir => new RegExp(`^repair-file-${round}-${index}-\\d+$`).test(dir)).sort((a, b) => Number(b.split("-").at(-1)) - Number(a.split("-").at(-1)))[0];
        if (!candidate) break;
        const responseFile = path.join(modelDirectory, candidate, "response.json"); if (!(await exists(responseFile))) break;
        let parsed: z.infer<typeof SourceFile>;
        try {
          const response = await json(responseFile);
          try { parsed = parseCodex(response, SourceFile, 24000); }
          catch {
            const patch = parseCodex(response, SourceEdits, 12000);
            const originals = new Map(prior.files.map(file => [file.path, file]));
            for (const saved of files) originals.set(saved.path, saved);
            const original = originals.get(file.path); if (!original) break;
            parsed = applySourceEdits(original, patch);
          }
          checkSourcePaths([parsed]);
        } catch { break; }
        if (parsed.path !== file.path) break;
        files.push(parsed); calls.push({ path: responseFile, sha256: await fileSha(responseFile) });
      }
      if (!files.length) continue;
      return { round: Number(round), prior, plan, files, issues, approvedDesign: data.approvedDesign, appProfile: data.appProfile, calls, planResponse: planFile, planSha256: await fileSha(planFile), recoveryOutputLimit: 24000 };
    } catch { continue; }
  }
  return null;
}
