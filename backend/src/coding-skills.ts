import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z, pipelineRoot, json, fileSha, semanticHash, WorkbenchError, exists, write } from '../../pipeline/dist/src/integration.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const Manifest = z.object({
  version: z.literal(1), stage: z.literal('coding'),
  toolchain: z.object({ compileSdk: z.literal(35), composeBom: z.literal('2025.05.01'), navigation3: z.literal(false) }).strict(),
  upstream: z.object({ repository: z.literal('https://github.com/android/skills'), commit: z.string().regex(/^[a-f0-9]{40}$/), license: z.string().min(1) }).strict(),
  skills: z.array(z.object({ id: z.enum(['edge-to-edge', 'adaptive', 'jetpack-compose-performance']), profile: z.string().min(1), source: z.string().url() }).strict()).length(3),
  files: z.record(z.string(), digest),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.skills.map(s => s.id)).size !== 3 || value.skills.some(s => !value.files[s.profile])) ctx.addIssue({ code:'custom', message:'Every coding skill needs one bound compatibility profile.' });
});
export async function loadCodingSkills(directory = path.join(pipelineRoot, '../backend/skills')) {
  const manifest = Manifest.parse(await json(path.join(directory, 'manifest.json'))), root = await fs.realpath(directory);
  for (const [name, digest] of Object.entries(manifest.files)) {
    const file = path.resolve(directory, name), relative = path.relative(path.resolve(directory), file);
    if (path.isAbsolute(name) || relative.startsWith('..') || !relative || (await fs.lstat(file)).isSymbolicLink() || !path.relative(root, await fs.realpath(file)) || path.relative(root, await fs.realpath(file)).startsWith('..') || await fileSha(file) !== digest) throw new WorkbenchError('coding_skill_changed', 'The pinned coding skills changed. Restore their snapshot or create an intentional new profile version.', 409);
  }
  const profiles = await Promise.all(manifest.skills.map(async skill => {
    const text = await fs.readFile(path.join(directory, skill.profile), 'utf8');
    if (text.length > 16000) throw new WorkbenchError('coding_skill_invalid', 'A coding skill profile exceeds its context budget.', 422);
    return text;
  }));
  return { fingerprint: semanticHash(manifest), manifest, instructions: 'Apply these coding-only compatibility profiles to the approved UI design. They do not authorize redesigning the product or changing the supplied build dependencies. Base UI design and explicit user choices remain authoritative.\n\n' + profiles.join('\n\n') };
}
export async function pinCodingSkills(directory: string, snapshot: Awaited<ReturnType<typeof loadCodingSkills>>) {
  const file = path.join(directory, 'coding-skills.json');
  if (await exists(file)) {
    const previous = await json(file);
    if (previous.fingerprint !== snapshot.fingerprint || semanticHash(previous.manifest) !== snapshot.fingerprint) throw new WorkbenchError('coding_skill_changed', 'This build already started with another coding skill snapshot. Start a new build to use updated skills.', 409);
  } else await write(file, { fingerprint: snapshot.fingerprint, manifest: snapshot.manifest });
  return { fingerprint: snapshot.fingerprint, stage: snapshot.manifest.stage, skills: snapshot.manifest.skills, upstream: snapshot.manifest.upstream, toolchain: snapshot.manifest.toolchain };
}
