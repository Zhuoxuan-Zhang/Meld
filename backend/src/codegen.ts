import { z, write, exists, json, WorkbenchError } from "../../pipeline/dist/src/integration.js";
import path from "node:path";
import { promises as fs } from "node:fs";
import { isDeepStrictEqual } from "node:util";
// executeClaudeCli's saved response.json uses the same envelope shape as Codex's
// (execution.code, turn_completed, errors, tool_activity, final_text, usage),
// so this recovery parser works unchanged on artifacts from either provider.
import { parseCodex } from "../../pipeline/dist/src/codex.js";
import { fileSha } from "../../pipeline/dist/src/integration.js";
import { buildModelJson as modelJson } from "./model";

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
const SourceRepair = z.object({
  path: SourceFile.shape.path,
  edits: SourceEdits.shape.edits.nullable().default(null),
  content: SourceFile.shape.content.nullable().default(null),
}).strict();
export function applySourceRepair(original: z.infer<typeof SourceFile>, value: unknown) {
  const patch = SourceRepair.parse(value);
  if (patch.path !== original.path) throw new WorkbenchError("invalid_code", "The repaired file does not match its planned module.", 422);
  checkSourcePaths([original]);
  if (patch.edits !== null && patch.content === null) return applySourceEdits(original, { path: patch.path, edits: patch.edits });
  if (patch.edits === null && patch.content !== null) return SourceFile.parse({ path: patch.path, content: patch.content });
  throw new WorkbenchError("invalid_code", "Choose exact edits or complete replacement contents, never both or neither.", 422);
}
export const SourceFiles = z.object({ files: z.array(SourceFile).min(1).max(20), explanation: z.string().max(3000) }).strict();
const PatchPlan = z.object({ interfaces: z.array(z.string().max(2000)).max(40), removePaths: z.array(z.string().max(240)).max(20).default([]), files: z.array(z.object({ path: z.string().max(240), responsibility: z.string().max(2000) }).strict()).max(20) }).strict();
const Plan = z.object({ interfaces: z.array(z.string().max(2000)).max(40), files: z.array(z.object({ path: z.string().max(240), responsibility: z.string().max(2000) }).strict()).min(2).max(16) }).strict();
// CLI output usage includes reasoning, not only the small returned JSON plan.
const planExecutionBudget = 24000;
const moduleExecutionBudget = 24000;
// A 24k-token response can exceed six minutes on the authenticated CLI.
const moduleTimeout = 600000;
export type Sources = z.infer<typeof SourceFiles>;
export function checkSourcePaths(files: Sources["files"]) {
  if (new Set(files.map(file => file.path)).size !== files.length) throw new WorkbenchError("invalid_code", "Generated source paths must be unique.", 422);
  for (const file of files) if (!/^app\/src\/(main|test)\/java\/generated\/[A-Za-z0-9_/-]+\.kt$/.test(file.path) || file.path.includes("..")) throw new WorkbenchError("invalid_code", "Generated source paths are outside the app contract.", 422);
}

export function removeSourceFiles(files: Sources["files"], removePaths: string[]) {
  checkSourcePaths(files);
  checkSourcePaths(removePaths.map(path => ({ path, content: "planned removal" })));
  const remaining = new Map(files.map(file => [file.path, file]));
  for (const path of removePaths) {
    if (!remaining.has(path)) throw new WorkbenchError("invalid_code", "A removed module must belong to the supplied implementation.", 422);
    remaining.delete(path);
  }
  return [...remaining.values()];
}
function repairBase(prior: Sources, plan: z.infer<typeof PatchPlan>) {
  checkSourcePaths(plan.files.map(file => ({ path: file.path, content: "planned" })));
  if (!plan.files.length && !plan.removePaths.length || plan.files.some(file => plan.removePaths.includes(file.path))) throw new WorkbenchError("invalid_code", "Plan a repair or removal; never edit and remove the same module.", 422);
  const remaining = removeSourceFiles(prior.files, plan.removePaths);
  const projected = new Set([...remaining.map(file => file.path), ...plan.files.map(file => file.path)]);
  if (projected.size > 20) throw new WorkbenchError("invalid_code", `The repaired application exceeds the 20-module limit (${projected.size} planned modules). Consolidate modules or retire obsolete sources without dropping behavior or production tests.`, 422);
  return remaining;
}

