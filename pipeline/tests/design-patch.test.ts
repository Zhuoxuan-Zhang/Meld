import { it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DesignPatch, applyDesignPatch } from '../src/design-patch.js';
import { fixtureData, comparison } from './fixtures/workbench.js';
import { synthesize } from '../src/design.js';
import { write, json } from '../src/storage.js';
import type { Claude } from '../src/claude.js';
import { validateRun } from '../src/validate.js';

it('applies narrow design edits without changing the source or unrelated fields', () => {
  const original = fixtureData().design;
  const result = applyDesignPatch(original, { edits: [{ path: ['features', '0', 'title'], format: 'text' as const, value: 'Capture ideas' }] });
  expect(result.features[0].title).toBe('Capture ideas');
  expect(applyDesignPatch(original, { edits: [{ path: ['prior_design', 'features', '0', 'title'], format: 'text', value: 'Capture ideas' }] })).toEqual(result);
  expect(() => applyDesignPatch(original, { edits: [{ path: ['prior_design'], format: 'json', value: '{}' }] })).toThrow('not the whole design');
  expect(applyDesignPatch(original, { edits: [{ path: ['features', original.features[0].id, 'title'], format: 'text', value: 'Capture ideas' }] })).toEqual(result);
  expect(result.pages).toEqual(original.pages); expect(result.visual).toEqual(original.visual);
  expect(original.features[0].title).not.toBe('Capture ideas');
  const appended = applyDesignPatch(original, { edits: [{ path: ['scope', 'constraints', '-'], format: 'text', value: 'Retain the create ID across retries.' }] });
  expect(appended.scope.constraints).toEqual([...original.scope.constraints, 'Retain the create ID across retries.']);
  expect(() => applyDesignPatch(original, { edits: [{ path: ['pages'], format: 'json', value: '[invalid' }] })).toThrow('Invalid replacement at pages');
  for (const target of [['__proto__'], ['features', '99'], ['missing']]) expect(() => applyDesignPatch(original, { edits: [{ path: target, format: 'json', value: 'null' }] })).toThrow('existing field');
  expect(() => applyDesignPatch(original, { edits: [{ path: ['pages'], format: 'json', value: 'false' }] })).toThrow();
  expect(() => DesignPatch.parse({ edits: [{ path: [], format: 'json', value: '{}' }] })).toThrow();
});

it('reports every invalid edit path and applies none of a failed patch', () => {
  const source = fixtureData().design, title = source.title;
  try {
    applyDesignPatch(source, { edits: [{ path: ['title'], format: 'text', value: 'Not committed' }, { path: ['unknown-one'], format: 'text', value: 'x' }, { path: ['unknown-two'], format: 'text', value: 'y' }] });
    throw new Error('Expected rejection');
  } catch (error) {
    expect(String(error)).toContain('unknown-one'); expect(String(error)).toContain('unknown-two');
  }
  expect(source.title).toBe(title);
});

it('resumes a recorded targeted repair after review interruption and rejects altered repair output', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'design-patch-recovery-')), data = fixtureData();
  const state: any = { config: { provider: 'codex_cli' }, stages: {}, calls: [], fingerprint: { digest: 'synthetic' } };
  const { pages, visual, compose, ...core } = data.design;
  const fragments = [{ name: 'core', value: core }, { name: 'pages', value: { pages } }, { name: 'contracts', value: { visual, compose } }];
  const labels: string[] = []; let interrupt = true;
  const patch = { edits: [{ path: ['features', '0', 'title'], format: 'text' as const, value: 'Capture ideas' }] };
  try {
    for (const f of fragments) { const id = `saved-${f.name}`; state.calls.push({ id, stage: `design-${f.name}-0`, success: true }); await write(path.join(dir, 'calls', id, 'parsed.json'), f.value); }
    await write(path.join(dir, 'synthesis/fragment-design-0-1.json'), data.design);
    await write(path.join(dir, 'synthesis/fragment-validation-0-2.json'), { fragment_calls: state.calls.map((c: any) => c.id) });
    await write(path.join(dir, 'synthesis/fragment-review-0-3.json'), { passed: false, issues: [{ severity: 'blocking', location: 'feature title', issue: 'Use the approved name', correction: 'Rename to Capture ideas' }], limitations: [] });
    const model = { provider: 'codex_cli', prompt: async () => 'synthetic', ask: async (label: string) => {
      labels.push(label); const entry = { id: `request-${state.calls.length}`, stage: label, success: false }; state.calls.push(entry);
      let result;
      if (label === 'compare') result = comparison;
      else if (label === 'decide') result = data.decisions;
      else if (label === 'design-corrections-1') result = patch;
      else if (label === 'design-review-patched-1' && interrupt) throw new Error('Review interrupted');
      else if (label === 'design-review-resumed-2') result = { passed: true, issues: [], limitations: ['Synthetic review'] };
      else throw new Error(`Unexpected regeneration ${label}`);
      entry.success = true; await write(path.join(dir, 'calls', entry.id, 'parsed.json'), result); return result;
    } } as unknown as Claude;
    await expect(synthesize(dir, state, model, data.brief, [])).rejects.toThrow('Review interrupted');
    interrupt = false; await synthesize(dir, state, model, data.brief, []);
    expect(labels).toEqual(['compare', 'decide', 'design-corrections-1', 'design-review-patched-1', 'design-review-resumed-2']);
    const final = await json(path.join(dir, 'final/final-design.json'));
    expect(final).toEqual(applyDesignPatch(data.design, patch));
    const assembly = await json(path.join(dir, 'synthesis/design-assembly.json'));
    expect(assembly.patch_calls).toHaveLength(1); expect(assembly.parsed_patch_sha256[0].sha256).toMatch(/^[a-f\d]{64}$/);
    await write(path.join(dir, 'apps.lock.json'), []); await write(path.join(dir, 'brief.json'), data.brief);
    const validation = await validateRun(dir);
    expect(validation.errors.filter((e: string) => /[Dd]esign (repair|fragment)|model-generated fragments/.test(e))).toEqual([]);
    delete state.stages.design;
    await write(path.join(dir, 'calls', assembly.patch_calls[0], 'parsed.json'), { edits: [{ path: ['title'], format: 'text', value: 'Tampered' }] });
    expect((await validateRun(dir)).errors.join()).toContain('Design repair changed');
    await expect(synthesize(dir, state, model, data.brief, [])).rejects.toThrow('Saved draft differs');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
