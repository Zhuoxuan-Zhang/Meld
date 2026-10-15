import path from 'node:path';
import { promises as fs } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { Claude } from './claude.js';
import { Comparison, Decisions, UnifiedDesign, Review } from './schemas.js';
import { write, json, sha, fileSha, exists } from './storage.js';
import { validateComparison, validateDecisions, validateDesign } from './validate.js';
import { renderDesign } from './render.js';
import { stage } from './state.js';
import { DesignPatch, applyDesignPatch } from './design-patch.js';
import { zodTextFormat } from 'openai/helpers/zod';
const DesignCore=UnifiedDesign.omit({pages:true,visual:true,compose:true});
const DesignPages=UnifiedDesign.pick({pages:true});
const DesignContracts=UnifiedDesign.pick({visual:true,compose:true});
const DesignTargetSchema = zodTextFormat(UnifiedDesign, 'design').schema;

async function acceptFragments(run: string, state: any, design: any, review: any, fragmentCalls: string[], patchCalls: string[] = []) {
  const dir = path.join(run, 'synthesis');
  await write(path.join(dir, 'design-review.json'), review);
  await write(path.join(run, 'final/final-design.json'), design); await renderDesign(path.join(run, 'final'), design);
  await write(path.join(dir, 'design-assembly.json'), { provider: 'codex_cli', mode: 'model schema fragments and recorded targeted repairs, followed by whole-design auxiliary review', fragment_calls: fragmentCalls, patch_calls: patchCalls, parsed_patch_sha256: await Promise.all(patchCalls.map(async id => ({ id, sha256: await fileSha(path.join(run, 'calls', id, 'parsed.json')) }))), parsed_fragment_sha256: await Promise.all(fragmentCalls.map(async id => ({ id, sha256: await fileSha(path.join(run, 'calls', id, 'parsed.json')) }))), final_design_sha256: sha(JSON.stringify(design)), review_call: state.calls.at(-1).id, fields_generated_by_model: true, templates_used: false });
}

