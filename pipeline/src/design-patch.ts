import { z } from 'zod';
import { UnifiedDesign } from './schemas.js';

export const DesignPatch = z.object({ edits: z.array(z.object({ path: z.array(z.string().min(1)).min(1).max(12), format: z.enum(['text', 'json']), value: z.string().max(60000) }).strict()).min(1).max(80) }).strict();

// Replace existing fields or append at the end of an array. Never allow
// sparse arrays, prototype traversal or arbitrary new schema fields.
export function applyDesignPatch(source: unknown, patch: z.infer<typeof DesignPatch>) {
  const result = structuredClone(source) as any;
  const errors: string[] = [];
  for (const edit of DesignPatch.parse(patch).edits) {
    try {
    const keys = edit.path[0] === 'prior_design' ? edit.path.slice(1) : edit.path;
    if (!keys.length) throw new Error('Design edit must target an existing field, not the whole design');
    let parent = result;
    for (const [i, segment] of keys.entries()) {
      let key = segment;
      if (Array.isArray(parent) && i === keys.length - 1 && segment === '-') key = String(parent.length);
      if (Array.isArray(parent) && segment !== '-' && !/^(0|[1-9]\d*)$/.test(segment)) {
        const matches = parent.flatMap((item: any, index: number) => item && typeof item === 'object' && (item.id === segment || item.id == null && item.name === segment) ? [index] : []);
        if (matches.length > 1) throw new Error(`Design edit has an ambiguous item name: ${edit.path.join('.')}`);
        if (matches.length === 1) key = String(matches[0]);
      }
      const append = Array.isArray(parent) && i === keys.length - 1 && key === String(parent.length);
      if (['__proto__', 'prototype', 'constructor'].includes(key) || !parent || typeof parent !== 'object' || !Object.hasOwn(parent, key) && !append || Array.isArray(parent) && !/^(0|[1-9]\d*)$/.test(key)) throw new Error(`Design edit must target an existing field or the next array index: ${edit.path.join('.')}${Array.isArray(parent) ? ` (array length ${parent.length}; append with -)` : ''}`);
      if (i === keys.length - 1) {
        try { parent[key] = edit.format === 'text' ? edit.value : JSON.parse(edit.value); } catch (error) { throw new Error(`Invalid replacement at ${edit.path.join('.')}: ${String(error)}`); }
      }
      else parent = parent[key];
    }
    } catch (error) { errors.push(String(error)); }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return UnifiedDesign.parse(result);
}
