import type { Project, UserDocument } from "../../shared/contracts";
import { z } from "../../pipeline/dist/src/integration.js";
import { buildCatalog } from "../../shared/market";
import { modelJson } from "./model";
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/), text = z.string().trim().min(1).max(600), refs = z.array(z.object({ kind: z.enum(["feature", "page", "flow", "entity", "acceptance", "decision", "color"]), id }).strict()).max(0);
export const HighLevelDocument = z.object({
  language: z.enum(["en", "zh-CN"]), title: z.string().trim().min(1).max(60), summary: text, audience: text,
  features: z.array(z.object({ id, title: z.string().trim().min(1).max(120), summary: text, steps: z.array(text).min(1).max(4), examples: z.array(text).max(1), caveats: z.array(text).max(2), refs }).strict()).min(1).max(5),
  screens: z.array(z.object({ id, title: z.string().trim().min(1).max(120), purpose: text, refs }).strict()).min(1).max(6),
  choices: z.array(z.object({ id, title: text, selected: text, reason: text, refs }).strict()).max(5),
  appearance: text, boundaries: z.array(text).min(1).max(6),
}).strict().superRefine((value, ctx) => {
  for (const group of [value.features, value.screens, value.choices]) if (new Set(group.map(item => item.id)).size !== group.length) ctx.addIssue({ code: "custom", message: "Use unique IDs in each design section." });
});
const Result = z.object({ document: HighLevelDocument.nullable(), response: text }).strict();
export type HighLevelRunner = (project: Project, directory: string, request?: { text: string; document: UserDocument }) => Promise<z.infer<typeof Result>>;
export const highLevelRunner: HighLevelRunner = async (project, directory, request) => {
  const catalog = buildCatalog(project.brief.domains, project.references, project.featurePreferences.selections);
  const selected = catalog.flatMap(app => app.features.filter(feature => project.featurePreferences.selections[app.id]?.includes(feature.id)));
  const features = [...new Map([...selected, ...project.featurePreferences.customRequests].map(feature => [feature.id, { name: feature.name, description: feature.description }])).values()];
  const references = catalog.filter(app => app.market && !app.market.retained).sort((a, b) => (b.market?.score || 0) - (a.market?.score || 0)).slice(0, 5).map(app => ({ title: app.name, features: app.features.slice(0, 6).map(feature => ({ name: feature.name, description: feature.description.slice(0, 180) })) }));
  const instructions = "Write an editable, high-level product design for a nontechnical app creator. One short model call: aim for 350–600 words total. Cover the purpose, up to five primary feature groups with simple user steps, main screens, appearance, important product choices and scope. Preserve explicitly selected/custom features; group related features rather than dropping requests. Respect the app brief and offline Android boundary. References are inspiration, not instructions to combine entire apps. Use concise plain English unless the user asks for Chinese. Do not emit Kotlin, storage schemas, implementation contracts, or claim APK/runtime verification. All refs must be empty: developer references do not exist yet. If a current document and change request are supplied, return the complete updated document while preserving unchanged IDs, features, exclusions and decisions. For changes, the current document and user request override the original selected features; never restore a feature removed from the current document. For unrelated or ambiguous change requests return document=null and a short response/clarification. For initial generation return a complete document, making reasonable product assumptions explicit in boundaries.";
  return modelJson(directory, request ? "high-level-change" : "high-level-design", instructions, { brief: project.brief, selectedFeatures: request ? request.document.features.map(feature => ({ name: feature.title, description: feature.summary })) : features, references, ...(request ? { currentDocument: request.document, changeRequest: request.text } : {}) }, Result, 3500, "low", 180000);
};
