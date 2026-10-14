import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Ajv from 'ajv/dist/2020.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { write, sha, inside, redact, exists } from './storage.js';
import type { EvidenceT } from './schemas.js';
export const allowedTools = ['inspect_android_package', 'search_android_classes', 'inspect_android_class', 'inspect_android_method', 'trace_android_references', 'inspect_apktool_client', 'decode_android_resources'];

export class Rea {
  client = new Client({ name: 'apk-design-mvp', version: '0.1.0' });
  schemas = new Map<string, any>();
  validators = new Map<string, any>();
  transport?: StdioClientTransport;
  constructor(public root: string, public run: string, public timeout: number) {}
  async connect() {
    const connectionId = Date.now();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v && !['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'].includes(k)) env[k] = v;
    this.transport = new StdioClientTransport({ command: process.execPath, args: [path.join(this.root, 'vendor/rea/scripts/rea.mjs'), 'mcp'], cwd: this.root, env, stderr: 'pipe' });
    await fs.mkdir(path.join(this.run, 'setup'), { recursive: true });
    let stderr = '';
    this.transport.stderr?.on('data', b => { stderr += redact(b.toString()); });
    await this.client.connect(this.transport);
    const list = await this.client.listTools();
    await write(path.join(this.run, `setup/tools-list-${connectionId}.json`), list);
    if (!await exists(path.join(this.run, 'setup/tools-list.json'))) await write(path.join(this.run, 'setup/tools-list.json'), list);
    const ajv = new (Ajv as any)({ strict: false, allErrors: true });
    for (const t of list.tools) if (allowedTools.includes(t.name)) {
      this.schemas.set(t.name, t.inputSchema); this.validators.set(t.name, ajv.compile(t.inputSchema));
    }
    for (const name of allowedTools) if (!this.schemas.has(name)) throw new Error(`REA did not advertise ${name}`);
    const close = this.client.close.bind(this.client);
    this.client.close = async () => { await close(); await write(path.join(this.run, `setup/rea-stderr-${connectionId}.log`), stderr); };
  }
  async call(name: string, parameters: any, app: any, dest: string): Promise<{ evidence: EvidenceT; result: any }> {
    if (!this.validators.has(name)) throw new Error(`Tool not permitted: ${name}`);
    if (parameters.path) {
      const p = inside(this.run, parameters.path);
      if (p !== app.path) throw new Error('REA may only read the selected APK');
    }
    if (!this.validators.get(name)(parameters)) throw new Error(`Invalid ${name} parameters: ${JSON.stringify(this.validators.get(name).errors)}`);
    let result: any;
    try { result = await this.client.callTool({ name, arguments: parameters }, undefined, { timeout: this.timeout }); }
    catch (e) { result = { isError: true, error: redact(String(e)) }; }
    await write(dest, result);
    const bytes = await fs.readFile(dest);
    const evidence: EvidenceT = { id: `${app.id}-e-${sha(path.relative(this.run, dest)).slice(0, 12)}`, app_id: app.id, apk_sha256: app.sha256, tool: name, parameters, result_path: path.relative(this.run, dest), result_sha256: sha(bytes), locator: '/', limitations: result.isError ? ['Tool failed; this response does not support positive claims.'] : ['Static analysis only; decompiled text is derived, not original source.'] };
    return { evidence, result };
  }
  async close() { await this.client.close(); }
}
export function unwrap(result: any): any {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n');
  try { return JSON.parse(text); } catch { return { text, isError: result.isError, error: result.error }; }
}
