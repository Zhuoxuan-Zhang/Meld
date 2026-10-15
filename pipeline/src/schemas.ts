import { z } from 'zod';
const S = z.string();
const A = z.array(S);
export const Evidence = z.object({
  id: S, app_id: S, apk_sha256: S, tool: S, parameters: z.record(S, z.unknown()),
  result_path: S, result_sha256: S, locator: S, limitations: A,
});
const Claim = z.object({ id: S, statement: S, classification: z.enum(['artifact_fact', 'decompiled_fact', 'inferred', 'unknown']), evidence_ids: A, limitations: A });
export const AppSpec = z.object({
  app_id: S, package_name: S, version: S, apk_sha256: S,
  static_only: z.literal(true), runtime_verified: z.literal(false), status: z.enum(['complete', 'partial']), scope: S,
  features: z.array(z.object({ id: S, task: S, title: S, claims: z.array(Claim) })),
  pages: z.array(z.object({ id: S, title: S, purpose: S, evidence_ids: A, limitations: A })),
  flows: z.array(z.object({ id: S, task: S, steps: A, evidence_ids: A, limitations: A })),
  data_structures: z.array(z.object({ name: S, fields: A, persistence: S, evidence_ids: A, limitations: A })),
  unknowns: A, coverage: z.object({ examined: A, omitted: A, tool_failures: A, limitations: A }),
});
const Ref = z.object({ app_id: S, feature_id: S });
export const Comparison = z.object({
  tasks: z.array(z.object({ id: S, task: S, sources: z.array(Ref), common: A, differences: A, relationship: z.enum(['duplicate', 'complementary', 'tradeoff', 'hard_conflict', 'insufficient_evidence']), dependencies: A, unknowns: A })),
  conflicts: z.array(z.object({ id: S, question: S, kind: z.enum(['tradeoff', 'hard_conflict']), blocking: z.boolean(), sources: z.array(Ref), options: z.array(z.object({ id: S, behavior: S, benefits: A, costs: A, requires_option_ids: A, incompatible_option_ids: A })) })),
  coverage: A,
});
export const Decisions = z.object({
  chosen_by: z.enum(['claude_proxy', 'openai_proxy', 'codex_proxy', 'user']), selections: z.array(z.object({ conflict_id: S, option_id: S, reason: S, rejected: z.array(z.object({ option_id: S, reason: S })), assumptions: A, sources: z.array(Ref) })),
  global_consistency: z.object({ offline: z.boolean(), features_within_limit: z.boolean(), navigation_within_limit: z.boolean(), compatible: z.boolean(), explanation: S }),
});
const Acceptance = z.object({ id: S, given: S, when: S, then: S });
const Event = z.object({ id: S, trigger: S, action: S, state_change: S, target_page_id: S, error_recovery: S });
export const UnifiedDesign = z.object({
  title: S, status: z.enum(['final', 'draft']), behavior_classification: z.literal('proposed'),
  scope: z.object({ target_users: S, core_tasks: A, included: A, excluded: z.array(z.object({ behavior: S, reason: S })), constraints: A }),
  features: z.array(z.object({ id: S, title: S, task: S, behavior: S, page_ids: A, flow_ids: A, sources: z.array(Ref), proposed_reason: S, acceptance: z.array(Acceptance) })),
  entities: z.array(z.object({ id: S, name: S, fields: z.array(z.object({ name: S, type: S, nullable: z.boolean(), validation: S, default_value: S })), relationships: A, persistence: S })),
  flows: z.array(z.object({ id: S, task: S, entry_page_id: S, steps: z.array(z.object({ page_id: S, operation: S, state_change: S })), completion: S, back: S, cancel: S, failure_recovery: S })),
  navigation: z.array(z.object({ label: S, page_id: S, parameters: A })),
  pages: z.array(z.object({
    id: S, title: S, purpose: S, entries: A,
    components: z.array(z.object({ id: S, parent_id: S, type: S, text: S, binding: S, event_ids: A })),
    events: z.array(Event), validation: A,
    states: z.array(z.object({ id: S, kind: z.enum(['normal', 'empty', 'no_results', 'error', 'delete_confirmation', 'unsaved_changes']), condition: S, message: S, component_ids: A, event_ids: A })),
    keyboard_focus: S, back_behavior: S, long_text: S, font_scaling: S, accessibility: A,
  })),
  visual: z.object({ colors: z.array(z.object({ role: S, value: S })), typography: A, spacing: A, corners: A, icons: A }),
  compose: z.object({ components: A, ui_states: A, events: A, navigation_parameters: A, repository_responsibilities: A, type_examples: A }),
  decisions: A, unknowns: A, assumptions: A, validation_needed: A,
});
export const Plan = z.object({
  tasks: A, missing_evidence: A, ready_for_spec: z.boolean(),
  actions: z.array(z.object({ tool: z.enum(['search_android_classes', 'inspect_android_class', 'inspect_android_method', 'inspect_android_bytecode', 'trace_android_references', 'read_artifact']), query: S, class_name: S, method_name: S, overload_index: z.number().int().nullable(), path: S, offset: z.number().int(), limit: z.number().int(), reason: S })),
});
export const Review = z.object({ passed: z.boolean(), issues: z.array(z.object({ severity: z.enum(['blocking', 'minor']), location: S, issue: S, correction: S })), limitations: A });
export const Selection = z.object({ selected: A, reason: S, limitations: A });
export type EvidenceT = z.infer<typeof Evidence>;
export type AppSpecT = z.infer<typeof AppSpec>;
export type DesignT = z.infer<typeof UnifiedDesign>;
