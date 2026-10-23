import { z } from "../../pipeline/dist/src/integration.js";
import { modelChoices } from "../../shared/model-selection";

// Capture a choice for the lifetime of a request and its queued background work.
// Never mutate process.env when a user switches models.
export { modelSelectionContext, selectedModel, selectedModelConfig } from "../../pipeline/dist/src/integration.js";
export const ModelSelectionInput = z.object({
  provider: z.enum(["codex_cli", "claude_cli"]),
  model: z.string().min(1).max(100),
  effort: z.enum(["low", "medium", "high"]),
}).strict().refine(value => modelChoices.some(model => model.provider === value.provider && model.id === value.model), "Choose a model from the selected provider.");
