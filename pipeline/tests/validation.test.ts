import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateSpecData, validateDecisions, validateDesign, validateEvidence, validateComparison, validateRun } from '../src/validate.js';
import { checkApk } from '../src/resources.js';
import { renderDesign } from '../src/render.js';
import { controls } from '../src/workbench/changes.js';
import { fileSha, inside, execLogged, redact } from '../src/storage.js';

const app = { id: 'a', sha256: 'hash', package_name: 'example.a' };
const evidence: any[] = [{ id: 'a-e-1', app_id: 'a', apk_sha256: 'hash', tool: 'inspect_android_method', limitations: [] }];
const spec = () => ({ app_id: 'a', package_name: 'example.a', version: '1', apk_sha256: 'hash', static_only: true, runtime_verified: false, status: 'partial', scope: 'notes', features: [{ id: 'a-create', task: 'create', title: 'Create', claims: [{ id: 'a-claim', statement: 'Writes note', classification: 'decompiled_fact', evidence_ids: ['a-e-1'], limitations: [] }] }], pages: [], flows: [], data_structures: [], unknowns: ['Other functions not inspected'], coverage: { examined: [], omitted: [], tool_failures: [], limitations: [] } });
const comparison = (): any => ({ tasks: [{ id: 't', task: 'create', sources: [{ app_id: 'a', feature_id: 'a-create' }], common: [], differences: [], relationship: 'tradeoff', dependencies: [], unknowns: [] }], conflicts: [{ id: 'c1', question: 'Storage?', kind: 'hard_conflict', blocking: true, sources: [], options: [{ id: 'room', behavior: 'database', benefits: [], costs: [], requires_option_ids: [], incompatible_option_ids: ['files'] }, { id: 'files', behavior: 'filesystem', benefits: [], costs: [], requires_option_ids: [], incompatible_option_ids: ['room'] }] }], coverage: [] });
const decisions = () => ({ chosen_by: 'claude_proxy', selections: [{ conflict_id: 'c1', option_id: 'room', reason: 'Local entity consistency', rejected: [{ option_id: 'files', reason: 'Not selected' }], assumptions: [], sources: [] }], global_consistency: { offline: true, features_within_limit: true, navigation_within_limit: true, compatible: true, explanation: 'fixture' } });
function design(): any {
  return { title: 'Fixture only', status: 'draft', behavior_classification: 'proposed', scope: { target_users: 'test', core_tasks: ['create','edit','save','find','reopen'], included: [], excluded: [], constraints: [] }, features: [{ id: 'f', title: 'Notes', task: 'notes', behavior: 'fixture', page_ids: ['p'], flow_ids: [], sources: [], proposed_reason: 'fixture', acceptance: [{ id: 'ac', given: 'note', when: 'save', then: 'saved' }] }], entities: [], flows: [], navigation: [{ label: 'Notes', page_id: 'p', parameters: [] }], pages: [{ id: 'p', title: 'Notes', purpose: 'fixture', entries: [], components: [{ id: 'btn', parent_id: '', type: 'Button', text: 'Save', binding: '', event_ids: ['save'] }], events: [{ id: 'save', trigger: 'tap', action: 'persist', state_change: 'saved', target_page_id: '', error_recovery: 'retry' }], validation: [], states: ['normal','empty','no_results','error','delete_confirmation','unsaved_changes'].map(kind => ({ id: kind, kind, condition: 'fixture', message: '', component_ids: ['btn'], event_ids: ['save'] })), keyboard_focus: 'fixture', back_behavior: 'fixture', long_text: 'fixture', font_scaling: 'fixture', accessibility: [] }], visual: { colors: [], typography: [], spacing: [], corners: [], icons: [] }, compose: { components: [], ui_states: ['fixture'], events: [], navigation_parameters: [], repository_responsibilities: ['persist'], type_examples: [] }, decisions: ['room'], unknowns: [], assumptions: [], validation_needed: [] };
}
describe('evidence and decision risk validation (isolated fixtures)', () => {
  it('rejects missing and cross-app references', () => {
    const s=spec();s.features[0].claims[0].evidence_ids=['missing'];expect(validateSpecData(s,evidence,app).join()).toContain('Unknown evidence');
    s.features[0].claims[0].evidence_ids=['a-e-1'];expect(validateSpecData(s,[{...evidence[0],app_id:'b'}],app).join()).toContain('Cross-app');
  });
  it('rejects method facts supported only by strings', () => { expect(validateSpecData(spec(),[{...evidence[0],tool:'decode_android_resources'}],app).join()).toContain('lacks method'); });
  it('rejects empty feature output and false runtime verification', () => { const s=spec();s.features=[];expect(validateSpecData(s,evidence,app).length).toBeGreaterThan(0);expect(validateSpecData({...spec(),runtime_verified:true},evidence,app).length).toBeGreaterThan(0); });
  it('rejects unknown options and unresolved hard conflicts', () => { const d=decisions();d.selections[0].option_id='bogus';expect(validateDecisions(d,comparison(),[spec()]).join()).toContain('Invalid decision');d.selections=[];expect(validateDecisions(d,comparison(),[spec()]).join()).toContain('Unresolved blocking'); });
  it('rejects incompatible choices and missing dependencies', () => {
    const c=comparison();c.conflicts.push({...c.conflicts[0],id:'c2'});const d=decisions();d.selections.push({...d.selections[0],conflict_id:'c2',option_id:'files',rejected:[{option_id:'room',reason:'fixture'}]});expect(validateDecisions(d,c,[spec()]).join()).toContain('Incompatible selections');
    c.conflicts[0].options[0].requires_option_ids=['files'];d.selections.pop();expect(validateDecisions(d,c,[spec()]).join()).toContain('Unsatisfied dependency');
  });
  it('rejects comparisons omitting an app', () => { expect(validateComparison(comparison(),[spec(),{...spec(),app_id:'b'}]).join()).toContain('omits b'); });
  it('rejects dangling navigation and missing acceptance', () => { const d=design();expect(validateDesign(d,{max_features:5,max_navigation:3},decisions(),[])).toEqual([]);d.pages[0].events[0].target_page_id='missing';d.features[0].acceptance=[];const errors=validateDesign(d,{max_features:5,max_navigation:3},decisions(),[]).join();expect(errors).toContain('Dangling navigation');expect(errors).toContain('Missing acceptance'); });
  it('rejects actions with no result', () => { const d=design();d.pages[0].components[0].event_ids=[];expect(validateDesign(d,{max_features:5,max_navigation:3},decisions(),[]).join()).toContain('Action without result'); });
  it('detects changed evidence bytes', async () => { const root=await mkdtemp(path.join(os.tmpdir(),'mvp-test-'));const p=path.join(root,'raw.json');await writeFile(p,'{"value":1}');const e={...evidence[0],parameters:{},result_path:'raw.json',result_sha256:await fileSha(p),locator:'/value'};expect(await validateEvidence(root,[e])).toEqual([]);await writeFile(p,'{"value":2}');expect((await validateEvidence(root,[e])).join()).toContain('hash changed'); });
  it('refuses path traversal', () => { expect(()=>inside('/tmp/run','/etc/passwd')).toThrow('outside'); });
  it('rejects invalid APK and split extension', async () => { const root=await mkdtemp(path.join(os.tmpdir(),'mvp-apk-'));const p=path.join(root,'bad.apk');await writeFile(p,'not a zip');await expect(checkApk(p,path.join(root,'log.json'))).rejects.toThrow();await expect(checkApk(p+'.aab',path.join(root,'log2.json'))).rejects.toThrow('standalone'); });
  it('rejects ZIP traversal before extraction', async () => { const root=await mkdtemp(path.join(os.tmpdir(),'mvp-zip-'));const p=path.join(root,'bad.apk');await execLogged('python3',['-c',"import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('AndroidManifest.xml','m');z.writestr('classes.dex','d');z.writestr('../outside','x')",p],path.join(root,'create.json'));await expect(checkApk(p,path.join(root,'check.json'))).rejects.toThrow('Unsafe APK path'); });
});

