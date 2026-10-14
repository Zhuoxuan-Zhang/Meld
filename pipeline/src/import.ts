import path from 'node:path';
import { parseArgs } from 'node:util';
import { DesignService, pipelineRoot, json } from './integration.js';
const { values } = parseArgs({ options: { run: { type: 'string' }, id: { type: 'string', default: 'notes' }, root: { type: 'string', default: '../frontend/.meld-cache/designs' }, implementation: { type: 'string' }, screenshots: { type: 'string' } } });
if (!values.run) throw new Error('Use --run /path/to/analyzed-run [--implementation source-design.json]');
const service = new DesignService(pipelineRoot, path.resolve(values.root!));
const result = await service.initialize(values.id!, path.resolve(values.run), await json(path.join(pipelineRoot, 'config/runtime.workbench.json')), values.implementation && path.resolve(values.implementation), values.screenshots && path.resolve(values.screenshots));
console.log(JSON.stringify({ id: result.id, revision: result.revision, implementation: result.implementation }, null, 2));
