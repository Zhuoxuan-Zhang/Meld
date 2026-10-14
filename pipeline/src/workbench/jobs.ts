import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { exists, json, redact, write } from '../storage.js';
import { DesignService } from './service.js';
import { withLock } from './store.js';
import { semanticHash, WorkbenchError } from './validation.js';

export type Job = { id: string; design_id: string; kind: 'propose' | 'apply' | 'restore'; change_id?: string;
  request: any; signature: string; status: 'queued' | 'running' | 'succeeded' | 'failed';
  created_at: string; updated_at: string; result?: any; error?: { code: string; message: string; status: number } };
export class DesignJobs {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private service: DesignService) {}
  directory() { return path.join(this.service.store.root, 'jobs'); }
  file(id: string) { if (!/^job-[a-f\d-]{36}$/.test(id)) throw new WorkbenchError('invalid_id', 'Invalid job ID'); return path.join(this.directory(), `${id}.json`); }
  async get(id: string): Promise<Job> {
    try { return await json(this.file(id)); } catch (e: any) { if (e.code === 'ENOENT') throw new WorkbenchError('not_found', '找不到这个任务。', 404); throw e; }
  }
  async recover() {
    await fs.mkdir(this.directory(), { recursive: true });
    for (const file of await fs.readdir(this.directory())) {
      if (!/^job-[a-f\d-]{36}\.json$/.test(file)) continue;
      const job: Job = await json(path.join(this.directory(), file));
      if (!['running', 'queued'].includes(job.status)) continue;
      const manifest = await this.service.store.manifest(job.design_id);
      const receipt = manifest.receipts[job.request.idempotency_key];
      if (job.kind !== 'propose' && receipt) {
        if (receipt.signature !== semanticHash(job.kind === 'apply' ? { changeId: job.change_id, request: job.request } : { kind: 'restore', request: job.request })) throw new Error('Job receipt signature mismatch');
        job.result = await this.service.get(job.design_id, receipt.revision); job.status = 'succeeded';
      } else if (job.kind === 'propose') {
        const dir = path.join(this.service.store.directory(job.design_id), 'proposals');
        let saved: any;
        if (await exists(dir)) for (const name of await fs.readdir(dir)) {
          if (!/^change-[a-f\d-]{36}\.json$/.test(name)) continue;
          const proposal = await json(path.join(dir, name)); if (proposal.source_job_id === job.id) saved = await this.service.proposal(job.design_id, proposal.id);
        }
        if (saved) { job.result = saved; job.status = 'succeeded'; }
        else { job.status = 'failed'; job.error = { code: 'interrupted', message: '任务被中断，原设计保持不变。请重新提交。', status: 503 }; }
      } else { job.status = 'failed'; job.error = { code: 'interrupted', message: '任务被中断，未发布新版本。请重新提交。', status: 503 }; }
      job.updated_at = new Date().toISOString(); await write(this.file(job.id), job);
    }
  }
  async submit(designId: string, kind: Job['kind'], request: any, changeId?: string) {
    await this.service.store.manifest(designId);
    return withLock(path.join(this.directory(), 'submit.lock'), async () => {
      const indexFile = path.join(this.directory(), 'index.json');
      const index = await exists(indexFile) ? await json(indexFile) : {};
      const key = `${designId}:${request.idempotency_key}`;
      const signature = semanticHash({ designId, kind, changeId: changeId || null, request });
      if (index[key]) {
        if (index[key].signature !== signature) throw new WorkbenchError('idempotency_conflict', '提交编号已经用于其他内容。', 409);
        return this.get(index[key].id);
      }
      const job: Job = { id: `job-${randomUUID()}`, design_id: designId, kind, change_id: changeId, request, signature,
        status: 'queued', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      await write(this.file(job.id), job); index[key] = { id: job.id, signature }; await write(indexFile, index);
      this.tail = this.tail.then(() => this.run(job)).catch(() => undefined);
      return job;
    }, 1000);
  }
  private async run(job: Job) {
    job.status = 'running'; job.updated_at = new Date().toISOString(); await write(this.file(job.id), job);
    try {
      job.result = await withLock<any>(path.join(this.directory(), 'worker.lock'), () => job.kind === 'propose'
        ? this.service.createProposal(job.design_id, job.request, job.id)
        : job.kind === 'apply' ? this.service.apply(job.design_id, job.change_id!, job.request) : this.service.restore(job.design_id, job.request), 1000);
      job.status = 'succeeded';
    } catch (e: any) {
      job.status = 'failed'; job.error = { code: e.code || 'model_error', message: redact(e.message || '生成失败，请重试。'), status: e.status || 502 };
    }
    job.updated_at = new Date().toISOString(); await write(this.file(job.id), job);
  }
  async idle() { await this.tail; }
}
