import { z } from 'zod';
import { Decisions, UnifiedDesign } from '../schemas.js';

const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
const Text = z.string().min(1).max(1200);
export const Reference = z.object({ kind: z.enum(['feature', 'page', 'flow', 'entity', 'acceptance', 'decision', 'color']), id: z.string().min(1).max(96) }).strict();
export const UserDocument = z.object({
  language: z.enum(['en', 'zh-CN']), title: Text, summary: Text, audience: Text,
  features: z.array(z.object({ id: Id, title: Text, summary: Text, steps: z.array(Text).min(1).max(5), examples: z.array(Text).max(3), caveats: z.array(Text).max(3), refs: z.array(Reference).min(1) }).strict()).min(1).max(20),
  screens: z.array(z.object({ id: Id, title: Text, purpose: Text, refs: z.array(Reference).min(1) }).strict()).min(1).max(12),
  choices: z.array(z.object({ id: Id, title: Text, selected: Text, reason: Text, refs: z.array(Reference).min(1) }).strict()).max(12),
  appearance: Text, boundaries: z.array(Text).min(1).max(8),
}).strict();
export const PatchOperation = z.object({
  target: z.enum(['feature', 'page', 'flow', 'entity', 'component', 'event', 'state', 'color', 'scope', 'compose', 'decision', 'brief', 'design']),
  id: z.string().max(96), owner_id: z.string().max(96), field: z.string().max(64),
  op: z.enum(['set', 'append', 'add', 'remove', 'replace_text']),
  value_json: z.string().max(100000), match_text: z.string().max(16000),
}).strict();
export const ChangePlan = z.object({
  disposition: z.enum(['proposal', 'clarification', 'no_change']), response: Text,
  questions: z.array(z.object({ id: Id, question: Text, options: z.array(Text).min(2).max(3) }).strict()).max(3),
  changes: z.array(z.object({
    id: Id, title: Text, before: Text, after: Text, reason: Text,
    impacts: z.array(Text).min(1).max(8), refs: z.array(Reference).min(1),
    depends_on: z.array(Id).max(8), operations: z.array(PatchOperation).min(1).max(70),
  }).strict()).max(8),
}).strict();
export const WorkspaceBrief = z.object({
  project_name: Text.optional(), market_signals: z.unknown().optional(),
  target_users: Text, core_tasks: z.array(Text), max_features: z.number().int().min(1).max(20),
  max_navigation: z.number().int().min(1).max(8), offline_only: z.literal(true),
  implementation: Text, excluded: z.array(Text), scope: Text,
}).strict();
export const HumanDecisions = Decisions.extend({ chosen_by: z.enum(['claude_proxy', 'openai_proxy', 'codex_proxy', 'user']) });
export const RevisionData = z.object({ design: UnifiedDesign, brief: WorkspaceBrief, decisions: HumanDecisions });
export const ChangeRequest = z.object({
  base_revision: Id, idempotency_key: Id, text: z.string().max(6000).default(''),
  edits: z.array(z.object({ control_id: z.enum(['primary-color', 'save-mode', 'delete-mode', 'editor-content', 'pinning']), value: z.string().max(100) }).strict()).max(5).default([]),
}).strict().refine(x => x.text.trim() || x.edits.length, 'Enter a request or choose a setting');
export const ApplyRequest = z.object({ base_revision: Id, idempotency_key: Id, selected_change_ids: z.array(Id).min(1).max(8) }).strict();
export const RestoreRequest = z.object({ base_revision: Id, target_revision: Id, idempotency_key: Id }).strict();
export type UserDocumentT = z.infer<typeof UserDocument>;
export type ChangePlanT = z.infer<typeof ChangePlan>;
export type OperationT = z.infer<typeof PatchOperation>;
export type RevisionDataT = z.infer<typeof RevisionData>;
export type RefT = z.infer<typeof Reference>;
export type ChangeRequestT = z.infer<typeof ChangeRequest>;
export type ApplyRequestT = z.infer<typeof ApplyRequest>;
