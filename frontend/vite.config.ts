import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { suggestionsApi } from "./server/suggestions";
import { marketApi, marketOptionsFromEnv } from "./server/market";
import path from "node:path";
import { SignalsStore } from "./server/signals";
import { designApi } from "./server/design";
import { claudeApi, claudeOptionsFromEnv } from "./server/claude";
export default defineConfig(({ mode }) => {
  const env = {
    ...loadEnv(mode, process.cwd(), ""),
    ...process.env,
  } as Record<string, string>;
  const cache = path.join(process.cwd(), ".meld-cache");
  const signals = new SignalsStore(path.join(cache, "signals"));
  return {
    plugins: [
      react(),
      suggestionsApi(env),
      marketApi({ ...marketOptionsFromEnv(env, process.cwd()), onResult: result => signals.record(result) }),
      designApi({ root: path.join(cache, "designs"), signals, exampleId: env.MELD_DESIGN_EXAMPLE,
        pipeline: { directory: path.join(cache, "pipeline"), apkDir: env.MELD_APK_DIR && path.resolve(env.MELD_APK_DIR), toolRoot: env.MELD_PIPELINE_TOOL_ROOT && path.resolve(env.MELD_PIPELINE_TOOL_ROOT), config: env.MELD_PIPELINE_CONFIG && path.resolve(env.MELD_PIPELINE_CONFIG) } }),
      claudeApi(claudeOptionsFromEnv(env, process.cwd())),
    ],
    server: { watch: { ignored: ["**/.meld-cache/**"] } },
  };
});
