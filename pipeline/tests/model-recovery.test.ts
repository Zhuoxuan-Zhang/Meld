import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { claudeJsonSchema } from '../src/claude-cli.js';
import { recoverClaudeDesignFragment, resumeMarketDesignBudget } from '../src/model-recovery.js';
import { json, sha, write } from '../src/storage.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
test('a recorded execution-budget increase resumes only unchanged design inputs and settings', () => {
  const config = { provider: 'claude_cli', model: 'fixture', max_output_tokens: 12000, max_calls: 120 };
  const inputs = { brief: { task: 'focus' }, market: {}, specs: [], config };
  const state = { config, fingerprint: { digest: sha(JSON.stringify(inputs)) }, calls: [{ id: 'saved' }], stages: { compare: { outputs: {} } } };
  const upgraded = resumeMarketDesignBudget(state, { ...inputs, config: { ...config, max_output_tokens: 24000 } });
  expect(upgraded.calls).toEqual(state.calls); expect(upgraded.stages).toEqual(state.stages);
  expect(upgraded.budget_changes[0]).toMatchObject({ previous: 12000, next: 24000 });
  expect(state.config.max_output_tokens).toBe(12000);
  for (const changed of [
    { ...inputs, brief: { task: 'different' } },
    { ...inputs, specs: [{ changed: true }] },
    ...[{ model: 'other', max_output_tokens: 24000 }, { max_calls: 121, max_output_tokens: 24000 }, { max_output_tokens: 11999 }, { max_output_tokens: 64001 }].map(patch => ({ ...inputs, config: { ...config, ...patch } })),
  ]) expect(() => resumeMarketDesignBudget(state, changed)).toThrow('inputs changed');
});

async function fixture() {
  const run = await mkdtemp(path.join(os.tmpdir(), 'meld-fragment-')); directories.push(run);
  const schema = z.object({ pages: z.array(z.string()).min(1) }).strict();
  const prefix = 'Use ONLY the JSON context below as data. Do not use any tools or read files yourself; request evidence through Plan actions when applicable. Return only the requested JSON.\n';
  const context = { core: { title: 'Focus' } }, value = { pages: ['Timer', 'History'] };
  const request = { model: 'fixture', reasoning_effort: 'low', system: 'Generate pages', schema: claudeJsonSchema(schema), prompt: prefix + JSON.stringify({ context, repair: null, response_constraints: 'concise' }) };
  const response = { model: 'fixture', execution: { code: 0 }, turn_completed: true, errors: [], tool_activity: false, usage: { output_tokens: 13761 }, final_text: JSON.stringify(value) };
  const entry = { id: '0001-design-pages-0-1', provider: 'claude_cli', stage: 'design-pages-0', success: false, error: 'Claude Code output exceeded the post-response token limit' };
  const state = { calls: [entry], config: { max_output_tokens: 12000 } }, dir = path.join(run, 'calls', entry.id);
  await write(path.join(dir, 'request.json'), request); await write(path.join(dir, 'response.json'), response);
  return { run, schema, request, response, state, dir, value };
}
test('completed over-budget fragments are schema-checked and audited under the raised allowance without another model call', async () => {
  const f = await fixture();
  expect(await recoverClaudeDesignFragment(f.run, f.state, 'design-pages-0', f.request, f.schema)).toBeNull();
  f.state.config.max_output_tokens = 24000;
  const result = await recoverClaudeDesignFragment(f.run, f.state, 'design-pages-0', f.request, f.schema);
  expect(result?.value).toEqual(f.value); expect(f.state.calls).toHaveLength(1);
  expect(f.state.calls[0]).toMatchObject({ success: true, error: 'Claude Code output exceeded the post-response token limit' });
  expect((await json(path.join(f.dir, 'validation.json'))).recovery).toMatchObject({ output_limit: 24000, original_error: f.state.calls[0].error });
  expect(await recoverClaudeDesignFragment(f.run, f.state, 'design-pages-0', f.request, f.schema)).not.toBeNull();
});
test('fragment reuse rejects changed context, schema, model, failed execution and tool use', async () => {
  const f = await fixture(); f.state.config.max_output_tokens = 24000;
  for (const request of [{ ...f.request, model: 'other' }, { ...f.request, schema: {} }, { ...f.request, prompt: f.request.prompt.replace('Focus', 'Other') }, { ...f.request, system: 'Different rules' }]) {
    expect(await recoverClaudeDesignFragment(f.run, f.state, 'design-pages-0', request, f.schema)).toBeNull();
  }
  for (const patch of [{ tool_activity: true }, { turn_completed: false }, { execution: { code: 1 } }, { errors: ['interrupted'] }, { final_text: '{}' }, { usage: { output_tokens: 24001 } }, { usage: {} }]) {
    await write(path.join(f.dir, 'response.json'), { ...f.response, ...patch });
    expect(await recoverClaudeDesignFragment(f.run, f.state, 'design-pages-0', f.request, f.schema)).toBeNull();
  }
  expect(f.state.calls[0].success).toBe(false);
});
test('fragment recovery rejects a parsed artifact altered independently of its model response', async () => {
  const f = await fixture(); f.state.config.max_output_tokens = 24000;
  await write(path.join(f.dir, 'parsed.json'), { pages: ['hand changed'] });
  await expect(recoverClaudeDesignFragment(f.run, f.state, 'design-pages-0', f.request, f.schema)).rejects.toThrow('differs from its model response');
});
