import { isDeepStrictEqual } from 'node:util';
import { ChangePlan, RevisionData, type ChangePlanT, type OperationT, type RevisionDataT } from './schemas.js';
import { designErrors, refIndex, resolveRefs, WorkbenchError } from './validation.js';

const forbidden = new Set(['__proto__', 'prototype', 'constructor', 'id', 'role', 'chosen_by']);
const fields: Record<string, string[]> = {
  feature: ['title', 'task', 'behavior', 'page_ids', 'flow_ids', 'sources', 'proposed_reason', 'acceptance'],
  page: ['title', 'purpose', 'entries', 'components', 'events', 'validation', 'states', 'keyboard_focus', 'back_behavior', 'long_text', 'font_scaling', 'accessibility'],
  flow: ['task', 'entry_page_id', 'steps', 'completion', 'back', 'cancel', 'failure_recovery'],
  entity: ['name', 'fields', 'relationships', 'persistence'],
  component: ['parent_id', 'type', 'text', 'binding', 'event_ids'],
  event: ['trigger', 'action', 'state_change', 'target_page_id', 'error_recovery'],
  state: ['kind', 'condition', 'message', 'component_ids', 'event_ids'],
  color: ['value'], scope: ['target_users', 'core_tasks', 'included', 'excluded', 'constraints'],
  compose: ['components', 'ui_states', 'events', 'navigation_parameters', 'repository_responsibilities', 'type_examples'],
  brief: ['project_name', 'target_users', 'core_tasks', 'max_features', 'max_navigation', 'implementation', 'excluded', 'scope'],
  design: ['title', 'assumptions', 'unknowns', 'validation_needed', 'navigation'],
  decision: ['option_id', 'reason', 'rejected', 'assumptions', 'sources', 'explanation'],
};
function parseValue(text: string): any {
  return JSON.parse(text, (key, value) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new WorkbenchError('invalid_patch', 'Unsafe object property');
    return value;
  });
}
function target(data: RevisionDataT, operation: OperationT): { object?: any; list?: any[]; index?: number } {
  const { target: kind, id, owner_id } = operation;
  if (kind === 'scope' || kind === 'compose') return { object: data.design[kind] };
  if (kind === 'brief') return { object: data.brief };
  if (kind === 'design') return { object: data.design };
  if (kind === 'decision' && id === 'global_consistency') return { object: data.decisions.global_consistency };
  let list: any[];
  if (kind === 'color') list = data.design.visual.colors;
  else if (kind === 'decision') list = data.decisions.selections;
  else if (['component', 'event', 'state'].includes(kind)) {
    const page = data.design.pages.find(p => p.id === owner_id);
    if (!page) throw new WorkbenchError('invalid_patch', `Unknown owner page ${owner_id}`);
    list = (page as any)[({ component: 'components', event: 'events', state: 'states' } as Record<string, string>)[kind]];
  } else list = (data.design as any)[({ feature: 'features', page: 'pages', flow: 'flows', entity: 'entities' } as Record<string, string>)[kind]];
  const index = list.findIndex(value => (kind === 'color' ? value.role : kind === 'decision' ? value.conflict_id : value.id) === id);
  return { object: list[index], list, index };
}
function replaceText(value: any, match: string, replacement: string): { value: any; count: number } {
  if (typeof value === 'string') return { value: value.split(match).join(replacement), count: value.split(match).length - 1 };
  if (Array.isArray(value)) {
    const results = value.map(item => replaceText(item, match, replacement));
    return { value: results.map(x => x.value), count: results.reduce((s, x) => s + x.count, 0) };
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => [key, replaceText(item, match, replacement)] as const);
    return { value: Object.fromEntries(entries.map(([key, item]) => [key, item.value])), count: entries.reduce((s, [, item]) => s + item.count, 0) };
  }
  return { value, count: 0 };
}
export function applyOperations(base: RevisionDataT, operations: OperationT[]): RevisionDataT {
  let data = structuredClone(base);
  for (const operation of operations) {
    const result = target(data, operation);
    const value = parseValue(operation.value_json);
    if (operation.op === 'add' || operation.op === 'remove') {
      if (!result.list || !['feature', 'page', 'flow', 'entity', 'component', 'event', 'state'].includes(operation.target) || operation.field) throw new WorkbenchError('invalid_patch', 'Add/remove requires an ID-addressed item and empty field');
      if (operation.op === 'add') {
        if (result.object || !value || value.id !== operation.id) throw new WorkbenchError('invalid_patch', `Invalid or duplicate new item ${operation.id}`);
        if (operation.target === 'feature') value.proposed_reason = `${value.proposed_reason || ''} User-requested capability; original APK sources do not establish this addition.`.trim();
        result.list.push(value);
      } else {
        if (!result.object) throw new WorkbenchError('invalid_patch', `Cannot remove missing item ${operation.id}`);
        result.list.splice(result.index!, 1);
      }
      continue;
    }
    if (!result.object || forbidden.has(operation.field) || !fields[operation.target].includes(operation.field)) throw new WorkbenchError('invalid_patch', `Unsupported target field ${operation.target}/${operation.id}/${operation.field}`);
    if (operation.target === 'color') {
      if (operation.op !== 'set' || !/^#[\da-f]{6}$/i.test(value)) throw new WorkbenchError('invalid_patch', 'Color updates require a six-digit hex value');
      const prior = result.object.value;
      if (value !== prior && data.design.visual.colors.filter(c => c.value === prior).length > 1) throw new WorkbenchError('invalid_patch', 'Shared color values require explicit role-specific developer updates');
      // The baseline repeats visual tokens in page contracts; keep those references synchronized.
      data.design = replaceText(data.design, prior, value).value;
      continue;
    }
    if (operation.op === 'set') result.object[operation.field] = value;
    else if (operation.op === 'append') {
      const array = result.object[operation.field];
      if (!Array.isArray(array) || array.some(item => isDeepStrictEqual(item, value) || item?.id && item.id === value?.id)) throw new WorkbenchError('invalid_patch', `Invalid or duplicate append ${operation.field}`);
      array.push(value);
    } else if (operation.op === 'replace_text') {
      if (!operation.match_text || typeof value !== 'string') throw new WorkbenchError('invalid_patch', 'Text replacement needs a nonempty exact match and string replacement');
      const replaced = replaceText(result.object[operation.field], operation.match_text, value);
      if (!replaced.count) throw new WorkbenchError('invalid_patch', `Text replacement did not match the saved baseline: ${operation.target}/${operation.owner_id}/${operation.id}/${operation.field}, match=${JSON.stringify(operation.match_text)}`);
      result.object[operation.field] = replaced.value;
    }
  }
  data.design.decisions = data.decisions.selections.map(s => s.option_id);
  if (!isDeepStrictEqual(base.decisions.selections, data.decisions.selections)) data.decisions.chosen_by = 'user';
  data.design.status = 'final';
  return RevisionData.parse(data);
}
export function planErrors(plan: ChangePlanT, base: RevisionDataT, comparison: any, specs: any[]): string[] {
  const parsed = ChangePlan.safeParse(plan); if (!parsed.success) return [parsed.error.message];
  const errors: string[] = [];
  const ids = new Set(plan.changes.map(c => c.id));
  if (ids.size !== plan.changes.length) errors.push('Duplicate change IDs');
  if (plan.disposition !== 'proposal' && plan.changes.length) errors.push('Clarification/no-change must not mutate the design');
  if (plan.disposition === 'proposal' && (!plan.changes.length || plan.questions.length)) errors.push('A proposal needs executable changes without unanswered questions');
  if (plan.disposition === 'clarification' && !plan.questions.length) errors.push('Clarification needs a specific question');
  const touched = new Map<string, string>();
  for (const change of plan.changes) {
    try { resolveRefs(change.refs, base); } catch (error) { errors.push(String(error)); }
    for (const dep of change.depends_on) if (!ids.has(dep) || dep === change.id) errors.push(`Invalid dependency ${dep}`);
    for (const operation of change.operations) {
      const key = `${operation.target}/${operation.owner_id}/${operation.id}/${operation.field}`;
      const owner = touched.get(key);
      if (owner && owner !== change.id) errors.push(`Changes ${owner}/${change.id} overlap; combine them into one selectable change`);
      touched.set(key, change.id);
    }
  }
  const visit = (id: string, visiting = new Set<string>()) => {
    if (visiting.has(id)) { errors.push('Cyclic change dependencies'); return; }
    const change = plan.changes.find(c => c.id === id); if (!change) return;
    const next = new Set(visiting).add(id); for (const dep of change.depends_on) visit(dep, next);
  };
  for (const id of ids) visit(id);
  if (plan.disposition === 'proposal') {
    try {
      const candidate = applyOperations(base, plan.changes.flatMap(c => c.operations));
      errors.push(...designErrors(candidate, comparison, specs));
      if (isDeepStrictEqual(candidate, base)) errors.push('Proposal does not change the design');
    } catch (error) { errors.push(String(error)); }
  }
  return [...new Set(errors)];
}
export function selectedOperations(plan: ChangePlanT, selected: string[]): OperationT[] {
  if (new Set(selected).size !== selected.length || !selected.length) throw new WorkbenchError('invalid_selection', 'Select distinct changes');
  for (const id of selected) {
    const change = plan.changes.find(c => c.id === id);
    if (!change) throw new WorkbenchError('invalid_selection', `Unknown change ${id}`);
    for (const dependency of change.depends_on) if (!selected.includes(dependency)) throw new WorkbenchError('missing_dependency', `Change ${id} requires ${dependency}`);
  }
  return plan.changes.filter(c => selected.includes(c.id)).flatMap(c => c.operations);
}
export function selectedErrors(plan: ChangePlanT, selected: string[], base: RevisionDataT, comparison: any, specs: any[]): string[] {
  try { return designErrors(applyOperations(base, selectedOperations(plan, selected)), comparison, specs); }
  catch (error) { return [String(error)]; }
}
export function controls(data: RevisionDataT) {
  const chosen = Object.fromEntries(data.decisions.selections.map(s => [s.conflict_id, s.option_id]));
  const primary = data.design.visual.colors.find(c => /^primary$/i.test(c.role)) || data.design.visual.colors.find(c => /light/i.test(c.role) && /primary|accent/i.test(c.role) && !/on[-_ ]?primary/i.test(c.role)) || data.design.visual.colors.find(c => /primary|accent/i.test(c.role) && !/on[-_ ]?primary/i.test(c.role));
  const result = [
    { id: 'primary-color', label: '主色', type: 'color', value: primary?.value || '#315DA8', options: [] },
    { id: 'save-mode', label: '保存方式', type: 'select', value: chosen['choice-save'] === 'option-save-explicit' ? 'manual' : 'automatic', options: [{ value: 'automatic', label: '自动保存' }, { value: 'manual', label: '手动保存' }] },
    { id: 'delete-mode', label: '删除方式', type: 'select', value: chosen['choice-delete'] === 'option-delete-permanent' ? 'permanent' : 'recoverable', options: [{ value: 'recoverable', label: '删除后可恢复' }, { value: 'permanent', label: '确认后彻底删除' }] },
    { id: 'editor-content', label: '笔记类型', type: 'select', value: chosen['choice-editor-content'] === 'option-content-checklists' ? 'checklists' : 'text', options: [{ value: 'text', label: '普通文本' }, { value: 'checklists', label: '文本和清单' }] },
    { id: 'pinning', label: '重要笔记置顶', type: 'select', value: data.design.entities.find(e => e.id === 'entity-note')?.fields.some(f => /^(pinned|isPinned|pinnedAt)$/.test(f.name)) ? 'on' : 'off', options: [{ value: 'off', label: '不置顶' }, { value: 'on', label: '支持置顶' }] },
  ];
  const labels: Record<string, string> = { 'primary-color': 'Accent color', 'save-mode': 'Saving', 'delete-mode': 'Deleting notes', 'editor-content': 'Note content', pinning: 'Pin important notes' };
  const options: Record<string, string> = { automatic: 'Automatic save', manual: 'Save manually', recoverable: 'Allow recovery', permanent: 'Permanently delete', text: 'Plain text', checklists: 'Text and checklists', off: 'No pinning', on: 'Allow pinning' };
  return result.filter(control => control.id === 'primary-color' || control.id === 'pinning' ? control.id === 'primary-color' || Boolean(data.design.entities.find(e => e.id === 'entity-note') && data.design.features.find(f => f.id === 'feature-organize')) : Boolean(chosen[({ 'save-mode': 'choice-save', 'delete-mode': 'choice-delete', 'editor-content': 'choice-editor-content' } as Record<string, string>)[control.id]]))
    .map(control => ({ ...control, label: labels[control.id], options: control.options.map(option => ({ ...option, label: options[option.value] })) }));
}
export function describeEdits(edits: { control_id: string; value: string }[], data: RevisionDataT): string {
  return edits.map(edit => {
    const control = controls(data).find(c => c.id === edit.control_id);
    if (!control) throw new WorkbenchError('invalid_edit', 'This setting is not available for the current design');
    if (control.type === 'color') { if (!/^#[\da-f]{6}$/i.test(edit.value)) throw new WorkbenchError('invalid_edit', '主色需要完整的十六进制颜色值'); }
    else if (!control.options.some(o => o.value === edit.value)) throw new WorkbenchError('invalid_edit', `Unknown control value ${edit.control_id}`);
    const label = control.options.find(o => o.value === edit.value)?.label || edit.value;
    return `Change ${control.label} to ${label}.`;
  }).join('\n');
}
