import { z } from 'zod';

export const DesignTextRepair = z.object({
  edits: z.array(z.object({ path: z.string(), before: z.string(), after: z.string() }).strict()).min(1).max(24),
}).strict();

// Replace existing prose only. Exact-value guards prevent stale or ambiguous edits.
export function applyDesignTextRepair<T>(design: T, repair: z.infer<typeof DesignTextRepair>): T {
  const result = structuredClone(design);
  const seen = new Set<string>();
  for (const edit of repair.edits) {
    if (!edit.path.startsWith('/')) throw new Error('Repair needs an absolute JSON pointer');
    const keys = edit.path.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (seen.has(edit.path) || keys.some(key => ['__proto__', 'prototype', 'constructor', 'id', 'status', 'sources', 'decisions', 'scope'].includes(key) || /_ids?$/.test(key))) throw new Error('Repair cannot change identity, decisions or scope');
    seen.add(edit.path);
    let owner: any = result;
    for (const key of keys.slice(0, -1)) {
      if (!owner || !Object.hasOwn(owner, key)) throw new Error(`Repair path does not exist: ${edit.path}. Paths start at the design root; omit /context/design.`);
      owner = owner[key];
    }
    const key = keys.at(-1)!;
    if (!owner || !Object.hasOwn(owner, key) || typeof owner[key] !== 'string' || owner[key] !== edit.before) throw new Error('Repair does not match the saved text');
    if (!edit.after.trim() || edit.after === edit.before) throw new Error('Repair must supply changed, nonempty text');
    owner[key] = edit.after;
  }
  return result;
}
