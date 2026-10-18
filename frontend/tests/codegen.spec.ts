import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateSources, checkSourcePaths, recoverCompletedBatch, recoverRepairPrefix, applySourceEdits, applySourceRepair } from "../../backend/src/codegen";
import { write, fileSha } from "../../pipeline/dist/src/integration.js";
import { readRuntimeFeedback, approvedOutlineForBuild } from "../../backend/src/build";
import { parseClaudeCli } from "../../pipeline/dist/src/claude-cli.js";

const main = "app/src/main/java/generated/MainActivity.kt";
const tests = "app/src/test/java/generated/RulesTest.kt";
test("the builder receives explicit operations only from the outline approved for its developer revision", () => {
  const outline = { revision: "hl-v0002", approvedRevision: "hl-v0002", developerRevision: "v0001-current", document: { features: [{ steps: ["Create, edit, check and delete a task"] }] } };
  expect(approvedOutlineForBuild({ highLevelDesign: outline } as any, "v0001-current")).toEqual({ revision: outline.revision, document: outline.document });
  expect(approvedOutlineForBuild({ highLevelDesign: { ...outline, approvedRevision: "hl-v0001" } } as any, "v0001-current")).toBeNull();
  expect(approvedOutlineForBuild({ highLevelDesign: outline } as any, "v0001-old")).toBeNull();
  expect(approvedOutlineForBuild({}, "v0001-current")).toBeNull();
});
test("code-module execution budgets accept completed structured responses including their reasoning usage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-module-budget-"));
  try {
    const labels: string[] = [];
    const ask: any = async (_dir: string, label: string, _instructions: string, data: any, schema: any, budget: number) => {
      labels.push(label);
      if (label === "source-plan") return { interfaces: [], files: [{ path: main, responsibility: "launcher" }, { path: tests, responsibility: "tests" }] };
      if (label === "repair-plan-0") return { interfaces: [], files: [{ path: main, responsibility: "fix" }] };
      const result = label.startsWith("repair-file") ? { path: main, edits: [{ find: "old", replace: "fixed" }] } : { path: data.requestedFile.path, content: "package generated\n// Synthetic source" };
      return parseClaudeCli({ execution: { code: 0 }, turn_completed: true, errors: [], tool_activity: false, usage: { output_tokens: 12313 }, final_text: JSON.stringify(result) }, schema, budget);
    };
    await generateSources(directory, 0, "fixture", {}, null, [], async () => {}, ask);
    const repaired = await generateSources(directory, 0, "fixture", {}, { files: [{ path: main, content: "old" }], explanation: "fixture" }, ["fix"], async () => {}, ask);
    expect(repaired.files[0].content).toBe("fixed");
    expect(labels).toEqual(["source-plan", "file-0", "file-1", "repair-plan-0", "repair-file-0-0"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("modular generation requests each planned file and keeps exact shared contracts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-codegen-"));
  const calls: any[] = [];
  const ask: any = async (_dir: string, label: string, _instructions: string, data: any) => {
    calls.push({ label, data });
    if (label === "source-plan") return { interfaces: ["fun move(board: Board): Board"], files: [{ path: main, responsibility: "launcher" }, { path: tests, responsibility: "rules tests" }] };
    return { path: data.requestedFile.path, content: "package generated\n// synthetic test source" };
  };
  try {
    const result = await generateSources(directory, 0, "fixture", {}, null, [], async () => {}, ask);
    expect(result.files.map(file => file.path)).toEqual([main, tests]);
    expect(calls.map(call => call.label)).toEqual(["source-plan", "file-0", "file-1"]);
    expect(calls[2].data.generatedFiles[0].path).toBe(main);
    expect(calls[1].data.plan.interfaces).toEqual(["fun move(board: Board): Board"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("targeted repairs preserve unmodified modules and reject paths outside the source tree", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-codegen-"));
  const prior = { files: [{ path: main, content: "old" }, { path: tests, content: "unchanged tests" }], explanation: "fixture" };
  try {
    const result = await generateSources(directory, 1, "fixture", {}, prior, ["fix launcher"], async () => {}, (async (_dir: string, label: string) => label.startsWith("repair-plan") ? { interfaces: [], files: [{ path: main, responsibility: "fix launcher" }] } : { path: main, edits: [{ find: "old", replace: "fixed" }] }) as any);
    expect(result.files).toEqual([{ path: main, content: "fixed" }, { path: tests, content: "unchanged tests" }]);
    expect(() => checkSourcePaths([{ path: "app/src/main/java/generated/../../outside.kt", content: "bad" }])).toThrow();
    expect(() => checkSourcePaths([{ path: main, content: "a" }, { path: main, content: "b" }])).toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("a module cannot replace a different planned file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-codegen-"));
  const ask: any = async (_dir: string, label: string) => label === "source-plan" ? { interfaces: [], files: [{ path: main, responsibility: "launcher" }, { path: tests, responsibility: "test" }] } : { path: tests, content: "wrong file" };
  try { await expect(generateSources(directory, 0, "fixture", {}, null, [], async () => {}, ask)).rejects.toThrow("does not match"); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
test("repair schemas bind the exact module and a rejected foreign-file patch retries without applying it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-codegen-path-"));
  const prior = { files: [{ path: main, content: "old" }, { path: tests, content: "keep tests" }], explanation: "fixture" };
  const labels: string[] = [];
  try {
    const ask: any = async (_dir: string, label: string, _instructions: string, data: any, schema: any) => {
      labels.push(label);
      if (label.startsWith("repair-plan")) return { interfaces: [], files: [{ path: main, responsibility: "fix launcher" }] };
      const wrong = { path: tests, edits: [{ find: "keep tests", replace: "wrongly changed" }] };
      expect(schema.safeParse(wrong).success).toBe(false);
      expect(data.currentFiles).toEqual(prior.files);
      if (label.endsWith("edit-retry")) {
        expect(data.rejectedPatch).toEqual(wrong);
        return { path: main, edits: [{ find: "old", replace: "fixed" }] };
      }
      // Exercise the path guard too, even if a provider bypasses the schema.
      return wrong;
    };
    const result = await generateSources(directory, 0, "fixture", {}, prior, ["fix"], async () => {}, ask);
    expect(labels).toEqual(["repair-plan-0", "repair-file-0-0", "repair-file-0-0-edit-retry"]);
    expect(result.files).toEqual([{ path: main, content: "fixed" }, prior.files[1]]);
    const second = await mkdtemp(path.join(os.tmpdir(), "meld-codegen-path-reject-"));
    try {
      await expect(generateSources(second, 0, "fixture", {}, prior, ["fix"], async () => {}, (async (_dir: string, label: string) => label.startsWith("repair-plan") ? { interfaces: [], files: [{ path: main, responsibility: "fix" }] } : { path: tests, edits: [{ find: "keep tests", replace: "wrong" }] }) as any)).rejects.toThrow("does not match");
    } finally { await rm(second, { recursive: true, force: true }); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("interrupted module generation resumes its ordered checkpoint without regenerating completed files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-codegen-"));
  const completed = { path: main, content: "saved launcher" };
  const plan = { interfaces: [], files: [{ path: main, responsibility: "launcher" }, { path: tests, responsibility: "rules tests" }] };
  const labels: string[] = [];
  try {
    await write(path.join(directory, "generation-checkpoint.json"), { plan, files: [completed] });
    const result = await generateSources(directory, 0, "fixture", {}, null, [], async () => {}, (async (_dir: string, label: string, _instructions: string, data: any) => { labels.push(label); return { path: data.requestedFile.path, content: "new tests" }; }) as any);
    expect(labels).toEqual(["file-1"]); expect(result.files).toEqual([completed, { path: tests, content: "new tests" }]);
    await write(path.join(directory, "generation-checkpoint.json"), { plan, files: [{ path: tests, content: "out of order" }] });
    await expect(generateSources(directory, 0, "fixture", {}, null, [], async () => {})).rejects.toThrow("does not match");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("completed over-budget legacy batches recover only after execution, schema and path validation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-codegen-"));
  const prior = { files: [{ path: main, content: "old" }, { path: tests, content: "keep" }], explanation: "fixture" };
  const response = { execution: { code: 0 }, turn_completed: true, errors: [], tool_activity: false, usage: { output_tokens: 16900 }, final_text: JSON.stringify({ files: [{ path: main, content: "fixed" }], explanation: "repair" }) };
  try {
    const file = path.join(directory, "repair-2-123", "response.json"); await write(file, response);
    const result = await recoverCompletedBatch(directory, prior); expect(result?.sources.files).toEqual([{ path: main, content: "fixed" }, { path: tests, content: "keep" }]); expect(result?.recoveryOutputLimit).toBe(24000);
    for (const invalid of [{ ...response, tool_activity: true }, { ...response, turn_completed: false }, { ...response, errors: ["failed"] }, { ...response, usage: { output_tokens: 24001 } }, { ...response, final_text: JSON.stringify({ files: [{ path: "../escape.kt", content: "bad" }], explanation: "bad" }) }]) {
      await write(file, invalid); expect(await recoverCompletedBatch(directory, prior)).toBeNull();
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("planned repairs update dependent files sequentially without replacing unaffected modules", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-codegen-"));
  const helper = "app/src/main/java/generated/Helper.kt";
  const prior = { files: [{ path: main, content: "old" }, { path: tests, content: "keep tests" }], explanation: "fixture" };
  const calls: any[] = [];
  try {
    const result = await generateSources(directory, 1, "fixture", {}, prior, ["fix two modules"], async () => {}, (async (_dir: string, label: string, _instructions: string, data: any) => {
      calls.push({ label, data });
      if (label.startsWith("repair-plan")) return { interfaces: ["fun helper(): Int"], files: [{ path: helper, responsibility: "shared helper" }, { path: main, responsibility: "call helper" }] };
      return label.endsWith("-0") ? { path: data.requestedFile.path, content: "new helper" } : { path: data.requestedFile.path, edits: [{ find: "old", replace: "fixed launcher" }] };
    }) as any);
    expect(calls.map(x => x.label)).toEqual(["repair-plan-1", "repair-file-1-0", "repair-file-1-1"]);
    expect(calls[2].data.currentFiles.find((file: any) => file.path === helper).content).toBe("new helper");
    expect(result.files.find(file => file.path === tests)?.content).toBe("keep tests");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("accepted repair responses resume an interrupted prefix and reject an invalid next response", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-codegen-"));
  const prior = { files: [{ path: main, content: "old" }, { path: tests, content: "keep" }], explanation: "fixture" };
  const plan = { interfaces: [], files: [{ path: main, responsibility: "launcher" }, { path: tests, responsibility: "tests" }] };
  const response = (value: any, tokens = 100) => ({ execution: { code: 0 }, turn_completed: true, errors: [], tool_activity: false, usage: { output_tokens: tokens }, final_text: JSON.stringify(value) });
  try {
    await write(path.join(directory, "repair-plan-0-1/response.json"), response(plan, 13984));
    await write(path.join(directory, "repair-plan-0-1/prompt.txt"), "instructions\n" + JSON.stringify({ prior, integration: { manifest: "fixture-manifest" }, issues: ["fix"], approvedDesign: { title: "fixture" }, appProfile: { name: "fixture" } }));
    await write(path.join(directory, "repair-file-0-0-2/response.json"), response({ path: main, content: "fixed", edits: null }));
    await write(path.join(directory, "repair-file-0-1-3/response.json"), { ...response({ path: tests, content: "new tests" }), errors: ["incomplete"] });
    expect(await recoverRepairPrefix(directory, { manifest: "changed-manifest" })).toBeNull();
    expect((await recoverRepairPrefix(directory, { manifest: "fixture-manifest" }))?.files).toHaveLength(1);
    const prefix = await recoverRepairPrefix(directory); expect(prefix?.files.map(file => file.path)).toEqual([main]);
    await write(path.join(directory, "repair-file-0-1-retry-4/response.json"), response({ path: tests, content: "new tests" }, 13508));
    const complete = await recoverRepairPrefix(directory); expect(complete?.files.length).toBe(2); expect(complete?.calls.length).toBe(2);
    await write(path.join(directory, "repair-checkpoint-0.json"), { plan: prefix!.plan, files: prefix!.files });
    const calls: string[] = [];
    const resumed = await generateSources(directory, 0, "fixture", {}, prior, ["fix"], async () => {}, (async (_dir: string, label: string, _instructions: string, data: any) => { calls.push(label); return { path: data.requestedFile.path, edits: [{ find: "keep", replace: "resumed tests" }] }; }) as any);
    expect(calls).toEqual(["repair-file-0-1"]); expect(resumed.files[0].content).toBe("fixed"); expect(resumed.files[1].content).toBe("resumed tests");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a saved repair plan survives failure before its first module", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-codegen-"));
  const prior = { files: [{ path: main, content: "old" }, { path: tests, content: "keep" }], explanation: "fixture" };
  let plans = 0;
  const ask: any = async (_dir: string, label: string, _instructions: string, _data: any, _schema: any, budget: number) => {
    if (label.startsWith("repair-plan")) { plans++; expect(budget).toBeGreaterThanOrEqual(13984); return { interfaces: [], files: [{ path: main, responsibility: "launcher" }] }; }
    throw new Error("Synthetic connection loss");
  };
  try {
    await expect(generateSources(directory, 0, "fixture", {}, prior, ["fix"], async () => {}, ask)).rejects.toThrow("connection loss");
    const result = await generateSources(directory, 0, "fixture", {}, prior, ["fix"], async () => {}, (async (_dir: string, label: string) => {
      expect(label).toBe("repair-file-0-0"); return { path: main, edits: [{ find: "old", replace: "fixed" }] };
    }) as any);
    expect(plans).toBe(1); expect(result.files[0].content).toBe("fixed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("device findings survive a failed build retry and remain bound to the APK, project and design", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-feedback-"));
  const tested = "job-11111111-1111-4111-8111-111111111111", retry = "job-22222222-2222-4222-8222-222222222222";
  const expected = { projectId: "fixture-project", revision: "v0001", designHash: "fixture-hash" };
  try {
    for (const id of [tested, retry]) await write(path.join(directory, id, "input.json"), expected);
    await write(path.join(directory, retry, "retry-source.json"), { previousBuildId: tested });
    const apk = path.join(directory, tested, "source/app/build/outputs/apk/debug/app-debug.apk");
    await write(apk, "Synthetic unit-test APK bytes");
    await write(path.join(directory, tested, "runtime-findings.json"), { apkSha256: await fileSha(apk), issues: ["Rotation abandons the active timer"] });
    expect((await readRuntimeFeedback(directory, retry, expected))?.previousBuildId).toBe(tested);
    expect(await readRuntimeFeedback(directory, retry, { ...expected, projectId: "foreign" })).toBeNull();
    expect(await readRuntimeFeedback(directory, retry, { ...expected, revision: "v0002" })).toBeNull();
    await rm(path.join(directory, retry, "retry-source.json"));
    await write(path.join(directory, retry, "update-source.json"), { previousBuildId: tested });
    expect((await readRuntimeFeedback(directory, retry, expected))?.previousBuildId).toBe(tested);
    const deliveredApk = path.join(directory, tested, "artifacts/app.apk");
    await write(deliveredApk, "Delivered test APK differs from a later debug build");
    await write(path.join(directory, tested, "runtime-findings.json"), { apkSha256: await fileSha(deliveredApk), issues: ["Screen sleep fails focus"] });
    expect((await readRuntimeFeedback(directory, retry, expected))?.issues).toEqual(["Screen sleep fails focus"]);
    await write(path.join(directory, retry, "artifacts.json"), []);
    expect(await readRuntimeFeedback(directory, retry, expected)).toBeNull();
    await rm(path.join(directory, retry, "artifacts.json"));
    await rm(deliveredApk);
    await write(path.join(directory, tested, "runtime-findings.json"), { apkSha256: await fileSha(apk), issues: ["Rotation abandons the active timer"] });
    await write(apk, "Changed bytes");
    await expect(readRuntimeFeedback(directory, retry, expected)).rejects.toThrow("do not match");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("exact source edits reject stale, ambiguous, overlapping and foreign-file patches", () => {
  expect(applySourceEdits({ path: main, content: "before old after" }, { path: main, edits: [{ find: "old", replace: "fixed" }] }).content).toBe("before fixed after");
  for (const content of ["missing", "old old", "aaa"]) expect(() => applySourceEdits({ path: main, content }, { path: main, edits: [{ find: content === "aaa" ? "aa" : "old", replace: "fixed" }] })).toThrow("exactly one");
  expect(() => applySourceEdits({ path: main, content: "old" }, { path: tests, edits: [{ find: "old", replace: "fixed" }] })).toThrow("does not match");
});

test("an incomplete module retries once without repeating completed modules or hiding the failed attempt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-codegen-"));
  const labels: string[] = [];
  const plan = { interfaces: [], files: [{ path: main, responsibility: "launcher" }, { path: tests, responsibility: "rules tests" }] };
  const ask: any = async (_dir: string, label: string, _instructions: string, data: any) => {
    labels.push(label);
    if (label === "source-plan") return plan;
    if (label === "file-1") throw Object.assign(new Error("Synthetic interrupted response"), { code: "model_output" });
    return { path: data.requestedFile.path, content: "package generated\n// Synthetic source" };
  };
  try {
    const result = await generateSources(directory, 0, "fixture", {}, null, [], async () => {}, ask);
    expect(labels).toEqual(["source-plan", "file-0", "file-1", "file-1-retry"]);
    expect(result.files.map(file => file.path)).toEqual([main, tests]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("new repair modules retry interrupted responses and preserve existing source files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-codegen-"));
  const helper = "app/src/main/java/generated/ShareHelper.kt";
  const prior = { files: [{ path: main, content: "launcher" }, { path: tests, content: "existing tests" }], explanation: "fixture" };
  const labels: string[] = [];
  const ask: any = async (_dir: string, label: string) => {
    labels.push(label);
    if (label === "repair-plan-0") return { interfaces: [], files: [{ path: helper, responsibility: "share helper" }] };
    if (label === "repair-file-0-0") throw Object.assign(new Error("Synthetic incomplete response"), { code: "model_output" });
    return { path: helper, content: "package generated\n// Synthetic helper" };
  };
  try {
    const result = await generateSources(directory, 0, "fixture", {}, prior, ["Implement sharing"], async () => {}, ask);
    expect(labels).toEqual(["repair-plan-0", "repair-file-0-0", "repair-file-0-0-retry"]);
    expect(result.files.slice(0, 2)).toEqual(prior.files); expect(result.files[2].path).toBe(helper);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("implementation review never accepts a blocking issue hidden behind a passed flag", async () => {
  const { implementationReviewPassed } = await import("../../backend/src/build");
  expect(implementationReviewPassed({ passed: true, issues: ["[blocking] Sharing fails on an ordinary image"] })).toBe(false);
  expect(implementationReviewPassed({ passed: false, issues: ["[follow-up] Refine corner spacing"] })).toBe(false);
  expect(implementationReviewPassed({ passed: true, issues: ["[follow-up] Refine corner spacing"] })).toBe(true);
});

test("an ambiguous exact edit retries against the unchanged file without partially applying the rejected patch", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-codegen-"));
  const prior = { files: [{ path: main, content: "begin value value" }, { path: tests, content: "keep tests" }], explanation: "fixture" };
  const calls: string[] = [];
  const ask: any = async (_dir: string, label: string, _instructions: string, data: any) => {
    calls.push(label);
    if (label === "repair-plan-0") return { interfaces: [], files: [{ path: main, responsibility: "fix launcher" }] };
    if (label === "repair-file-0-0") return { path: main, edits: [{ find: "begin", replace: "changed" }, { find: "value", replace: "wrong" }] };
    expect(data.validationError).toContain("exactly one"); expect(data.currentFiles[0].content).toBe("begin value value");
    return { path: main, edits: [{ find: "begin value value", replace: "fixed" }] };
  };
  try {
    const result = await generateSources(directory, 0, "fixture", {}, prior, ["fix"], async () => {}, ask);
    expect(calls).toEqual(["repair-plan-0", "repair-file-0-0", "repair-file-0-0-edit-retry"]);
    expect(result.files).toEqual([{ path: main, content: "fixed" }, prior.files[1]]); expect(prior.files[0].content).toBe("begin value value");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("split-module repairs retire the original source and preserve removals across interruption", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-codegen-split-"));
  const old = "app/src/main/java/generated/Combined.kt", first = "app/src/main/java/generated/First.kt", second = "app/src/main/java/generated/Second.kt";
  const prior = { files: [{ path: main, content: "launcher" }, { path: tests, content: "production tests" }, { path: old, content: "old declarations" }], explanation: "fixture" };
  try {
    const ask: any = async (_dir: string, label: string, _instructions: string, data: any) => {
      if (label.startsWith("repair-plan")) return { interfaces: [], removePaths: [old], files: [{ path: first, responsibility: "first declaration" }, { path: second, responsibility: "second declaration" }] };
      expect(data.currentFiles.some((file: any) => file.path === old)).toBe(false);
      if (data.requestedFile.path === second) throw new Error("Synthetic interruption");
      return { path: first, content: "first declaration" };
    };
    await expect(generateSources(directory, 0, "fixture", {}, prior, ["split"], async () => {}, ask)).rejects.toThrow("Synthetic interruption");
    const calls: string[] = [];
    const result = await generateSources(directory, 0, "fixture", {}, prior, ["split"], async () => {}, (async (_dir: string, label: string, _instructions: string, data: any) => {
      calls.push(label); expect(data.currentFiles.some((file: any) => file.path === old)).toBe(false);
      return { path: second, content: "second declaration" };
    }) as any);
    expect(calls).toEqual(["repair-file-0-1"]);
    expect(result.files).toEqual([prior.files[0], prior.files[1], { path: first, content: "first declaration" }, { path: second, content: "second declaration" }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("repair removals reject foreign, duplicate and simultaneously edited paths before generating modules", async () => {
  const prior = { files: [{ path: main, content: "launcher" }, { path: tests, content: "tests" }], explanation: "fixture" };
  for (const removePaths of [["../outside.kt"], ["app/src/main/java/generated/Unknown.kt"], [tests, tests], [main]]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "meld-codegen-remove-"));
    let generated = false;
    try {
      await expect(generateSources(directory, 0, "fixture", {}, prior, ["repair"], async () => {}, (async (_dir: string, label: string) => {
        if (label.startsWith("repair-plan")) return { interfaces: [], removePaths, files: [{ path: main, responsibility: "fix" }] };
        generated = true; return { path: main, content: "unexpected" };
      }) as any)).rejects.toMatchObject({ code: "invalid_code" });
      expect(generated).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("an oversized repair plan is corrected before module generation without dropping existing sources", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-codegen-plan-bound-"));
  const prior = { files: [{ path: main, content: "old" }, { path: tests, content: "tests" }, ...Array.from({ length: 18 }, (_, i) => ({ path: `app/src/main/java/generated/Helper${i}.kt`, content: `helper ${i}` }))], explanation: "fixture" };
  const labels: string[] = [];
  try {
    const result = await generateSources(directory, 0, "fixture", {}, prior, ["repair"], async () => {}, (async (_dir: string, label: string, _prompt: string, data: any) => {
      labels.push(label);
      if (label === "repair-plan-0") return { interfaces: [], files: [{ path: "app/src/main/java/generated/Extra.kt", responsibility: "oversized addition" }] };
      if (label.includes("validation-retry")) {
        expect(data.validationError).toContain("21 planned modules");
        expect(data.rejectedPlan.files[0].path).toContain("Extra.kt");
        return { interfaces: [], files: [{ path: main, responsibility: "repair within the existing module" }] };
      }
      return { path: main, edits: [{ find: "old", replace: "fixed" }] };
    }) as any);
    expect(labels).toEqual(["repair-plan-0", "repair-plan-0-validation-retry-1", "repair-file-0-0"]);
    expect(result.files).toHaveLength(20); expect(result.files[0].content).toBe("fixed"); expect(result.files.slice(1)).toEqual(prior.files.slice(1));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a saved oversized plan is reused only as a candidate for correction, never as recovered source", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-codegen-plan-recovery-"));
  const prior = { files: [{ path: main, content: "old" }, { path: tests, content: "tests" }, ...Array.from({ length: 18 }, (_, i) => ({ path: `app/src/main/java/generated/Helper${i}.kt`, content: "helper" }))], explanation: "fixture" };
  const plan = { interfaces: [], files: [{ path: "app/src/main/java/generated/Extra.kt", responsibility: "addition" }] };
  try {
    const call = path.join(directory, "repair-plan-0-100");
    await write(path.join(call, "response.json"), { execution: { code: 0 }, turn_completed: true, errors: [], tool_activity: false, final_text: JSON.stringify(plan), usage: { output_tokens: 100 } });
    await write(path.join(call, "prompt.txt"), "Fixture prompt\n" + JSON.stringify({ prior, issues: ["repair"], approvedDesign: {}, appProfile: {}, integration: { version: 1 } }));
    const recovered = await recoverRepairPrefix(directory, { version: 1 });
    expect(recovered?.files).toEqual([]); expect(recovered && "planNeedsRepair" in recovered && recovered.planNeedsRepair).toBe(true);
    const next = path.join(directory, "next"); await write(path.join(next, "repair-checkpoint-0.json"), { plan: recovered!.plan, files: [] });
    const labels: string[] = [];
    const result = await generateSources(next, 0, "fixture", {}, prior, ["repair"], async () => {}, (async (_dir: string, label: string, _prompt: string, data: any) => {
      labels.push(label);
      if (label.includes("validation-retry")) { expect(data.validationError).toContain("21 planned modules"); return { interfaces: [], files: [{ path: main, responsibility: "fix" }] }; }
      return { path: main, edits: [{ find: "old", replace: "fixed" }] };
    }) as any);
    expect(labels[0]).toBe("repair-plan-0-validation-retry-1"); expect(result.files).toHaveLength(20);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("substantial rewrites use complete contents without duplicating old text and retain exact-file recovery safety", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-source-replacement-"));
  const prior = { files: [{ path: main, content: "old source" }, { path: tests, content: "keep tests" }], explanation: "fixture" };
  try {
    const output = await generateSources(directory, 0, "fixture", {}, prior, ["rewrite coordinator"], async () => {}, (async (_dir: string, label: string, _instructions: string, _data: any, schema: any) => {
      if (label.startsWith("repair-plan")) return { interfaces: [], files: [{ path: main, responsibility: "coordinator rewrite" }] };
      return schema.parse({ path: main, edits: null, content: "package generated\nclass MainActivity" });
    }) as any);
    expect(output.files).toEqual([{ path: main, content: "package generated\nclass MainActivity" }, prior.files[1]]);
    for (const patch of [
      { path: tests, content: "foreign", edits: null },
      { path: main, content: "ambiguous", edits: [{ find: "old source", replace: "patch" }] },
      { path: main, content: null, edits: null },
    ]) expect(() => applySourceRepair(prior.files[0], patch)).toThrow();
    expect(prior.files[0].content).toBe("old source");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
