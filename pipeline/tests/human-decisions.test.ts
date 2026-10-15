import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { synthesize } from '../src/design.js';
import { write, json } from '../src/storage.js';
import { comparison, fixtureData } from './fixtures/workbench.js';
import type { Claude } from '../src/claude.js';

describe('human decisions at the initial merge (synthetic model)', () => {
  it('pauses after comparison, resumes only recorded user choices and never calls model decide', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'human-merge-')); const data = fixtureData(), calls: string[] = [];
    const state = { human_decisions: true, config: { provider: 'anthropic' }, stages: {}, calls: [], fingerprint: { digest: 'synthetic' } };
    const model = { provider: 'anthropic', prompt: async () => 'synthetic prompt', ask: async (label: string) => {
      calls.push(label); if (label === 'compare') return comparison;
      if (label === 'design') return { ...data.design, decisions: ['option-save-explicit'] };
      if (label.startsWith('design-review')) return { passed: true, issues: [], limitations: ['Synthetic review'] };
      throw new Error(`Unexpected model call ${label}`);
    } } as unknown as Claude;
    try {
      expect(await synthesize(dir, state, model, data.brief, [])).toBe('waiting_user'); expect(calls).toEqual(['compare']);
      await write(path.join(dir, 'human-decisions.json'), { ...data.decisions, chosen_by: 'user', selections: [{ ...data.decisions.selections[0], option_id: 'option-save-explicit', rejected: [{ option_id: 'option-save-automatic', reason: 'User selected manual saving' }] }] });
      await synthesize(dir, state, model, data.brief, []);
      expect(calls).toEqual(['compare', 'design', 'design-review-0']); expect((await json(path.join(dir, 'synthesis/decisions.json'))).chosen_by).toBe('user');
      expect((await json(path.join(dir, 'final/final-design.json'))).decisions).toEqual(['option-save-explicit']);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  it('rejects model-proxy decisions supplied to a human-choice run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'human-merge-')), data = fixtureData();
    const state = { human_decisions: true, config: { provider: 'anthropic' }, stages: {}, calls: [], fingerprint: { digest: 'synthetic' } };
    const model = { provider: 'anthropic', prompt: async () => '', ask: async () => comparison } as unknown as Claude;
    try { await write(path.join(dir, 'human-decisions.json'), data.decisions); await expect(synthesize(dir, state, model, data.brief, [])).rejects.toThrow('User choices are required'); }
    finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});

describe('saved design fragment recovery', () => {
  for (const tamper of [false, true]) it(tamper ? 'rejects a draft changed after its model fragments' : 'reuses completed fragments only after a fresh passing review', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fragment-recovery-')), data = fixtureData();
    const state: any = { human_decisions: false, config: { provider: 'codex_cli' }, stages: {}, calls: [], fingerprint: { digest: 'synthetic' } };
    const { pages, visual, compose, ...core } = data.design;
    const fragments = [{ name: 'core', value: core }, { name: 'pages', value: { pages } }, { name: 'contracts', value: { visual, compose } }];
    const calls: string[] = [];
    try {
      for (const f of fragments) {
        const id = `saved-${f.name}`; state.calls.push({ id, stage: `design-${f.name}-0`, success: true });
        await write(path.join(dir, 'calls', id, 'parsed.json'), f.value);
      }
      await write(path.join(dir, 'synthesis/fragment-design-0-1.json'), { ...data.design, ...(tamper ? { title: 'Changed after generation' } : {}) });
      await write(path.join(dir, 'synthesis/fragment-validation-0-2.json'), { fragment_calls: state.calls.map((c: any) => c.id) });
      const model = { provider: 'codex_cli', prompt: async () => 'synthetic', ask: async (label: string) => {
        calls.push(label); state.calls.push({ id: label, stage: label, success: true });
        if (label === 'compare') return comparison;
        if (label === 'decide') return data.decisions;
        if (label === 'design-review-resumed-1') return { passed: true, issues: [], limitations: ['Synthetic review'] };
        throw new Error(`Unexpected new generation ${label}`);
      } } as unknown as Claude;
      if (tamper) await expect(synthesize(dir, state, model, data.brief, [])).rejects.toThrow('Saved draft differs');
      else {
        await synthesize(dir, state, model, data.brief, []);
        expect(calls).toEqual(['compare', 'decide', 'design-review-resumed-1']);
        expect(await json(path.join(dir, 'final/final-design.json'))).toEqual(data.design);
        const assembly = await json(path.join(dir, 'synthesis/design-assembly.json'));
        expect(assembly.fragment_calls).toEqual(['saved-core', 'saved-pages', 'saved-contracts']);
        expect(assembly.review_call).toBe('design-review-resumed-1');
      }
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