// Bound each response to one file. Repairs return patches rather than another
// full application, preserving unchanged files and the complete attempt history.
export async function generateSources(directory: string, round: number, instructions: string, data: Record<string, unknown>, prior: Sources | null, issues: string[], progress: (phase: string) => Promise<void>, ask: typeof modelJson = modelJson): Promise<Sources> {
  if (prior) {
    const checkpoint = path.join(directory, `repair-checkpoint-${round}.json`);
    const resumed = await exists(checkpoint) ? z.object({ plan: PatchPlan, files: z.array(SourceFile).max(20) }).strict().parse(await json(checkpoint)) : null;
    let plan = resumed?.plan;
    let rejectedPlan: z.infer<typeof PatchPlan> | undefined;
    let validationError: string | undefined;
    if (plan) {
      try { repairBase(prior, plan); }
      catch (error) {
        if (resumed?.files.length || (error as WorkbenchError).code !== "invalid_code") throw error;
        rejectedPlan = plan; validationError = (error as Error).message; plan = undefined;
        await write(path.join(directory, `rejected-repair-plan-${round}-${Date.now()}.json`), { plan: rejectedPlan, validationError });
      }
    }
    const retryOffset = rejectedPlan ? 1 : 0;
    for (let attempt = 0; !plan && attempt < 3; attempt++) {
      const label = rejectedPlan ? `repair-plan-${round}-validation-retry-${attempt + retryOffset}` : `repair-plan-${round}`;
      const candidate = PatchPlan.parse(await ask(directory, label, instructions + " Plan complete repairs for all supplied compiler/review findings. Return a concise ordered manifest of changed or added Kotlin files and exact changed shared signatures. Preserve unaffected modules. Use removePaths to retire obsolete modules when moving or splitting declarations; include every original file whose declarations would otherwise be duplicated. Never leave enabled controls with empty callbacks. Tests must exercise production logic through injected platform ports, not duplicate stand-in implementations. Include meaningful test changes where needed. Split oversized files into focused modules when necessary; the combined application may contain at most 20 Kotlin files. Each planned file will be generated in its own response. Do not defer known findings merely to limit the number of files in one response." + (rejectedPlan ? " Correct the supplied rejected plan against the exact validation error. Prefer editing existing modules or merging small test files. Preserve every required operation and meaningful production test; do not drop scope to meet the limit. Return the complete corrected plan." : ""),
        { ...data, prior, issues, ...(rejectedPlan ? { rejectedPlan, validationError, existingPaths: prior.files.map(file => file.path), maxModules: 20 } : {}) }, PatchPlan, planExecutionBudget, "medium", 900000));
      try { repairBase(prior, candidate); plan = candidate; }
      catch (error) {
        if ((error as WorkbenchError).code !== "invalid_code" || attempt === 2) throw error;
        rejectedPlan = candidate; validationError = (error as Error).message;
        await progress("Correcting the implementation repair plan…");
      }
    }
    if (!plan) throw new WorkbenchError("invalid_code", "The implementation repair plan did not validate.", 422);
    const merged = new Map(repairBase(prior, plan).map(file => [file.path, file]));
    const completed = resumed?.files || [];
    checkSourcePaths(completed);
    if (completed.some((file, index) => file.path !== plan.files[index]?.path)) throw new WorkbenchError("invalid_code", "The repair checkpoint does not match its ordered plan.", 422);
    await write(checkpoint, { plan, files: completed });
    for (const file of completed) merged.set(file.path, file);
    for (const [index, file] of plan.files.entries()) {
      if (index < completed.length) continue;
      await progress(`Applying app corrections ${index + 1} of ${plan.files.length}…`);
      const existing = merged.get(file.path), context = { ...data, issues, plan, requestedFile: file, currentFiles: [...merged.values()] };
      const askRepair = async <T>(schema: z.ZodType<T>, prompt: string, effort: string): Promise<T> => {
        try { return await ask(directory, `repair-file-${round}-${index}`, prompt, context, schema, moduleExecutionBudget, effort, moduleTimeout); }
        catch (error) {
          if ((error as WorkbenchError).code !== "model_output") throw error;
          await progress(`Retrying app corrections ${index + 1} of ${plan.files.length}…`);
          return ask(directory, `repair-file-${round}-${index}-retry`, prompt + " The previous response did not complete or validate. Keep the response compact, preserve required behavior and shared signatures, and omit commentary and repeated declarations.", context, schema, moduleExecutionBudget, "low", moduleTimeout);
        }
      };
      let generated: z.infer<typeof SourceFile>;
      if (existing) {
        const editSchema = SourceRepair.extend({ path: z.literal(file.path) });
        const editInstructions = instructions + ` Repair only ${file.path}; return that exact path. For localized fixes, return edits with content:null: each find string must occur exactly once in the current file and edits apply in order. Use short unique anchors. For a substantial rewrite, return the complete new content with edits:null, avoiding a duplicate quotation of the old file. Choose exactly one form. Keep unchanged functionality and interfaces unless the approved repair requires changes. Preserve existing functionality and tests. Follow the complete repair plan and exact shared signatures. Do not emit Markdown fences.`;
        const patch = await askRepair(editSchema, editInstructions, "medium");
        try { generated = applySourceRepair(existing, patch); }
        catch (error) {
          if ((error as WorkbenchError).code !== "invalid_code") throw error;
          await progress(`Refining app corrections ${index + 1} of ${plan.files.length}…`);
          const corrected = await ask(directory, `repair-file-${round}-${index}-edit-retry`, editInstructions + " The prior patch did not match the requested path or exact current file. Recreate the smallest valid patch using the supplied unchanged current file and validation error. Use exact unique anchors; do not assume any rejected edit was applied.", { ...context, rejectedPatch: patch, validationError: String(error) }, editSchema, moduleExecutionBudget, "low", moduleTimeout);
          generated = applySourceRepair(existing, corrected);
        }
      } else {
        generated = await askRepair(SourceFile.extend({ path: z.literal(file.path) }), instructions + ` Generate only ${file.path}; return that exact path and its full contents according to the complete repair plan. Follow the agreed shared signatures and current application declarations. Keep the module concise and complete, aiming for 800–1800 output tokens without repeated boilerplate. Do not emit Markdown fences.`, "low");
      }
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
  let plan = resumed?.plan;
  let rejectedPlan: z.infer<typeof Plan> | undefined;
  let validationError: string | undefined;
  const validatePlan = (candidate: z.infer<typeof Plan>) => {
    checkSourcePaths(candidate.files.map(file => ({ path: file.path, content: "planned" })));
    if (!candidate.files.some(file => file.path === "app/src/main/java/generated/MainActivity.kt") || !candidate.files.some(file => file.path.startsWith("app/src/test/java/generated/"))) throw new WorkbenchError("invalid_code", "The source plan must include app/src/main/java/generated/MainActivity.kt and meaningful tests under app/src/test/java/generated/.", 422);
  };
  if (plan) {
    try { validatePlan(plan); }
    catch (error) {
      if (resumed?.files.length || (error as WorkbenchError).code !== "invalid_code") throw error;
      rejectedPlan = plan; validationError = (error as Error).message; plan = undefined;
      await write(path.join(directory, `rejected-source-plan-${Date.now()}.json`), { plan: rejectedPlan, validationError });
    }
  }
  let planRetries = 0;
  for (let attempt = 0; !plan && attempt < 3; attempt++) {
    const label = rejectedPlan ? `source-plan-validation-retry-${++planRetries}` : "source-plan";
    const candidate = Plan.parse(await ask(directory, label, instructions + " Plan a small implementation using only as many focused Kotlin files as the approved scope needs, typically 4–16. This response is a manifest only: each responsibility is a short prose sentence, never Kotlin source or a truncated implementation. Return concise exact shared signatures in interfaces without function bodies. Keep each eventual file small enough to generate reliably: aim for 800–1800 output tokens and roughly 80–160 lines. Put common pure types first, domain logic next, storage/coordinator after them, UI last, and meaningful pure JUnit tests after implementations. Include app/src/main/java/generated/MainActivity.kt and tests under app/src/test/java/generated/. Split large UI implementations into separate feature screens or panels. Include every approved feature and the base app’s primary workflow. Avoid speculative abstractions and dependencies unavailable in the supplied Gradle configuration." + (rejectedPlan ? " Correct the supplied rejected plan against its validation error. Return the complete concise manifest, preserving all approved features; source contents are generated in later calls." : ""), { ...data, ...(rejectedPlan ? { rejectedPlan, validationError } : {}) }, Plan, planExecutionBudget, "medium"));
    try { validatePlan(candidate); plan = candidate; }
    catch (error) {
      if ((error as WorkbenchError).code !== "invalid_code") throw error;
      rejectedPlan = candidate; validationError = (error as Error).message;
      await write(path.join(directory, `rejected-source-plan-${attempt}-${Date.now()}.json`), { plan: candidate, validationError });
      if (attempt === 2) throw error;
      await progress("Correcting the app source plan…");
    }
  }
  if (!plan) throw new WorkbenchError("invalid_code", "The app source plan did not validate.", 422);
  const files: Sources["files"] = resumed?.files || [];
  checkSourcePaths(files);
  if (files.some((file, index) => file.path !== plan.files[index]?.path)) throw new WorkbenchError("invalid_code", "The generation checkpoint does not match its ordered module plan.", 422);
  await write(checkpoint, { plan, files });
  for (const [index, file] of plan.files.entries()) {
    if (index < files.length) continue;
    await progress(`Implementing app module ${index + 1} of ${plan.files.length}…`);
    const moduleInstructions = instructions + " Generate only the requested Kotlin file. Follow the exact agreed interfaces and already generated declarations; do not redefine types belonging to other files. Implement complete logic for this module with no TODO placeholders. Pure tests must exercise the app’s domain rules and recovery as applicable, not merely assert constants. Keep this file concise, aiming for 800–1800 output tokens. Do not emit Markdown fences.";
    const context = { ...data, plan, requestedFile: file, generatedFiles: files };
    const moduleSchema = SourceFile.extend({ path: z.literal(file.path) });
    let generated: z.infer<typeof SourceFile>;
    try {
      generated = await ask(directory, `file-${index}`, moduleInstructions, context, moduleSchema, moduleExecutionBudget, "medium", moduleTimeout);
    } catch (error) {
      if ((error as WorkbenchError).code !== "model_output") throw error;
      // Keep the failed raw response. Retry only this unsaved module, leaving
      // the ordered checkpoint and completed modules untouched.
      await progress(`Retrying app module ${index + 1} of ${plan.files.length} with a smaller response…`);
      generated = await ask(directory, `file-${index}-retry`, moduleInstructions + " The previous response did not complete or validate. Return a compact implementation with minimal commentary and no duplicated helpers. Preserve every required behavior and exact shared signature; use existing modules rather than restating them.", context, moduleSchema, moduleExecutionBudget, "low", moduleTimeout);
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
export async function recoverRepairPrefix(modelDirectory: string, expectedIntegration?: unknown) {
  const names = (await fs.readdir(modelDirectory)).filter(name => /^repair-plan-\d+(?:-validation-retry-\d+)?-\d+$/.test(name)).sort((a, b) => Number(b.split("-").at(-1)) - Number(a.split("-").at(-1)));
  for (const name of names) {
    const planFile = path.join(modelDirectory, name, "response.json"), prompt = path.join(modelDirectory, name, "prompt.txt");
    if (!(await exists(planFile)) || !(await exists(prompt))) continue;
    try {
      const plan = PatchPlan.parse(parseCodex(await json(planFile), PatchPlan, planExecutionBudget));
      checkSourcePaths(plan.files.map(file => ({ path: file.path, content: "planned" })));
      const data = JSON.parse((await fs.readFile(prompt, "utf8")).trim().split("\n").at(-1)!);
      if (expectedIntegration !== undefined && !isDeepStrictEqual(data.integration, expectedIntegration)) continue;
      const prior = SourceFiles.parse(data.prior);
      const issues = z.array(z.string()).parse(data.issues), round = name.split("-")[2];
      let remaining: Sources["files"];
      try { remaining = repairBase(prior, plan); }
      catch (error) {
        if ((error as WorkbenchError).code !== "invalid_code" || !(error as Error).message.includes("20-module limit")) throw error;
        // This is a recorded plan candidate, not recovered application code.
        // The next run must replan before applying any module changes.
        return { round: Number(round), prior, plan, files: [], issues, approvedDesign: data.approvedDesign, appProfile: data.appProfile,
          calls: [], planResponse: planFile, planSha256: await fileSha(planFile), recoveryOutputLimit: 24000, planNeedsRepair: true };
      }
      const all = await fs.readdir(modelDirectory), files: Sources["files"] = [], calls: { path: string; sha256: string }[] = [];
      for (const [index, file] of plan.files.entries()) {
        const candidate = all.filter(dir => new RegExp(`^repair-file-${round}-${index}(?:-(?:retry|edit-retry))?-\\d+$`).test(dir)).sort((a, b) => Number(b.split("-").at(-1)) - Number(a.split("-").at(-1)))[0];
        if (!candidate) break;
        const responseFile = path.join(modelDirectory, candidate, "response.json"); if (!(await exists(responseFile))) break;
        let parsed: z.infer<typeof SourceFile>;
        try {
          const response = await json(responseFile);
          try { parsed = parseCodex(response, SourceFile, 24000); }
          catch {
            const patch = parseCodex(response, SourceRepair, moduleExecutionBudget);
            const originals = new Map(remaining.map(file => [file.path, file]));
            for (const saved of files) originals.set(saved.path, saved);
            const original = originals.get(file.path); if (!original) break;
            parsed = applySourceRepair(original, patch);
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
