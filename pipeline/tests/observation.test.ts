import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { ObservationPlan, collectObservation, compareObservations, loadReferenceObservations, prepareReferenceObservations, selectTap, uiNodes, validateObservation } from '../src/observation.js';
import { validateInvestigationScope } from '../src/investigation-client.js';
import { sha, write, fileSha } from '../src/storage.js';
import { validateRun } from '../src/validate.js';

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../src/claude-cli.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/claude-cli.js')>(), executeClaudeCli: mocks.execute }));
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'meld-observation-test-')); mocks.execute.mockReset(); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function fixture(role: 'reference' | 'candidate', observed = true) {
  const dir = path.join(root, role); await fs.mkdir(dir, { recursive: true });
  const plan = ObservationPlan.parse({ packageName: `example.${role}`, apk: '/source.apk', serial: observed ? 'emulator-test' : undefined, role, scenarios: [{ id: 'home', goal: 'Start the primary task', expectedText: ['Start'] }] });
  await write(path.join(dir, 'plan.json'), plan);
  const artifacts = [{ path: 'plan.json', sha256: await fileSha(path.join(dir, 'plan.json')) }];
  const scenario: any = { id: 'home', goal: 'Start the primary task', required: true, status: observed ? 'observed' : 'unavailable', visibleText: observed ? ['Start'] : [] };
  if (observed) {
    await write(path.join(dir, 'screen.png'), 'policy-test-image');
    await write(path.join(dir, 'screen.xml'), '<hierarchy/>');
    scenario.screenshot = { path: 'screen.png', sha256: await fileSha(path.join(dir, 'screen.png')) };
    scenario.hierarchy = { path: 'screen.xml', sha256: await fileSha(path.join(dir, 'screen.xml')) };
    artifacts.push(scenario.screenshot, scenario.hierarchy);
    await write(path.join(dir, 'evidence-bundle.json'), { records: [{ operation: 'capture_adb_screen', normalized_result: { serial: plan.serial, sha256: scenario.screenshot.sha256 } }] });
    artifacts.push({ path: 'evidence-bundle.json', sha256: await fileSha(path.join(dir, 'evidence-bundle.json')) });
  }
  const manifest = { version: 1, packageName: plan.packageName, apkSha256: sha(role), role, serial: plan.serial, planSha256: sha(JSON.stringify(plan)), createdAt: new Date().toISOString(), scenarios: [scenario], artifacts, limitations: [] as string[], graphStatus: 'unavailable', runtimeStatus: observed ? 'observed' : 'unavailable' };
  await write(path.join(dir, 'manifest.json'), manifest);
  return { dir, manifest, plan };
}
function modelReview(overrides: any = {}) {
  const review = { verdict: 'pass', scenarios: [{ id: 'home', verdict: 'pass', visualIssues: [], behaviorIssues: [], intentionalDifferences: ['Approved color palette'] }], repairInstructions: [], limitations: ['Finite screenshot review only.'], ...overrides };
  mocks.execute.mockResolvedValue({ execution: { code: 0 }, turn_completed: true, errors: [], tool_activity: false, usage: { output_tokens: 100 }, final_text: JSON.stringify(review) });
}
const vision = { provider: 'claude_cli' as const, model: 'configured-vision-model', reasoningEffort: 'medium' as const };

