import { test, expect } from '@playwright/test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cp, readFile, writeFile, rm } from 'node:fs/promises';
import { androidBuildRunner, hasForbiddenSourceOperation } from '../../backend/src/build';
import { exists, json, pipelineRoot, write, fileSha } from '../../pipeline/dist/src/integration.js';
import { projectServer, idea } from './project-fixtures';

// Synthetic external-tool fixtures establish orchestration and recovery only.
// Real compilation, model review and device behavior are checked by live runs.
async function fixture(runtimeFailure = false) {
  const api = await projectServer();
  const project = await api.service.create({ requestKey: randomUUID(), brief: idea, exampleId: 'notes' });
  const revision = project.currentDesignRevision!, designHash = 'a'.repeat(64);
  const previousId = `job-${randomUUID()}`, directory = path.join(api.root, 'builds', `job-${randomUUID()}`);
  const previous = path.join(path.dirname(directory), previousId);
  const files = [
    { path: 'app/src/main/java/generated/MainActivity.kt', content: 'package generated\nclass MainActivity' },
    { path: 'app/src/test/java/generated/LogicTest.kt', content: 'package generated\nclass LogicTest' },
  ];
  await write(path.join(previous, 'model/implementation-0.json'), { files, explanation: 'Synthetic fixture, not a compiled implementation.' });
  project.latestBuild = { id: previousId, revision, designHash, status: runtimeFailure ? 'failed' : 'succeeded', artifacts: [] };
  if (runtimeFailure) {
    await write(path.join(previous, 'input.json'), { projectId: project.id, revision, designHash });
    await write(path.join(previous, 'failure.json'), { stage: 'native', issues: ['Actual Android UI checks failed: rotated JPEG kept its original dimensions.'] });
    await write(path.join(previous, 'gradle-0.log'), 'BUILD SUCCESSFUL in 1s\n');
    for (const file of files) await write(path.join(previous, 'source', file.path), file.content);
  }
  const template = path.join(api.root, 'template'), sdk = path.join(api.root, 'sdk'), javaHome = path.join(api.root, 'jdk');
  await cp(path.join(pipelineRoot, '../backend/templates/android'), template, { recursive: true });
  await write(path.join(sdk, 'platforms/android-35/android.jar'), 'fixture');
  await write(path.join(javaHome, 'bin/java'), 'fixture');
  await writeFile(path.join(template, 'gradlew'), "#!/bin/bash\nprintf 'BUILD SUCCESSFUL in 1s\\n'\n", { mode: 0o755 });
  const calls = path.join(api.root, 'calls.jsonl'), cli = path.join(api.root, 'claude-fixture');
  await writeFile(cli, `#!/usr/bin/env node
const fs = require('node:fs');
const prompt = fs.readFileSync(0,'utf8');
const schema = JSON.parse(process.argv[process.argv.indexOf('--json-schema')+1]);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({prompt,schema})+'\\n');
const output = schema.properties.passed ? {passed:false,issues:['[blocking] Crop controls are placeholders.'],acceptanceTests:['Crop must change exported pixels.']} : {};
process.stdout.write(JSON.stringify({structured_output:output}));
`, { mode: 0o755 });
  const marker = path.join(api.root, 'native-executed'), native = path.join(api.root, 'native.py');
  await writeFile(native, `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('unexpected')\nraise SystemExit(1)\n`);
  const runner = androidBuildRunner({ sdk, javaHome, templateDirectory: template, nativeSmoke: { projectId: project.id, script: native, adb: '/unused-fixture-adb', serial: 'fixture', output: path.join(api.root, 'device') } });
  return { api, cli, calls, marker, directory, input: { project, revision, designHash, directory, design: { developer_design: { title: 'Synthetic' } }, progress: async () => {} }, runner };
}

test('a rejected implementation review cannot reach device checks or publish an APK', async () => {
  const setup = await fixture(), previous = process.env.MELD_CLAUDE_BIN;
  process.env.MELD_CLAUDE_BIN = setup.cli;
  try {
    await expect(setup.runner(setup.input)).rejects.toMatchObject({ code: 'model_output' });
    expect((await json(path.join(setup.directory, 'review-0.json'))).passed).toBe(false);
    expect(await exists(setup.marker)).toBe(false);
    expect(await exists(path.join(setup.directory, 'artifacts.json'))).toBe(false);
  } finally { if (previous === undefined) delete process.env.MELD_CLAUDE_BIN; else process.env.MELD_CLAUDE_BIN = previous; await setup.api.close(); }
});

test('recovery preserves native failures recorded after compilation and before review', async () => {
  const setup = await fixture(true), previous = process.env.MELD_CLAUDE_BIN;
  process.env.MELD_CLAUDE_BIN = setup.cli;
  try {
    await expect(setup.runner(setup.input)).rejects.toMatchObject({ code: 'model_output' });
    const first = JSON.parse((await readFile(setup.calls, 'utf8')).trim().split('\n')[0]);
    const context = JSON.parse(first.prompt.trim().split('\n').at(-1));
    expect(context.issues).toContain('Actual Android UI checks failed: rotated JPEG kept its original dimensions.');
    expect(await exists(path.join(setup.directory, 'checked-source-recovery.json'))).toBe(false);
  } finally { if (previous === undefined) delete process.env.MELD_CLAUDE_BIN; else process.env.MELD_CLAUDE_BIN = previous; await setup.api.close(); }
});