import { Claude, parseMessage, parseResponse } from '../src/claude.js';
import { parseCodex } from '../src/codex.js';
import { report } from '../src/state.js';
import { z } from 'zod';
it('does not apply API dollar prices to ChatGPT-authenticated CLI usage', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'mvp-codex-usage-'));
  const state:any={status:'partial',stages:{},config:{provider:'codex_cli',model:'fixture',max_calls:40,pricing:{source:'subscription fixture'}},calls:[{usage:{input_tokens:1000000,output_tokens:1000}}]};
  await report(root,state);
  expect(state.usage.estimated_usd).toBeNull();
  expect(state.usage.input_tokens).toBe(1000000);
  expect(await readFile(path.join(root,'report.md'),'utf8')).toContain('subscription charge: unknown');
});
it('accepts only a completed tool-free Codex turn within the output limit (isolated CLI fixtures)', () => {
  const schema=z.object({ok:z.boolean()});
  const response={execution:{code:0},turn_completed:true,errors:[],tool_activity:false,usage:{output_tokens:12},final_text:'{"ok":true}'};
  expect(parseCodex(response,schema,20)).toEqual({ok:true});
  expect(()=>parseCodex({...response,execution:{code:1}},schema,20)).toThrow('Incomplete');
  expect(()=>parseCodex({...response,turn_completed:false},schema,20)).toThrow('Incomplete');
  expect(()=>parseCodex({...response,tool_activity:true},schema,20)).toThrow('outside');
  expect(()=>parseCodex(response,schema,10)).toThrow('token limit');
});
it('rejects truncated, refused and malformed model responses', () => {
  const schema=z.object({ok:z.boolean()});
  for(const reason of ['max_tokens','refusal','pause_turn']) expect(()=>parseMessage({stop_reason:reason,content:[{type:'text',text:'{"ok":true}'}]},schema)).toThrow('Incomplete/refused');
  expect(()=>parseMessage({stop_reason:'end_turn',content:[{type:'text',text:'{'}]},schema)).toThrow();
});

