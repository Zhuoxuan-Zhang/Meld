import path from 'node:path';
import { z, json, fileSha, write, collectObservation, compareObservations, ObservationPlan, ObservationVision, observationDesignContext, validateObservation, pipelineRoot, WorkbenchError } from '../../pipeline/dist/src/integration.js';

const Entry = z.object({
  referenceDirectory: z.string().min(1), serial: z.string().min(1), resetTask: z.boolean().optional(),
  scenarios: ObservationPlan.shape.scenarios,
  vision: ObservationVision,
}).strict();
const Configuration = z.object({ projects: z.record(z.string(), Entry).default({}), bases: z.record(z.string(), Entry).default({}), requireMatch: z.boolean().default(false) }).strict();
export type UiValidationEntry = z.infer<typeof Entry>;

export async function uiValidationEntry(file: string | undefined, projectId: string, baseAppId?: string): Promise<UiValidationEntry | null> {
  if (!file) return null;
  const config = Configuration.parse(await json(file));
  const entry = config.projects[projectId] || (baseAppId ? config.bases[baseAppId] : undefined);
  if (!entry && config.requireMatch) throw new WorkbenchError('ui_reference_missing', 'This build requires an original-app UI reference and matching scenario plan.', 422);
  if (!entry) return null;
  return { ...entry, referenceDirectory: path.resolve(path.dirname(file), entry.referenceDirectory) };
}

export async function uiReferenceContext(entry: UiValidationEntry) {
  const manifest = await validateObservation(entry.referenceDirectory);
  if (manifest.role !== 'reference' || manifest.runtimeStatus !== 'observed') throw new WorkbenchError('ui_reference_missing', 'The original app UI scenarios are unavailable or incomplete. Capture them before building with UI validation.', 422);
  return observationDesignContext(entry.referenceDirectory);
}

export async function validateBuiltUi(entry: UiValidationEntry, apk: string, packageName: string, directory: string, approvedDesign: unknown, referenceManifestSha256?: string) {
  if (referenceManifestSha256 && await fileSha(path.join(entry.referenceDirectory, 'manifest.json')) !== referenceManifestSha256) throw new WorkbenchError('ui_reference_changed', 'The original UI reference changed during this build. Start a new build with the intended reference.', 409);
  const observed = await collectObservation(path.resolve(process.env.MELD_PIPELINE_TOOL_ROOT || pipelineRoot), path.join(directory, 'candidate'), {
    packageName, apk, role: 'candidate', serial: entry.serial, install: true, resetTask: entry.resetTask, scenarios: entry.scenarios,
  });
  if (observed.apkSha256 !== await fileSha(apk)) throw new WorkbenchError('ui_apk_changed', 'UI observations do not match this build APK.', 422);
  const result = await compareObservations(entry.referenceDirectory, path.join(directory, 'candidate'), path.join(directory, 'comparison'), entry.vision, approvedDesign);
  if (referenceManifestSha256 && result.referenceManifestSha256 !== referenceManifestSha256) throw new WorkbenchError('ui_reference_changed', 'The original UI reference changed during comparison.', 409);
  await write(path.join(directory, 'ui-validation.json'), result);
  return result;
}
