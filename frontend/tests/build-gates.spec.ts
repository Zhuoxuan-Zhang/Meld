import { test, expect } from '@playwright/test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cp, readFile, writeFile, rm } from 'node:fs/promises';
import { androidBuildRunner, hasForbiddenSourceOperation } from '../../backend/src/build';
import { exists, json, pipelineRoot, write, fileSha } from '../../pipeline/dist/src/integration.js';
import { projectServer, idea } from './project-fixtures';
import { uiAssertionIssues } from '../../backend/src/ui-validation';

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
  await writeFile(path.join(template, 'gradlew'), "#!/bin/bash\nmkdir -p app/build/outputs/apk/debug\nprintf 'synthetic APK' > app/build/outputs/apk/debug/app-debug.apk\nprintf 'BUILD SUCCESSFUL in 1s\\n'\n", { mode: 0o755 });
  const calls = path.join(api.root, 'calls.jsonl'), cli = path.join(api.root, 'claude-fixture');
  await writeFile(cli, `#!/usr/bin/env node
const fs = require('node:fs');
const prompt = fs.readFileSync(0,'utf8');
const schema = JSON.parse(process.argv[process.argv.indexOf('--json-schema')+1]);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({prompt,schema})+'\\n');
const output = schema.properties.passed ? {passed:false,issues:['[blocking] Crop controls are placeholders.'],acceptanceTests:['Crop must change exported pixels.']} : {};
process.stdout.write(JSON.stringify({type:'result',structured_output:output}));
`, { mode: 0o755 });
  const marker = path.join(api.root, 'native-executed'), native = path.join(api.root, 'native.py');
  await writeFile(native, `from pathlib import Path
import os,sys,json,hashlib,base64
Path(${JSON.stringify(marker)}).write_text('synthetic device fixture, not runtime proof')
out=Path(os.environ['MELD_NATIVE_QA_OUTPUT'])
(out/'home-ready.png').write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='))
report={'passed':True,'apkSha256':hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest(),'packageId':sys.argv[2],'device':{'serial':'fixture','api':'35','abi':'fixture','display':'fixture'},'cases':[{'case':'Synthetic orchestration fixture '+str(i),'passed':True} for i in range(6)],'scope':'Synthetic orchestration only; no actual device tested.'}
(out/'runtime-report.json').write_text(json.dumps(report))
`);
  const environment = { sdk, javaHome, templateDirectory: template, nativeSmoke: { projectId: project.id, script: native, adb: '/unused-fixture-adb', serial: 'fixture', output: path.join(api.root, 'device') } };
  const runner = androidBuildRunner(environment);
  return { api, cli, calls, marker, directory, environment, input: { project, revision, designHash, directory, design: { developer_design: { title: 'Synthetic' } }, progress: async () => {} }, runner };
}

test('device screenshots inform implementation review while a rejection still prevents publication', async () => {
  const setup = await fixture(), previous = process.env.MELD_CLAUDE_BIN;
  process.env.MELD_CLAUDE_BIN = setup.cli;
  try {
    await expect(setup.runner(setup.input)).rejects.toMatchObject({ code: 'model_output' });
    const pinned = await json(path.join(setup.directory, 'coding-skills.json'));
    const modelDirectories = await (await import('node:fs/promises')).readdir(path.join(setup.directory, 'model'));
    const reviewDirectory = modelDirectories.find(name => name.startsWith('review-0-'))!;
    const request = await json(path.join(setup.directory, 'model', reviewDirectory, 'request.json'));
    const payload = JSON.parse(request.prompt.trim().split('\n').at(-1));
    expect(payload.codingSkills.fingerprint).toBe(pinned.fingerprint);
    expect(payload.codingSkills.skills.map((skill: any) => skill.id)).toEqual(['edge-to-edge', 'adaptive', 'jetpack-compose-performance']);
    expect(request.system).not.toContain('# Base app UI design');
    expect((await json(path.join(setup.directory, 'review-0.json'))).passed).toBe(false);
    expect(await exists(setup.marker)).toBe(true);
    expect(payload.runtimeEvidence.report.apkSha256).toBe(await fileSha(path.join(setup.directory,'source/app/build/outputs/apk/debug/app-debug.apk')));
    expect(payload.runtimeEvidence.screenshots[0].name).toBe('home-ready.png');
    expect(request.images).toHaveLength(1);
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
    expect(await exists(setup.marker)).toBe(true);
    expect(await exists(path.join(setup.directory, 'artifacts.json'))).toBe(false);
  } finally { if (previous === undefined) delete process.env.MELD_CLAUDE_BIN; else process.env.MELD_CLAUDE_BIN = previous; await setup.api.close(); }
});


test('captured app assertions provide concrete repair findings while missing evidence stays unverified', () => {
  const artifact = { path: 'fixture', sha256: 'a'.repeat(64) };
  const scene = { id: 'adjust', goal: 'Keep the photo and Apply/Cancel visible.', required: true, status: 'failed' as const, screenshot: artifact, hierarchy: artifact, window: artifact, visibleText: ['Brightness', 'Contrast'], error: 'Error: Expected visible text missing: Apply' };
  const issues = uiAssertionIssues([scene, { ...scene, id: 'device', error: 'Error: REA adb is unavailable' }, { ...scene, id: 'foreground', error: 'Error: Captured foreground window does not belong to the planned app' }, { ...scene, id: 'no-image', screenshot: undefined }, { ...scene, id: 'optional', required: false }]);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toContain('Screen adjust');
  expect(issues[0]).toContain('Apply');
  expect(issues[0]).toContain('Brightness | Contrast');
});

