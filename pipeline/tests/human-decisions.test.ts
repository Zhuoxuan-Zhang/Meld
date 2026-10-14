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
