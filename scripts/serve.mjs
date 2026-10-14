import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), frontend = path.join(root, "frontend");
if (existsSync(path.join(frontend, ".env.local"))) process.loadEnvFile(path.join(frontend, ".env.local"));
const args = process.argv.slice(2), preview = args.includes("--preview"), portIndex = args.indexOf("--port");
const frontendPort = portIndex >= 0 ? args[portIndex + 1] : process.env.MELD_PORT || "4173", apiPort = process.env.MELD_API_PORT || "3001";
const children = new Set(); let stopping = false;
function launch(args, cwd) {
  const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: "inherit" }); children.add(child);
  child.once("error", error => { console.error(error.message); shutdown(1); });
  child.once("close", code => { children.delete(child); if (!stopping) shutdown(code || 0); }); return child;
}
function shutdown(code) { if (stopping) return; stopping = true; for (const child of children) child.kill("SIGTERM"); setTimeout(() => { for (const child of children) child.kill("SIGKILL"); process.exit(code); }, 5000).unref(); }
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => shutdown(0));
async function status() { try { return await (await fetch(`http://127.0.0.1:${apiPort}/api/status`, { signal: AbortSignal.timeout(15000) })).json(); } catch { return null; } }
async function occupied() { return new Promise(resolve => { const socket = createConnection({ host: "127.0.0.1", port: Number(apiPort) }); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false)); socket.setTimeout(1000, () => { socket.destroy(); resolve(false); }); }); }
let ready = await status();
if ((ready && ready.service !== "meld-project-api") || (!ready && await occupied())) { console.error(`Port ${apiPort} belongs to another service. Set MELD_API_PORT to a free port.`); process.exit(1); }
if (!ready) {
  launch(["--import", path.join(root, "pipeline/node_modules/tsx/dist/loader.mjs"), path.join(root, "backend/src/server.ts")], root);
  for (let attempt = 0; attempt < 80 && !stopping; attempt++) { ready = await status(); if (ready) break; await new Promise(resolve => setTimeout(resolve, 250)); }
  if (!ready) { console.error("The project backend did not become ready."); shutdown(1); }
}
if (!stopping) launch([path.join(frontend, "node_modules/vite/bin/vite.js"), ...(preview ? ["preview"] : []), "--host", "127.0.0.1", "--port", frontendPort, "--strictPort", ...(args.includes("--open") ? ["--open"] : [])], frontend);
