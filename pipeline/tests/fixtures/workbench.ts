import path from 'node:path';
import { z } from 'zod';
import { write } from '../../src/storage.js';
import { RevisionData, type ChangePlanT, type RevisionDataT, type OperationT } from '../../src/workbench/schemas.js';
import { type DesignModel } from '../../src/workbench/model.js';

// Synthetic contracts for failure-path tests. Never used as live LLM evidence.
export const comparison = { tasks: [], coverage: [], conflicts: [{ id: 'choice-save', question: 'Save?', kind: 'tradeoff', blocking: true, sources: [],
  options: ['option-save-automatic', 'option-save-explicit'].map(id => ({ id, behavior: id, benefits: [], costs: [], requires_option_ids: [], incompatible_option_ids: [] })) }] };
export const fixtureData = (): RevisionDataT => RevisionData.parse({
  brief: { target_users: 'fixture', core_tasks: ['create', 'edit', 'save', 'find', 'reopen'], max_features: 5, max_navigation: 3, offline_only: true, implementation: 'Kotlin Compose', excluded: [], scope: 'fixture' },
  decisions: { chosen_by: 'codex_proxy', selections: [{ conflict_id: 'choice-save', option_id: 'option-save-automatic', reason: 'fixture', rejected: [{ option_id: 'option-save-explicit', reason: 'fixture' }], assumptions: [], sources: [] }], global_consistency: { offline: true, features_within_limit: true, navigation_within_limit: true, compatible: true, explanation: 'fixture' } },
  design: { title: 'Fixture notes', status: 'final', behavior_classification: 'proposed',
    scope: { target_users: 'fixture', core_tasks: ['create', 'edit', 'save', 'find', 'reopen'], included: ['fixture'], excluded: [], constraints: ['offline'] },
    features: [{ id: 'feature-write', title: '写笔记', task: 'write', behavior: 'fixture', page_ids: ['page-collection'], flow_ids: [], sources: [], proposed_reason: 'synthetic test fixture', acceptance: [{ id: 'accept-write', given: 'note', when: 'save', then: 'saved' }] }],
    entities: [{ id: 'entity-note', name: 'Note', fields: [{ name: 'noteId', type: 'String', nullable: false, validation: 'fixture', default_value: 'UUID' }], relationships: [], persistence: 'fixture memory for testing' }], flows: [],
    navigation: [{ label: 'Notes', page_id: 'page-collection', parameters: [] }],
    pages: [{ id: 'page-collection', title: 'Notes', purpose: 'fixture', entries: [], components: [{ id: 'save-button', parent_id: '', type: 'Button', text: 'Save', binding: '', event_ids: ['event-save'] }],
      events: [{ id: 'event-save', trigger: 'tap', action: 'save', state_change: 'saved', target_page_id: '', error_recovery: 'retry' }], validation: [],
      states: ['normal', 'empty', 'no_results', 'error', 'delete_confirmation', 'unsaved_changes'].map(kind => ({ id: `state-${kind}`, kind, condition: 'fixture', message: '', component_ids: ['save-button'], event_ids: ['event-save'] })),
      keyboard_focus: 'fixture', back_behavior: 'fixture', long_text: 'fixture', font_scaling: 'fixture', accessibility: [] }],
    visual: { colors: [{ role: 'primary', value: '#315DA8' }, { role: 'onPrimary', value: '#FFFFFF' }, { role: 'background', value: '#FAFAFA' }, { role: 'surface', value: '#FFFFFF' }, { role: 'textPrimary', value: '#202124' }], typography: [], spacing: [], corners: [], icons: [] },
    compose: { components: [], ui_states: ['fixture'], events: [], navigation_parameters: [], repository_responsibilities: ['save'], type_examples: [] },
    decisions: ['option-save-automatic'], unknowns: [], assumptions: [], validation_needed: [],
  },
});
export const op = (target: OperationT['target'], id: string, field: string, value: any, operation: OperationT['op'] = 'set'): OperationT => ({ target, id, owner_id: '', field, op: operation, value_json: JSON.stringify(value), match_text: '' });
export function fixturePlan(): ChangePlanT {
  return { disposition: 'proposal', response: '可分别确认这两项修改。', questions: [], changes: [
    { id: 'change-title', title: '改功能名称', before: '写笔记', after: '记录想法', reason: 'fixture', impacts: ['功能显示名称改变'], refs: [{ kind: 'feature', id: 'feature-write' }], depends_on: [], operations: [op('feature', 'feature-write', 'title', '记录想法')] },
    { id: 'change-color', title: '改主色', before: '蓝色', after: '深绿色', reason: 'fixture', impacts: ['主色改变'], refs: [{ kind: 'color', id: 'primary' }], depends_on: [], operations: [op('color', 'primary', 'value', '#246B4A')] },
  ] };
}
export const readable = (data: RevisionDataT) => ({ language: 'zh-CN', title: data.design.title, summary: '用于测试的易读说明。', audience: 'fixture',
  features: data.design.features.map(f => ({ id: f.id, title: f.title, summary: '写下并保存你的笔记。', steps: ['打开笔记', '输入文字'], examples: [], caveats: [], refs: [{ kind: 'feature', id: f.id }, ...f.acceptance.map(a => ({ kind: 'acceptance', id: a.id }))] })),
  screens: data.design.pages.map(p => ({ id: p.id, title: p.title, purpose: '查看笔记', refs: [{ kind: 'page', id: p.id }] })),
  choices: data.decisions.selections.map(s => ({ id: s.conflict_id, title: '保存方式', selected: s.option_id, reason: 'fixture', refs: [{ kind: 'decision', id: s.conflict_id }] })),
  appearance: 'fixture', boundaries: ['fixture'],
});
export class FixtureModel implements DesignModel {
  fail = false; invalidDoc = false; failReview = false; repairReviewOnce = false; reviewCalls = 0; calls: string[] = [];
  plan = fixturePlan();
  async ask<T>(label: string, _prompt: string, context: any, schema: z.ZodType<T>): Promise<T> {
    this.calls.push(label); if (this.fail) throw new Error('Synthetic model failure');
    if (label === 'workbench-explain') { const doc = readable({ design: context.detailed_design, brief: context.brief, decisions: context.decisions }); if (this.invalidDoc) doc.features[0].refs[0].id = 'missing'; return schema.parse(doc); }
    if (label.startsWith('workbench-review')) { const failed = this.failReview || this.repairReviewOnce && this.reviewCalls++ === 0; return schema.parse({ passed: !failed, issues: failed ? [{ severity: 'blocking', location: 'fixture', issue: 'Synthetic mismatch', correction: 'Repair the generated output' }] : [], limitations: ['Synthetic review'] }); }
    if (context.request === 'vague') return schema.parse({ disposition: 'clarification', response: '请具体一些。', questions: [{ id: 'question-style', question: '想改哪一项？', options: ['颜色', '功能'] }], changes: [] });
    if (context.request === 'unrelated') return schema.parse({ disposition: 'no_change', response: '这条输入没有修改笔记设计。', questions: [], changes: [] });
    return schema.parse(this.plan);
  }
}
export async function sourceFixture(dir: string) {
  const data = fixtureData();
  await write(path.join(dir, 'final/final-design.json'), data.design);
  await write(path.join(dir, 'brief.json'), data.brief); await write(path.join(dir, 'synthesis/decisions.json'), data.decisions);
  await write(path.join(dir, 'synthesis/comparison.json'), comparison); await write(path.join(dir, 'apps.lock.json'), []);
  return data;
}