import { stopOwnedProcesses } from '../src/storage.js';
it('terminates only owned decoder children on interruption', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'mvp-owned-'));const log=path.join(root,'child.json');
  const running=execLogged(process.execPath,['-e','console.log(process.pid);setInterval(()=>{},1000)'],log,30000);
  const check=expect(running).rejects.toThrow('failed');
  setTimeout(()=>stopOwnedProcesses(),200);
  await check;
  const result=JSON.parse(await readFile(log,'utf8'));const pid=Number(result.stdout.trim());
  expect(result.signal).toBe('SIGKILL');
  if(pid) expect(()=>process.kill(pid,0)).toThrow();
});
it('rejects producer evidence from a different APK despite valid file hash', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'mvp-identity-'));const p=path.join(root,'raw.json');await writeFile(p,JSON.stringify({structuredContent:{subject:{digest:{sha256:'other-apk'}}}}));
  const e={...evidence[0],parameters:{},result_path:'raw.json',result_sha256:await fileSha(p),locator:'/structuredContent'};
  expect((await validateEvidence(root,[e])).join()).toContain('Producer APK identity mismatch');
});
it('repairs truncation without accepting it and limits repairs to two (isolated SDK fixture)', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'mvp-response-'));
  const previous=process.env.ANTHROPIC_API_KEY;process.env.ANTHROPIC_API_KEY='isolated-test-placeholder';
  try {
    const schema=z.object({ok:z.boolean()});
    const state:any={calls:[],config:{model:'fixture',max_calls:10,max_output_tokens:100}};
    const claude=new Claude(root,root,state);let responses=0;
    claude.sdk={messages:{create:async()=>({model:'fixture',stop_reason:++responses===1?'max_tokens':'end_turn',usage:{input_tokens:1,output_tokens:1},content:[{type:'text',text:'{"ok":true}'}]})}} as any;
    expect(await claude.ask('fixture','fixture only',{},schema)).toEqual({ok:true});
    expect(state.calls.map((c:any)=>c.success)).toEqual([false,true]);
    const failure:any={calls:[],config:state.config};const bounded=new Claude(root,root,failure);
    bounded.sdk={messages:{create:async()=>({model:'fixture',stop_reason:'max_tokens',content:[{type:'text',text:'{'}]})}} as any;
    await expect(bounded.ask('fixture-truncated','fixture only',{},schema)).rejects.toThrow('two repairs');
    expect(failure.calls).toHaveLength(3);expect(failure.calls.every((c:any)=>!c.success)).toBe(true);
  } finally {if(previous===undefined) delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=previous;}
});
it('reports missing outputs in a partial run without crashing or claiming zero conflicts', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'mvp-partial-'));
  const apps=[];
  for(let i=0;i<3;i++) {const id=`fixture${i}`;await mkdir(path.join(root,'apps',id),{recursive:true});const p=path.join(root,'apps',id,'input.apk');await writeFile(p,'isolated fixture bytes');apps.push({id,sha256:await fileSha(p),package_name:id});}
  await writeFile(path.join(root,'run.json'),JSON.stringify({config:{model:'fixture'},calls:[],stages:{}}));
  await writeFile(path.join(root,'apps.lock.json'),JSON.stringify(apps));
  const result=await validateRun(root);
  expect(result.passed).toBe(false);expect(result.status).toBe('INCOMPLETE');expect(result.hard_conflicts).toBe(null);
  expect(result.errors.join()).toContain('Missing/partial specification fixture0');expect(result.errors.join()).toContain('final-design.json');
});
it('redacts both provider credentials from diagnostic messages', () => {
  const priorA=process.env.ANTHROPIC_API_KEY,priorO=process.env.OPENAI_API_KEY;
  process.env.ANTHROPIC_API_KEY='anthropic-test-secret';process.env.OPENAI_API_KEY='openai-test-secret';
  try {expect(redact('anthropic-test-secret openai-test-secret openai-test-secret')).toBe('[REDACTED] [REDACTED] [REDACTED]');}
  finally {if(priorA===undefined) delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=priorA;if(priorO===undefined) delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=priorO;}
});
it('rejects incomplete and refused OpenAI structured responses (isolated fixtures)', () => {
  const schema=z.object({ok:z.boolean()});
  const response={status:'completed',output:[{type:'message',status:'completed',content:[{type:'output_text',text:'{"ok":true}'}]}]};
  expect(parseResponse(response,schema)).toEqual({ok:true});
  expect(()=>parseResponse({...response,status:'incomplete',incomplete_details:{reason:'max_output_tokens'}},schema)).toThrow('Incomplete/refused');
  expect(()=>parseResponse({...response,output:[{type:'message',status:'completed',content:[{type:'refusal',refusal:'fixture'}]}]},schema)).toThrow('Incomplete/refused');
});
it('does not retry OpenAI credit exhaustion or accept a mismatched model (isolated SDK fixtures)', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'mvp-openai-'));
  const previous=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='isolated-test-placeholder';
  try {
    const state:any={calls:[],config:{provider:'openai',model:'fixture',max_calls:10,max_output_tokens:100}};
    const client=new Claude(root,root,state);
    client.sdk={responses:{create:async()=>{throw Object.assign(new Error('No credits remaining'),{status:429,code:'credit_balance_exhausted'});}}} as any;
    await expect(client.ask('quota-fixture','fixture only',{},z.object({ok:z.boolean()}))).rejects.toThrow('No credits');
    expect(state.calls).toHaveLength(1);
    client.sdk={responses:{create:async()=>({model:'other-model',status:'completed',output:[{type:'message',status:'completed',content:[{type:'output_text',text:'{"ok":true}'}]}]})}} as any;
    await expect(client.ask('identity-fixture','fixture only',{},z.object({ok:z.boolean()}))).rejects.toThrow('Unexpected model');
    expect(state.calls.every((c:any)=>!c.success)).toBe(true);
  } finally {if(previous===undefined) delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;}
});
it('validates fallback method text against the retained disassembled class bytes', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'mvp-smali-'));
  const body='.method public final h()V\n return-void\n.end method';
  await writeFile(path.join(root,'class.smali'),'.class Lfixture;\n'+body);
  const raw={apk_sha256:'hash',class_name:'fixture',method_name:'h',raw_class_path:'class.smali',raw_class_sha256:await fileSha(path.join(root,'class.smali')),method_text:body};
  await writeFile(path.join(root,'method.json'),JSON.stringify(raw));
  const e={...evidence[0],tool:'apktool_smali_method',parameters:{class_name:'fixture',method_name:'h'},result_path:'method.json',result_sha256:await fileSha(path.join(root,'method.json')),locator:'/method_text'};
  expect(await validateEvidence(root,[e])).toEqual([]);
  await writeFile(path.join(root,'class.smali'),'.class Ldifferent;');
  expect((await validateEvidence(root,[e])).join()).toContain('Invalid derived smali');
});

