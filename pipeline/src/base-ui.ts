import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileSha } from './storage.js';

const text = z.string().trim().min(1).max(700);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const BaseUiVisual = z.object({
  summary: text, navigation: text, hierarchy: text, typography: text, colors: text, spacing: text, controls: text,
  screens: z.array(z.object({ screenshotId: z.string().min(1), name: text, layout: text, preserve: z.array(text).min(1).max(6), adapt: z.array(text).max(6) }).strict()).min(1).max(6),
  limitations: z.array(text).max(8),
}).strict();
export const BaseUiReference = z.object({
  id: z.string().regex(/^base-ui-[a-f0-9]{24}$/), baseAppId: z.string().min(1), title: z.string().min(1),
  source: z.enum(['runtime_capture', 'store_screenshots']),
  screenshots: z.array(z.object({ id: z.string().regex(/^screen-\d+$/), url: z.string().min(1), sha256: digest, label: text }).strict()).min(1).max(6),
  visual: BaseUiVisual,
}).strict();
export const BaseUiEvidence = z.object({ reference: BaseUiReference,
  images: z.array(z.object({ id: z.string(), path: z.string().min(1), sha256: digest }).strict()).min(1).max(6),
}).strict().superRefine((value, ctx) => {
  const expected = value.reference.screenshots;
  if (new Set(expected.map(s => s.id)).size !== expected.length || expected.length !== value.images.length || expected.some(s => !value.images.some(i => i.id === s.id && i.sha256 === s.sha256))) ctx.addIssue({ code: 'custom', message: 'Base UI images must match the reference exactly.' });
  const ids = value.reference.visual.screens.map(s => s.screenshotId);
  if (new Set(ids).size !== ids.length || ids.length !== expected.length || expected.some(s => !ids.includes(s.id))) ctx.addIssue({ code: 'custom', message: 'Base UI analysis must cover each screenshot exactly once.' });
});
export type BaseUiEvidenceT = z.infer<typeof BaseUiEvidence>;
export type BaseUiReferenceT = z.infer<typeof BaseUiReference>;

export function imageMediaType(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return 'image/webp';
  throw new Error('Unsupported visual evidence image; expected PNG, JPEG or WebP.');
}
export async function baseUiImages(input: unknown): Promise<string[]> {
  if (!input) return [];
  const evidence = BaseUiEvidence.parse(input);
  for (const image of evidence.images) {
    const stat = await fs.lstat(image.path);
    if (!path.isAbsolute(image.path) || !stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024 || await fileSha(image.path) !== image.sha256) throw new Error('Base UI screenshot changed; prepare a new reference.');
    imageMediaType(await fs.readFile(image.path));
  }
  return evidence.images.map(image => image.path);
}
export const baseUiDesignInstructions = 'When baseUi or brief.market_signals.base_ui is supplied, its attached original-base screenshots are the visual foundation, not optional inspiration. Keep the main screen composition, navigation placement, content-to-controls proportions, visual hierarchy, typography scale, color roles, spacing and tool grouping recognizably close to the observed base. Integrate selected enhancements into that structure instead of inventing a generic card-stack UI. Map each relevant target screen to the supplied reference screen and explain necessary adaptations in screen descriptions/appearance/choices. Store screenshots may contain promotional framing: infer only visible app UI and explicitly mark hidden screens unknown. Do not reproduce promotional posters, logos, brand names, advertisements, paid/account gates or unrelated features. brief.style is a generic fallback, not an explicit request to replace the base palette. Preserve explicit user appearance edits as documented deviations; do not silently override them. Never claim runtime verification from store images.';

export const BaseUiMapping = z.array(z.object({
  screenId: z.string().min(1), referenceScreenIds: z.array(z.string().min(1)).max(6),
  preserved: z.array(text).max(6), adaptations: z.array(text).max(6), proposedReason: z.string().max(700).nullable(),
}).strict()).min(1).max(6);
export type BaseUiMappingT = z.infer<typeof BaseUiMapping>;
export function validateBaseUiMapping(screens: {id: string}[], mapping: BaseUiMappingT, reference: BaseUiReferenceT): string[] {
  const errors: string[] = [], ids = mapping.map(item => item.screenId);
  if (new Set(ids).size !== ids.length || ids.length !== screens.length || screens.some(screen => !ids.includes(screen.id))) errors.push('Map every proposed screen to the base UI exactly once.');
  for (const item of mapping) {
    if (new Set(item.referenceScreenIds).size !== item.referenceScreenIds.length || item.referenceScreenIds.some(id => !reference.screenshots.some(screen => screen.id === id))) errors.push('UI mapping cites an unknown or repeated base screenshot.');
    if (item.referenceScreenIds.length ? !item.preserved.length : !item.proposedReason?.trim()) errors.push('Explain preserved base layout or explicitly identify a proposed unseen screen.');
  }
  if (!mapping.some(item => item.referenceScreenIds.length && item.preserved.length)) errors.push('The proposed design must follow at least one observed base screen.');
  return errors;
}
