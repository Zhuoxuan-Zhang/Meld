import { isDeepStrictEqual } from 'node:util';
import { sha } from '../storage.js';
import { validateDecisions, validateDesign } from '../validate.js';
import { RevisionData, UserDocument, type RevisionDataT, type UserDocumentT, type RefT } from './schemas.js';

export class WorkbenchError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const semanticHash = (value: any) => sha(canonical(value));
export function refIndex(data: RevisionDataT): Map<string, any> {
  const map = new Map<string, any>();
  const put = (kind: string, id: string, value: any) => { if (map.has(`${kind}:${id}`)) throw new WorkbenchError('invalid_reference', `Duplicate ${kind} ID ${id}`); map.set(`${kind}:${id}`, value); };
  for (const [kind, values] of [['feature', data.design.features], ['page', data.design.pages], ['flow', data.design.flows], ['entity', data.design.entities]] as const) for (const value of values) put(kind, value.id, value);
  for (const feature of data.design.features) for (const acceptance of feature.acceptance) put('acceptance', acceptance.id, acceptance);
  for (const selection of data.decisions.selections) put('decision', selection.conflict_id, selection);
  put('decision', 'global_consistency', data.decisions.global_consistency);
  for (const color of data.design.visual.colors) put('color', color.role, color);
  return map;
}
export function resolveRefs(refs: RefT[], data: RevisionDataT): any[] {
  const index = refIndex(data);
  return refs.map(ref => {
    const value = index.get(`${ref.kind}:${ref.id}`);
    if (!value) throw new WorkbenchError('invalid_reference', `Unknown developer reference ${ref.kind}:${ref.id}`);
    return { ...ref, value };
  });
}
export function readableErrors(doc: UserDocumentT, data: RevisionDataT): string[] {
  const parsed = UserDocument.safeParse(doc); if (!parsed.success) return [parsed.error.message];
  const errors: string[] = [];
  const unique = (items: { id: string }[], label: string) => { if (new Set(items.map(x => x.id)).size !== items.length) errors.push(`Duplicate readable ${label}`); };
  unique(doc.features, 'features'); unique(doc.screens, 'screens'); unique(doc.choices, 'choices');
  for (const feature of data.design.features) if (!doc.features.some(x => x.id === feature.id)) errors.push(`Readable document omits ${feature.id}`);
  for (const page of data.design.pages) if (!doc.screens.some(x => x.id === page.id)) errors.push(`Readable document omits ${page.id}`);
  for (const choice of data.decisions.selections) if (!doc.choices.some(x => x.id === choice.conflict_id)) errors.push(`Readable document omits ${choice.conflict_id}`);
  for (const card of [...doc.features, ...doc.screens, ...doc.choices]) {
    try { resolveRefs(card.refs, data); } catch (error) { errors.push(String(error)); }
  }
  for (const card of doc.features) if (!data.design.features.some(x => x.id === card.id) || !card.refs.some(x => x.kind === 'feature' && x.id === card.id)) errors.push(`Feature card must link its own developer feature ${card.id}`);
  for (const card of doc.screens) if (!data.design.pages.some(x => x.id === card.id) || !card.refs.some(x => x.kind === 'page' && x.id === card.id)) errors.push(`Screen card must link its own developer page ${card.id}`);
  for (const card of doc.choices) if (!data.decisions.selections.some(x => x.conflict_id === card.id) || !card.refs.some(x => x.kind === 'decision' && x.id === card.id)) errors.push(`Choice card must link its own decision ${card.id}`);
  return errors;
}
function colorRgb(value: string): number[] {
  if (!/^#[\da-f]{6}$/i.test(value)) throw new WorkbenchError('invalid_color', 'Use a six-digit hexadecimal color');
  return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16) / 255);
}
export function contrast(a: string, b: string): number {
  const luminance = (value: string) => colorRgb(value).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((s, x, i) => s + x * [.2126, .7152, .0722][i], 0);
  const [x, y] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (x + .05) / (y + .05);
}
export function paletteErrors(tokens: { role: string; value: string }[]): string[] {
  const normalized = tokens.map(token => ({ name: token.role.toLowerCase().replace(/[^a-z]/g, ''), value: token.value }));
  const themes = ['light', 'dark'].filter(theme => normalized.some(token => token.name.startsWith(theme)));
  const errors: string[] = [];
  for (const theme of themes.length ? themes : ['']) {
    const candidates = normalized.filter(token => theme ? token.name.startsWith(theme) : !/^(light|dark)/.test(token.name));
    const get = (pattern: RegExp, exclude?: RegExp) => candidates.find(token => pattern.test(token.name) && !(exclude?.test(token.name)))?.value;
    const palette: Record<string, string | undefined> = { primary: get(/primary|accent/, /onprimary|onaccent|textprimary|primarytext/), onPrimary: get(/onprimary|onaccent/), textPrimary: get(/textprimary|primarytext|(?:light|dark)text$/), background: get(/background$/), surface: get(/surface$/) };
    for (const [a, b] of [['primary', 'onPrimary'], ['textPrimary', 'background'], ['textPrimary', 'surface']]) {
      try { if (!palette[a] || !palette[b] || contrast(palette[a]!, palette[b]!) < 4.5) errors.push(`Insufficient contrast ${theme ? theme + ' ' : ''}${a}/${b}`); } catch (error) { errors.push(String(error)); }
    }
  }
  return errors;
}
export function designErrors(data: RevisionDataT, comparison: any, specs: any[]): string[] {
  const parsed = RevisionData.safeParse(data); if (!parsed.success) return [parsed.error.message];
  // Keep the original pipeline's provider contract intact; human ownership is stored separately.
  const providerCompatible = { ...data.decisions, chosen_by: 'codex_proxy' };
  const errors = [...validateDesign(data.design, data.brief, data.decisions, specs), ...validateDecisions(providerCompatible, comparison, specs)];
  try { refIndex(data); } catch (error) { errors.push(String(error)); }
  errors.push(...paletteErrors(data.design.visual.colors));
  if (!/kotlin|compose/i.test(data.brief.implementation)) errors.push('This workspace targets Android Kotlin / Compose');
  if (!data.decisions.global_consistency.offline) errors.push('This workspace retains the offline product boundary');
  return errors;
}
export function changedFeatures(before: RevisionDataT, after: RevisionDataT): string[] {
  const changedPages = new Set(after.design.pages.filter(p => !isDeepStrictEqual(p, before.design.pages.find(b => b.id === p.id))).map(p => p.id));
  const shared = !isDeepStrictEqual(before.design.visual, after.design.visual) || !isDeepStrictEqual(before.design.entities, after.design.entities) || !isDeepStrictEqual(before.design.scope, after.design.scope) || !isDeepStrictEqual(before.design.compose, after.design.compose);
  return after.design.features.filter(f => shared || !isDeepStrictEqual(f, before.design.features.find(b => b.id === f.id)) || f.page_ids.some(id => changedPages.has(id))).map(f => f.id);
}
