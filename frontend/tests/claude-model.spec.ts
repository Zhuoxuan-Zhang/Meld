import { test, expect } from "./fixtures";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { modelJson } from "../../backend/src/model";
import { HighLevelDocument, highLevelRunner } from "../../backend/src/high-level";
import { z, pipelineRoot } from "../../pipeline/dist/src/integration.js";
import { projectServer } from "../../frontend/tests/project-fixtures";
import { fromScannerReport } from "../src/market";
import { scannerReport } from "./market-data";

test("outline calls use a CLI-compatible schema and distinguish CLI failures from bad model output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-model-schema-"));
  const oldBin = process.env.MELD_CLAUDE_BIN;
  const bin = path.join(directory, "claude-fixture");
  const ajv = createRequire(path.join(pipelineRoot, "package.json")).resolve("ajv");
  process.env.MELD_CLAUDE_BIN = bin;
  try {
    await writeFile(bin, `#!/usr/bin/env node
const Ajv = require(${JSON.stringify(ajv)});
const schema = JSON.parse(process.argv[process.argv.indexOf('--json-schema') + 1]);
try { new Ajv({strict:false}).compile(schema); }
catch (error) { process.stderr.write('Error: --json-schema is not a valid JSON Schema: ' + error.message); process.exit(1); }
process.stdout.write(JSON.stringify({structured_output:{document:null,response:'Please clarify the app idea.'}}));
`, { mode: 0o755 });
    const schema = z.strictObject({ document: HighLevelDocument.nullable(), response: z.string() });
    expect(await modelJson(directory, "outline", "Generate an outline.", {}, schema)).toEqual({ document: null, response: "Please clarify the app idea." });
    await writeFile(bin, "#!/usr/bin/env node\nprocess.stderr.write('Error: --json-schema is not a valid JSON Schema: unsupported dialect');process.exit(1);\n", { mode: 0o755 });
    await expect(modelJson(directory, "rejected", "Generate an outline.", {}, schema)).rejects.toMatchObject({ code: "model_configuration" });
    await writeFile(bin, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({structured_output:{unexpected:true}}));\n", { mode: 0o755 });
    await expect(modelJson(directory, "invalid", "Generate an outline.", {}, schema)).rejects.toMatchObject({ code: "model_output" });
  } finally {
    if (oldBin === undefined) delete process.env.MELD_CLAUDE_BIN; else process.env.MELD_CLAUDE_BIN = oldBin;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a legacy domain placeholder cannot override the selected base, while explicit intent is kept", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-foundation-brief-"));
  const oldBin = process.env.MELD_CLAUDE_BIN;
  const bin = path.join(directory, "claude-fixture"), input = path.join(directory, "input.json");
  const api = await projectServer();
  process.env.MELD_CLAUDE_BIN = bin;
  try {
    await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const text = fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(input)}, text.slice(text.indexOf('\\n') + 1));
process.stdout.write(JSON.stringify({structured_output:{document:null,response:'Fixture response.'},usage:{output_tokens:4394}}));
`, { mode: 0o755 });
    const project = await api.service.create({ requestKey: crypto.randomUUID(), brief: { name: "Focus & habits app", input: "Build Focus & habits app from the selected features.", purpose: "", goal: "", audience: "", style: "warm", domains: ["Focus & habits", "Notes & lists"] } });
    project.references = { "Notes & lists": fromScannerReport("Notes & lists", scannerReport("Notes & lists")) };
    project.featurePreferences.baseAppId = "com.example.notes";
    await highLevelRunner(project, directory);
    const recovered = JSON.parse(await readFile(input, "utf8"));
    expect(recovered.foundation.appId).toBe("com.example.notes");
    expect(recovered.brief.input).toContain("primary purpose and core user loop");
    expect(recovered.brief.input).not.toContain("Focus & habits");
    project.brief.input = "I want a focus timer with notes.";
    await highLevelRunner(project, directory);
    expect(JSON.parse(await readFile(input, "utf8")).brief.input).toBe(project.brief.input);
  } finally {
    if (oldBin === undefined) delete process.env.MELD_CLAUDE_BIN; else process.env.MELD_CLAUDE_BIN = oldBin;
    await api.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider session limits report a specific quota error and preserve the reset time", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-model-quota-"));
  const previous = process.env.MELD_CLAUDE_BIN, bin = path.join(directory, "claude-fixture");
  try {
    process.env.MELD_CLAUDE_BIN = bin;
    await writeFile(bin, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({is_error:true,result:"You've hit your session limit; resets 5:40am (UTC)"}));process.exitCode=1;\n`, { mode: 0o755 });
    await expect(modelJson(directory, "limited", "Fixture", {}, z.object({ ready: z.boolean() }))).rejects.toMatchObject({ code: "model_quota", status: 503, message: expect.stringContaining("5:40am (UTC)") });
  } finally { if (previous === undefined) delete process.env.MELD_CLAUDE_BIN; else process.env.MELD_CLAUDE_BIN = previous; await rm(directory, { recursive: true, force: true }); }
});

test("an explicitly configured Codex build uses the existing CLI adapter and includes implementation instructions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meld-build-provider-"));
  const previous = Object.fromEntries(["PATH", "MELD_BUILD_PROVIDER", "MELD_CODEX_BUILD_MODEL"].map(key => [key, process.env[key]]));
  const { mkdir, readdir } = await import("node:fs/promises");
  const { buildModelJson } = await import("../../backend/src/model");
  try {
    const bin = path.join(directory, "bin"); await mkdir(bin);
    const input = path.join(directory, "input.json");
    await writeFile(path.join(bin, "codex"), `#!/usr/bin/env node
const fs=require('node:fs');
const prompt=fs.readFileSync(0,'utf8');
fs.writeFileSync(${JSON.stringify(input)},JSON.stringify({prompt,args:process.argv.slice(2)}));
fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],JSON.stringify({ready:true,removePaths:[]}));
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:5}})+'\\n');
`, { mode: 0o755 });
    process.env.PATH = bin + path.delimiter + previous.PATH;
    process.env.MELD_BUILD_PROVIDER = "codex_cli"; process.env.MELD_CODEX_BUILD_MODEL = "fixture-codex";
    const result = await buildModelJson(directory, "build", "Preserve every approved tool operation.", { scope: "fixture" }, z.object({ ready: z.boolean(), removePaths: z.array(z.string()).default([]) }).strict());
    expect(result).toEqual({ ready: true, removePaths: [] });
    const captured = JSON.parse(await readFile(input, "utf8"));
    expect(captured.prompt).toContain("Preserve every approved tool operation."); expect(captured.prompt).toContain('"scope":"fixture"');
    expect(captured.args[captured.args.indexOf("--model") + 1]).toBe("fixture-codex");
    const call = (await readdir(directory)).find(name => name.startsWith("build-"))!;
    expect(JSON.parse(await readFile(path.join(directory, call, "response.json"), "utf8")).provider).toBe("codex_cli");
    process.env.MELD_BUILD_PROVIDER = "unsupported";
    await expect(buildModelJson(directory, "invalid", "Fixture", {}, z.object({ ready: z.boolean() }))).rejects.toMatchObject({ code: "model_configuration" });
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(directory, { recursive: true, force: true }); }
});
