import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { currentWorker, workerIsAlive } from '../../backend/src/worker';

test('worker recovery distinguishes live, dead and reused local process identities', async () => {
  const owner = currentWorker();
  expect(workerIsAlive(owner)).toBe(true);
  expect(workerIsAlive(undefined)).toBe(false);
  expect(workerIsAlive({ pid: -1 })).toBe(false);
  if (owner.start) expect(workerIsAlive({ ...owner, start: 'different-process-start' })).toBe(false);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    expect(workerIsAlive({ pid: child.pid! })).toBe(true);
  } finally {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }
  expect(workerIsAlive({ pid: child.pid! })).toBe(false);
});
