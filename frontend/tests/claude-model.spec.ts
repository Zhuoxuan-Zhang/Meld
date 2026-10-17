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