it('validates game tasks and required states from the brief without inventing notes behavior', () => {
  const d = design(); d.scope.core_tasks = ['play', 'save', 'resume'];
  d.pages[0].states = d.pages[0].states.filter((s: any) => ['normal', 'error'].includes(s.kind));
  const brief = { max_features: 5, max_navigation: 3, core_tasks: ['play', 'save', 'resume'], required_states: ['normal', 'error'] };
  expect(validateDesign(d, brief, decisions(), [spec()])).toEqual([]);
  d.scope.core_tasks = ['save', 'resume'];
  expect(validateDesign(d, brief, decisions(), [spec()])).toContain('Missing core task play');
});

it('renders game palettes and accent controls without inherited notes context', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'game-render-'));
  const d = design(); d.title = 'Puzzle Harbor';
  d.visual.colors = [{ role: 'Light background', value: '#F7F8FA' }, { role: 'Light text', value: '#18212B' }, { role: 'Light primary and focus', value: '#2357C6' }, { role: 'Light on-primary', value: '#FFFFFF' }];
  await renderDesign(dir, d);
  const html = await readFile(path.join(dir, 'wireframes.html'), 'utf8');
  expect(html).toContain('--accent:#2357C6');
  expect(html).not.toContain('normal · Notes');
  expect(controls({ design: d, brief: {}, decisions: { selections: [] } } as any).find(control => control.id === 'primary-color')?.value).toBe('#2357C6');
});
