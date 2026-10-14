import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
const ownedProcesses = new Set<ChildProcess>();
export function trackOwnedProcess(child: ChildProcess) {
  ownedProcesses.add(child);
  return () => ownedProcesses.delete(child);
}
export function stopOwnedProcesses() { for (const child of ownedProcesses) child.kill('SIGKILL'); }

export const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const fileSha = async (p: string) => sha(await fs.readFile(p));
export async function json(p: string): Promise<any> { return JSON.parse(await fs.readFile(p, 'utf8')); }
export async function write(p: string, value: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  await fs.rename(tmp, p);
}
export async function exists(p: string) { return fs.access(p).then(() => true, () => false); }
export function inside(root: string, p: string) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path outside permitted root: ${p}`);
  return path.resolve(p);
}
export async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isSymbolicLink()) throw new Error(`Symlink not permitted in artifacts: ${p}`);
    if (e.isDirectory()) result.push(...await files(p)); else result.push(p);
  }
  return result;
}
export function redact(s: string) {
  for (const key of [process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY]) if (key) s = s.split(key).join('[REDACTED]');
  return s;
}
export async function execLogged(command: string, args: string[], log: string, timeout = 180000, maxBytes = 8 * 1024 * 1024, inspect?: () => Promise<void>) {
  const started = Date.now();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    ownedProcesses.add(child);
    let stdout = '', stderr = '', exceeded = false, timedOut = false, guardError = '';
    let inspecting = false;
    const guardTimer = inspect ? setInterval(async () => {
      if (inspecting) return; inspecting = true;
      try { await inspect(); } catch (e) { guardError = redact(String(e)); child.kill('SIGKILL'); }
      finally { inspecting = false; }
    }, 1000) : undefined;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    const collect = (which: 'out' | 'err', b: Buffer) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + b.length > maxBytes) {
        exceeded = true; child.kill('SIGKILL'); return;
      }
      if (which === 'out') stdout += b.toString(); else stderr += b.toString();
    };
    child.stdout.on('data', b => collect('out', b)); child.stderr.on('data', b => collect('err', b));
    child.on('error', async e => { clearTimeout(timer); clearInterval(guardTimer); ownedProcesses.delete(child); await write(log, { command, args, error: redact(e.message) }); reject(e); });
    child.on('close', async (code, signal) => {
      clearTimeout(timer); clearInterval(guardTimer); ownedProcesses.delete(child);
      await write(log, { command, args, stdout: redact(stdout), stderr: redact(stderr), code, signal, timedOut, exceeded, guardError, elapsed_ms: Date.now() - started });
      if (code !== 0 || timedOut || exceeded || guardError) reject(new Error(`${command} failed (code ${code}, timeout ${timedOut}, output limit ${exceeded}): ${guardError || redact(stderr).slice(-1500)}`));
      else resolve(stdout);
    });
  });
}