async function codexDesign(run:string,state:any,model:Claude,base:any,comparison:any,decisions:any){
  const dir=path.join(run,'synthesis'),prompt=await model.prompt('design');
  let prior:any=null,review:any=null,priorFragmentCalls:string[]=[],priorPatchCalls:string[]=[];
  // A rejected large response may be evidence for a repair, never the accepted final output.
  for(const call of [...state.calls].reverse()) if(call.stage.startsWith('design')&&call.stage!=='design-review-0'){
    try{const response=await json(path.join(run,'calls',call.id,'response.json'));if(response.turn_completed&&response.final_text){const p=UnifiedDesign.safeParse(JSON.parse(response.final_text));if(p.success){prior=p.data;break;}}}catch{}
  }
  let startRound = 0;
  const drafts = (await fs.readdir(dir)).filter(name => /^(fragment|patched)-design-\d+-\d+\.json$/.test(name)).sort((a, b) => Number(b.match(/-(\d+)\.json$/)![1]) - Number(a.match(/-(\d+)\.json$/)![1]));
  if (drafts.length) {
    const name = drafts[0], kind = name.split('-')[0], round = Number(name.match(/^(?:fragment|patched)-design-(\d+)/)![1]);
    const validationName = name.replace(`${kind}-design-`, `${kind}-validation-`);
    // Timestamps can differ by milliseconds; match the same round's latest record.
    const validations = (await fs.readdir(dir)).filter(file => file.startsWith(`${kind}-validation-${round}-`)).sort((a, b) => Number(b.match(/-(\d+)\.json$/)![1]) - Number(a.match(/-(\d+)\.json$/)![1]));
    const saved = UnifiedDesign.parse(await json(path.join(dir, name)));
    const record = await json(path.join(dir, validations[0] || validationName));
    let joined: any = {};
    if (record.fragment_calls?.length !== 3) throw new Error('Draft fragment provenance is incomplete');
    for (const id of record.fragment_calls) {
      if (!state.calls.some((call: any) => call.id === id && call.success && /^design-(core|pages|contracts)-/.test(call.stage))) throw new Error('Draft fragment call is not verified');
      joined = { ...joined, ...await json(path.join(run, 'calls', id, 'parsed.json')) };
    }
    for (const id of record.patch_calls || []) {
      if (!state.calls.some((call: any) => call.id === id && call.success && call.stage.startsWith('design-corrections-'))) throw new Error('Draft repair call is not verified');
      joined = applyDesignPatch(joined, DesignPatch.parse(await json(path.join(run, 'calls', id, 'parsed.json'))));
    }
    if (!isDeepStrictEqual(joined, saved)) throw new Error('Saved draft differs from its actual model fragments');
    const reviews = (await fs.readdir(dir)).filter(file => file.startsWith(`${kind}-review-${round}-`)).sort((a, b) => Number(b.match(/-(\d+)\.json$/)![1]) - Number(a.match(/-(\d+)\.json$/)![1]));
    prior = saved; priorFragmentCalls = record.fragment_calls; priorPatchCalls = record.patch_calls || []; review = reviews.length ? await json(path.join(dir, reviews[0])) : null; startRound = round + 1;
  }
  if (prior) {
    const errors = validateDesign(prior, base.brief, decisions, base.specs);
    // A completed saved draft may only need its interrupted review. Its three
    // model fragments were checked above; require a fresh review before reuse.
    if (!errors.length && priorFragmentCalls.length === 3 && prior.status === 'final' && !review?.issues.some((i: any) => i.severity === 'blocking')) {
      review = await model.ask(`design-review-resumed-${startRound}`, await model.prompt('review'), { kind: 'unified-design', ...base, comparison, decisions, design: prior, program_errors: [] }, Review);
      await write(path.join(dir, `resumed-review-${Date.now()}.json`), review);
      if (review.passed && !review.issues.some((i: any) => i.severity === 'blocking')) { await acceptFragments(run, state, prior, review, priorFragmentCalls, priorPatchCalls); return; }
    }
    review = review || { passed: false, issues: [], limitations: [] };
    review.issues.push(...errors.map(issue => ({ severity: 'blocking', location: 'program validation', issue, correction: 'Correct this requirement in the next fragments.' })));
  }
  for(let round=startRound;round<startRound+3;round++){
    const before=state.calls.length;
    let design: any, fragmentCalls: string[], patchCalls: string[] = [], kind = 'fragment';
    if (prior && priorFragmentCalls.length === 3) {
      const patch = await model.ask(`design-corrections-${round}`, prompt + '\nRepair only the supplied review findings with narrow replacements of existing JSON fields. path is relative to the design root, such as ["features","0","behavior"] or ["pages","1","back_behavior"]. For arrays of objects with id fields, use the item id instead of its numeric index, for example ["pages","page-editor","back_behavior"]. This avoids editing a neighboring item. Do not include the context key prior_design. For string fields use format=text and a plain value without JSON quoting. Use format=json only for objects, arrays, numbers, booleans or null; value must then be valid JSON. To append an array item, use - as the final path segment, for example ["pages","page-editor","states","-"]. To remove or reorder items, replace the containing array. Do not leave index gaps. Preserve all unrelated fields, IDs, copy, scope and accepted behavior exactly. Apply each correction consistently across relevant entities, flows, pages, states, contracts and acceptance cases. All replacement values must satisfy target_schema, including its enums and required fields. Every response must be a complete corrected patch against the unchanged supplied prior_design. Failed patches are atomic: none of their edits have been applied. On a retry, include every still-needed edit and append from the previous attempt, not just the fixes to its errors. Do not redesign the app or return the full design.', { ...base, comparison, decisions, prior_design: prior, review, target_schema: DesignTargetSchema }, DesignPatch, value => {
        try { return validateDesign(applyDesignPatch(prior, value), base.brief, decisions, base.specs); } catch (error) { return [String(error)]; }
      });
      design = applyDesignPatch(prior, patch); kind = 'patched'; fragmentCalls = priorFragmentCalls;
      patchCalls = [...priorPatchCalls, ...state.calls.slice(before).filter((c: any) => c.success && c.stage === `design-corrections-${round}`).map((c: any) => c.id)];
    } else {
    const core=await model.ask(`design-core-${round}`,prompt+'\nThis request generates only the core fragment named by the output schema. Do not emit pages, visual or compose here. Keep it concise; the next calls fill those fields.',{...base,comparison,decisions,prior_design:prior,review,fragment:'core',instruction:'Preserve all unchanged fields, IDs and established domain rules from the prior draft; apply only review corrections. Keep all chosen option IDs exact. Define at most eight page IDs across navigation/features/flows. Preserve complete core flows, entities and acceptance. Aim for 3000 tokens.'},DesignCore);
    const pages=await model.ask(`design-pages-${round}`,prompt+'\nGenerate only the pages fragment specified by this output schema. Core fields are already supplied. Do not re-emit them.',{brief:base.brief,decisions,core,prior_pages:prior?.pages,review,fragment:'pages',instruction:'Preserve accepted page behavior and IDs; apply only review corrections. Cover every referenced page ID, applicable states, event outcomes, back/cancel/error recovery, keyboard and accessibility. Use short clauses; aim for 4000 tokens.'},DesignPages);
    const contracts=await model.ask(`design-contracts-${round}`,prompt+'\nGenerate only visual and compose fields named by this output schema. Do not re-emit core or pages.',{brief:base.brief,decisions,core,pages:pages.pages,prior_contracts:prior?{visual:prior.visual,compose:prior.compose}:null,review,fragment:'contracts',instruction:'Preserve accepted visual tokens and contracts; apply only review corrections. Match entity names and page/event IDs exactly. Include actionable repositories, UiState/event/navigation contracts and short Kotlin examples. Define conflict/pending recovery from the pages. Aim for 2000 tokens.'},DesignContracts);
    fragmentCalls=state.calls.slice(before).filter((c:any)=>c.success).map((c:any)=>c.id);
    design=UnifiedDesign.parse({...core,...pages,...contracts});
    }
    const errors=validateDesign(design,base.brief,decisions,base.specs);
    await write(path.join(dir,`${kind}-design-${round}-${Date.now()}.json`),design);
    await write(path.join(dir,`${kind}-validation-${round}-${Date.now()}.json`),{passed:!errors.length,errors,fragment_calls:fragmentCalls,patch_calls:patchCalls});
    review=await model.ask(`design-review-${kind}-${round}`,await model.prompt('review'),{kind:'unified-design',...base,comparison,decisions,design,program_errors:errors},Review);
    await write(path.join(dir,`${kind}-review-${round}-${Date.now()}.json`),review);
    if(!errors.length&&review.passed&&!review.issues.some((i:any)=>i.severity==='blocking')&&design.status==='final'){
      await acceptFragments(run, state, design, review, fragmentCalls, patchCalls);
      return;
    }
    prior=design;priorFragmentCalls=fragmentCalls;priorPatchCalls=patchCalls;review.issues.push(...errors.map(error=>({severity:'blocking',location:'program validation',issue:error,correction:'Fix referenced IDs, bounds and required mappings in the next fragments.'})));
  }
  throw new Error('Design remains draft after two targeted repairs');
}
export async function synthesize(run: string, state: any, claude: Claude, brief: any, specs: any[]) {
  const base = { brief, specs };
  const dir = path.join(run, 'synthesis');
  let comparison: any, decisions: any;
  await stage(run, state, 'compare', ['synthesis/comparison.json'], async () => {
    comparison = await claude.ask('compare', await claude.prompt('compare'), base, Comparison, c => validateComparison(c, specs));
    await write(path.join(dir, 'comparison.json'), comparison); await write(path.join(dir, 'conflicts.json'), comparison.conflicts);
  }, async () => validateComparison(await json(path.join(dir, 'comparison.json')), specs));
  comparison = await json(path.join(dir, 'comparison.json'));
  if (state.human_decisions && comparison.conflicts.length && !(await exists(path.join(run, 'human-decisions.json')))) return 'waiting_user';
  await stage(run, state, 'decide', ['synthesis/decisions.json'], async () => {
    if (state.human_decisions) {
      decisions = comparison.conflicts.length ? Decisions.parse(await json(path.join(run, 'human-decisions.json'))) : {
        chosen_by: 'user', selections: [], global_consistency: { offline: true, features_within_limit: true, navigation_within_limit: true, compatible: true, explanation: 'No source-app conflicts require a user choice.' },
      };
      if (decisions.chosen_by !== 'user') throw new Error('User choices are required for this run');
      const errors = validateDecisions(decisions, comparison, specs); if (errors.length) throw new Error(errors.join('; '));
      await write(path.join(dir, 'decisions.json'), decisions); return;
    }
    const chosen_by = claude.provider === 'codex_cli' ? 'codex_proxy' : claude.provider === 'openai' ? 'openai_proxy' : 'claude_proxy';
    decisions = await claude.ask('decide', await claude.prompt('decide'), { ...base, comparison, chosen_by }, Decisions, d => [...validateDecisions(d, comparison, specs), ...(d.chosen_by === chosen_by ? [] : ['Decision provider identity mismatch'])]);
    await write(path.join(dir, 'decisions.json'), decisions);
  }, async () => validateDecisions(await json(path.join(dir, 'decisions.json')), comparison, specs));
  decisions = await json(path.join(dir, 'decisions.json'));
  await stage(run, state, 'design', ['final/final-design.json', 'final/design.md', 'final/wireframes.html', 'synthesis/design-review.json'], async () => {
    if(claude.provider==='codex_cli'){await codexDesign(run,state,claude,base,comparison,decisions);return;}
    let design: any = await claude.ask('design', await claude.prompt('design'), { ...base, comparison, decisions }, UnifiedDesign, d => validateDesign(d, brief, decisions, specs));
    await write(path.join(dir, `design-draft-${Date.now()}.json`), design);
    let review: any;
    for (let round = 0; round < 3; round++) {
      review = await claude.ask(`design-review-${round}`, await claude.prompt('review'), { kind: 'unified-design', ...base, comparison, decisions, design }, Review);
      await write(path.join(dir, `design-review-${Date.now()}.json`), review);
      if (review.passed && !review.issues.some((i: any) => i.severity === 'blocking')) break;
      if (round === 2) { design.status = 'draft'; break; }
      design = await claude.ask(`design-repair-${round}`, await claude.prompt('design'), { ...base, comparison, decisions, prior_design: design, review }, UnifiedDesign, d => validateDesign(d, brief, decisions, specs));
      await write(path.join(dir, `design-draft-${Date.now()}.json`), design);
    }
    await write(path.join(dir, 'design-review.json'), review);
    await write(path.join(run, 'final/final-design.json'), design); await renderDesign(path.join(run, 'final'), design);
    if (design.status !== 'final') throw new Error('Design remains draft after two targeted review repairs');
  }, async () => validateDesign(await json(path.join(run, 'final/final-design.json')), brief, decisions, specs));
}
