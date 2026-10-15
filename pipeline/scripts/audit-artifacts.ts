import path from 'node:path';
import { json, write, fileSha, inside } from '../src/storage.js';
import { validateEvidence } from '../src/validate.js';

// The supplied review file records actual static-code inspection. This script
// checks the reviewed anchors and provenance; it cannot certify runtime behavior.
const run = path.resolve(process.argv[2]), review = await json(path.resolve(process.argv[3]));
const apps = await json(path.join(run, 'apps.lock.json')), errors: string[] = [], audited: any[] = [];
for (const app of apps) {
  const specPath = path.join(run, 'apps', app.id, 'app-spec.json'), spec = await json(specPath);
  const evidence = await json(path.join(run, 'apps', app.id, 'evidence.json'));
  errors.push(...await validateEvidence(run, evidence));
  const points: any[] = [];
  for (const [field, expected] of [['package_name', app.package_name], ['version', app.version], ['apk_sha256', app.sha256]]) {
    const matches = spec[field] === expected;
    if (!matches) errors.push(`Specification identity differs ${app.id}/${field}`);
    points.push({ id: `${app.id}-${field}`, source_path: path.relative(run, specPath), source_sha256: await fileSha(specPath), locator: `/${field}`, expected, matches, method_level: false, classification: 'APK identity cross-check' });
  }
  const selected = review.apps.find((entry: any) => entry.app_id === app.id);
  if (!selected || selected.methods.length < 2) { errors.push(`Two independently inspected methods required ${app.id}`); continue; }
  for (const point of selected.methods) {
    const e = evidence.find((entry: any) => entry.id === point.evidence_id);
    if (!e || !['inspect_android_method', 'apktool_smali_method'].includes(e.tool)) { errors.push(`Invalid method point ${app.id}/${point.evidence_id}`); continue; }
    const raw = await json(inside(run, path.join(run, e.result_path)));
    let value = raw;
    for (const part of e.locator.slice(1).split('/')) value = value?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const matches = point.matches === true && point.anchors.length > 0 && point.anchors.every((anchor: string) => text?.includes(anchor));
    if (!matches) errors.push(`Reviewed anchor changed ${app.id}/${point.evidence_id}`);
    points.push({ ...point, source_path: e.result_path, source_sha256: e.result_sha256, locator: e.locator, matches, method_level: true, selected_before_spec: false, raw_hash_verified: true });
  }
  audited.push({ app_id: app.id, spec_sha256: await fileSha(specPath), apk_sha256: app.sha256, points });
}
const result = { passed: errors.length === 0 && audited.length === apps.length, checked_at: new Date().toISOString(), reviewer: review.reviewer, scope: 'Retrospective static artifact sampling: three identity checks and at least two manually inspected method bodies per reference. Not runtime verification or proof of full-app behavior.', apps: audited, errors, runtime_verified: false };
await write(path.join(run, 'validation/artifact-audit.json'), result);
console.log(JSON.stringify({ passed: result.passed, errors, points: audited.map(app => ({ app_id: app.app_id, count: app.points.length })) }));
if (!result.passed) process.exitCode = 1;
