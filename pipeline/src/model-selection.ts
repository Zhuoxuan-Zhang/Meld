import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
const Selection = z.object({ provider: z.enum(['codex_cli', 'claude_cli']), model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/), effort: z.enum(['low', 'medium', 'high']) }).strict();
export type ModelSelection = z.infer<typeof Selection>;
export const modelSelectionContext = new AsyncLocalStorage<ModelSelection | null>();
export function selectedModel(): ModelSelection | null {
  const context = modelSelectionContext.getStore();
  if (context !== undefined) return context;
  return process.env.MELD_MODEL_SELECTION ? Selection.parse(JSON.parse(process.env.MELD_MODEL_SELECTION)) : null;
}
export function selectedModelConfig(config: any, selection = selectedModel()) {
  return selection ? { ...config, provider: selection.provider, model: selection.model, design_model: selection.model, reasoning_effort: selection.effort, design_reasoning_effort: selection.effort, pricing: { source: 'User-selected CLI account; subscription charges are unknown, not API-dollar estimates' } } : config;
}
