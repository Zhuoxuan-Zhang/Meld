import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Review } from '../schemas.js';
import { exists, fileSha, json, write } from '../storage.js';
import { ChangePlan, UserDocument, RevisionData, type ChangePlanT, type RevisionDataT, type UserDocumentT, type ChangeRequestT, type ApplyRequestT } from './schemas.js';
import { applyOperations, controls, describeEdits, planErrors, selectedOperations } from './changes.js';
import { DesignStore, withLock, type RevisionRecord } from './store.js';
import { LiveDesignModel, type DesignModel } from './model.js';
import { changedFeatures, designErrors, readableErrors, resolveRefs, semanticHash, WorkbenchError } from './validation.js';
import { renderDocuments, screenshotFor } from './render.js';

type Proposal = { id: string; base_revision: string; base_data_hash: string; created_at: string; request: ChangeRequestT; request_text: string; plan: ChangePlanT; review: any; source_job_id: string | null };
export class DesignService {
  store: DesignStore;
  constructor(public project: string, root: string, private injectedModel?: DesignModel) { this.store = new DesignStore(path.resolve(root)); }
  async model(id: string): Promise<DesignModel> {
    if (this.injectedModel) return this.injectedModel;
    return new LiveDesignModel(this.project, this.store.directory(id), await json(path.join(this.store.directory(id), 'settings.json')));
  }
  async prompt(name: string) { return fs.readFile(path.join(this.project, 'prompts', `workbench-${name}.md`), 'utf8'); }
  async ask<T>(id: string, label: string, prompt: string, context: any, schema: z.ZodType<T>, validate?: (value: T) => string[]): Promise<T> {
    const value = schema.parse(await (await this.model(id)).ask(label, prompt, context, schema, validate));
    const errors = validate?.(value) || [];
    if (errors.length) throw new WorkbenchError('model_validation', errors.join('\n'), 422);
    return value;
  }
  async review(id: string, context: any) {
    return this.ask(id, `workbench-review-${context.kind}`, await this.prompt('review'), context, Review);
  }
  assertReview(review: z.infer<typeof Review>) {
    if (!review.passed || review.issues.some(i => i.severity === 'blocking')) throw new WorkbenchError('semantic_review', review.issues.map(i => `${i.location}: ${i.issue}; ${i.correction}`).join('\n') || 'Review did not pass', 422);
  }
  async explain(id: string, data: RevisionDataT) {
    let repair: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const document = await this.ask(id, 'workbench-explain', await this.prompt('explain'), { detailed_design: data.design, brief: data.brief, decisions: data.decisions, repair }, UserDocument, value => readableErrors(value, data));
      const review = await this.review(id, { kind: 'explanation', detailed_design: data.design, brief: data.brief, decisions: data.decisions, user_document: document });
      if (review.passed && !review.issues.some(i => i.severity === 'blocking')) return { document, review };
      repair = { prior_document: document, review };
      if (attempt === 2) this.assertReview(review);
    }
    throw new Error('Unreachable');
  }
  async initialize(id: string, run: string, config: any, implementationDesign?: string, screenshotDir?: string) {
    await this.store.assertDirectory(id);
    const dir = this.store.directory(id);
    if (await exists(path.join(dir, 'manifest.json'))) return this.get(id);
    const data = RevisionData.parse({ design: await json(path.join(run, 'final/final-design.json')), brief: await json(path.join(run, 'brief.json')), decisions: await json(path.join(run, 'synthesis/decisions.json')) });
    const comparison = await json(path.join(run, 'synthesis/comparison.json'));
    const appIds = (await json(path.join(run, 'apps.lock.json'))).map((a: any) => a.id);
    if (appIds.some((x: string) => !/^[\w-]+$/.test(x))) throw new WorkbenchError('invalid_source', 'Invalid source app ID');
    const specs = await Promise.all(appIds.map((app: string) => json(path.join(run, 'apps', app, 'app-spec.json'))));
    const errors = designErrors(data, comparison, specs); if (errors.length) throw new WorkbenchError('invalid_source', errors.join('\n'));
    const source = path.join(dir, 'source');
    if (!(await exists(path.join(source, 'source.json')))) {
      await fs.mkdir(source, { recursive: true });
      await write(path.join(source, 'baseline.json'), data);
      await write(path.join(source, 'comparison.json'), comparison);
      await write(path.join(source, 'specs.json'), specs);
      const sourceFiles: Record<string, string> = {};
      for (const name of ['baseline.json', 'comparison.json', 'specs.json']) sourceFiles[name] = await fileSha(path.join(source, name));
      const originalPath = path.join(run, 'final/final-design.json');
      if (screenshotDir) for (const name of ['collection.png', 'search.png', 'editor.png', 'labels.png']) {
        const input = path.join(screenshotDir, name); if (await exists(input)) { await fs.copyFile(input, path.join(source, `screenshot-${name}`)); sourceFiles[`screenshot-${name}`] = await fileSha(path.join(source, `screenshot-${name}`)); }
      }
      await write(path.join(source, 'source.json'), { run_id: path.basename(run), source_path: originalPath, source_sha256: await fileSha(originalPath), baseline_data_hash: semanticHash(data), files: sourceFiles });
      await write(path.join(dir, 'settings.json'), config);
    }
    const imported = await this.store.source(id);
    if (imported.baseline_data_hash !== semanticHash(data)) throw new WorkbenchError('source_changed', 'Initialization retry needs the same imported design', 409);
    const { document, review } = await this.explain(id, data);
    const implementation = implementationDesign && await exists(implementationDesign) && semanticHash(await json(implementationDesign)) === semanticHash(data.design)
      ? { revision: '', semantic_hash: semanticHash(data.design), source_sha256: await fileSha(implementationDesign), app_name: 'Offline Notes' } : null;
    await this.store.commit(id, null, 'initial-import', semanticHash(data), (staging, record) => this.prepare(id, staging, record, data, document, { explanation: review }, Boolean(implementation)), {
      kind: 'import', change_id: null, selected_change_ids: [], data_hash: semanticHash(data), semantic_hash: semanticHash(data.design), changed_features: [],
      authorship: { actor: 'imported_llm', request: 'Import validated analysis design and generate a user-facing explanation', scope: 'Preserve original run; no app modification' },
    }, implementation);
    return this.get(id);
  }
  async prepare(id: string, dir: string, record: RevisionRecord, data: RevisionDataT, document: UserDocumentT, reviews: any, implemented: boolean) {
    for (const page of document.screens) {
      const name = screenshotFor(page.id); if (!name) continue;
      const source = path.join(this.store.directory(id), 'source', `screenshot-${name}`);
      if (await exists(source)) await fs.copyFile(source, path.join(dir, `screenshot-${name}`));
    }
    await renderDocuments(dir, document, data, record.version, implemented);
    await write(path.join(dir, 'reviews.json'), reviews);
    const { comparison, specs, ...source } = await this.store.source(id);
    await write(path.join(dir, 'provenance.json'), { ...record, files: undefined, source, implementation_updated: false });
    await write(path.join(dir, 'validation.json'), { schema: 'passed', references: 'passed', semantic_review: 'passed', original_run_modified: false, app_build_performed: false });
  }
  async get(id: string, revision?: string) {
    const value = await this.store.revision(id, revision);
    const baseline = RevisionData.parse(await json(path.join(this.store.directory(id), 'source/baseline.json')));
    const implemented = value.manifest.implementation?.semantic_hash === semanticHash(value.data.design);
    const changed = changedFeatures(baseline, value.data);
    return {
      id, revision: value.record.id, version: value.record.version, current_revision: value.manifest.current_revision,
      implementation: { status: value.manifest.implementation ? implemented ? 'in_sync' : 'pending_update' : 'untracked', revision: value.manifest.implementation?.revision || null, app_name: value.manifest.implementation?.app_name || null },
      document: value.document, controls: controls(value.data), changed_feature_ids: implemented ? [] : changed,
      artifacts: Object.keys(value.record.files).map(name => ({ name, url: `/designs/${id}/revisions/${value.record.id}/artifacts/${name}` })),
    };
  }
  async createProposal(id: string, request: ChangeRequestT, sourceJobId: string | null = null): Promise<Proposal> {
    const base = await this.store.revision(id);
    if (base.record.id !== request.base_revision) throw new WorkbenchError('stale_revision', '请基于最新设计提交修改。', 409);
    const described = describeEdits(request.edits, base.data);
    const text = [request.text.trim(), described].filter(Boolean).join('\n');
    const source = await this.store.source(id);
    const context = {
      request: text, detailed_design: base.data.design, brief: base.data.brief, decisions: base.data.decisions,
      available_choice_options: source.comparison.conflicts, controls: controls(base.data),
    };
    let plan!: ChangePlanT;
    let review: any = null;
    let repair: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      plan = await this.ask(id, 'workbench-interpret', await this.prompt('interpret'), { ...context, repair }, ChangePlan, value => planErrors(value, base.data, source.comparison, source.specs));
      if (plan.disposition !== 'proposal') break;
      review = await this.review(id, { kind: 'revision', user_request: text, selected_changes: plan.changes, before: base.data, after: applyOperations(base.data, plan.changes.flatMap(c => c.operations)) });
      if (review.passed && !review.issues.some((i: any) => i.severity === 'blocking')) break;
      repair = { prior_plan: plan, review };
      if (attempt === 2) this.assertReview(review);
    }
    if ((await this.store.manifest(id)).current_revision !== base.record.id) throw new WorkbenchError('stale_revision', '生成建议期间设计发生了变化，请重新提交。', 409);
    const proposal: Proposal = { id: `change-${randomUUID()}`, base_revision: base.record.id, base_data_hash: base.record.data_hash, created_at: new Date().toISOString(), request, request_text: text, plan, review, source_job_id: sourceJobId };
    const directory = path.join(this.store.directory(id), 'proposals');
    await withLock(path.join(directory, 'index.lock'), async () => {
      const indexFile = path.join(directory, 'index.json'); const index = await exists(indexFile) ? await json(indexFile) : {};
      const file = path.join(directory, `${proposal.id}.json`); await write(file, proposal); index[proposal.id] = await fileSha(file); await write(indexFile, index);
    }, 1000);
    return proposal;
  }
  async proposal(id: string, changeId: string): Promise<Proposal> {
    if (!/^change-[a-f\d-]{36}$/.test(changeId)) throw new WorkbenchError('invalid_id', 'Invalid change ID');
    try {
      const directory = path.join(this.store.directory(id), 'proposals'); const file = path.join(directory, `${changeId}.json`);
      const index = await json(path.join(directory, 'index.json'));
      if (!Object.hasOwn(index, changeId)) throw new WorkbenchError('not_found', '找不到这个修改建议。', 404);
      if (await fileSha(file) !== index[changeId]) throw new WorkbenchError('proposal_changed', '已生成建议发生变化，请重新生成建议。', 409);
      const value = await json(file); ChangePlan.parse(value.plan); return value;
    }
    catch (error: any) { if (error.code === 'ENOENT') throw new WorkbenchError('not_found', '找不到这个修改建议。', 404); throw error; }
  }
  async apply(id: string, changeId: string, request: ApplyRequestT) {
    const signature = semanticHash({ changeId, request });
    const manifest = await this.store.manifest(id);
    const receipt = manifest.receipts[request.idempotency_key];
    if (receipt) {
      if (receipt.signature !== signature) throw new WorkbenchError('idempotency_conflict', '同一次提交不能使用不同的修改内容。', 409);
      return this.get(id, receipt.revision);
    }
    const base = await this.store.revision(id);
    const proposal = await this.proposal(id, changeId);
    if (base.record.id !== request.base_revision || proposal.base_revision !== request.base_revision || proposal.base_data_hash !== base.record.data_hash) throw new WorkbenchError('stale_revision', '这个建议属于旧版本，请基于最新设计重新提出。', 409);
    if (proposal.plan.disposition !== 'proposal') throw new WorkbenchError('invalid_selection', '尚未形成可确认的修改建议。');
    const data = applyOperations(base.data, selectedOperations(proposal.plan, request.selected_change_ids));
    const source = await this.store.source(id);
    const errors = designErrors(data, source.comparison, source.specs);
    if (errors.length) throw new WorkbenchError('invalid_selection', errors.join('\n'), 422);
    const revisionReview = await this.review(id, { kind: 'revision', user_request: proposal.request_text,
      selected_changes: proposal.plan.changes.filter(c => request.selected_change_ids.includes(c.id)), before: base.data, after: data });
    this.assertReview(revisionReview);
    const { document, review } = await this.explain(id, data);
    const implemented = manifest.implementation?.semantic_hash === semanticHash(data.design);
    const revision = await this.store.commit(id, request.base_revision, request.idempotency_key, signature,
      (dir, record) => this.prepare(id, dir, record, data, document, { revision: revisionReview, explanation: review }, Boolean(implemented)), {
        kind: 'change', change_id: changeId, selected_change_ids: request.selected_change_ids,
        data_hash: semanticHash(data), semantic_hash: semanticHash(data.design), changed_features: changedFeatures(base.data, data),
        authorship: { actor: 'user', request: proposal.request_text, scope: 'Only selected, precompiled proposal operations; app implementation remains at its recorded baseline' },
      });
    return this.get(id, revision);
  }
  async restore(id: string, request: { base_revision: string; target_revision: string; idempotency_key: string }) {
    const signature = semanticHash({ kind: 'restore', request });
    const manifest = await this.store.manifest(id);
    const receipt = manifest.receipts[request.idempotency_key];
    if (receipt) { if (receipt.signature !== signature) throw new WorkbenchError('idempotency_conflict', 'Restore key already used', 409); return this.get(id, receipt.revision); }
    const current = await this.store.revision(id);
    if (current.record.id !== request.base_revision) throw new WorkbenchError('stale_revision', '请先查看最新设计版本。', 409);
    const target = await this.store.revision(id, request.target_revision);
    const source = await this.store.source(id); const errors = designErrors(target.data, source.comparison, source.specs);
    if (errors.length) throw new WorkbenchError('invalid_revision', errors.join('\n'), 422);
    const revision = await this.store.commit(id, request.base_revision, request.idempotency_key, signature,
      async (dir, record) => this.prepare(id, dir, record, target.data, target.document, { restored_from: target.record.id, original_reviews: await json(path.join(target.dir, 'reviews.json')) }, manifest.implementation?.semantic_hash === target.record.semantic_hash), {
        kind: 'restore', change_id: null, selected_change_ids: [], data_hash: target.record.data_hash, semantic_hash: target.record.semantic_hash,
        changed_features: changedFeatures(current.data, target.data), authorship: { actor: 'user', request: `Restore ${target.record.id}`, scope: 'Create a new revision; keep all historical revisions' },
      });
    return this.get(id, revision);
  }
  async developerReference(id: string, revision: string, refs: any[]) {
    const value = await this.store.revision(id, revision); return resolveRefs(refs, value.data);
  }
  async revisions(id: string) { return (await this.store.manifest(id)).revisions; }
  async validate(id: string) {
    const source = await this.store.source(id); const manifest = await this.store.manifest(id);
    const results = [];
    for (const record of manifest.revisions) {
      const revision = await this.store.revision(id, record.id);
      const errors = [...designErrors(revision.data, source.comparison, source.specs), ...readableErrors(revision.document, revision.data)];
      const inspect = (value: any): void => {
        if (!value || typeof value !== 'object') return;
        if (typeof value.passed === 'boolean' && (!value.passed || value.issues?.some((issue: any) => issue.severity === 'blocking'))) errors.push('Saved semantic review did not pass');
        for (const child of Object.values(value)) if (child && typeof child === 'object') inspect(child);
      };
      inspect(await json(path.join(revision.dir, 'reviews.json')));
      results.push({ revision: record.id, passed: !errors.length, errors });
    }
    const originalUnchanged = await exists(source.source_path) ? await fileSha(source.source_path) === source.source_sha256 : null;
    return { passed: results.every(r => r.passed) && originalUnchanged !== false, model_calls_performed: false, original_source_unchanged: originalUnchanged, revisions: results };
  }
}
