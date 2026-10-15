import type { ChildProcess } from "node:child_process";
import { trackOwnedProcess } from "../pipeline/dist/src/storage.js";

export const detachedProcessGroup = process.platform !== "win32";

// Launchers can leave a native child holding their output pipes. Each worker
// owns its own group, so cancelling it also stops those descendants.
export function stopProcessOnAbort(child: ChildProcess, signal: AbortSignal) {
  let closed = false;
  const stop = () => {
    if (closed) return;
    if (detachedProcessGroup && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    } else child.kill("SIGKILL");
  };
  const untrack = trackOwnedProcess(child, stop);
  const cleanup = () => { closed = true; signal.removeEventListener("abort", stop); untrack(); };
  child.once("error", cleanup);
  child.once("close", cleanup);
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
}
