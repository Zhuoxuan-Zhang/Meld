import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateSources, checkSourcePaths, recoverCompletedBatch, recoverRepairPrefix, applySourceEdits } from "../../backend/src/codegen";
import { write } from "../../pipeline/dist/src/integration.js";

const main = "app/src/main/java/generated/MainActivity.kt";
const tests = "app/src/test/java/generated/RulesTest.kt";
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
    await write(path.join(directory, "repair-plan-0-1/response.json"), response(plan));
    await write(path.join(directory, "repair-plan-0-1/prompt.txt"), "instructions\n" + JSON.stringify({ prior, integration: { manifest: "fixture-manifest" }, issues: ["fix"], approvedDesign: { title: "fixture" }, appProfile: { name: "fixture" } }));
    await write(path.join(directory, "repair-file-0-0-2/response.json"), response({ path: main, content: "fixed" }));
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
