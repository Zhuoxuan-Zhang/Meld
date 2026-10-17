import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesignService } from '../src/workbench/service.js';
import { DesignJobs } from '../src/workbench/jobs.js';
import { applyOperations, planErrors, selectedOperations } from '../src/workbench/changes.js';
import { designErrors, readableErrors, semanticHash, paletteErrors } from '../src/workbench/validation.js';

it('checks descriptive color roles using their token names', () => {
  const colors = [{ role: 'primary — buttons', value: '#315DA8' }, { role: 'onPrimary — button text', value: '#FFFFFF' }, { role: 'textPrimary — titles', value: '#202124' }, { role: 'background — app canvas', value: '#FAFAFA' }, { role: 'surface — panels', value: '#FFFFFF' }];
  expect(paletteErrors(colors)).toEqual([]);
  colors[0].value = '#EEEEEE';
  expect(paletteErrors(colors)).toEqual(['Insufficient contrast primary/onPrimary']);
});
import { RevisionData, UserDocument, ChangeRequest, readableDocumentSchema } from '../src/workbench/schemas.js';
import { json, write } from '../src/storage.js';
import { comparison, fixtureData, fixturePlan, FixtureModel, op, readable, sourceFixture } from './fixtures/workbench.js';

const project = process.cwd(); let root: string, service: DesignService, model: FixtureModel, initial: any;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'design-workbench-test-')); model = new FixtureModel();
  service = new DesignService(project, path.join(root, 'workspaces'), model);
  await sourceFixture(path.join(root, 'run')); initial = await service.initialize('notes', path.join(root, 'run'), {}, path.join(root, 'run/final/final-design.json'));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const request = (text = 'change') => ChangeRequest.parse({ base_revision: initial.revision, idempotency_key: randomUUID(), text });
