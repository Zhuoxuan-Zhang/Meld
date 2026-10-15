import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { Rea, unwrap } from './rea.js';
import { Claude } from './claude.js';
import { Selection } from './schemas.js';
import { analyze } from './analyze.js';
import { synthesize } from './design.js';
import { json, write, fileSha, exists, sha, files, redact, execLogged, stopOwnedProcesses } from './storage.js';
import { fingerprint, stage, report } from './state.js';
import { checkApk } from './resources.js';
import { validateRun, validateSpecData, validateEvidence } from './validate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolRoot = path.resolve(process.env.MELD_PIPELINE_TOOL_ROOT || root);
dotenv.config({ path: path.join(root, '../.env'), quiet: true });
dotenv.config({ path: path.join(root, '.env'), quiet: true });
process.env.JAVA_HOME ||= '/usr/lib/jvm/java-21-openjdk-amd64';
process.env.REA_JADX_MCP_JAR ||= path.join(toolRoot, 'vendor/rea/_reference/apk-integration/jadx-headless-mcp-0.7.1-all.jar');
process.env.REA_APKTOOL_COMMAND ||= path.join(toolRoot, 'tools/apktool');
process.env.REA_JADX_HEAP_MIB ||= '4096'; process.env.REA_JADX_ACTIVE_PROCESSOR_COUNT ||= '4';
const Brief = z.object({ target_users: z.string(), core_tasks: z.array(z.string()), reference_scopes: z.record(z.string(), z.object({ core_tasks: z.array(z.string()).min(1), scope: z.string() })).optional(), required_states: z.array(z.enum(["normal", "empty", "no_results", "error", "delete_confirmation", "unsaved_changes"])).optional(), project_name: z.string().optional(), market_signals: z.unknown().optional(), max_features: z.number().int().positive().max(5), max_navigation: z.number().int().positive().max(3), offline_only: z.literal(true), implementation: z.string(), excluded: z.array(z.string()), scope: z.string() });
function parse(args: string[]) {
  const command = args.shift(); const opts: any = {};
  while (args.length) {
    const key = args.shift()!;
    if (key === '--demo') opts.demo = true;
    else if (key === '--pause-for-decisions') opts.pauseForDecisions = true;
    else if (key === '--analysis-only') opts.analysisOnly = true;
    else if (key === '--apks') { opts.apks = []; while (args[0] && !args[0].startsWith('--')) opts.apks.push(args.shift()); }
    else if (['--brief', '--run', '--config', '--market-input'].includes(key)) { if (!args[0] || args[0].startsWith('--')) throw new Error(`Missing value ${key}`); opts[key.slice(2)] = args.shift(); }
    else throw new Error(`Unknown argument ${key}`);
  }
  if (!['run', 'resume', 'validate'].includes(command || '')) throw new Error('Usage: npm run mvp -- run --demo --brief config/brief.notes.json | run --apks a.apk b.apk c.apk --brief ... | resume --run runs/<id> | validate --run runs/<id>');
  if (command === 'run' && ((!!opts.demo === !!opts.apks) || opts.apks && (opts.apks.length < 1 || opts.apks.length > 5))) throw new Error('Choose --demo or one to five --apks');
  if (command !== 'run' && !opts.run) throw new Error('--run is required');
  return { command, opts };
}
async function download(url: string, dest: string, digest: string, log: string) {
  if (await exists(dest)) { if (await fileSha(dest) !== digest) throw new Error(`Locked download hash mismatch ${dest}`); return; }
  const tmp = dest + '.partial-' + randomUUID(); let bytes = 0;
  const start = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(180000) }); if (!r.ok || !r.body) throw new Error(`Download HTTP ${r.status}`);
    await fs.mkdir(path.dirname(dest), { recursive: true }); const handle = await fs.open(tmp, 'wx');
    try { for await (const chunk of r.body as any) { bytes += chunk.length; if (bytes > 256 * 1024 * 1024) throw new Error('Download too large'); await handle.writeFile(chunk); } } finally { await handle.close(); }
    if (await fileSha(tmp) !== digest) throw new Error('Downloaded APK differs from lock'); await fs.rename(tmp, dest);
    await write(log, { url, bytes, sha256: digest, elapsed_ms: Date.now() - start, success: true });
  } catch (e) { await write(log, { url, bytes, elapsed_ms: Date.now() - start, success: false, error: redact(String(e)), partial_path: tmp }); throw e; }
}
async function execute() {
  const { command, opts } = parse(process.argv.slice(2));
  let run = opts.run ? path.resolve(opts.run) : path.join(root, 'runs', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 6));
  let state: any, rea: Rea | undefined;
  if (command === 'validate') {
    state = await json(path.join(run, 'run.json'));
    try { const result = await validateRun(run); state.status = result.passed ? result.status : state.status === 'blocked' ? 'blocked' : result.status; if (result.passed) state.error = ''; state.validation_errors = result.errors; await report(run, state); console.log(JSON.stringify(result, null, 2)); if (!result.passed) process.exitCode = 1; }
    catch (e) { state.status = 'INCOMPLETE'; state.error = redact(String(e)); await report(run, state); throw e; }
    return;
  }
  if (command === 'run') {
    const cfg = await json(opts.config ? path.resolve(opts.config) : path.join(root, 'config/runtime.json'));
    const brief = Brief.parse(await json(path.resolve(opts.brief || path.join(root, 'config/brief.notes.json'))));
    await fs.mkdir(run, { recursive: true });
    state = { id: path.basename(run), created_at: new Date().toISOString(), status: 'initializing', config: cfg, stages: {}, calls: [], mode: opts.demo ? 'demo' : 'user_apks', input_plan: opts.demo ? await json(path.join(root, 'config/demo.apps.lock.json')) : opts.apks.map((p: string, i: number) => ({ id: `app${i+1}`, input_source: path.resolve(p), url: '', version: '', package_name: '' })) };
    state.human_decisions = Boolean(opts.pauseForDecisions); state.analysis_only = Boolean(opts.analysisOnly);
    if (opts['market-input']) {
      const input = await json(path.resolve(opts['market-input']));
      if (!Array.isArray(input.apps) || input.apps.length !== state.input_plan.length || input.apps.some((a: any) => !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(a.appId))) throw new Error('Market handoff must match every selected APK');
      state.input_plan.forEach((a: any, i: number) => { a.expected_package_name = input.apps[i].appId; a.sha256 = input.apps[i].apk_sha256; });
      await write(path.join(run, 'market-input.json'), input);
    }
    await write(path.join(run, 'run.json'), state); await write(path.join(run, 'brief.json'), brief);
  } else state = await json(path.join(run, 'run.json'));
  console.log(`Run directory: ${run}`);
  try {
    const fp = await fingerprint(root, state.config);
    if (state.fingerprint && state.fingerprint.digest !== fp.digest) throw new Error('Resume requires unchanged configuration, prompts and tool versions. Create a new run for changed inputs.');
    state.fingerprint ||= fp;
    state.executions ||= [];
    state.executions.push({ started_at: new Date().toISOString(), command, code_and_prompt_hashes: fp.code_and_prompts });
    await write(path.join(run, 'run.json'), state);
    const brief = await json(path.join(run, 'brief.json'));
    rea = new Rea(toolRoot, run, state.config.tool_timeout_ms); await rea.connect();
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return; shuttingDown = true;
      stopOwnedProcesses();
      try { await rea?.close(); } catch {}
      state.status = 'interrupted'; state.error = `Interrupted by ${signal}`;
      await report(run, state); process.exit(130);
    };
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    const claude = new Claude(root, run, state);
    state.input_plan ||= await json(path.join(run, 'apps.lock.json'));
    const candidateApps = state.mode === 'demo' ? state.input_plan : null;
    await stage(run, state, 'inputs', ['apps.lock.json'], async () => {
      if (candidateApps) {
        await write(path.join(run, 'selection/release-candidates.json'), candidateApps);
        for (const f of await fs.readdir(path.join(root, 'setup'))) if (f.endsWith('-release.json') && ['OmGodse','Fossify','gsantner'].some(x => f.startsWith(x))) await fs.copyFile(path.join(root, 'setup', f), path.join(run, 'selection', f));
        const selection = await claude.ask('selection', await claude.prompt('selection'), { brief, candidates: candidateApps }, Selection, s => s.selected.length === 3 && candidateApps.every((a: any) => s.selected.includes(a.repository)) ? [] : ['Select all three locked repositories; download replacements require separate recorded failure evidence.']);
        await write(path.join(run, 'selection/selection.json'), selection);
      }
      const apps: any[] = state.input_plan;
      for (const app of apps) {
        const src = candidateApps ? path.join(root, 'downloads', app.filename) : app.input_source;
        if (candidateApps) await download(app.url, src, app.sha256, path.join(run, 'selection', `${app.id}-download-${Date.now()}.json`));
        const inputDigest = await fileSha(src);
        if (app.sha256 && app.sha256 !== inputDigest) throw new Error(`Selected input changed ${app.id}; create a new run`);
        app.sha256 = inputDigest; await write(path.join(run, 'run.json'), state);
        await checkApk(src, path.join(run, 'setup', `${app.id}-input-check.json`), state.config.max_expanded_bytes);
        const dest = path.join(run, 'apps', app.id, 'input.apk'); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.copyFile(src, dest);
        app.sha256 = await fileSha(dest); app.path = dest;
        const result = await rea!.call('inspect_android_package', { path: dest }, app, path.join(run, 'setup', `${app.id}-package.json`));
        const observation = unwrap(result.result);
        if (result.result.isError || !observation.normalized_result?.package_name) throw new Error(`Package inspection failed ${app.id}: ${JSON.stringify(observation)}`);
        const pkg = observation.normalized_result;
        if (app.expected_package_name && pkg.package_name !== app.expected_package_name) throw new Error(`APK identity does not match market app ${app.expected_package_name}`);
        if (candidateApps && (pkg.package_name !== app.package_name || pkg.version_name !== app.version)) throw new Error(`Locked identity differs from APK ${app.id}`);
        if (/\bsplit\s*=|isSplitRequired="true"/.test(pkg.manifest?.text || '')) throw new Error('Split APK is unsupported');
        app.package_name = pkg.package_name; app.version = pkg.version_name;
        await write(path.join(run, 'setup', `${app.id}-identity.json`), app);
      }
      if (new Set(apps.map(a => a.package_name)).size !== apps.length) throw new Error('Every input must have a distinct package name');
      await write(path.join(run, 'apps.lock.json'), apps);
    });
    const apps = await json(path.join(run, 'apps.lock.json'));
    for (const a of apps) if (await fileSha(path.join(run, 'apps', a.id, 'input.apk')) !== a.sha256) throw new Error(`Input changed ${a.id}`);
    const specs: any[] = [];
    for (const app of apps) {
      app.path = path.join(run, 'apps', app.id, 'input.apk');
      const output = `apps/${app.id}/app-spec.json`, ev = `apps/${app.id}/evidence.json`;
      try {
        await stage(run, state, `analyze-${app.id}`, [output, ev, `apps/${app.id}/review.json`, `apps/${app.id}/app-spec.md`], async () => { const scoped = brief.reference_scopes?.[app.package_name];
          const { required_states: _targetStates, ...sourceBrief } = brief;
          await analyze(root, run, app, rea!, claude, scoped ? { ...sourceBrief, core_tasks: scoped.core_tasks, scope: scoped.scope, analysis_role: 'Reference method behavior only. Target screen states, target persistence guarantees and other game modes are not source-completeness requirements. Keep unconfirmed caller wiring and initialization as explicit unknowns.' } : brief, state.config); }, async () => [...validateSpecData(await json(path.join(run, output)), await json(path.join(run, ev)), app), ...await validateEvidence(run, await json(path.join(run, ev)))]);
        specs.push(await json(path.join(run, output)));
      } catch (error) {
        if (!state.analysis_only) throw error;
        state.analysis_failures ||= [];
        state.analysis_failures.push({ app_id: app.id, at: new Date().toISOString(), error: redact(String(error)) });
        await write(path.join(run, 'run.json'), state);
      }
    }
    await write(path.join(run, 'validation/static-tools.json'), { passed: true, apps: apps.map((a: any) => ({ app_id: a.id, package_name: a.package_name, sha256: a.sha256 })), tools: [...rea.schemas.keys()], rea_revision: fp.tools.lock.rea_commit, limitations: ['Static tools only; upstream verify:android bootstrap failure is separately logged, not counted as passed.'] });
    if (state.analysis_only) { state.status = state.analysis_failures?.length ? 'ANALYSIS_PARTIAL' : 'ANALYSIS_PASSED'; state.error = ''; await report(run, state); return; }
    if (await synthesize(run, state, claude, brief, specs) === 'waiting_user') {
      state.status = 'waiting_user'; state.error = ''; await report(run, state); console.log('Waiting for recorded user conflict choices.'); return;
    }
    const result = await validateRun(run); state.status = result.status; state.error = result.errors.join('\n');
    await report(run, state);
    console.log(`Output: ${path.join(run, 'final/design.md')}`);
    if (!result.passed) { console.log('Model artifacts completed; independent checks remain:\n' + result.errors.join('\n')); process.exitCode = 1; }
  } catch (e: any) {
    state.status = /Intentional stage interruption/.test(String(e)) ? 'interrupted' : /API|Download|capability_unavailable|ENOTFOUND|ECONN|missing|401|403|429|credit balance|no credits remaining|insufficient[_ ]quota/i.test(String(e)) ? 'blocked' : 'partial';
    state.error = redact(e.message || String(e)); await report(run, state); console.error(state.error); process.exitCode = 1;
  } finally { if (rea) await rea.close(); }
}
execute().catch(e => { console.error(redact(String(e))); process.exitCode = 1; });
