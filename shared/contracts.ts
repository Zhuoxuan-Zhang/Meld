import type { BaseUiReferenceT, BaseUiMappingT } from "../pipeline/src/base-ui";
import type { MarketResult } from "./market";

export type Reference = { kind: "feature" | "page" | "flow" | "entity" | "acceptance" | "decision" | "color"; id: string };
export type UserDocument = {
  language: "en" | "zh-CN"; title: string; summary: string; audience: string;
  features: { id: string; title: string; summary: string; steps: string[]; examples: string[]; caveats: string[]; refs: Reference[] }[];
  screens: { id: string; title: string; purpose: string; refs: Reference[] }[];
  choices: { id: string; title: string; selected: string; reason: string; refs: Reference[] }[];
  appearance: string; boundaries: string[];
};
export type DesignView = {
  id: string; revision: string; version: number; current_revision: string;
  implementation: { status: string; revision: string | null; app_name: string | null };
  document: UserDocument;
  controls: { id: string; label: string; value: string; type: string; options: { value: string; label: string }[] }[];
  changed_feature_ids: string[]; artifacts: { name: string; url: string }[];
};
export type Change = { id: string; title: string; before: string; after: string; reason: string; impacts: string[]; refs: Reference[]; depends_on: string[] };
export type ChangeProposal = {
  id: string; base_revision: string; request_text: string;
  plan: { disposition: "proposal" | "clarification" | "no_change"; response: string; questions: { id: string; question: string; options: string[] }[]; changes: Change[] };
};
export type Brief = { name: string; input: string; audience: string; purpose: string; goal: string; style: "warm" | "sage" | "ink"; domains: string[]; coreTasks?: string[]; requiredStates?: string[] };
export type FeatureRequest = { id: string; name: string; description: string };
export type Conflict = { id: string; question: string; kind: string; blocking: boolean; advanced?: boolean; options: { id: string; behavior: string; benefits: string[]; costs: string[]; requires_option_ids: string[]; incompatible_option_ids: string[] }[] };
export type HighLevelDesign = { baseUiMapping?: BaseUiMappingT; baseUiReference?: BaseUiReferenceT; revision: string; version: number; document: UserDocument; createdAt: string; approvedRevision?: string; developerRevision?: string };
export type Decision = { id: string; kind: "high_level_changes"; baseUiMapping?: BaseUiMappingT; baseRevision: string; document: UserDocument; response: string } | { id: string; kind: "merge_choices"; jobId: string; comparisonHash: string; conflicts: Conflict[] } | { id: string; kind: "design_changes"; proposal: ChangeProposal };
export type JobStatus = "queued" | "running" | "waiting_inputs" | "waiting_user" | "succeeded" | "failed";
export type PipelineProgress = {
  stage: "download" | "analysis" | "compare" | "merge" | "document" | "complete";
  apps: { appId: string; title: string; download: { status: "pending" | "running" | "completed" | "failed"; bytes: number; totalBytes?: number; source?: string; message?: string }; analysis: "pending" | "running" | "completed" | "failed" | "skipped" }[];
  steps: { id: string; label: string; status: "pending" | "running" | "completed" | "failed" | "waiting" }[];
  modelCalls?: number;
};
export type Job = { resumable?: boolean; id: string; projectId: string; type: "research" | "design" | "detail" | "change" | "confirm" | "restore" | "build"; status: JobStatus; phase: string; createdAt: string; updatedAt: string; result?: unknown; error?: { code: string; message: string }; missingInputs?: string[]; progress?: PipelineProgress; internalJobId?: string };
export type EmulatorSession = { id: string; projectId: string; buildId: string; apkSha256: string; status: "starting" | "ready" | "failed"; phase: string; width: number; height: number };
export type Build = { id: string; revision: string; designHash: string; status: JobStatus; artifacts: { name: string; url: string; sha256: string }[]; validation?: { build: boolean; unitTests: boolean; lint: boolean; runtimeVerified: boolean; visualVerified?: boolean; limitations: string[] } };
export type Project = {
  id: string; version: number; createdAt: string; updatedAt: string; brief: Brief;
  references: Record<string, MarketResult>; featurePreferences: { baseAppId?: string; selections: Record<string, string[]>; customRequests: FeatureRequest[] };
  designId: string | null; currentDesignRevision: string | null; approvedRevision: string | null;
  pendingDecision: Decision | null; lastJobId?: string; activeJobId: string | null; latestBuild: Build | null; lastDeliveredBuild?: Build;
  referencePreparationId?: string; referencePreparation?: { id: string; status: JobStatus; phase: string; progress?: PipelineProgress };
  baseUiReference?: BaseUiReferenceT; highLevelVersion?: number; highLevelDesign?: HighLevelDesign; highLevelFeedback?: string; needsResearch: boolean; needsDesign: boolean; design?: DesignView;
  designHistory?: { designId: string; revision: string }[];
};
export type ApiError = { error: { code: string; message: string; details?: string[] } };
