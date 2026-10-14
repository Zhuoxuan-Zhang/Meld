import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { exists, fileSha, json, write } from '../storage.js';
import { RevisionData, UserDocument, type RevisionDataT, type UserDocumentT } from './schemas.js';
import { semanticHash, WorkbenchError } from './validation.js';

export async function acquireLock(lock: string, waitMs = 0): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const token = randomUUID(); const deadline = Date.now() + waitMs;
  while (true) {
    try {
      const handle = await fs.open(lock, 'wx');
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, created_at: Date.now() })); } finally { await handle.close(); }
      break;
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = await json(lock);
        try { process.kill(owner.pid, 0); } catch (probe: any) { if (probe.code === 'ESRCH') { await fs.unlink(lock); continue; } }
      } catch (read: any) { if (read.code === 'ENOENT') continue; }
      if (Date.now() >= deadline) throw new WorkbenchError('busy', '设计正在处理中，请稍后重试。', 423);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  return async () => {
    try { if ((await json(lock)).token === token) await fs.unlink(lock); } catch {}
  };
}
export async function withLock<T>(lock: string, action: () => Promise<T>, waitMs = 0): Promise<T> {
  const release = await acquireLock(lock, waitMs);
  try { return await action(); } finally { await release(); }
}
export type RevisionRecord = {
  id: string; version: number; parent_revision: string | null; created_at: string;
  kind: 'import' | 'change' | 'restore'; change_id: string | null; selected_change_ids: string[];
  data_hash: string; semantic_hash: string; files: Record<string, string>; changed_features: string[];
  authorship: { actor: 'imported_llm' | 'user'; request: string; scope: string };
};
export type Manifest = {
  id: string; current_revision: string; revisions: RevisionRecord[];
  receipts: Record<string, { signature: string; revision: string }>;
  implementation: { revision: string; semantic_hash: string; source_sha256: string; app_name: string } | null;
};
export class DesignStore {
  constructor(public root: string) {}
  directory(id: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id)) throw new WorkbenchError('invalid_id', 'Invalid design ID');
    return path.join(this.root, id);
  }
  async assertDirectory(id: string) {
    try { if ((await fs.lstat(this.directory(id))).isSymbolicLink()) throw new WorkbenchError('invalid_path', 'Workspace symlinks are not allowed'); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  async manifest(id: string): Promise<Manifest> {
    await this.assertDirectory(id);
    try { return await json(path.join(this.directory(id), 'manifest.json')); }
    catch (error: any) { if (error.code === 'ENOENT') throw new WorkbenchError('not_found', '找不到这个设计。', 404); throw error; }
  }
  async source(id: string): Promise<any> {
    await this.assertDirectory(id);
    const dir = path.join(this.directory(id), 'source');
    const meta = await json(path.join(dir, 'source.json'));
    for (const [name, digest] of Object.entries(meta.files)) if (await fileSha(path.join(dir, name)) !== digest) throw new WorkbenchError('source_changed', `Imported source changed: ${name}`, 409);
    return { ...meta, comparison: await json(path.join(dir, 'comparison.json')), specs: await json(path.join(dir, 'specs.json')) };
  }
  async revision(id: string, revision?: string) {
    const manifest = await this.manifest(id);
    const record = manifest.revisions.find(r => r.id === (revision || manifest.current_revision));
    if (!record) throw new WorkbenchError('not_found', '找不到这个版本。', 404);
    const dir = path.join(this.directory(id), 'revisions', record.id);
    for (const [name, hash] of Object.entries(record.files)) {
      const target = path.join(dir, name);
      if ((await fs.lstat(target)).isSymbolicLink() || await fileSha(target) !== hash) throw new WorkbenchError('revision_changed', '已保存版本的内容发生变化，已停止读取。', 409);
    }
    const data = RevisionData.parse(await json(path.join(dir, 'developer-design.json')));
    const document = UserDocument.parse(await json(path.join(dir, 'user-doc.json')));
    if (semanticHash(data) !== record.data_hash) throw new WorkbenchError('revision_changed', 'Revision data hash mismatch', 409);
    return { manifest, record, dir, data, document };
  }
  async commit(id: string, expected: string | null, requestKey: string, signature: string,
    prepare: (dir: string, record: RevisionRecord) => Promise<void>, record: Omit<RevisionRecord, 'id' | 'version' | 'parent_revision' | 'created_at' | 'files'>,
    implementation?: Manifest['implementation']): Promise<string> {
    return withLock(path.join(this.directory(id), 'commit.lock'), async () => {
      const manifestPath = path.join(this.directory(id), 'manifest.json');
      const manifest: Manifest = await exists(manifestPath) ? await json(manifestPath) : { id, current_revision: '', revisions: [], receipts: {}, implementation: null };
      const receipt = manifest.receipts[requestKey];
      if (receipt) {
        if (receipt.signature !== signature) throw new WorkbenchError('idempotency_conflict', '同一次提交不能使用不同的修改内容。', 409);
        return receipt.revision;
      }
      if ((manifest.current_revision || null) !== expected) throw new WorkbenchError('stale_revision', '设计已有更新，请查看最新版本后重新提交。', 409);
      const version = manifest.revisions.length + 1;
      const revision = `v${String(version).padStart(4, '0')}-${randomUUID().slice(0, 8)}`;
      const complete: RevisionRecord = { ...record, id: revision, version, parent_revision: expected, created_at: new Date().toISOString(), files: {} };
      const staging = path.join(this.directory(id), 'revisions', `.staging-${revision}`);
      await fs.mkdir(staging, { recursive: true });
      await prepare(staging, complete);
      for (const name of await fs.readdir(staging)) complete.files[name] = await fileSha(path.join(staging, name));
      await fs.rename(staging, path.join(this.directory(id), 'revisions', revision));
      manifest.current_revision = revision;
      manifest.revisions.push(complete);
      manifest.receipts[requestKey] = { signature, revision };
      if (implementation) manifest.implementation = { ...implementation, revision };
      // Publication and idempotency receipt are one atomic pointer update.
      // A crash before this write leaves an unreferenced, invisible revision directory.
      await write(manifestPath, manifest);
      return revision;
    });
  }
}
