import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Ajv from 'ajv/dist/2020.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { inside, write, redact } from './storage.js';
import { unwrap } from './rea.js';

// This client is deliberately separate from the model-facing static whitelist.
// Device mutations can only be selected by the typed observation orchestrator.
export const investigationTools = [
  'open_binary', 'inspect_artifact', 'project_android_application_graph',
  'inspect_binary_layout', 'binary_overview', 'batch_decompile',
  'inspect_adb_device', 'inspect_adb_display', 'inspect_adb_package',
  'inspect_adb_window', 'read_adb_logcat', 'capture_adb_screen',
  'install_adb_package', 'start_adb_app', 'stop_adb_app',
  'get_evidence_bundle', 'export_evidence_bundle', 'import_evidence_bundle',
  'build_reconstruction_obligation_ledger',
] as const;
export type InvestigationTool = typeof investigationTools[number];
export type InvestigationScope = { serial?: string; apk?: string; packageName?: string; allowInstall?: boolean };

export function validateInvestigationScope(name: InvestigationTool, args: Record<string, any>, directory: string, scope: InvestigationScope) {
  if (!investigationTools.includes(name)) throw new Error('Investigation tool is not permitted');
  if (name.includes('_adb_')) {
    if (!scope.serial || args.serial !== scope.serial) throw new Error('Device serial differs from observation plan');
    if (args.package && args.package !== scope.packageName) throw new Error('Package differs from observation plan');
    if (name === 'install_adb_package' && (!scope.allowInstall || args.apk_path !== scope.apk)) throw new Error('APK install is outside observation plan');
  }
  if (name === 'open_binary' || name === 'inspect_binary_layout') {
    if (args.path !== scope.apk) inside(directory, args.path);
  }
  if (args.output_directory) inside(directory, args.output_directory);
  if (['export_evidence_bundle', 'import_evidence_bundle'].includes(name)) inside(directory, args.path);
}

export function observationAdbPath(toolRoot: string): string {
  return process.env.REA_ADB_PATH || process.env.MELD_ANDROID_ADB || path.join(toolRoot, 'tools/android-sdk/platform-tools/adb');
}

export class InvestigationClient {
  private client = new Client({ name: 'meld-reference-observation', version: '0.1.0' });
  private validators = new Map<string, any>();
  private count = 0;
  constructor(readonly toolRoot: string, readonly directory: string, readonly scope: InvestigationScope = {}) {}
  async connect() {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('REA requires Node >=22.19; use pipeline/tools/node/bin/node');
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value && !/API_KEY|ACCESS_TOKEN|AUTH_TOKEN/.test(key)) env[key] = value;
    env.REA_ADB_PATH = observationAdbPath(this.toolRoot);
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(this.toolRoot, 'vendor/rea/scripts/rea.mjs'), 'mcp'], cwd: this.toolRoot, env, stderr: 'pipe' });
    await fs.mkdir(this.directory, { recursive: true });
    let stderr = '';
    transport.stderr?.on('data', chunk => { if (stderr.length < 200000) stderr += redact(chunk.toString()); });
    try { await this.client.connect(transport); }
    catch (error) { await write(path.join(this.directory, 'rea-stderr.log'), stderr); await this.client.close().catch(() => {}); throw error; }
    const list = await this.client.listTools();
    await write(path.join(this.directory, 'tools.json'), list.tools.filter(tool => investigationTools.includes(tool.name as InvestigationTool)));
    const ajv = new (Ajv as any)({ strict: false, allErrors: true });
    for (const tool of list.tools) if (investigationTools.includes(tool.name as InvestigationTool)) this.validators.set(tool.name, ajv.compile(tool.inputSchema));
    const close = this.client.close.bind(this.client);
    this.client.close = async () => { await close(); await write(path.join(this.directory, 'rea-stderr.log'), stderr); };
  }
  async call(name: InvestigationTool, args: Record<string, any> = {}) {
    validateInvestigationScope(name, args, this.directory, this.scope);
    const validate = this.validators.get(name);
    if (!validate) throw new Error(`REA capability unavailable: ${name}`);
    if (!validate(args)) throw new Error(`Invalid ${name} request: ${JSON.stringify(validate.errors)}`);
    const prefix = path.join(this.directory, 'calls', `${String(++this.count).padStart(3, '0')}-${name}`);
    await write(prefix + '-request.json', args);
    let result: any;
    try { result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }); }
    catch (error) { result = { isError: true, error: redact(String(error)) }; }
    await write(prefix + '.json', result);
    const value = unwrap(result);
    if (result.isError || value.error) throw new Error(`REA ${name} failed: ${redact(JSON.stringify(value)).slice(0, 2000)}`);
    return value;
  }
  async close() { await this.client.close(); }
}
