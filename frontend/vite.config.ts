import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { suggestionsApi } from "./server/suggestions";
import { marketApi, marketOptionsFromEnv } from "./server/market";
export default defineConfig(({ mode }) => {
  const env = {
    ...loadEnv(mode, process.cwd(), ""),
    ...process.env,
  } as Record<string, string>;
  return {
    plugins: [
      react(),
      suggestionsApi(env),
      marketApi(marketOptionsFromEnv(env, process.cwd())),
    ],
    server: { watch: { ignored: ["**/.meld-cache/**"] } },
  };
});
