import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { write, redact, trackOwnedProcess } from './storage.js';

export function parseCodex(response: any, schema: z.ZodType<any>, outputLimit: number) {
  if (response.execution.code !== 0 || !response.turn_completed || response.errors.length) throw new Error(`Incomplete Codex execution: ${response.errors.join('; ') || response.execution.code}`);
  if (response.tool_activity) throw new Error('Codex used a tool outside the pipeline evidence interface');
  if (response.usage.output_tokens > outputLimit) throw new Error('Codex output exceeded the post-response token limit');
  return schema.parse(JSON.parse(response.final_text));
}

// Fresh ephemeral context; REA remains in the serial orchestrator.
export async function executeCodex(dir: string, request: any, timeout: number) {
  await write(path.join(dir, 'schema.json'), request.schema);
  await write(path.join(dir, 'prompt.txt'), request.prompt);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'apk-design-codex-'));
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', request.model,
    '-c', `model_reasoning_effort="${request.reasoning_effort}"`, '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
    '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'apps', '--disable', 'computer_use', '--disable', 'browser_use', '--disable', 'unbounded_connection_retries',
    '--json', '--output-schema', path.join(dir, 'schema.json'), '--output-last-message', path.join(dir, 'answer.json'), '-'];
  const env: Record<string, string> = {};
  for (const [key,value] of Object.entries(process.env)) if (value && !['OPENAI_API_KEY','ANTHROPIC_API_KEY','CODEX_API_KEY'].includes(key)) env[key] = value;
  const start = Date.now();
  await write(path.join(dir, 'command.json'), { command: 'codex', args, cwd, authentication: 'existing ChatGPT CLI login; API-key environment variables removed', output_limit: 'Checked after response; CLI does not expose the API max_output_tokens parameter.' });
  let stdout = '', stderr = '';
  try {
    const execution: any = await new Promise((resolve, reject) => {
      const child = spawn('codex', args, {cwd,env,stdio:['pipe','pipe','pipe']});
      const untrack = trackOwnedProcess(child); let timedOut = false, exceeded = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
      const collect = (stream: 'out'|'err', chunk: Buffer) => {
        if (Buffer.byteLength(stdout)+Buffer.byteLength(stderr)+chunk.length > 16*1024*1024) { exceeded = true; child.kill('SIGKILL'); return; }
        if (stream === 'out') stdout += chunk.toString(); else stderr += chunk.toString();
      };
      child.stdout.on('data',chunk=>collect('out',chunk)); child.stderr.on('data',chunk=>collect('err',chunk));
      child.stdin.on('error',()=>{}); child.stdin.end(request.prompt);
      child.once('error',error=>{clearTimeout(timer);untrack();reject(error);});
      child.once('close',(code,signal)=>{clearTimeout(timer);untrack();resolve({code,signal,timedOut,exceeded,elapsed_ms:Date.now()-start});});
    });
    await write(path.join(dir,'events.jsonl'),redact(stdout));
    await write(path.join(dir,'stderr.log'),redact(stderr));
    const events = stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const turn = events.find(e=>e.type==='turn.completed');
    const errors = events.filter(e=>['error','turn.failed'].includes(e.type)).map(e=>redact(JSON.stringify(e)));
    if (execution.timedOut || execution.exceeded) errors.push(`CLI stopped: timeout=${execution.timedOut}, output_limit=${execution.exceeded}`);
    const final_text = await fs.readFile(path.join(dir,'answer.json'),'utf8').catch(()=> '');
    const u = turn?.usage || {};
    return {provider:'codex_cli',model:request.model,model_identity_source:'explicit --model CLI argument; event stream does not report resolved server model',turn_completed:!!turn,final_text,errors,
      tool_activity:events.some(e=>e.item && !['agent_message','reasoning'].includes(e.item.type)),
      usage:turn?.usage ? {input_tokens:u.input_tokens || 0,output_tokens:u.output_tokens || 0,input_tokens_details:{cached_tokens:u.cached_input_tokens || 0,cache_write_tokens:u.cache_write_input_tokens || 0},reasoning_output_tokens:u.reasoning_output_tokens || 0} : undefined,
      execution,thread_id:events.find(e=>e.type==='thread.started')?.thread_id};
  } finally {
    await write(path.join(dir,'events.jsonl'),redact(stdout)); await write(path.join(dir,'stderr.log'),redact(stderr));
    await fs.rm(cwd,{recursive:true,force:true});
  }
}
