import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';
import { Rea, unwrap } from './rea.js';
import { Claude } from './claude.js';
import { AppSpec, Plan, Review, type EvidenceT } from './schemas.js';
import { extractResources, resourceSummary, extractSmaliMethod } from './resources.js';
import { json, write, sha, fileSha, inside, exists, redact } from './storage.js';
import { validateSpecData, validateEvidence } from './validate.js';
import { renderSpec } from './render.js';

function clipped(value: any, limit = 16000): any {
  const text = JSON.stringify(value);
  return text.length > limit ? { excerpt: text.slice(0, limit), truncated_for_context: true, original_characters: text.length, instruction: 'Read remaining saved artifact on demand; truncation does not establish completeness.' } : value;
}
function stringsIn(value: any, found: string[] = []): string[] {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) value.forEach(x => stringsIn(x, found));
  else if (value && typeof value === 'object') Object.values(value).forEach(x => stringsIn(x, found));
  return found;
}
function pointerForText(result: any) {
  let best = '/', bestLength = 0;
  const walk = (v: any, pointer: string) => {
    if (typeof v === 'string' && /method|source|code|body|manifest/.test(pointer) && v.length > bestLength) { best = pointer; bestLength = v.length; }
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, pointer + '/' + k.replace(/~/g,'~0').replace(/\//g,'~1'));
  };
  walk(result, ''); return best;
}
export async function analyze(root: string, run: string, app: any, rea: Rea, claude: Claude, brief: any, cfg: any) {
  const dir = path.join(run, 'apps', app.id), attempt = `attempt-${Date.now()}`, attempts = path.join(dir, 'attempts', attempt), stat = path.join(dir, 'static', attempt);
  await fs.mkdir(attempts, { recursive: true });
  const evidence: EvidenceT[] = [], context: any[] = [];
  let count = 0;
  const call = async (tool: string, args: any) => {
    const dest = path.join(stat, `${String(++count).padStart(3,'0')}-${tool}.json`);
    const r = await rea.call(tool, args, app, dest);
    r.evidence.locator = r.result.structuredContent?.normalized_result ? (tool === 'inspect_android_method' && r.result.structuredContent.normalized_result.source?.text ? '/structuredContent/normalized_result/source/text' : '/structuredContent/normalized_result') : pointerForText(r.result);
    evidence.push(r.evidence);
    const result = unwrap(r.result);
    context.push({ evidence: r.evidence, observation: clipped(result.normalized_result ? { result: result.normalized_result, limitations: result.limitations } : result) });
    if (tool === 'inspect_android_method' && result.normalized_result?.body_status === 'not_available' && result.normalized_result?.overload_count === 1) {
      const fallbackDir = path.join(stat, `smali-${count}`);
      try {
        const body = await extractSmaliMethod(app.path,args.class_name,args.method_name,run,fallbackDir,cfg);
        const rawPath = path.join(fallbackDir,'method.json');
        const e: EvidenceT = { id:`${app.id}-smali-${attempt}-${count}`,app_id:app.id,apk_sha256:app.sha256,tool:'apktool_smali_method',parameters:{path:app.path,class_name:args.class_name,method_name:args.method_name},result_path:path.relative(run,rawPath),result_sha256:await fileSha(rawPath),locator:'/method_text',limitations:body.limitations };
        evidence.push(e); context.push({evidence:e,observation:clipped(body)});
      } catch (error) {
        await write(path.join(fallbackDir,'failure.json'),{error:redact(String(error))});
        context.push({limitation:`Static disassembly fallback unavailable for ${args.class_name}.${args.method_name}: ${redact(String(error))}`});
      }
    }
    return result;
  };
  const savedCheckpoint = claude.state.collections?.[app.id];
  const checkpointPath = savedCheckpoint ? inside(run, path.join(run, savedCheckpoint.path)) : path.join(dir, 'collection-checkpoint.json');
  let resumedPlan: any = null, startRound = 0, specReady = false;
  if (await exists(checkpointPath)) {
    if (savedCheckpoint && await fileSha(checkpointPath) !== savedCheckpoint.sha256) throw new Error('Collection checkpoint hash changed');
    const cp = await json(checkpointPath);
    if (cp.apk_sha256 !== app.sha256 || cp.fingerprint !== claude.state.fingerprint.digest) throw new Error('Collection checkpoint identity changed; create a new run');
    const errors = await validateEvidence(run, cp.evidence);
    if (errors.length) throw new Error('Collection checkpoint evidence invalid: ' + errors.join('; '));
    evidence.push(...cp.evidence); context.push(...cp.context); resumedPlan = cp.plan; startRound = cp.next_round; specReady = cp.spec_ready;
    console.log(`Resume collection ${app.id} at round ${startRound}`);
  } else {
  const pkg = await call('inspect_android_package', { path: app.path });
  if (context.at(-1).observation?.error || context.at(-1).observation?.isError) throw new Error(`APK package inspection failed ${app.id}`);
  const inventory = await call('search_android_classes', { path: app.path, query: '' });
  await call('decode_android_resources', { path: app.path });
  const resourceDir = path.join(stat, 'snapshot');
  const resources = await extractResources(app.path, resourceDir, cfg);
  const indexPath = path.join(resourceDir, 'resource-index.json');
  const resourceEvidence: EvidenceT = { id: `${app.id}-e-${attempt}-resources`, app_id: app.id, apk_sha256: app.sha256, tool: 'apktool_local_snapshot', parameters: { path: app.path, no_src: true }, result_path: path.relative(run, indexPath), result_sha256: await fileSha(indexPath), locator: '/files', limitations: ['Resource strings alone do not establish complete functionality; locale variants are retained.'] };
  evidence.push(resourceEvidence); context.push({ evidence: resourceEvidence, observation: clipped(resourceSummary(resources), 16000) });
  const names = [...new Set(stringsIn(inventory).filter(x => x.startsWith(app.package_name + '.') && x.length < 220))];
  // Full inventories remain on disk. Give only app-owned class names initially.
  context[1].observation = { app_class_names: names, full_inventory_path: context[1].evidence.result_path, limitation: 'Framework/support/library classes omitted from initial context; full raw inventory is retained.' };
  }
  const prompt = await claude.prompt('analyze');
  const sourceCompletion = 'For source specifications, complete means substantial static documentation of the core_tasks explicitly listed for this reference, with at least two distinct method-supported core behaviors and explicit coverage gaps. Optional behaviors mentioned in scope, unconfirmed caller wiring, initial-data origins and target screen-state requirements are not additional required core tasks. Complete is scoped static documentation, never full-app or runtime verification. An entirely undocumented core task or missing method evidence requires partial; unsupported facts must be corrected or marked unknown. The closed-flow and full lifecycle requirements apply to the proposed unified design, not every reference-app behavior.';
  let plan: any = resumedPlan;
  const checkpoint = async (next_round: number, spec_ready = false) => {
    const cp = { apk_sha256: app.sha256, fingerprint: claude.state.fingerprint.digest, next_round, spec_ready, evidence, context, plan };
    const cpPath = path.join(attempts, `checkpoint-${next_round}-${Date.now()}.json`);
    await write(cpPath, cp);
    claude.state.collections ||= {};
    claude.state.collections[app.id] = { path: path.relative(run, cpPath), sha256: sha(JSON.stringify(cp, null, 2) + '\n') };
    await write(path.join(run, 'run.json'), claude.state);
  };
  const toolSchemas = { ...Object.fromEntries(rea.schemas), inspect_android_bytecode: { description: 'App-local APKtool method disassembly, distinct from REA Java output. Use inventoried class and method names when Java decompilation is missing or contradicts mutations (for example Kotlin default-argument masks). Preserves APK and raw class hashes. A selector must identify exactly one method; overloaded selectors may fail honestly.', inputSchema: { type: 'object', properties: { class_name: { type: 'string' }, method_name: { type: 'string' } }, required: ['class_name', 'method_name'] } } };
  const executeActions = async (actions: any[]) => {
    for (const action of actions.slice(0, 20)) {
      if (action.tool === 'inspect_android_bytecode') {
        const dir = path.join(stat, `bytecode-${++count}`);
        try {
          const body = await extractSmaliMethod(app.path, action.class_name, action.method_name, run, dir, cfg);
          const rawPath = path.join(dir, 'method.json'); await write(rawPath, body);
          const e: EvidenceT = { id: `${app.id}-bytecode-${attempt}-${count}`, app_id: app.id, apk_sha256: app.sha256, tool: 'apktool_smali_method', parameters: { path: app.path, class_name: action.class_name, method_name: action.method_name }, result_path: path.relative(run, rawPath), result_sha256: await fileSha(rawPath), locator: '/method_text', limitations: body.limitations };
          evidence.push(e); context.push({ evidence: e, observation: clipped(body) });
        } catch (error) { await write(path.join(dir, 'failure.json'), { error: redact(String(error)) }); context.push({ limitation: `Bytecode unavailable for ${action.class_name}.${action.method_name}: ${redact(String(error))}` }); }
        continue;
      }
      if (action.tool === 'read_artifact') {
        const p = inside(path.join(dir, 'static'), path.join(run, action.path));
        const real = await fs.realpath(p); inside(path.join(dir, 'static'), real);
        if (action.offset < 0 || action.limit < 1 || action.limit > 16000) throw new Error('Invalid artifact read window');
        let seen = 0, excerpt = '';
        const stream = createReadStream(p, { encoding: 'utf8', highWaterMark: 65536 });
        for await (const chunk of stream) {
          const text = String(chunk), start = Math.max(0, action.offset - seen);
          if (start < text.length) excerpt += text.slice(start, start + action.limit - excerpt.length);
          seen += text.length; if (excerpt.length >= action.limit) break;
        }
        const read = { tool: 'read_artifact', path: action.path, offset: action.offset, limit: action.limit, total_bytes: (await fs.stat(p)).size, excerpt };
        await write(path.join(attempts, `read-${Date.now()}-${count++}.json`), read); context.push(read); continue;
      }
      const args: any = { path: app.path };
      if (action.tool === 'search_android_classes') args.query = action.query;
      else {
        args.class_name = action.class_name;
        if (action.tool === 'inspect_android_method' || action.tool === 'trace_android_references' && action.method_name) args.method_name = action.method_name;
        if (action.tool === 'inspect_android_method' && action.overload_index !== null) args.overload_index = action.overload_index;
      }
      await call(action.tool, args);
    }
  };
  for (let round = startRound; !specReady && round < cfg.max_tool_rounds; round++) {
    await checkpoint(round);
    await write(path.join(attempts, 'evidence-working.json'), evidence);
    plan = await claude.ask(`${app.id}-plan-${round}`, prompt, { mode: 'plan', app: { id: app.id, package_name: app.package_name, version: app.version, sha256: app.sha256 }, brief, round, prior_plan: plan || null, evidence: context, tool_schemas: toolSchemas,scoped_completion_criteria:sourceCompletion }, Plan);
    await write(path.join(attempts, `analysis-plan-${round}.json`), plan);
    if (round === 0) await write(path.join(dir, 'analysis-plan.json'), plan);
    if (plan.ready_for_spec && round > 0) { await checkpoint(round + 1, true); break; }
    if (!plan.actions.length) break;
    await executeActions(plan.actions);
    if (round === cfg.max_tool_rounds - 1) context.push({ limitation: 'Tool-planning round limit reached; insufficient behavior evidence must remain partial.' });
    await checkpoint(round + 1);
  }
  await write(path.join(dir, 'evidence.json'), evidence);
  await write(path.join(attempts, 'model-evidence-context.json'), context);
  const specContext = { mode: 'app-spec', app: { id: app.id, package_name: app.package_name, version: app.version, sha256: app.sha256 }, brief, evidence: context, latest_plan: plan, scoped_completion_criteria:sourceCompletion };
  let spec: any = await claude.ask(`${app.id}-spec`, prompt, specContext, AppSpec, s => validateSpecData(s, evidence, app));
  await write(path.join(attempts, 'app-spec-draft-0.json'), spec);
  let review: any;
  for (let round = 0; round < 3; round++) {
    review = await claude.ask(`${app.id}-review-${round}`, await claude.prompt('review'), { kind: 'app-spec', spec, evidence: context, brief, scoped_completion_criteria:sourceCompletion }, Review);
    await write(path.join(attempts, `review-${round}.json`), review);
    if (review.passed && !review.issues.some((x: any) => x.severity === 'blocking')) { spec.status = 'complete'; break; }
    if (round === 2) { spec.status = 'partial'; break; }
    const supplementPlan = await claude.ask(`${app.id}-supplement-${round}`, prompt, { mode: 'plan', app: { id: app.id, package_name: app.package_name, version: app.version, sha256: app.sha256 }, brief, prior_spec: spec, review, evidence: context, tool_schemas: toolSchemas, instruction: 'Request only targeted missing evidence for blocking review issues. Read remaining saved method windows before declaring their behavior unsupported. Use real inventoried selectors; at most twelve actions.' }, Plan);
    await write(path.join(attempts, `supplement-plan-${round}.json`), supplementPlan);
    await executeActions(supplementPlan.actions);
    await checkpoint(cfg.max_tool_rounds, true);
    await write(path.join(dir, 'evidence.json'), evidence);
    spec = await claude.ask(`${app.id}-repair-${round}`, prompt, { ...specContext, prior_spec: spec, review, instruction: 'Repair supported claims, or mark insufficient ones inferred/unknown. Do not invent evidence.' }, AppSpec, s => validateSpecData(s, evidence, app));
    await write(path.join(attempts, `app-spec-draft-${round + 1}.json`), spec);
  }
  await write(path.join(dir, 'review.json'), review);
  await write(path.join(dir, 'app-spec.json'), spec);
  await renderSpec(path.join(dir, 'app-spec.md'), spec);
  const errors = [...validateSpecData(spec, evidence, app), ...await validateEvidence(run, evidence)];
  await write(path.join(attempts, 'final-validation.json'), { passed: errors.length === 0, errors });
  if (errors.length || spec.status === 'partial') throw new Error(`Partial/invalid specification ${app.id}: ${errors.join('; ')}`);
  return spec;
}