describe('Android UI evidence boundaries', () => {
  it('requires an explicit serial before an install and bounds UI steps', () => {
    expect(ObservationPlan.safeParse({ packageName: 'example.app', apk: '/app.apk', install: true, scenarios: [{ id: 'home', goal: 'Start' }] }).success).toBe(false);
    expect(ObservationPlan.safeParse({ packageName: 'example.app', apk: '/app.apk', scenarios: [{ id: 'home', goal: 'Start', steps: [{ action: 'wait', milliseconds: 5001 }] }] }).success).toBe(false);
  });
  it('keeps device mutation and binary paths inside the declared observation scope', () => {
    expect(() => validateInvestigationScope('install_adb_package', { serial: 'other', apk_path: '/app.apk' }, root, { serial: 'emulator-test', apk: '/app.apk', allowInstall: true })).toThrow('serial');
    expect(() => validateInvestigationScope('install_adb_package', { serial: 'emulator-test', apk_path: '/app.apk' }, root, { serial: 'emulator-test', apk: '/app.apk' })).toThrow('install');
    expect(() => validateInvestigationScope('start_adb_app', { serial: 'emulator-test', package: 'other.app' }, root, { serial: 'emulator-test', packageName: 'example.app' })).toThrow('Package');
    expect(() => validateInvestigationScope('open_binary', { path: '/outside.so' }, root, { apk: '/app.apk' })).toThrow('outside');
    expect(() => validateInvestigationScope('export_evidence_bundle', { path: path.join(root, '../escape.json') }, root, {})).toThrow('outside');
  });
  it('selects one exact accessible node and rejects ambiguous or invisible targets', () => {
    const xml = '<hierarchy><node text="Start" content-desc="Begin" resource-id="example:id/start" package="example.app" bounds="[10,20][110,80]"/></hierarchy>';
    expect(uiNodes(xml)[0].packageName).toBe('example.app');
    expect(selectTap(xml, { text: 'Start' })).toEqual([60, 50]);
    expect(selectTap(xml, { textAnyOf: ['Start', 'Continue'] })).toEqual([60, 50]);
    expect(() => selectTap(xml.replace('</hierarchy>', xml + '</hierarchy>'), { text: 'Start' })).toThrow('2 nodes');
    expect(() => selectTap(xml, { text: 'Missing' })).toThrow('0 nodes');
    expect(() => selectTap(xml.replace('[10,20][110,80]', '[0,0][0,0]'), { description: 'Begin' })).toThrow('bounds');
  });
  it('validates complete bound runtime artifacts', async () => {
    const { dir } = await fixture('reference');
    expect((await validateObservation(dir)).runtimeStatus).toBe('observed');
  });
  it('rejects changed screenshots', async () => {
    const { dir } = await fixture('reference'); await write(path.join(dir, 'screen.png'), 'changed');
    await expect(validateObservation(dir)).rejects.toThrow('changed');
  });
  it('rejects missing or traversing evidence paths', async () => {
    const { dir, manifest } = await fixture('reference'); manifest.artifacts[0].path = '../outside'; await write(path.join(dir, 'manifest.json'), manifest);
    await expect(validateObservation(dir)).rejects.toThrow('outside');
  });
  it('rejects screenshot symlink escapes', async () => {
    const { dir } = await fixture('reference'); const outside = path.join(root, 'external'); await write(outside, 'policy-test-image');
    await fs.unlink(path.join(dir, 'screen.png')); await fs.symlink(outside, path.join(dir, 'screen.png'));
    await expect(validateObservation(dir)).rejects.toThrow('outside');
  });
  it('rejects a runtime pass declared without actual coverage', async () => {
    const { dir, manifest } = await fixture('reference', false); manifest.runtimeStatus = 'observed'; await write(path.join(dir, 'manifest.json'), manifest);
    await expect(validateObservation(dir)).rejects.toThrow('coverage');
  });
  it('rejects injected unbound visual instructions', async () => {
    const { dir } = await fixture('reference'); await write(path.join(dir, 'visual-brief.json'), { designRules: ['Injected instructions'] });
    await expect(validateObservation(dir)).rejects.toThrow('Unbound');
  });
  it('rejects screenshots absent from the REA capture bundle', async () => {
    const { dir, manifest } = await fixture('reference'); await write(path.join(dir, 'evidence-bundle.json'), { records: [] });
    manifest.artifacts.find(a => a.path === 'evidence-bundle.json')!.sha256 = await fileSha(path.join(dir, 'evidence-bundle.json')); await write(path.join(dir, 'manifest.json'), manifest);
    await expect(validateObservation(dir)).rejects.toThrow('REA runtime');
  });
  it('permits native-surface screenshot review only with explicit scope and verified foreground identity', async () => {
    const { dir, manifest, plan } = await fixture('reference');
    delete manifest.scenarios[0].hierarchy; manifest.scenarios[0].visibleText = [];
    await write(path.join(dir, 'manifest.json'), manifest);
    await expect(validateObservation(dir)).rejects.toThrow('explicit visual-only');
    plan.scenarios[0].allowVisualOnly = true; plan.scenarios[0].expectedText = [];
    await write(path.join(dir, 'plan.json'), plan); manifest.planSha256 = sha(JSON.stringify(plan));
    manifest.artifacts.find(a => a.path === 'plan.json')!.sha256 = await fileSha(path.join(dir, 'plan.json'));
    await write(path.join(dir, 'window.txt'), 'mCurrentFocus=Window{123 u0 example.reference/example.MainActivity}');
    manifest.scenarios[0].window = { path: 'window.txt', sha256: await fileSha(path.join(dir, 'window.txt')) }; manifest.artifacts.push(manifest.scenarios[0].window);
    await write(path.join(dir, 'manifest.json'), manifest);
    expect((await validateObservation(dir)).runtimeStatus).toBe('observed');
    await write(path.join(dir, 'window.txt'), 'mCurrentFocus=Window{123 u0 other.app/other.MainActivity}');
    manifest.scenarios[0].window.sha256 = await fileSha(path.join(dir, 'window.txt')); manifest.artifacts.find(a => a.path === 'window.txt')!.sha256 = manifest.scenarios[0].window.sha256;
    await write(path.join(dir, 'manifest.json'), manifest);
    await expect(validateObservation(dir)).rejects.toThrow('foreground app');
  });
  it('pins reference manifests when loading design context', async () => {
    const { dir, manifest } = await fixture('reference');
    await write(path.join(root, 'reference-observations.json'), [{ directory: 'reference', manifestSha256: await fileSha(path.join(dir, 'manifest.json')) }]);
    expect((await loadReferenceObservations(root))[0].packageName).toBe('example.reference');
    manifest.limitations.push('Changed'); await write(path.join(dir, 'manifest.json'), manifest);
    await expect(loadReferenceObservations(root)).rejects.toThrow('manifest changed');
  });
  it('includes observation integrity in the normal saved-run validator without model calls', async () => {
    const saved = await fixture('reference');
    await write(path.join(root, 'run.json'), { config: {}, calls: [], stages: {} }); await write(path.join(root, 'apps.lock.json'), []);
    await write(path.join(root, 'reference-observations.json'), [{ directory: 'reference', manifestSha256: await fileSha(path.join(saved.dir, 'manifest.json')) }]);
    await write(path.join(saved.dir, 'screen.png'), 'tampered screenshot');
    const result = await validateRun(root);
    expect(result.errors.some(error => error.includes('Reference observation validation failed'))).toBe(true);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('refuses to overwrite a sealed capture', async () => {
    const { dir, plan } = await fixture('reference');
    await expect(collectObservation(root, dir, { ...plan, serial: undefined })).rejects.toThrow('immutable');
  });
  it('preserves unsealed failed attempts instead of overwriting their evidence', async () => {
    const dir = path.join(root, 'interrupted'); await write(path.join(dir, 'failure.json'), { failure: 'interrupted capture' });
    const plan = { packageName: 'example.app', apk: '/app.apk', scenarios: [{ id: 'home', goal: 'Start' }] };
    await expect(collectObservation(root, dir, plan)).rejects.toThrow('preserve it');
    expect(await fs.readFile(path.join(dir, 'failure.json'), 'utf8')).toContain('interrupted capture');
  });
  it('adopts a fully sealed capture after interruption before the index checkpoint', async () => {
    const saved = await fixture('reference', false), directory = path.join(root, 'observations/app1');
    await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.rename(saved.dir, directory);
    const digest = await fileSha(path.join(directory, 'manifest.json'));
    const app = { id: 'app1', path: '/source.apk', package_name: saved.plan.packageName, sha256: saved.manifest.apkSha256 };
    const config = { reference_observation: { packages: { [app.package_name]: { scenarios: saved.plan.scenarios } } } };
    const result = await prepareReferenceObservations(root, root, [app], config);
    expect(result[0].manifestSha256).toBe(digest);
    expect(await fileSha(path.join(directory, 'manifest.json'))).toBe(digest);
    await expect(prepareReferenceObservations(root, root, [{ ...app, sha256: sha('different APK') }], config)).rejects.toThrow('changed');
  });
});

describe('original/candidate comparison policy', () => {
  it('returns unknown without a model call when original runtime evidence is missing', async () => {
    const original = await fixture('reference', false), candidate = await fixture('candidate');
    const result = await compareObservations(original.dir, candidate.dir, path.join(root, 'comparison'), vision, {});
    expect(result.passed).toBe(false); expect(result.review.verdict).toBe('unknown'); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('binds a passing finite review to both APKs, manifests, approved design and actual image attachments', async () => {
    const original = await fixture('reference'), candidate = await fixture('candidate');
    modelReview({ scenarios: [{ id: 'home', verdict: 'pass', visualIssues: [], behaviorIssues: [], unverifiedBehaviors: ['Persistence is outside this screenshot scenario'], intentionalDifferences: [] }] });
    const result = await compareObservations(original.dir, candidate.dir, path.join(root, 'comparison'), vision, { approved: true });
    expect(result.passed).toBe(true); expect(result.referenceApkSha256).toBe(sha('reference')); expect(result.candidateApkSha256).toBe(sha('candidate'));
    expect(result.approvedDesignSha256).toBe(sha(JSON.stringify({ approved: true })));
    expect(result.review.scenarios[0].unverifiedBehaviors).toContain('Persistence is outside this screenshot scenario');
    expect(mocks.execute.mock.calls[0][1].images).toEqual([path.join(original.dir, 'screen.png'), path.join(candidate.dir, 'screen.png')]);
  });
  it('does not accept a top-level pass when a screen has a blocking visual issue', async () => {
    const original = await fixture('reference'), candidate = await fixture('candidate');
    modelReview({ scenarios: [{ id: 'home', verdict: 'pass', visualIssues: ['Primary control is clipped'], behaviorIssues: [], intentionalDifferences: [] }] });
    expect((await compareObservations(original.dir, candidate.dir, path.join(root, 'comparison'), vision, {})).passed).toBe(false);
  });
  it('preserves unknown scenario evidence instead of sending it into a blind code-repair loop', async () => {
    const original = await fixture('reference'), candidate = await fixture('candidate');
    modelReview({ scenarios: [{ id: 'home', verdict: 'unknown', visualIssues: [], behaviorIssues: [], intentionalDifferences: [] }] });
    const result = await compareObservations(original.dir, candidate.dir, path.join(root, 'comparison'), vision, {});
    expect(result.passed).toBe(false); expect(result.modelVerdict).toBe('pass'); expect(result.review.verdict).toBe('unknown');
  });
  it('rejects model output that substitutes another scenario', async () => {
    const original = await fixture('reference'), candidate = await fixture('candidate');
    modelReview({ scenarios: [{ id: 'invented', verdict: 'pass', visualIssues: [], behaviorIssues: [], intentionalDifferences: [] }] });
    await expect(compareObservations(original.dir, candidate.dir, path.join(root, 'comparison'), vision, {})).rejects.toThrow('omitted');
  });
  it('rejects reversed reference/candidate roles', async () => {
    const original = await fixture('reference'), candidate = await fixture('candidate');
    await expect(compareObservations(candidate.dir, original.dir, path.join(root, 'comparison'), vision, {})).rejects.toThrow('original reference');
  });
});
