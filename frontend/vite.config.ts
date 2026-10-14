import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const target = `http://127.0.0.1:${env.MELD_API_PORT || 3001}`;
  const proxy = { "/api": { target, changeOrigin: false } };
  return { plugins: [react()], server: { proxy, watch: { ignored: ["**/.meld-cache/**"] } }, preview: { proxy } };
});
