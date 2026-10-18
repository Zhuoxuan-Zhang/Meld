import { spawn } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { write, redact, trackOwnedProcess } from './storage.js';

export function parseClaudeCli(response: any, schema: z.ZodType<any>, outputLimit: number) {
  if (response.execution.code !== 0 || !response.turn_completed || response.errors.length) throw new Error(`Incomplete Claude Code execution: ${response.errors.join('; ') || response.execution.code}`);
  if (response.tool_activity) throw new Error('Claude Code used a tool outside the pipeline evidence interface');
  if (response.usage.output_tokens > outputLimit) throw new Error('Claude Code output exceeded the post-response token limit');
  return schema.parse(JSON.parse(response.final_text));
}

// Marks a running Claude Code session so a nested `claude` call started from
// inside one (e.g. this pipeline running under active Claude Code) still
// spawns a fresh, independent CLI process instead of inheriting it.
const sessionVariable = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|SESSION_ATTENDED|SSE_PORT|CHILD_SESSION|EXECPATH|MESSAGING_\w+))$/;

// Fresh ephemeral session; REA remains in the serial orchestrator.
export async function executeClaudeCli(dir: string, request: any, timeout: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const images = z.array(z.string().min(1)).max(12).parse(request.images || []);
  const imageContent: any[] = [];
  for (const image of images) {
    const stat = await fs.stat(image);
    if (!path.isAbsolute(image) || !stat.isFile() || stat.size > 12 * 1024 * 1024) throw new Error('Invalid visual evidence image');
    imageContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: (await fs.readFile(image)).toString('base64') } });
  }
  const input = images.length ? JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: request.prompt }, ...imageContent] } }) + '\n' : request.prompt;
  await write(path.join(dir, 'schema.json'), request.schema);
  await write(path.join(dir, 'prompt.txt'), request.prompt);
  const args = ['-p', '--safe-mode', '--setting-sources', '', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
    '--output-format', images.length ? 'stream-json' : 'json', ...(images.length ? ['--verbose'] : []), '--model', request.model, '--effort', request.reasoning_effort,
    '--system-prompt', request.system, '--json-schema', JSON.stringify(request.schema), ...(images.length ? ['--input-format', 'stream-json'] : [])];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value && !sessionVariable.test(key) && !['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY'].includes(key)) env[key] = value;
  const command = process.env.MELD_CLAUDE_BIN || 'claude';
  const start = Date.now();
  await write(path.join(dir, 'command.json'), { command, args: args.map(a => a === request.system ? '<system-prompt>' : a === JSON.stringify(request.schema) ? '<json-schema>' : a), authentication: 'existing Claude Code CLI login; API-key environment variables removed' });
  let stdout = '', stderr = '';
  try {
    signal?.throwIfAborted();
    const execution: any = await new Promise((resolve, reject) => {
      const detached = process.platform !== 'win32';
      const child = spawn(command, args, { env, detached, stdio: ['pipe', 'pipe', 'pipe'] });
      const stop = () => {
        if (detached && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        } else child.kill('SIGKILL');
      };
      const untrack = trackOwnedProcess(child, stop); let timedOut = false, exceeded = false;
      const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); untrack(); };
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      const collect = (stream: 'out' | 'err', chunk: Buffer) => {
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 16 * 1024 * 1024) { exceeded = true; stop(); return; }
        if (stream === 'out') stdout += chunk.toString(); else stderr += chunk.toString();
      };
      child.stdout.on('data', chunk => collect('out', chunk)); child.stderr.on('data', chunk => collect('err', chunk));
      child.stdin.on('error', () => {}); child.stdin.end(input);
      child.once('error', error => { cleanup(); reject(error); });
      child.once('close', (code, exitSignal) => { cleanup(); if (signal?.aborted) reject(signal.reason); else resolve({ code, signal: exitSignal, timedOut, exceeded, elapsed_ms: Date.now() - start }); });
    });
    await write(path.join(dir, 'stdout.json'), redact(stdout));
    await write(path.join(dir, 'stderr.log'), redact(stderr));
    let result: any = null;
    try { result = images.length ? stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).reverse().find(event => event.type === 'result') : JSON.parse(stdout); } catch { /* reported below */ }
    const errors: string[] = [];
    if (execution.timedOut || execution.exceeded) errors.push(`CLI stopped: timeout=${execution.timedOut}, output_limit=${execution.exceeded}`);
    if (!result) errors.push('Claude Code CLI did not return a parseable JSON result');
    else if (result.is_error) errors.push(redact(JSON.stringify(result.result ?? result)));
    else if (result.structured_output === undefined) errors.push('Claude Code CLI result did not include structured_output');
    const turn_completed = execution.code === 0 && !errors.length;
    const resolvedModel = result?.modelUsage && Object.keys(result.modelUsage)[0];
    const u = result?.usage || {};
    return { provider: 'claude_cli', model: resolvedModel || request.model,
      model_identity_source: resolvedModel ? 'resolved model reported in CLI result.modelUsage' : 'explicit --model CLI argument; CLI did not report a resolved model',
      turn_completed, final_text: turn_completed ? JSON.stringify(result.structured_output) : '', errors,
      tool_activity: Array.isArray(result?.permission_denials) && result.permission_denials.length > 0,
      usage: result?.usage ? { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, input_tokens_details: { cached_tokens: u.cache_read_input_tokens || 0, cache_write_tokens: u.cache_creation_input_tokens || 0 }, reasoning_output_tokens: u.output_tokens_details?.thinking_tokens || 0 } : undefined,
      execution, thread_id: result?.session_id };
  } finally {
    await write(path.join(dir, 'stdout.json'), redact(stdout));
    await write(path.join(dir, 'stderr.log'), redact(stderr));
  }
}
