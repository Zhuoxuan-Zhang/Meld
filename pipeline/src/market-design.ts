import path from 'node:path';
import { resumeMarketDesignBudget } from './model-recovery.js';
import { promises as fs } from 'node:fs';
import { Claude } from './claude.js';
import { synthesize } from './design.js';
import { validateSpecData, validateEvidence, validateDesign, validateComparison, validateDecisions } from './validate.js';
import { exists, json, write, fileSha, sha } from './storage.js';
import { pipelineRoot } from './integration.js';

// A proposed product design from store signals and any validated APK analyses.
// This runner never manufactures APK identities or static/runtime verification.
async function execute() {
  const options: Record<string, string> = {};
  const args = process.argv.slice(2);
  while (args.length) { const name = args.shift()!; const value = args.shift(); if (!['--run', '--brief', '--market', '--config', '--static-run'].includes(name) || !value) throw new Error('Invalid market-design argument'); options[name.slice(2)] = value; }
  const run = path.resolve(options.run), brief = await json(options.brief), config = await json(options.config), market = await json(options.market);
  const specs: any[] = [], locks: any[] = [], provenance: any[] = [];
  if (options['static-run'] && await exists(path.join(options['static-run'], 'run.json'))) {
    const source = path.resolve(options['static-run']), state = await json(path.join(source, 'run.json'));
    if (await exists(path.join(source, 'apps.lock.json'))) for (const app of await json(path.join(source, 'apps.lock.json'))) {
      if (!state.stages?.[`analyze-${app.id}`]) continue;
      const specFile = path.join(source, 'apps', app.id, 'app-spec.json'), evidenceFile = path.join(source, 'apps', app.id, 'evidence.json');
      const spec = await json(specFile), evidence = await json(evidenceFile);
      for (const [relative, digest] of Object.entries(state.stages[`analyze-${app.id}`].outputs)) if (await fileSha(path.join(source, relative)) !== digest) throw new Error('Completed APK analysis changed; preserve the original run');
      const errors = [...validateSpecData(spec, evidence, app), ...await validateEvidence(source, evidence)];
      if (errors.length) throw new Error('Completed APK evidence is invalid: ' + errors.join('; '));
      specs.push(spec); locks.push(app); provenance.push({ app_id: app.id, package_name: app.package_name, source_run: source, spec_sha256: await fileSha(specFile), evidence_sha256: await fileSha(evidenceFile) });
    }
  }
  const identity = sha(JSON.stringify({ brief, market, specs, config }));
  await fs.mkdir(run, { recursive: true });
  let state: any;
  if (await exists(path.join(run, 'run.json'))) { state = resumeMarketDesignBudget(await json(path.join(run, 'run.json')), { brief, market, specs, config }); }
  else state = { id: path.basename(run), mode: 'market_assisted_design', status: 'running', created_at: new Date().toISOString(), config, stages: {}, calls: [], fingerprint: { digest: identity }, human_decisions: !brief.market_signals?.approved_high_level };
  if (state.status === 'failed') await write(path.join(run, 'synthesis', `failed-state-${Date.now()}.json`), state);
  state.status = 'running'; delete state.error;
  await write(path.join(run, 'brief.json'), brief); await write(path.join(run, 'apps.lock.json'), locks);
  await write(path.join(run, 'market-input.json'), market); await write(path.join(run, 'static-source-provenance.json'), provenance);
  for (const spec of specs) await write(path.join(run, 'apps', spec.app_id, 'app-spec.json'), spec);
  await write(path.join(run, 'run.json'), state);
  const model = new Claude(pipelineRoot, run, state);
  try {
    if (await synthesize(run, state, model, brief, specs) === 'waiting_user') { state.status = 'waiting_user'; return; }
    const design = await json(path.join(run, 'final/final-design.json')), comparison = await json(path.join(run, 'synthesis/comparison.json')), decisions = await json(path.join(run, 'synthesis/decisions.json'));
    const errors = [...validateDesign(design, brief, decisions, specs), ...validateComparison(comparison, specs), ...validateDecisions(decisions, comparison, specs)];
    await write(path.join(run, 'validation/market-design.json'), { passed: !errors.length, classification: 'market_assisted_design', errors, verified_apk_packages: locks.map(app => app.package_name), listing_packages: market.reference_apps.map((app: any) => app.appId).filter((id: string) => !locks.some(app => app.package_name === id)), limitations: ['Proposed product design. Unavailable or incomplete APK references use store signals and user requests only. Reference runtime behavior is not verified. This is not an APK end-to-end validation result.'] });
    if (errors.length) throw new Error(errors.join('; ')); state.status = 'DESIGN_PASSED';
  } catch (error) { state.status = 'failed'; state.error = String(error); throw error; }
  finally { await write(path.join(run, 'run.json'), state); }
}
execute().catch(error => { console.error(String(error)); process.exitCode = 1; });