describe('interactive design boundaries and revision safety (synthetic models)', () => {
  it('constrains readable choices to real developer decisions, including an empty decision set', () => {
    const data = fixtureData(), document = UserDocument.parse(readable(data));
    expect(readableDocumentSchema(data.decisions).safeParse(document).success).toBe(true);
    const invented = structuredClone(document);
    invented.choices[0].id = 'smallest-core';
    expect(readableDocumentSchema(data.decisions).safeParse(invented).success).toBe(false);
    data.decisions.selections = [];
    const schema = readableDocumentSchema(data.decisions);
    expect(schema.safeParse(invented).success).toBe(false);
    expect(schema.safeParse({ ...document, choices: [] }).success).toBe(true);
    expect(readableErrors({ ...document, choices: [] }, data)).toEqual([]);
  });
  it('requires complete readable coverage and resolvable references', () => {
    const data = fixtureData(); const doc = UserDocument.parse(readable(data)); expect(readableErrors(doc, data)).toEqual([]);
    doc.features[0].refs[0].id = 'missing'; expect(readableErrors(doc, data).join()).toContain('Unknown developer reference');
    doc.features = []; expect(readableErrors(doc, data).length).toBeGreaterThan(0);
    const incomplete = UserDocument.parse(readable(data)); incomplete.choices = []; expect(readableErrors(incomplete, data).join()).toContain('choice-save');
  });
  it('rejects low contrast, duplicate IDs, missing acceptance and invented APK sources', () => {
    const data = fixtureData(); data.design.visual.colors[0].value = '#FFFFFF'; expect(designErrors(data, comparison, []).join()).toContain('contrast');
    data.design.features[0].acceptance = []; data.design.features[0].sources = [{ app_id: 'invented', feature_id: 'f' }]; expect(designErrors(data, comparison, []).length).toBeGreaterThan(1);
  });
  it('blocks prototype keys, ID mutation, bad decisions and dangling navigation', () => {
    const data = fixtureData(); expect(() => applyOperations(data, [{ ...op('entity', 'entity-note', 'fields', []), value_json: '[{"__proto__":{}}]' }])).toThrow('Unsafe');
    expect(() => applyOperations(data, [op('feature', 'feature-write', 'id', 'hijacked')])).toThrow('Unsupported');
    const plan = fixturePlan(); plan.changes[0].operations = [op('decision', 'choice-save', 'option_id', 'unknown')]; expect(planErrors(plan, data, comparison, []).join()).toContain('Invalid decision');
    plan.changes[0].operations = [op('design', '', 'navigation', [{ label: 'bad', page_id: 'missing', parameters: [] }])]; expect(planErrors(plan, data, comparison, []).join()).toContain('Dangling');
  });
  it('requires disjoint choices and selected dependencies', () => {
    const plan = fixturePlan(); plan.changes[1].operations = [op('feature', 'feature-write', 'title', 'other')]; expect(planErrors(plan, fixtureData(), comparison, []).join()).toContain('overlap');
    plan.changes[1].depends_on = ['change-title']; expect(() => selectedOperations(plan, ['change-color'])).toThrow('requires');
    plan.changes[0].depends_on = ['change-color']; expect(planErrors(plan, fixtureData(), comparison, []).join()).toContain('Cyclic');
  });
  it('updates repeated color tokens and attributes a formal choice to the user', () => {
    const data = fixtureData(); data.design.pages[0].entries = ['Primary #315DA8; surface #FFFFFF'];
    const changed = applyOperations(data, [op('color', 'primary', 'value', '#246B4A'), op('decision', 'choice-save', 'option_id', 'option-save-explicit'), op('decision', 'choice-save', 'rejected', [{ option_id: 'option-save-automatic', reason: 'User selected explicit saving' }])]);
    expect(changed.design.pages[0].entries[0]).toContain('#246B4A'); expect(changed.decisions.chosen_by).toBe('user'); expect(changed.design.decisions).toEqual(['option-save-explicit']); expect(designErrors(changed, comparison, [])).toEqual([]);
  });
  it('rejects a concurrent commit against a stale current pointer', async () => {
    const original = await service.store.revision('notes');
    const metadata = { ...original.record }; const { id, version, parent_revision, created_at, files, ...record } = metadata;
    const prepare = async (dir: string) => { for (const name of Object.keys(original.record.files)) await fs.copyFile(path.join(original.dir, name), path.join(dir, name)); };
    await service.store.commit('notes', initial.revision, 'commit-one', 'signature-one', prepare, record);
    await expect(service.store.commit('notes', initial.revision, 'commit-two', 'signature-two', prepare, record)).rejects.toThrow('已有更新');
    expect(await service.revisions('notes')).toHaveLength(2);
  });
  it('keeps the current pointer intact if preparing a revision is interrupted', async () => {
    const original = await service.store.revision('notes'); const { id, version, parent_revision, created_at, files, ...record } = original.record;
    await expect(service.store.commit('notes', initial.revision, 'interrupted-save', 'signature', async dir => { await write(path.join(dir, 'incomplete.json'), {}); throw new Error('Synthetic interrupted staging'); }, record)).rejects.toThrow('interrupted staging');
    expect((await service.get('notes')).revision).toBe(initial.revision); expect(await service.revisions('notes')).toHaveLength(1);
    expect((await service.store.manifest('notes')).receipts['interrupted-save']).toBeUndefined();
  });
  it('only applies confirmed choices, preserves history and records pending app work', async () => {
    const proposed = await service.createProposal('notes', request()); expect((await service.get('notes')).revision).toBe(initial.revision);
    const applied = await service.apply('notes', proposed.id, { base_revision: initial.revision, idempotency_key: randomUUID(), selected_change_ids: ['change-color'] });
    const saved = await service.store.revision('notes'); expect(saved.data.design.features[0].title).toBe('写笔记'); expect(saved.data.design.visual.colors[0].value).toBe('#246B4A');
    expect(applied.implementation.status).toBe('pending_update'); expect((await service.get('notes', initial.revision)).implementation.status).toBe('in_sync'); expect(await service.revisions('notes')).toHaveLength(2);
  });
  it('handles apply retries without another model call and rejects reused keys', async () => {
    const proposed = await service.createProposal('notes', request()); const apply = { base_revision: initial.revision, idempotency_key: randomUUID(), selected_change_ids: ['change-title'] };
    const first = await service.apply('notes', proposed.id, apply); const count = model.calls.length;
    expect((await service.apply('notes', proposed.id, apply)).revision).toBe(first.revision); expect(model.calls).toHaveLength(count);
    await expect(service.apply('notes', proposed.id, { ...apply, selected_change_ids: ['change-color'] })).rejects.toThrow('同一次');
  });
  it('rejects stale proposals and keeps the current design on a model failure', async () => {
    const a = await service.createProposal('notes', request()); const b = await service.createProposal('notes', request());
    const apply = { base_revision: initial.revision, idempotency_key: randomUUID(), selected_change_ids: ['change-title'] };
    const current = await service.apply('notes', a.id, apply);
    await expect(service.apply('notes', b.id, { ...apply, idempotency_key: randomUUID() })).rejects.toThrow('旧版本');
    model.fail = true; await expect(service.createProposal('notes', { ...request(), base_revision: current.revision })).rejects.toThrow('Synthetic'); expect((await service.get('notes')).revision).toBe(current.revision);
  });
  it('does not mutate the design for clarification or unrelated input', async () => {
    expect((await service.createProposal('notes', request('vague'))).plan.disposition).toBe('clarification');
    const unrelated = await service.createProposal('notes', request('unrelated')); expect(unrelated.plan.disposition).toBe('no_change');
    await expect(service.apply('notes', unrelated.id, { base_revision: initial.revision, idempotency_key: randomUUID(), selected_change_ids: ['anything'] })).rejects.toThrow('尚未');
    expect(await service.revisions('notes')).toHaveLength(1);
  });
  it('repairs pre-confirmation output but blocks changes when semantic review fails', async () => {
    model.repairReviewOnce = true; const proposed = await service.createProposal('notes', request());
    expect(model.calls.filter(x => x === 'workbench-interpret')).toHaveLength(2);
    model.failReview = true; await expect(service.apply('notes', proposed.id, { base_revision: initial.revision, idempotency_key: randomUUID(), selected_change_ids: ['change-color'] })).rejects.toThrow('Synthetic mismatch');
    expect((await service.get('notes')).revision).toBe(initial.revision);
  });
  it('never publishes an invalid regenerated explanation', async () => {
    const proposed = await service.createProposal('notes', request()); model.invalidDoc = true;
    await expect(service.apply('notes', proposed.id, { base_revision: initial.revision, idempotency_key: randomUUID(), selected_change_ids: ['change-color'] })).rejects.toThrow('Unknown developer reference');
    expect((await service.get('notes')).revision).toBe(initial.revision);
  });
  it('restores as a new revision, preserves parents and recovers the baseline app status', async () => {
    const p = await service.createProposal('notes', request()); const second = await service.apply('notes', p.id, { base_revision: initial.revision, idempotency_key: randomUUID(), selected_change_ids: ['change-color'] });
    const restored = await service.restore('notes', { base_revision: second.revision, target_revision: initial.revision, idempotency_key: randomUUID() });
    expect(restored.version).toBe(3); expect(restored.implementation.status).toBe('in_sync'); expect((await service.revisions('notes'))[2].parent_revision).toBe(second.revision);
  });
  it('does not expose unpublished crash artifacts and detects tampering', async () => {
    const dir = service.store.directory('notes'); await write(path.join(dir, 'revisions/unpublished/developer-design.json'), fixtureData());
    await expect(service.store.revision('notes', 'unpublished')).rejects.toThrow('找不到'); expect(await service.revisions('notes')).toHaveLength(1);
    const revision = await service.store.revision('notes'); await fs.appendFile(path.join(revision.dir, 'user-doc.md'), 'changed'); await expect(service.get('notes')).rejects.toThrow('发生变化');
  });
  it('refuses a proposal whose saved operations were changed', async () => {
    const proposed = await service.createProposal('notes', request());
    await fs.appendFile(path.join(service.store.directory('notes'), 'proposals', `${proposed.id}.json`), '\n');
    await expect(service.apply('notes', proposed.id, { base_revision: initial.revision, idempotency_key: randomUUID(), selected_change_ids: ['change-color'] })).rejects.toThrow('建议发生变化');
    expect((await service.get('notes')).revision).toBe(initial.revision);
  });
  it('recovers a committed job after interruption without another apply', async () => {
    const p = await service.createProposal('notes', request()); const apply = { base_revision: initial.revision, idempotency_key: randomUUID(), selected_change_ids: ['change-title'] };
    const result = await service.apply('notes', p.id, apply); const jobs = new DesignJobs(service); const id = `job-${randomUUID()}`;
    await write(jobs.file(id), { id, design_id: 'notes', kind: 'apply', change_id: p.id, request: apply, signature: 'fixture', status: 'running', created_at: '', updated_at: '' });
    await jobs.recover(); expect((await jobs.get(id)).status).toBe('succeeded'); expect((await jobs.get(id)).result.revision).toBe(result.revision); expect(await service.revisions('notes')).toHaveLength(2);
  });
  it('marks an unfinished job interrupted without changing the design', async () => {
    const jobs = new DesignJobs(service); const id = `job-${randomUUID()}`;
    await write(jobs.file(id), { id, design_id: 'notes', kind: 'propose', request: request(), signature: 'fixture', status: 'running', created_at: '', updated_at: '' });
    await jobs.recover(); expect((await jobs.get(id)).error?.code).toBe('interrupted'); expect((await service.get('notes')).revision).toBe(initial.revision);
  });
  it('escapes model text in exported HTML', async () => {
    model.plan.changes[0].operations = [op('feature', 'feature-write', 'title', '<img src=x onerror=alert(1)>')];
    const p = await service.createProposal('notes', request()); await service.apply('notes', p.id, { base_revision: initial.revision, idempotency_key: randomUUID(), selected_change_ids: ['change-title'] });
    const saved = await service.store.revision('notes'); const html = await fs.readFile(path.join(saved.dir, 'user-doc.html'), 'utf8'); expect(html).toContain('&lt;img'); expect(html).not.toContain('<img src=x');
  });
});

it('checks both named game palettes without accepting unreadable colors', () => {
  const colors = ['Light', 'Dark'].flatMap(theme => [{ role: `${theme} background`, value: '#FFFFFF' }, { role: `${theme} surface`, value: '#FFFFFF' }, { role: `${theme} text`, value: '#17202A' }, { role: `${theme} accent and focus`, value: '#2357C6' }, { role: `${theme} on-accent`, value: '#FFFFFF' }]);
  expect(paletteErrors(colors)).toEqual([]);
  colors.find(color => color.role === 'Dark text')!.value = '#FFFFFF';
  expect(paletteErrors(colors)).toContain('Insufficient contrast dark textPrimary/background');
});
