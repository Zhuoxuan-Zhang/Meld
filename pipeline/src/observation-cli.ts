import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectObservation, compareObservations, replayObservation, validateObservation, rebuildReconstructionLedger, ObservationPlan } from './observation.js';
import { pipelineRoot } from './integration.js';
import { json } from './storage.js';

export async function observationCli(args: string[]) {
  const command = args.shift(), options: Record<string, string> = {};
  while (args.length) {
    const key = args.shift()!, value = args.shift();
    if (!['--plan', '--out', '--reference', '--candidate', '--design', '--model', '--provider', '--request'].includes(key) || !value) throw new Error('Invalid observation argument');
    options[key.slice(2)] = value;
  }
  const toolRoot = path.resolve(process.env.MELD_PIPELINE_TOOL_ROOT || pipelineRoot);
  if (!options.out) throw new Error('--out is required');
  const out = path.resolve(options.out);
  if (command === 'collect') {
    if (!options.plan) throw new Error('--plan is required');
    const planFile = path.resolve(options.plan), input = await json(planFile);
    input.apk = path.resolve(path.dirname(planFile), input.apk);
    return collectObservation(toolRoot, out, ObservationPlan.parse(input));
  }
  if (command === 'validate') return validateObservation(out);
  if (command === 'replay') return replayObservation(toolRoot, out);
  if (command === 'ledger') {
    if (!options.request) throw new Error('ledger requires --request with an authenticated bundle, reviewed obligations and implementation manifest');
    return rebuildReconstructionLedger(toolRoot, out, await json(path.resolve(options.request)));
  }
  if (command === 'compare') {
    if (!options.reference || !options.candidate || !options.design || !options.model) throw new Error('compare requires --reference --candidate --design --model');
    if (options.provider && !['claude_cli', 'codex_cli'].includes(options.provider)) throw new Error('Invalid visual provider');
    return compareObservations(path.resolve(options.reference), path.resolve(options.candidate), out, { provider: options.provider as 'claude_cli' | 'codex_cli' || 'claude_cli', model: options.model, reasoningEffort: 'medium' }, await json(path.resolve(options.design)));
  }
  throw new Error('Usage: npm run observe -- collect --plan plan.json --out run | validate --out run | replay --out run | compare --reference run --candidate run --design design.json --model MODEL --out comparison');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) observationCli(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(String(error)); process.exitCode = 1; });
