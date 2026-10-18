import { workflowApi } from "./server/workflow";
import { intentApi } from "./server/intent";
import path from "node:path";
import { designApi } from "./server/design";
import { SignalsStore } from "./server/signals";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { marketApi, marketOptionsFromEnv } from "./server/market";
import { claudeApi, claudeOptionsFromEnv } from "./server/claude";
export default defineConfig(({ mode }) => {
  const env = {
    ...loadEnv(mode, process.cwd(), ""),
    ...process.env,
  } as Record<string, string>;
  const cache = path.join(process.cwd(), ".meld-cache");
  const signals = new SignalsStore(path.join(cache, "signals"));
  const claude = claudeOptionsFromEnv(env, process.cwd());
  // Backend workers inherit the same CLI and login used for listing summaries.
  // Keep the summary model separate from the backend's model defaults.
  const claudeBinary = claude.locate();
  if (claudeBinary) process.env.MELD_CLAUDE_BIN = claudeBinary;
  if (claude.env.CLAUDE_CONFIG_DIR) process.env.CLAUDE_CONFIG_DIR = claude.env.CLAUDE_CONFIG_DIR;
  for (const key of ["MELD_BUILD_PROVIDER", "MELD_CODEX_BUILD_MODEL", "MELD_CLAUDE_BUILD_MODEL", "REA_ADB_PATH"]) if (env[key]) process.env[key] = env[key];
  return {
    plugins: [
      react(),
      intentApi(cache),
      workflowApi(env, process.cwd(), signals),
      marketApi({ ...marketOptionsFromEnv(env, process.cwd()), record: result => signals.record(result) }),
      designApi({ root: path.join(cache, "designs"), signals, pipeline: { directory: path.join(cache, "pipeline-jobs"), apkDir: env.MELD_APK_DIR || path.join(cache, "apks"), toolRoot: env.MELD_PIPELINE_TOOL_ROOT, config: env.MELD_PIPELINE_CONFIG, observationConfig: env.MELD_REA_OBSERVATION_CONFIG }, exampleId: env.MELD_DESIGN_EXAMPLE }),
      claudeApi(claude),
    ],
    // Compile output is imported by the server configuration. Watching each
    // emitted module causes overlapping restarts and permanent 504 responses.
    // Restart the launcher explicitly after changing backend implementation.
    optimizeDeps: { entries: ["index.html"] },
    server: { watch: { ignored: ["**/.meld-cache/**", "**/test-results/**", "**/playwright-report/**", "**/pipeline/dist/**"] } },
  };
});
