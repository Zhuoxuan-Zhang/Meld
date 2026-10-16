import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { write, redact } from './storage.js';
import { executeCodex, parseCodex } from './codex.js';
import { executeClaudeCli, parseClaudeCli } from './claude-cli.js';

export function parseMessage(response: any, schema: z.ZodType<any>) {
  if (response.stop_reason !== 'end_turn') throw new Error(`Incomplete/refused model response: ${response.stop_reason}`);
  const content = response.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('');
  return schema.parse(JSON.parse(content));
}
export function responseText(response: any): string {
  return (response.output || []).filter((x: any) => x.type === 'message').flatMap((x: any) => x.content).filter((x: any) => x.type === 'output_text').map((x: any) => x.text).join('');
}
export function parseResponse(response: any, schema: z.ZodType<any>) {
  if (response.status !== 'completed' || (response.output || []).some((x: any) => x.type === 'message' && (x.status !== 'completed' || x.content.some((c: any) => c.type === 'refusal')))) throw new Error(`Incomplete/refused model response: ${response.status}/${response.incomplete_details?.reason || 'refusal'}`);
  return schema.parse(JSON.parse(responseText(response)));
}
export class Claude {
  sdk?: Anthropic | OpenAI;
  provider: 'anthropic' | 'openai' | 'codex_cli' | 'claude_cli';
  constructor(public root: string, public run: string, public state: any) {
    this.provider = state.config.provider || 'anthropic';
    if (!['anthropic', 'openai', 'codex_cli', 'claude_cli'].includes(this.provider)) throw new Error('Unsupported model provider');
    if (this.provider === 'codex_cli' || this.provider === 'claude_cli') return;
    const keyName = this.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    if (!process.env[keyName]) throw new Error(`${keyName} is missing`);
    const options = { apiKey: process.env[keyName], maxRetries: 0, timeout: this.state.config.model_timeout_ms ?? 600000 };
    this.sdk = this.provider === 'openai' ? new OpenAI({ ...options, baseURL: 'https://api.openai.com/v1' }) : new Anthropic(options);
  }
  async ask<T>(label: string, prompt: string, context: any, schema: z.ZodType<T>, validate?: (x: T) => string[]): Promise<T> {
    let repair: any = null; let networkRetries = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.state.calls.length >= this.state.config.max_calls) throw new Error('Model request budget exhausted; retain partial run and raise configured budget for a new run');
      const id = `${String(this.state.calls.length + 1).padStart(4, '0')}-${label}-${Date.now()}`;
      const dir = path.join(this.run, 'calls', id);
      const response_constraints = 'Be concise. Use short statements and avoid repeating the same limitations. App specs: at most five task features, three or four claims each, and four main pages/flows; aim for 4500 visible tokens. Unified design: aim for 7500 visible tokens while retaining every required development contract. Preserve uncertainty and all required schema fields.';
      const compactDesign = label === 'design' || label.startsWith('design-repair-') ? 'For UnifiedDesign, keep the complete development contract compact: exactly five primary features, at most five pages and five flows, three entities, two acceptance cases per feature, at most eight components and six events per page, and only applicable states. Put special states on the relevant pages rather than repeating every state everywhere. Use short clauses (about 15 words) for each non-code string. Include at most three short Kotlin type examples, each no longer than ten lines. Aim for 5000-6500 visible output tokens. All required schema fields, chosen decisions, navigation outcomes, errors, keyboard/back behavior, and core task coverage remain mandatory. Do not repeat source descriptions.' : '';
      const content = JSON.stringify({ context, repair, response_constraints:response_constraints+' '+compactDesign });
      const request: any = this.provider === 'codex_cli'
        ? { provider: 'codex_cli', model: this.state.config.model, reasoning_effort: this.state.config.reasoning_effort || 'low', schema: zodTextFormat(schema, 'result').schema,
            prompt: `${prompt}\n\nUse ONLY the JSON context below as data. Do not use any tools or read files yourself; request evidence through Plan actions when applicable. Return only the requested JSON.\n${content}` }
        : this.provider === 'claude_cli'
        ? { provider: 'claude_cli', model: this.state.config.model, reasoning_effort: this.state.config.reasoning_effort || 'low', schema: zodTextFormat(schema, 'result').schema,
            system: prompt, prompt: `Use ONLY the JSON context below as data. Do not use any tools or read files yourself; request evidence through Plan actions when applicable. Return only the requested JSON.\n${content}` }
        : this.provider === 'openai'
        ? { model: this.state.config.model, store: false, max_output_tokens: this.state.config.max_output_tokens, instructions: prompt, input: [{ role: 'user', content }], reasoning: { effort: 'low' }, text: { format: zodTextFormat(schema, 'result') } }
        : { model: this.state.config.model, max_tokens: this.state.config.max_output_tokens, system: prompt, messages: [{ role: 'user' as const, content }], output_config: { format: zodOutputFormat(schema), effort: 'low' as const } };
      const entry: any = { id, provider: this.provider, model: request.model, stage: label, attempt, success: false, started_at: new Date().toISOString() };
      this.state.calls.push(entry); await Promise.all([write(path.join(dir, 'request.json'), request), write(path.join(this.run, 'run.json'), this.state)]);
      console.log(`${this.provider}/${request.model} ${entry.id} (${this.state.calls.length}/${this.state.config.max_calls})`);
      const start = Date.now();
      let response: any;
      try {
        response = this.provider === 'codex_cli' ? await executeCodex(dir, request, this.state.config.model_timeout_ms || 600000) : this.provider === 'claude_cli' ? await executeClaudeCli(dir, request, this.state.config.model_timeout_ms || 600000) : this.provider === 'openai' ? await (this.sdk as OpenAI).responses.create(request) : await (this.sdk as Anthropic).messages.create(request);
        entry.elapsed_ms = Date.now() - start; entry.model = response.model; entry.usage = response.usage; entry.stop_reason = response.stop_reason ?? response.status ?? (response.turn_completed ? 'turn.completed' : 'turn.failed');
        if (response.model !== request.model) throw new Error(`Unexpected model ${response.model}`);
        entry.model_identity_source = response.model_identity_source;
        const value = this.provider === 'codex_cli' ? parseCodex(response, schema, this.state.config.max_output_tokens) : this.provider === 'claude_cli' ? parseClaudeCli(response, schema, this.state.config.max_output_tokens) : this.provider === 'openai' ? parseResponse(response, schema) : parseMessage(response, schema);
        const errors = validate ? validate(value) : [];
        await Promise.all([write(path.join(dir, 'response.json'), response), write(path.join(dir, 'parsed.json'), value), write(path.join(dir, 'validation.json'), { passed: errors.length === 0, errors })]);
        if (errors.length) throw new Error(errors.join('\n'));
        entry.success = true; await write(path.join(this.run, 'run.json'), this.state); return value;
      } catch (e: any) {
        if (response) await write(path.join(dir, 'response.json'), response);
        const message = redact(e.message || String(e));
        entry.elapsed_ms = Date.now() - start; entry.error = message;
        entry.http_status = e.status; entry.error_code = e.code; entry.error_type = e.type;
        await write(path.join(dir, 'error.json'), { name: e.name, status: e.status, code: e.code, type: e.type, message });
        await write(path.join(this.run, 'run.json'), this.state);
        if ((this.provider === 'codex_cli' || this.provider === 'claude_cli') && (!response || !response.turn_completed || response.execution.code !== 0 || response.errors.length || response.tool_activity)) throw new Error(message);
        if (response?.stop_reason && !['end_turn', 'max_tokens'].includes(response.stop_reason)) throw new Error(message);
        if (this.provider === 'openai' && response && (response.status !== 'completed' && response.incomplete_details?.reason !== 'max_output_tokens' || response.output?.some((x: any) => x.type === 'message' && x.content?.some((c: any) => c.type === 'refusal')))) throw new Error(message);
        if (['insufficient_quota', 'credit_balance_exhausted'].includes(e.code) || /no credits remaining/i.test(message)) throw new Error(message);
        if (e.status && ![408, 409, 429, 500, 502, 503, 504, 529].includes(e.status)) throw new Error(message);
        if (e.status || e instanceof Anthropic.APIConnectionError || e instanceof OpenAI.APIConnectionError || /APIConnection|Timeout/.test(e.name)) {
          if (networkRetries++ >= 2) throw e;
          await new Promise(r => setTimeout(r, 1000 * networkRetries));
        } else repair = { errors: message, prior_output: (this.provider === 'codex_cli' || this.provider === 'claude_cli') ? response?.final_text : this.provider === 'openai' ? responseText(response || {}) : response?.content?.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('') };
        if (attempt === 2) throw new Error(`Model output still invalid after two repairs: ${message}`);
      }
    }
    throw new Error('Unreachable');
  }
  async prompt(name: string) { return fs.readFile(path.join(this.root, 'prompts', `${name}.md`), 'utf8'); }
}
