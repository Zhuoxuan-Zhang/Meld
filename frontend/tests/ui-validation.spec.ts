import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { uiValidationEntry, uiReferenceContext, validateBuiltUi } from '../../backend/src/ui-validation';
import { ObservationPlan, write, fileSha } from '../../pipeline/dist/src/integration.js';
import { sha } from '../../pipeline/dist/src/storage.js';

const entry = { referenceDirectory: './reference', serial: 'emulator-test', vision: { provider: 'claude_cli', model: 'configured-model', reasoningEffort: 'medium' }, scenarios: [{ id: 'home', goal: 'Start the main task', steps: [] }] };

test('UI validation uses a project override before a base reference and resolves paths beside the config', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meld-ui-config-'));
  try {
    const file = path.join(directory, 'config.json');
    await write(file, { projects: { 'project-test': { ...entry, referenceDirectory: './project-reference' } }, bases: { 'example.base': entry } });
    expect((await uiValidationEntry(file, 'project-test', 'example.base'))?.referenceDirectory).toBe(path.join(directory, 'project-reference'));
    expect((await uiValidationEntry(file, 'another-project', 'example.base'))?.referenceDirectory).toBe(path.join(directory, 'reference'));
    expect(await uiValidationEntry(file, 'another-project', 'another.base')).toBeNull();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('required UI review rejects unmatched projects instead of silently disabling the gate', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meld-ui-required-'));
  try {
    const file = path.join(directory, 'config.json'); await write(file, { requireMatch: true });
    await expect(uiValidationEntry(file, 'unmatched')).rejects.toThrow('requires an original-app UI reference');
    expect(await uiValidationEntry(undefined, 'unmatched')).toBeNull();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('UI review configuration rejects arbitrary action scripts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meld-ui-actions-'));
  try {
    const file = path.join(directory, 'config.json');
    await write(file, { projects: { 'project-test': { ...entry, scenarios: [{ id: 'home', goal: 'Start', steps: [{ action: 'shell', command: 'arbitrary' }] }] } } });
    await expect(uiValidationEntry(file, 'project-test')).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('builds with a UI gate require observed originals before code generation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meld-ui-reference-'));
  try {
    const plan = ObservationPlan.parse({ packageName: 'example.original', apk: '/reference.apk', role: 'reference', scenarios: [{ id: 'home', goal: 'Start' }] });
    await write(path.join(directory, 'plan.json'), plan);
    await write(path.join(directory, 'manifest.json'), { version: 1, packageName: plan.packageName, apkSha256: sha('apk'), role: plan.role, planSha256: sha(JSON.stringify(plan)), createdAt: new Date().toISOString(), scenarios: [{ id: 'home', goal: 'Start', required: true, status: 'unavailable', visibleText: [] }], artifacts: [{ path: 'plan.json', sha256: await fileSha(path.join(directory, 'plan.json')) }], limitations: [], graphStatus: 'unavailable', runtimeStatus: 'unavailable' });
    await expect(uiReferenceContext({ ...entry, referenceDirectory: directory } as any)).rejects.toThrow('unavailable or incomplete');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a changed reference is rejected before device or model work starts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meld-ui-stale-'));
  try {
    await write(path.join(directory, 'manifest.json'), { changed: true });
    await expect(validateBuiltUi({ ...entry, referenceDirectory: directory } as any, '/unused.apk', 'example.candidate', path.join(directory, 'candidate'), {}, sha('previous manifest'))).rejects.toThrow('changed during this build');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
