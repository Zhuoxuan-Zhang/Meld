import { readFileSync } from 'node:fs';

export type WorkerOwner = { pid: number; start?: string };
function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  } catch { return undefined; }
}
const owner: WorkerOwner = { pid: process.pid, start: processStart(process.pid) };
export const currentWorker = (): WorkerOwner => ({ ...owner });

// Recovery runs in both the integrated studio and the optional API server.
// A job owned by a live local worker is still running, not interrupted.
export function workerIsAlive(worker: WorkerOwner | undefined): boolean {
  if (!worker || !Number.isSafeInteger(worker.pid) || worker.pid < 1) return false;
  try { process.kill(worker.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  const start = processStart(worker.pid);
  return !worker.start || !start || worker.start === start;
}
