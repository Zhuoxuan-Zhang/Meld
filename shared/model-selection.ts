export type ModelSelection = {
  provider: "codex_cli" | "claude_cli";
  model: string;
  effort: "low" | "medium" | "high";
};
export const recommendedModel: ModelSelection = { provider: "codex_cli", model: "gpt-6.1-sol", effort: "medium" };
export const modelChoices = [
  { provider: "codex_cli", id: "gpt-6.1-sol", name: "GPT-6.1 Sol", note: "Recommended · performance and cost" },
  { provider: "codex_cli", id: "gpt-6-astra", name: "GPT-6 Astra", note: "Demanding reasoning and coding" },
  { provider: "codex_cli", id: "gpt-6-luna", name: "GPT-6 Luna", note: "Focused, lower-cost tasks" },
  { provider: "claude_cli", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", note: "Speed and intelligence" },
  { provider: "claude_cli", id: "claude-opus-5-5", name: "Claude Opus 5.5", note: "Long-running coding tasks" },
  { provider: "claude_cli", id: "claude-haiku-5-5", name: "Claude Haiku 5.5", note: "Fast, focused tasks" },
] as const;
export type ProviderConnection = { installed: boolean; loggedIn: boolean };
export type LoginAttempt = {
  id: string;
  provider: ModelSelection["provider"];
  status: "starting" | "waiting" | "succeeded" | "failed" | "cancelled";
  url?: string;
  code?: string;
  message?: string;
};
export type AccountStatus = {
  enabled: boolean;
  mode: "local";
  selection: ModelSelection | null;
  connections: Record<ModelSelection["provider"], ProviderConnection>;
  login: LoginAttempt | null;
};