test('recovery distinguishes previously consumed APK feedback from genuinely new findings', async () => {
  const setup = await fixture(true), previous = process.env.MELD_CLAUDE_BIN;
  process.env.MELD_CLAUDE_BIN = setup.cli;
  const previousId = setup.input.project.latestBuild!.id;
  const previousDirectory = path.join(path.dirname(setup.directory), previousId);
  const testedId = `job-${randomUUID()}`, tested = path.join(path.dirname(setup.directory), testedId);
  try {
    await write(path.join(tested, 'input.json'), { projectId: setup.input.project.id, revision: setup.input.revision, designHash: setup.input.designHash });
    const apk = path.join(tested, 'source/app/build/outputs/apk/debug/app-debug.apk');
    await write(apk, 'Synthetic older tested APK');
    const finding = { apkSha256: await fileSha(apk), issues: ['Older import finding already supplied to the recovered implementation.'] };
    await write(path.join(tested, 'runtime-findings.json'), finding);
    await write(path.join(previousDirectory, 'retry-source.json'), { previousBuildId: testedId });
    await write(path.join(previousDirectory, 'runtime-feedback-source.json'), { previousBuildId: testedId, ...finding });
    await expect(setup.runner(setup.input)).rejects.toMatchObject({ code: 'model_output' });
    let first = JSON.parse((await readFile(setup.calls, 'utf8')).trim().split('\n')[0]);
    let context = JSON.parse(first.prompt.trim().split('\n').at(-1));
    expect(context.issues).toEqual(['Actual Android UI checks failed: rotated JPEG kept its original dimensions.']);
    expect((await json(path.join(setup.directory, 'runtime-feedback-replay.json'))).sourceBuildId).toBe(previousId);
    await write(path.join(tested, 'runtime-findings.json'), { ...finding, issues: ['Newly observed loss of edited pixels.'] });
    await writeFile(setup.calls, '');
    await expect(setup.runner(setup.input)).rejects.toMatchObject({ code: 'model_output' });
    first = JSON.parse((await readFile(setup.calls, 'utf8')).trim().split('\n')[0]);
    context = JSON.parse(first.prompt.trim().split('\n').at(-1));
    expect(context.issues).toContain('Newly observed loss of edited pixels.');
    expect(await exists(setup.marker)).toBe(false);
  } finally { if (previous === undefined) delete process.env.MELD_CLAUDE_BIN; else process.env.MELD_CLAUDE_BIN = previous; await setup.api.close(); }
});


test('source policy accepts heap reads but rejects process access and escaping Runtime aliases', () => {
  expect(hasForbiddenSourceOperation('val available = Runtime.getRuntime().maxMemory()')).toBe(false);
  expect(hasForbiddenSourceOperation('val runtime = Runtime.getRuntime()\nval used = runtime.totalMemory() - runtime.freeMemory()\nval available = runtime.maxMemory() - used')).toBe(false);
  for (const source of [
    'Runtime.getRuntime().exec("command")',
    'val runtime = Runtime.getRuntime()\nruntime.exec("command")',
    'val runtime = Runtime.getRuntime().exec("command")',
    'val runtime = Runtime.getRuntime()\nreturn runtime',
    'val runtime = Runtime.getRuntime()\nval escaped = runtime',
    'ProcessBuilder("command")', 'System.exit(0)', 'java.net.URL("https://example.test")',
  ]) expect(hasForbiddenSourceOperation(source), source).toBe(true);
});

test('a complete generated snapshot survives a source-gate interruption without repeating model generation', async () => {
  const setup = await fixture(true), previous = process.env.MELD_CLAUDE_BIN;
  process.env.MELD_CLAUDE_BIN = setup.cli;
  const previousDirectory = path.join(path.dirname(setup.directory), setup.input.project.latestBuild!.id);
  try {
    await rm(path.join(previousDirectory, 'failure.json'));
    await rm(path.join(previousDirectory, 'gradle-0.log'));
    await expect(setup.runner(setup.input)).rejects.toMatchObject({ code: 'model_output' });
    const first = JSON.parse((await readFile(setup.calls, 'utf8')).trim().split('\n')[0]);
    expect(first.schema.properties.passed).toBeDefined();
    expect(await exists(path.join(setup.directory, 'generated-source-recovery.json'))).toBe(true);
    expect(await exists(setup.marker)).toBe(false);
    expect(await exists(path.join(setup.directory, 'artifacts.json'))).toBe(false);
  } finally { if (previous === undefined) delete process.env.MELD_CLAUDE_BIN; else process.env.MELD_CLAUDE_BIN = previous; await setup.api.close(); }
});
