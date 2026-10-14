import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileSha, sha, json, write, exists, files } from './storage.js';

export async function fingerprint(root: string, cfg: any) {
  const inputs = [];
  for (const p of [...await files(path.join(root, 'prompts')), ...await files(path.join(root, 'src'))].sort()) inputs.push([path.relative(root, p), await fileSha(p)]);
  const lock = await json(path.join(root, 'config/toolchain.lock.json'));
  const toolRoot = path.resolve(process.env.MELD_PIPELINE_TOOL_ROOT || root);
  const actual = { node: process.version, rea: (await fs.readFile(path.join(toolRoot, 'vendor/rea/.git/HEAD'), 'utf8')).trim(), jadx: await fileSha(process.env.REA_JADX_MCP_JAR!), apktool: await fileSha(path.join(toolRoot, 'downloads/apktool_3.0.3.jar')) };
  if (actual.jadx !== lock.jadx_sha256 || actual.apktool !== lock.apktool_sha256 || actual.rea !== lock.rea_commit) throw new Error('Toolchain does not match pinned digests/revision');
  return { digest: sha(JSON.stringify({ prompts: inputs.filter(([p]) => String(p).startsWith('prompts/')), cfg, actual })), tools: { ...actual, lock }, code_and_prompts: inputs };
}
export async function stage(run: string, state: any, name: string, outputs: string[], work: () => Promise<void>, validate?: () => Promise<string[]>) {
  if (state.stages[name]) {
    for (const [rel, digest] of Object.entries(state.stages[name].outputs)) if (!(await exists(path.join(run, rel))) || await fileSha(path.join(run, rel)) !== digest) throw new Error(`Completed stage ${name} output changed: ${rel}. Preserve this run and create a new run.`);
    const errors = validate ? await validate() : [];
    if (errors.length) throw new Error(`Completed stage ${name} no longer validates: ${errors.join('; ')}`);
    console.log(`Resume: ${name} already validated`); return;
  }
  state.active_stage = name; state.status = 'running'; await write(path.join(run, 'run.json'), state);
  await work();
  const errors = validate ? await validate() : [];
  if (errors.length) throw new Error(`Stage ${name} validation failed: ${errors.join('; ')}`);
  const hashes: Record<string, string> = {};
  for (const rel of outputs) hashes[rel] = await fileSha(path.join(run, rel));
  state.stages[name] = { completed_at: new Date().toISOString(), fingerprint: state.fingerprint.digest, outputs: hashes };
  await write(path.join(run, 'run.json'), state);
  console.log(`Completed: ${name}`);
  if (process.env.MVP_STOP_AFTER_STAGE === name) throw new Error(`Intentional stage interruption after ${name}`);
}
export async function report(run: string, state: any) {
  const calls = state.calls || [];
  const input = calls.reduce((s: number, c: any) => s + (c.usage?.input_tokens || 0), 0);
  const output = calls.reduce((s: number, c: any) => s + (c.usage?.output_tokens || 0), 0);
  const cost = calls.reduce((sum: number, c: any) => {
    if (state.config.provider === 'codex_cli') return 0;
    const u = c.usage || {}, p = state.config.pricing;
    const cached = u.input_tokens_details?.cached_tokens || 0, written = u.input_tokens_details?.cache_write_tokens || 0;
    const long = state.config.provider === 'openai' && u.input_tokens > 272000;
    return sum + ((Math.max(0, (u.input_tokens || 0) - cached - written) * p.input_per_million + cached * (p.cached_input_per_million ?? p.input_per_million) + written * (p.cache_write_per_million ?? p.input_per_million)) * (long ? 2 : 1) + (u.output_tokens || 0) * p.output_per_million * (long ? 1.5 : 1)) / 1e6;
  }, 0);
  state.usage = { input_tokens: input, output_tokens: output, model_requests: calls.length, estimated_usd: state.config.provider === 'codex_cli' ? null : cost, price_source: state.config.pricing.source, limitation: state.config.provider === 'codex_cli' ? 'CLI-reported tokens from fresh ChatGPT-authenticated contexts. Subscription charges/remaining quota are unknown; no API-dollar estimate. Explicit CLI --model recorded; the event stream does not expose resolved server model. Output token limit is checked after completion.' : 'Estimate uses actual reported token counts and configured provider rates, including OpenAI cache and long-context rates; not an account invoice.' };
  await write(path.join(run, 'run.json'), state);
  const validation = await exists(path.join(run, 'validation/validation-report.json')) ? await json(path.join(run, 'validation/validation-report.json')) : null;
  let md = `# APK Design MVP Run Report\n\nStatus: **${state.status}**\n\nModel: ${state.config.model}. Run: ${run}\n\nRequests: ${calls.length}/${state.config.max_calls}; input tokens: ${input}; output tokens: ${output}; estimated cost: $${cost.toFixed(4)}. Price source: ${state.config.pricing.source}\n\n## Completed stages\n\n${Object.keys(state.stages).map(x => '- ' + x).join('\n')}\n\n## Validation\n\n`;
  for (const [label, file] of [['Program correctness','program-checks.json'],['Static tools','static-tools.json'],['Model output / references','validation-report.json'],['Stage recovery','recovery-check.json'],['Artifact audit','artifact-audit.json'],['Wireframe/design inspection','wireframe-check.json']]) {
    const p = path.join(run, 'validation', file);
    if (await exists(p)) { const d = await json(p); md += `- ${label}: ${d.passed ? 'passed' : 'incomplete/failed'} (${file})\n`; } else md += `- ${label}: not yet performed\n`;
  }
  md += '\n## Source specifications and unknowns\n\n';
  const locked = await exists(path.join(run, 'apps.lock.json')) ? await json(path.join(run, 'apps.lock.json')) : [];
  for (const app of locked) {
    const p = path.join(run, 'apps', app.id, 'app-spec.json');
    if (await exists(p)) { const spec = await json(p); md += `- ${app.id}: ${spec.status}; static_only=true, runtime_verified=false. ${spec.unknowns.join('; ')}\n`; }
    else md += `- ${app.id}: specification not generated. Saved static collection: ${state.collections?.[app.id]?.path || 'no checkpoint yet'}.\n`;
  }
  md += `\n## Blockers and limitations\n\n${state.error || 'No execution blocker recorded.'}\n\n${(validation?.errors || []).map((x: string) => '- ' + x).join('\n')}\n\nStatic analysis does not establish reference-app runtime experience, full app coverage, independent model review, or market demand. Proposed behavior is a new design.\n\n## Artifacts and rerun\n\nSee apps/*/app-spec.md, synthesis/comparison.json, synthesis/decisions.json, final/design.md and final/wireframes.html. All model-visible requests and responses are in calls/.\n\n\`npm run mvp -- resume --run ${path.relative(process.cwd(), run)}\`\n\n\`npm run mvp -- validate --run ${path.relative(process.cwd(), run)}\`\n`;
  if (state.config.provider === 'codex_cli') md = md.replace('Requests:', 'CLI executions:').replace(`estimated cost: $${cost.toFixed(4)}`, 'subscription charge: unknown (no API-dollar estimate)') + '\nCodex CLI uses the saved ChatGPT login with API-key environment variables removed. Each call has a fresh ephemeral context; the explicit --model argument is recorded, while resolved server identity is not exposed by CLI events. Output-token limits are validated after completion. The execution budget counts CLI turns; internal transport retries are not individually exposed.\n';
  await write(path.join(run, 'report.md'), md);
}