test('an invalid explicitly selected REA adb fails before model, compiler and native work', async () => {
  const setup = await fixture();
  const previous = process.env.REA_ADB_PATH, fallback = process.env.MELD_ANDROID_ADB;
  try {
    const config = path.join(setup.api.root, 'ui-config.json');
    await write(config, { projects: { [setup.input.project.id]: {
      referenceDirectory: 'not-yet-needed-reference', serial: 'fixture',
      scenarios: [{ id: 'home', goal: 'Show the image editor home screen.', steps: [], expectedText: ['Choose photo'] }],
      vision: { provider: 'codex_cli', model: 'fixture-model', reasoningEffort: 'low' },
    } } });
    process.env.REA_ADB_PATH = path.join(setup.api.root, 'missing-platform-tools/adb');
    process.env.MELD_ANDROID_ADB = setup.cli;
    await expect(androidBuildRunner({ ...setup.environment, uiValidationConfig: config })(setup.input)).rejects.toMatchObject({ code: 'ui_environment' });
    expect(await exists(setup.calls)).toBe(false);
    expect(await exists(setup.marker)).toBe(false);
    expect(await exists(path.join(setup.directory, 'gradle-0.log'))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.REA_ADB_PATH; else process.env.REA_ADB_PATH = previous;
    if (fallback === undefined) delete process.env.MELD_ANDROID_ADB; else process.env.MELD_ANDROID_ADB = fallback;
    await setup.api.close();
  }
});


test('a signalled native process stops as a harness failure without app repair', async () => {
  const setup = await fixture(), previous = process.env.MELD_CLAUDE_BIN;
  process.env.MELD_CLAUDE_BIN = setup.cli;
  try {
    await writeFile(setup.cli, (await readFile(setup.cli, 'utf8')).replace('passed:false', 'passed:true').replace("issues:['[blocking] Crop controls are placeholders.']", 'issues:[]'));
    await writeFile(setup.environment.nativeSmoke.script, 'import os,signal\nos.kill(os.getpid(),signal.SIGTERM)\n');
    await expect(setup.runner(setup.input)).rejects.toMatchObject({ code: 'native_harness', message: expect.stringContaining('SIGTERM') });
    expect((await json(path.join(setup.directory, 'failure.json'))).stage).toBe('native');
    expect(await exists(setup.calls)).toBe(false);
    expect(await exists(path.join(setup.directory, 'artifacts.json'))).toBe(false);
  } finally { if (previous === undefined) delete process.env.MELD_CLAUDE_BIN; else process.env.MELD_CLAUDE_BIN = previous; await setup.api.close(); }
});

for (const legacyMessage of ['Actual Android UI checks failed (null). PASS launch', 'Actual Android UI checks failed (1).\nRuntimeError: Tool not reachable: Text and stickers']) test(`legacy native harness failure retries source without app generation: ${legacyMessage.split('\n').at(-1)}`, async () => {
  const setup = await fixture(true), previous = process.env.MELD_CLAUDE_BIN;
  process.env.MELD_CLAUDE_BIN = setup.cli;
  try {
    await write(path.join(path.dirname(setup.directory), setup.input.project.latestBuild!.id, 'failure.json'), { stage: 'native', issues: [legacyMessage] });
    await expect(setup.runner(setup.input)).rejects.toMatchObject({ code: 'model_output' });
    const first = JSON.parse((await readFile(setup.calls, 'utf8')).trim().split('\n')[0]);
    expect(first.schema.properties.passed).toBeDefined();
    expect(await exists(path.join(setup.directory, 'harness-retry.json'))).toBe(true);
  } finally { if (previous === undefined) delete process.env.MELD_CLAUDE_BIN; else process.env.MELD_CLAUDE_BIN = previous; await setup.api.close(); }
});

for (const legacyStage of ['review', undefined]) test(`an old source-only review is rechecked with device evidence: ${legacyStage || 'legacy missing stage'}`, async () => {
  const setup = await fixture(true), previous = process.env.MELD_CLAUDE_BIN;
  process.env.MELD_CLAUDE_BIN = setup.cli;
  const directory = path.join(path.dirname(setup.directory), setup.input.project.latestBuild!.id);
  try {
    const rejection = { passed:false, issues:['[blocking] Estimated layout may hide Plant.'], acceptanceTests:['Measure the real phone viewport.'] };
    await write(path.join(directory,'failure.json'),{...(legacyStage ? {stage:legacyStage,round:0} : {}),issues:rejection.issues});
    await write(path.join(directory,'review-0.json'),rejection);
    await expect(setup.runner(setup.input)).rejects.toMatchObject({code:'model_output'});
    expect(await exists(path.join(setup.directory,'review-evidence-recheck.json'))).toBe(true);
    const first=JSON.parse((await readFile(setup.calls,'utf8')).trim().split('\n')[0]);
    expect(first.schema.properties.passed).toBeDefined();
    expect((await json(path.join(setup.directory,'review-runtime-context-0.json'))).runtimeEvidence.report.passed).toBe(true);
    expect(await exists(path.join(setup.directory,'artifacts.json'))).toBe(false);
  } finally { if(previous===undefined)delete process.env.MELD_CLAUDE_BIN;else process.env.MELD_CLAUDE_BIN=previous;await setup.api.close(); }
});
