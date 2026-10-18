import path from 'node:path';
import { paletteErrors } from './palette.js';
import { DesignPatch, applyDesignPatch } from './design-patch.js';
import { DesignReferenceRepair, applyDesignReferenceRepair } from './design-repair.js';
import { promises as fs } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { AppSpec, Comparison, Decisions, Evidence, UnifiedDesign, Review } from './schemas.js';
import { fileSha, inside, json, write, exists, sha } from './storage.js';

function unique(values: string[], label: string, errors: string[]) {
  if (new Set(values).size !== values.length) errors.push(`Duplicate ${label}`);
}
export function validateSpecData(spec: any, evidence: any[], app: any): string[] {
  const errors: string[] = [];
  const parsed = AppSpec.safeParse(spec);
  if (!parsed.success) return [parsed.error.message];
  const byId = new Map(evidence.map(e => [e.id, e]));
  unique(evidence.map(e => e.id), 'evidence IDs', errors);
  if (spec.app_id !== app.id || spec.apk_sha256 !== app.sha256 || spec.package_name !== app.package_name || spec.version !== app.version && app.version !== undefined) errors.push('App identity mismatch');
  unique(spec.features.map((f: any) => f.id), 'feature IDs', errors);
  unique(spec.features.flatMap((f: any) => f.claims.map((c: any) => c.id)), 'claim IDs', errors);
  const references = (ids: string[]) => {
    for (const id of ids) {
      const e = byId.get(id);
      if (!e) errors.push(`Unknown evidence ${id}`);
      else if (e.app_id !== app.id || e.apk_sha256 !== app.sha256) errors.push(`Cross-app evidence ${id}`);
    }
  };
  let methodClaims = 0; const methodEvidence = new Set<string>();
  const isMethod = (id: string) => ['inspect_android_method', 'apktool_smali_method'].includes(byId.get(id)?.tool || '');
  for (const f of spec.features) for (const c of f.claims) {
    references(c.evidence_ids);
    if (['artifact_fact', 'decompiled_fact'].includes(c.classification) && !c.evidence_ids.length) errors.push(`Fact without evidence ${c.id}`);
    for (const id of c.evidence_ids) if (byId.get(id)?.limitations.some((x: string) => x.startsWith('Tool failed'))) errors.push(`Failed-tool evidence used ${c.id}`);
    if (c.classification === 'decompiled_fact') {
      if (!c.evidence_ids.some(isMethod)) errors.push(`Method fact lacks method evidence ${c.id}`);
      else { methodClaims++; c.evidence_ids.filter(isMethod).forEach((id: string) => methodEvidence.add(id)); }
    }
  }
  for (const p of [...spec.pages, ...spec.flows, ...spec.data_structures]) references(p.evidence_ids);
  if (spec.status === 'complete' && (methodClaims < 2 || methodEvidence.size < 2)) errors.push('Complete spec requires at least two method-supported claims');
  if (!spec.features.length) errors.push('Empty feature specification');
  return errors;
}
export async function validateEvidence(run: string, evidence: any[]): Promise<string[]> {
  const errors: string[] = [];
  for (const raw of evidence) {
    const p = Evidence.safeParse(raw);
    if (!p.success) { errors.push(p.error.message); continue; }
    const e = p.data;
    try {
      const file = inside(run, path.join(run, e.result_path));
      if (await fileSha(file) !== e.result_sha256) errors.push(`Evidence hash changed: ${e.id}`);
      const saved = await json(file);
      let observed = saved.structuredContent;
      if (!observed && saved.content?.[0]?.text) { try { observed = JSON.parse(saved.content[0].text); } catch {} }
      const producerHash = observed?.subject?.digest?.sha256 || observed?.normalized_result?.target?.sha256 || saved.apk_sha256;
      if (producerHash && producerHash !== e.apk_sha256) errors.push(`Producer APK identity mismatch: ${e.id}`);
      if (e.tool === 'apktool_smali_method') {
        const rawClass = inside(run, path.join(run, saved.raw_class_path));
        const source = await fs.readFile(rawClass, 'utf8');
        if (await fileSha(rawClass) !== saved.raw_class_sha256 || saved.class_name !== e.parameters.class_name || saved.method_name !== e.parameters.method_name || !saved.method_text?.startsWith('.method ') || !saved.method_text?.trim().endsWith('.end method') || !source.includes(saved.method_text)) errors.push(`Invalid derived smali method ${e.id}`);
      }
      if (e.locator.startsWith('/') && e.locator !== '/') {
        let v = await json(file);
        for (const part of e.locator.slice(1).split('/')) v = v?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
        if (v === undefined) errors.push(`Unresolved locator: ${e.id}`);
      } else if (!e.locator) errors.push(`Missing locator: ${e.id}`);
    } catch (e2) { errors.push(`Evidence inaccessible ${e.id}: ${String(e2)}`); }
  }
  return errors;
}
export function sourceErrors(refs: any[], specs: any[]) {
  return refs.flatMap(r => specs.some(s => s.app_id === r.app_id && s.features.some((f: any) => f.id === r.feature_id)) ? [] : [`Unknown source feature ${r.app_id}/${r.feature_id}`]);
}
export function validateComparison(c: any, specs: any[]) {
  const p = Comparison.safeParse(c); if (!p.success) return [p.error.message];
  const errors = sourceErrors([...c.tasks.flatMap((t: any) => t.sources), ...c.conflicts.flatMap((t: any) => t.sources)], specs);
  unique(c.tasks.map((t: any) => t.id), 'comparison task IDs', errors);
  unique(c.conflicts.map((t: any) => t.id), 'conflict IDs', errors);
  const optionIds = c.conflicts.flatMap((t: any) => t.options.map((o: any) => o.id)); unique(optionIds, 'option IDs', errors);
  for (const app of specs) if (!c.tasks.some((t: any) => t.sources.some((r: any) => r.app_id === app.app_id))) errors.push(`Comparison omits ${app.app_id}`);
  for (const t of c.conflicts) {
    if (t.options.length < 2 || t.options.length > 3) errors.push(`Conflict ${t.id} must have 2–3 options`);
    for (const o of t.options) for (const id of [...o.requires_option_ids, ...o.incompatible_option_ids]) if (!optionIds.includes(id)) errors.push(`Unknown option dependency ${id}`);
  }
  return errors;
}
export function validateDecisions(d: any, c: any, specs: any[]) {
  const p = Decisions.safeParse(d); if (!p.success) return [p.error.message];
  const errors = sourceErrors(d.selections.flatMap((s: any) => s.sources), specs);
  unique(d.selections.map((s: any) => s.conflict_id), 'selected conflict IDs', errors);
  const selected = new Set(d.selections.map((s: any) => s.option_id));
  for (const s of d.selections) {
    const conflict = c.conflicts.find((x: any) => x.id === s.conflict_id);
    const option = conflict?.options.find((x: any) => x.id === s.option_id);
    if (!option) { errors.push(`Invalid decision option ${s.conflict_id}/${s.option_id}`); continue; }
    for (const r of s.rejected) if (!conflict.options.some((o: any) => o.id === r.option_id) || r.option_id === s.option_id) errors.push(`Invalid rejected option ${r.option_id}`);
    for (const o of conflict.options) if (o.id !== s.option_id && !s.rejected.some((r: any) => r.option_id === o.id)) errors.push(`Missing rejection reason ${o.id}`);
    for (const dep of option.requires_option_ids) if (!selected.has(dep)) errors.push(`Unsatisfied dependency ${dep}`);
    for (const dep of option.incompatible_option_ids) if (selected.has(dep)) errors.push(`Incompatible selections ${s.option_id}/${dep}`);
  }
  for (const conflict of c.conflicts) if (conflict.blocking && !d.selections.some((s: any) => s.conflict_id === conflict.id)) errors.push(`Unresolved blocking conflict ${conflict.id}`);
  if (Object.entries(d.global_consistency).some(([k, v]) => k !== 'explanation' && v !== true)) errors.push('Decision set violates global constraints');
  return errors;
}
export function validateDesign(d: any, brief: any, decisions: any, specs: any[]) {
  const p = UnifiedDesign.safeParse(d); if (!p.success) return [p.error.message];
  const errors = [...sourceErrors(d.features.flatMap((f: any) => f.sources), specs), ...paletteErrors(d.visual.colors)];
  if (d.features.length > brief.max_features || !d.features.length) errors.push('Feature scope limit violated');
  if (d.navigation.length > brief.max_navigation) errors.push('Navigation scope limit violated');
  const pages = new Set(d.pages.map((p: any) => p.id)), flows = new Set(d.flows.map((f: any) => f.id));
  unique(d.pages.map((p: any) => p.id), 'page IDs', errors); unique(d.features.map((f: any) => f.id), 'design feature IDs', errors); unique(d.flows.map((f: any) => f.id), 'flow IDs', errors);
  const checkPage = (id: string) => { if (id && !pages.has(id)) errors.push(`Dangling navigation ${id}`); };
  for (const n of d.navigation) checkPage(n.page_id);
  for (const f of d.features) {
    f.page_ids.forEach(checkPage);
    for (const id of f.flow_ids) if (!flows.has(id)) errors.push(`Unknown flow ${id}`);
    if (!f.acceptance.length) errors.push(`Missing acceptance ${f.id}`);
    for (const a of f.acceptance) if (![a.given, a.when, a.then].every((v: string) => v.trim())) errors.push(`Empty acceptance case ${a.id}`);
    if (!f.page_ids.length && !f.flow_ids.length) errors.push(`Unmapped feature ${f.id}`);
    if (!f.sources.length && !f.proposed_reason) errors.push(`Missing provenance ${f.id}`);
  }
  for (const f of d.flows) { checkPage(f.entry_page_id); for (const s of f.steps) checkPage(s.page_id); if (!f.steps.length) errors.push(`Empty flow ${f.id}`); }
  for (const p of d.pages) {
    const components = new Set(p.components.map((c: any) => c.id)), events = new Set(p.events.map((e: any) => e.id));
    unique(p.components.map((c: any) => c.id), `component IDs on ${p.id}`, errors); unique(p.events.map((e: any) => e.id), `event IDs on ${p.id}`, errors);
    for (const c of p.components) {
      if (c.parent_id && !components.has(c.parent_id)) errors.push(`Unknown component parent ${c.id}`);
      for (const id of c.event_ids) if (!events.has(id)) errors.push(`Missing event ${p.id}/${id}`);
      if (/button|action/i.test(c.type) && !c.event_ids.length) errors.push(`Action without result ${p.id}/${c.id}`);
    }
    for (const e of p.events) { checkPage(e.target_page_id); if (!e.action || !e.state_change || !e.error_recovery) errors.push(`Incomplete action ${e.id}`); }
    for (const s of p.states) {
      for (const id of s.component_ids) if (!components.has(id)) errors.push(`Unknown state component ${id}`);
      for (const id of s.event_ids) if (!events.has(id)) errors.push(`Unknown state action ${id}`);
    }
    if (!p.states.some((s: any) => s.kind === 'normal')) errors.push(`Missing normal state ${p.id}`);
  }
  const coreTasks = Array.isArray(brief.core_tasks) ? brief.core_tasks : [];
  if (!coreTasks.length) errors.push('Brief must define core tasks');
  for (const task of coreTasks) if (!d.scope.core_tasks.includes(task)) errors.push(`Missing core task ${task}`);
  for (const kind of (brief.required_states || ['empty', 'error', ...(coreTasks.some((t: string) => /find|search/i.test(t)) ? ['no_results'] : []), ...(coreTasks.some((t: string) => /delete/i.test(t)) ? ['delete_confirmation'] : []), ...(coreTasks.some((t: string) => /create|edit|capture/i.test(t)) ? ['unsaved_changes'] : [])])) if (!d.pages.some((p: any) => p.states.some((s: any) => s.kind === kind))) errors.push(`Missing design state ${kind}`);
  for (const s of decisions.selections) if (!d.decisions.includes(s.option_id)) errors.push(`Design omits decision ${s.option_id}`);
  for (const id of d.decisions) if (!decisions.selections.some((s: any) => s.option_id === id)) errors.push(`Unknown design decision ${id}`);
  for (const e of d.entities) { unique(e.fields.map((f: any) => f.name), `entity fields ${e.id}`, errors); if (!e.persistence) errors.push(`Missing persistence ${e.id}`); }
  if (!d.compose.ui_states.length || !d.compose.repository_responsibilities.length) errors.push('Missing Compose contracts');
  return errors;
}
export async function validateRun(run: string) {
  const errors: string[] = [], specs: any[] = [];
  const state = await json(path.join(run, 'run.json'));
  const load = async (relative: string) => {
    try { return await json(path.join(run, relative)); }
    catch (e) { errors.push(`Missing or unreadable artifact ${relative}: ${String(e)}`); return null; }
  };
  const apps = await load('apps.lock.json') || [];
  if (await exists(path.join(run, 'reference-observations.json'))) {
    try {
      const { loadReferenceObservations } = await import('./observation.js');
      const observations = await loadReferenceObservations(run);
      for (const observation of observations) if (!apps.some((app: any) => app.package_name === observation.packageName && app.sha256 === observation.apkSha256)) errors.push(`Reference observation APK identity mismatch ${observation.packageName}`);
    } catch (error) { errors.push(`Reference observation validation failed: ${String(error)}`); }
  }
  if (apps.length < 1 || apps.length > 5) errors.push('One to five locked APK inputs are required');
  for (const app of apps) {
    try { if (await fileSha(path.join(run, 'apps', app.id, 'input.apk')) !== app.sha256) errors.push(`Input changed ${app.id}`); }
    catch { errors.push(`Input APK unavailable ${app.id}`); }
    const spec = await load(`apps/${app.id}/app-spec.json`);
    const evidence = await load(`apps/${app.id}/evidence.json`);
    if (spec && Array.isArray(evidence)) {
      errors.push(...validateSpecData(spec, evidence, app), ...await validateEvidence(run, evidence));
      if (AppSpec.safeParse(spec).success) specs.push(spec);
    }
    const review = await load(`apps/${app.id}/review.json`);
    if (!Review.safeParse(review).success || !review.passed || review.issues.some((i: any) => i.severity === 'blocking')) errors.push(`Unresolved app review ${app.id}`);
    if (!spec || spec.status !== 'complete') errors.push(`Missing/partial specification ${app.id}`);
    if (!state.calls?.some((c: any) => c.success && (c.stage === `${app.id}-spec` || c.stage.startsWith(`${app.id}-repair-`)))) errors.push(`Successful live specification call missing ${app.id}`);
  }
  unique(apps.map((a: any) => a.package_name), 'APK package names', errors);
  const c = await load('synthesis/comparison.json'); if (c) errors.push(...validateComparison(c, specs));
  const d = await load('synthesis/decisions.json'); if (d && Comparison.safeParse(c).success) errors.push(...validateDecisions(d, c, specs));
  if (d && d.chosen_by !== (state.config.provider === 'codex_cli' ? 'codex_proxy' : state.config.provider === 'openai' ? 'openai_proxy' : 'claude_proxy')) errors.push('Decision provider identity mismatch');
  const design = await load('final/final-design.json');
  if (design && Decisions.safeParse(d).success) errors.push(...validateDesign(design, await load('brief.json'), d, specs));
  const review = await load('synthesis/design-review.json');
  if (!Review.safeParse(review).success || !review.passed || review.issues.some((i: any) => i.severity === 'blocking')) errors.push('Unresolved design review');
  if (!design || design.status !== 'final') errors.push('Design missing or remains draft');
  const cliProvider = ['codex_cli', 'claude_cli'].includes(state.config.provider);
  for (const label of ['compare', 'decide', 'design']) if (!(label === 'decide' && state.human_decisions && d?.chosen_by === 'user' && state.stages?.decide) && !state.calls?.some((c: any) => c.success && (c.stage === label || label === 'design' && c.stage.startsWith('design-repair-'))) && !(label==='design'&&cliProvider&&['design-core-','design-pages-','design-contracts-'].every(prefix=>state.calls?.some((c:any)=>c.success&&c.stage.startsWith(prefix))))) errors.push(`Successful live stage missing ${label}`);
  if(cliProvider&&state.calls?.some((c:any)=>c.stage.startsWith('design-core-'))&&design){
    const assembly=await load('synthesis/design-assembly.json');
    if(assembly?.final_design_sha256!==sha(JSON.stringify(design))||assembly.fragment_calls?.length!==3||!assembly.fields_generated_by_model||assembly.templates_used!==false) errors.push('Unverified fragmented design assembly');
    else {
      let joined:any={};
      for(const part of assembly.parsed_fragment_sha256){
        if(part.sha256!==await fileSha(path.join(run,'calls',part.id,'parsed.json'))) errors.push(`Design fragment changed ${part.id}`);
        if(!state.calls.some((c:any)=>c.id===part.id&&c.success&&/^design-(core|pages|contracts)-/.test(c.stage))) errors.push(`Unverified design fragment call ${part.id}`);
        joined={...joined,...await json(path.join(run,'calls',part.id,'parsed.json'))};
      }
      if (!isDeepStrictEqual(assembly.patch_calls || [], (assembly.parsed_patch_sha256 || []).map((part: any) => part.id))) errors.push('Design repair provenance is incomplete');
      for (const part of assembly.parsed_patch_sha256 || []) {
        try {
          if (part.sha256 !== await fileSha(path.join(run, 'calls', part.id, 'parsed.json'))) errors.push(`Design repair changed ${part.id}`);
          const call = state.calls.find((c: any) => c.id === part.id && c.success && /^(design-corrections-|design-reference-repair-)/.test(c.stage));
          if (!call) errors.push(`Unverified design repair call ${part.id}`);
          const patch = await json(path.join(run, 'calls', part.id, 'parsed.json'));
          joined = call?.stage.startsWith('design-reference-repair-')
            ? applyDesignReferenceRepair(joined, DesignReferenceRepair.parse(patch), (await load('brief.json')).core_tasks, d.selections.map((s: any) => s.option_id))
            : applyDesignPatch(joined, DesignPatch.parse(patch));
        } catch (error) { errors.push(`Invalid design repair ${part.id}: ${String(error)}`); }
      }
      if(!isDeepStrictEqual(joined,design)) errors.push('Final design does not match actual model-generated fragments');
    }
  }
  for (const [name, saved] of Object.entries(state.stages || {}) as [string, any][]) for (const [relative, digest] of Object.entries(saved.outputs)) {
    try { if (await fileSha(inside(run, path.join(run, relative))) !== digest) errors.push(`Completed stage output changed ${name}/${relative}`); }
    catch { errors.push(`Completed stage output unavailable ${name}/${relative}`); }
  }
  if (design) {
    const manifest = await load('final/render-manifest.json');
    if (manifest?.final_design_sha256 !== sha(JSON.stringify(design))) errors.push('Rendered document source digest mismatch');
  }
  const requirements = ['program-checks.json', 'recovery-check.json', 'artifact-audit.json', 'wireframe-check.json'];
  for (const name of requirements) {
    const p = path.join(run, 'validation', name);
    if (!(await exists(p))) { errors.push(`Required independent check missing ${name}`); continue; }
    const check = await json(p); if (check.passed !== true) errors.push(`Required check failed ${name}`);
    if (name === 'artifact-audit.json') for (const app of apps) {
      const audited = check.apps?.find((x: any) => x.app_id === app.id);
      const points = audited?.points || [];
      if (audited?.spec_sha256 && audited.spec_sha256 !== await fileSha(path.join(run,'apps',app.id,'app-spec.json'))) errors.push(`Artifact audit specification changed ${app.id}`);
      if (points.length < 5 || points.filter((x: any) => x.method_level).length < 2 || points.some((x: any) => x.matches !== true)) errors.push(`Artifact audit insufficient ${app.id}`);
    }
    if (name === 'wireframe-check.json' && check.wireframe_sha256 && check.wireframe_sha256 !== await fileSha(path.join(run,'final/wireframes.html'))) errors.push('Inspected wireframe changed');
  }
  if (!state.calls?.length || state.calls.some((c: any) => c.model !== state.config.model && c.success)) errors.push('Actual model identity missing/mismatched');
  if (state.config.provider === 'codex_cli') for (const call of state.calls || []) if (call.success) {
    try {
      const dir=inside(run,path.join(run,'calls',call.id));
      const response=await json(path.join(dir,'response.json')),parsed=await json(path.join(dir,'parsed.json')),command=await json(path.join(dir,'command.json'));
      const events=(await fs.readFile(path.join(dir,'events.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
      if (response.execution.code!==0 || !response.turn_completed || response.tool_activity || response.errors.length || !events.some(e=>e.type==='turn.completed') || command.args[command.args.indexOf('--model')+1]!==state.config.model || !isDeepStrictEqual(JSON.parse(response.final_text),parsed)) errors.push(`Unverified Codex CLI result ${call.id}`);
    } catch { errors.push(`Codex CLI execution proof unavailable ${call.id}`); }
  }
  if (state.config.provider === 'claude_cli') for (const call of state.calls || []) if (call.success) {
    try {
      const dir=inside(run,path.join(run,'calls',call.id));
      const response=await json(path.join(dir,'response.json')),parsed=await json(path.join(dir,'parsed.json')),command=await json(path.join(dir,'command.json'));
      if (response.execution.code!==0 || !response.turn_completed || response.tool_activity || response.errors.length || command.args[command.args.indexOf('--model')+1]!==state.config.model || !isDeepStrictEqual(JSON.parse(response.final_text),parsed)) errors.push(`Unverified Claude Code CLI result ${call.id}`);
    } catch { errors.push(`Claude Code CLI execution proof unavailable ${call.id}`); }
  }
  const result = { passed: errors.length === 0, status: errors.length ? 'INCOMPLETE' : 'LIVE_E2E_PASSED', errors, checked_at: new Date().toISOString(), hard_conflicts: Comparison.safeParse(c).success ? c.conflicts.filter((x: any) => x.kind === 'hard_conflict').length : null };
  await write(path.join(run, 'validation/validation-report.json'), result);
  return result;
}
