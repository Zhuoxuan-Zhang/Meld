import { describe, expect, it } from 'vitest';
import { paletteErrors } from '../src/workbench/validation.js';
import { WorkspaceBrief } from '../src/workbench/schemas.js';
import { fixtureData } from './fixtures/workbench.js';
import { applyDesignTextRepair } from '../src/design-repair.js';

describe('local design repair', () => {
  const draft = { features: [{ id: 'f4', acceptance: [{ then: 'codePointCount = 17' }] }], decisions: ['option-local'], pages: [{ components: [{ text: 'First-sentence summary' }] }] };
  it('corrects the exact saved fixture without altering the draft or unrelated fields', () => {
    const repaired = applyDesignTextRepair(draft, { edits: [{ path: '/features/0/acceptance/0/then', before: 'codePointCount = 17', after: 'codePointCount = 16' }] });
    expect(repaired.features[0].acceptance[0].then).toBe('codePointCount = 16');
    expect(draft.features[0].acceptance[0].then).toBe('codePointCount = 17');
    expect(repaired.decisions).toEqual(draft.decisions); expect(repaired.pages).toEqual(draft.pages);
  });
  it('rejects stale edits, invented paths and changes to decision or evidence identities', () => {
    for (const path of ['/features/0/id', '/decisions/0', '/pages/9/title', '/__proto__/polluted']) expect(() => applyDesignTextRepair(draft, { edits: [{ path, before: 'f4', after: 'new' }] })).toThrow();
    expect(() => applyDesignTextRepair(draft, { edits: [{ path: '/features/0/acceptance/0/then', before: 'wrong', after: 'new' }] })).toThrow();
  });
});

it('preserves the expanded approved-feature brief at the developer-document boundary', () => {
  const brief = { ...fixtureData().brief, scope: 'Approved feature behavior. '.repeat(160) };
  expect(WorkspaceBrief.parse(brief).scope).toBe(brief.scope);
  expect(WorkspaceBrief.safeParse({ ...brief, scope: 'x'.repeat(20001) }).success).toBe(false);
});

it('recognizes plain text palette roles while enforcing actual text contrast', () => {
  const palette = [{ role: 'primary', value: '#9C432C' }, { role: 'on_primary', value: '#FFFFFF' }, { role: 'text', value: '#302923' }, { role: 'background', value: '#FFF8F0' }, { role: 'surface', value: '#FFFFFF' }];
  expect(paletteErrors(palette)).toEqual([]);
  expect(paletteErrors(palette.map(token => token.role === 'text' ? { ...token, value: '#FFF8F0' } : token))).toContain('Insufficient contrast textPrimary/background');
});
