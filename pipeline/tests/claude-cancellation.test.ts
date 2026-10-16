import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeClaudeCli } from '../src/claude-cli.js';
import { stopOwnedProcesses } from '../src/storage.js';

let directory: string;
let pids: number[] = [];
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'meld-claude-cancel-test-'));
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  // Like the real CLI launcher, this fixture starts a child that inherits its
  // output pipes. Killing just the launcher would leave execution hanging.
  await writeFile(path.join(bin, 'custom-claude'), `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
fs.writeFileSync(path.join(process.env.MELD_TEST_CLAUDE_DIR, 'started.json'), JSON.stringify([process.pid, child.pid]));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  vi.stubEnv('MELD_TEST_CLAUDE_DIR', directory);
  vi.stubEnv('MELD_CLAUDE_BIN', path.join(bin, 'custom-claude'));
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
});
afterEach(async () => {
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
  pids = [];
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const request = { model: 'fixture', reasoning_effort: 'low', schema: {}, system: 'A test fixture.', prompt: 'Wait for cancellation.' };
async function started(_run: string) {
  await expect.poll(async () => {
    try { pids = JSON.parse(await readFile(path.join(directory, 'started.json'), 'utf8')); return pids.length; } catch { return 0; }
  }, { timeout: 5000 }).toBe(2);
}
async function stopped() {
  await expect.poll(() => pids.every(pid => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }), { timeout: 5000 }).toBe(true);
}

it('does not start the CLI for an already cancelled request', async () => {
  const controller = new AbortController(); controller.abort();
  const run = path.join(directory, 'cancelled');
  await expect(executeClaudeCli(run, request, 5000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  await expect(readFile(path.join(run, 'command.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform === 'win32')('cancellation stops the launcher and its child and settles promptly', async () => {
  const controller = new AbortController();
  const run = path.join(directory, 'running');
  const result = executeClaudeCli(run, request, 30000, controller.signal).catch(error => error);
  try {
    await started(run);
    controller.abort();
    expect(await result).toMatchObject({ name: 'AbortError' });
    await stopped();
  } finally { controller.abort(); await result; }
}, 10000);

it.skipIf(process.platform === 'win32')('server shutdown stops owned CLI descendants too', async () => {
  const run = path.join(directory, 'shutdown');
  const result = executeClaudeCli(run, request, 30000);
  try {
    await started(run);
    stopOwnedProcesses();
    expect((await result).execution).toMatchObject({ timedOut: false, signal: 'SIGKILL' });
    await stopped();
  } finally { stopOwnedProcesses(); await result; }
}, 10000);

it.skipIf(process.platform === 'win32')('timeout also stops descendants instead of leaving their pipes open', async () => {
  const run = path.join(directory, 'timeout');
  const result = executeClaudeCli(run, request, 3000);
  await started(run);
  expect((await result).execution).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
  await stopped();
}, 10000);
