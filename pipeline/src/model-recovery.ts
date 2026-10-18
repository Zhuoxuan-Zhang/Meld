import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { parseClaudeCli } from './claude-cli.js';
import { exists, fileSha, json, sha, write } from './storage.js';

// A larger execution allowance may resume the same inputs. Model, prompts,
// evidence and every other setting still retain their original identity.
export function resumeMarketDesignBudget(state: any, inputs: { brief: any; market: any; specs: any[]; config: any }) {
  const identityFor = (config: any) => sha(JSON.stringify({ brief: inputs.brief, market: inputs.market, specs: inputs.specs, config }));
  const identity = identityFor(inputs.config);
  if (state.fingerprint?.digest === identity) return state;
  const old = state.config, next = inputs.config;
  const previousIdentity = identityFor(old);
  const onlyBudget = old && isDeepStrictEqual({ ...next, max_output_tokens: old.max_output_tokens }, old);
  if (state.fingerprint?.digest !== previousIdentity || !onlyBudget || !Number.isInteger(next.max_output_tokens)
      || next.max_output_tokens <= old.max_output_tokens || next.max_output_tokens > 64000) {
    throw new Error('Market design inputs changed; create a new request');
  }
  return { ...state, config: next, fingerprint: { ...state.fingerprint, digest: identity },
    budget_changes: [...(state.budget_changes || []), { at: new Date().toISOString(), previous: old.max_output_tokens, next: next.max_output_tokens,
      previous_fingerprint: previousIdentity, fingerprint: identity, reason: 'Raised the CLI execution allowance; all task inputs and other settings are unchanged.' }] };
}

function payload(request: any) {
  const prefix = 'Use ONLY the JSON context below as data. Do not use any tools or read files yourself; request evidence through Plan actions when applicable. Return only the requested JSON.\n';
  if (!request.prompt?.startsWith(prefix)) return null;
  try { return JSON.parse(request.prompt.slice(prefix.length)); } catch { return null; }
}

export async function recoverClaudeDesignFragment<T>(run: string, state: any, label: string, request: any, schema: z.ZodType<T>, validate?: (value: T) => string[]) {
  if (!/^design-(core|pages|contracts)-\d+$/.test(label)) return null;
  const wanted = payload(request);
  if (!wanted) return null;
  for (const entry of [...state.calls].reverse()) {
    if (entry.stage !== label || entry.provider !== 'claude_cli' || (!entry.success && entry.error !== 'Claude Code output exceeded the post-response token limit')) continue;
    if (!/^[A-Za-z0-9-]+$/.test(entry.id)) continue;
    const directory = path.join(run, 'calls', entry.id);
    if (!(await exists(path.join(directory, 'request.json'))) || !(await exists(path.join(directory, 'response.json')))) continue;
    const saved = await json(path.join(directory, 'request.json')), input = payload(saved);
    if (!input || saved.model !== request.model || saved.reasoning_effort !== request.reasoning_effort || saved.system !== request.system
        || !isDeepStrictEqual(saved.schema, request.schema) || !isDeepStrictEqual(input.context, wanted.context)
        || input.response_constraints !== wanted.response_constraints) continue;
    const response = await json(path.join(directory, 'response.json'));
    if (response.model !== request.model || !Number.isInteger(response.usage?.output_tokens) || response.usage.output_tokens < 0) continue;
    let value: T;
    try { value = parseClaudeCli(response, schema, state.config.max_output_tokens); if (validate?.(value).length) continue; } catch { continue; }
    const parsed = path.join(directory, 'parsed.json');
    if (await exists(parsed) && !isDeepStrictEqual(await json(parsed), value)) throw new Error('Saved design fragment differs from its model response');
    const recovery = { at: new Date().toISOString(), output_limit: state.config.max_output_tokens,
      original_error: entry.error || null, request_sha256: await fileSha(path.join(directory, 'request.json')),
      response_sha256: await fileSha(path.join(directory, 'response.json')) };
    await write(path.join(directory, `revalidation-${Date.now()}.json`), recovery);
    await write(parsed, value);
    await write(path.join(directory, 'validation.json'), { passed: true, errors: [], recovery });
    entry.success = true; (entry.revalidations ||= []).push(recovery);
    await write(path.join(run, 'run.json'), state);
    return { id: entry.id, value };
  }
  return null;
}
