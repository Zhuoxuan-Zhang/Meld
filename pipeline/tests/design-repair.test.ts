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

it('checks parenthesized role descriptions without confusing text and background tokens', () => {
  const palette = [
    { role: 'primary (main green used for buttons, active tab, progress bar fill)', value: '#1B5E20' },
    { role: 'onPrimary (text/icons drawn on top of primary green)', value: '#FFFFFF' },
    { role: 'textPrimary (default body/heading text on background and surface)', value: '#1A1A16' },
    { role: 'background (screen background, warm off-white earth tone)', value: '#FBF8F2' },
    { role: 'surface (cards, dialogs, list rows, text fields)', value: '#FFFFFF' },
  ];
  expect(paletteErrors(palette)).toEqual([]);
  const unreadable = palette.map(token => token.role.startsWith('textPrimary') ? { ...token, value: '#FBF8F2' } : token);
  expect(paletteErrors(unreadable)).toEqual(['Insufficient contrast textPrimary/background', 'Insufficient contrast textPrimary/surface']);
  const themed = ['Light', 'Dark'].flatMap(theme => palette.map(token => ({ ...token, role: `${theme} ${token.role}` })));
  expect(paletteErrors(themed)).toEqual([]);
  expect(paletteErrors(palette.filter(token => !token.role.startsWith('background')))).toContain('Insufficient contrast textPrimary/background');
});

it('reconciles draft reference lists only against exact authoritative tasks and selected options', async () => {
  const { applyDesignReferenceRepair } = await import('../src/design-repair.js');
  const draft = { scope: { core_tasks: ['Import a photo'] }, decisions: ['Use JPEG because it is compact'], features: [{ id: 'import', behavior: 'Choose a device photo' }] };
  const patch = { core_tasks: { before: draft.scope.core_tasks, after: ['Select an image from the device.'] }, decisions: { before: draft.decisions, after: ['option-jpeg'] }, reason: 'Align reference lists; actual behavior still requires review.' };
  const result = applyDesignReferenceRepair(draft, patch, patch.core_tasks.after, ['option-jpeg']);
  expect(result.features).toEqual(draft.features); expect(result.decisions).toEqual(['option-jpeg']); expect(draft.decisions).toEqual(['Use JPEG because it is compact']);
  expect(() => applyDesignReferenceRepair(draft, patch, patch.core_tasks.after, ['option-png'])).toThrow('approved tasks');
  expect(() => applyDesignReferenceRepair(draft, { ...patch, decisions: { before: [], after: ['option-jpeg'] } }, patch.core_tasks.after, ['option-jpeg'])).toThrow('saved draft');
});
