import { selectedApps } from "./state";
import type { Draft } from "./state";
import { intentBrief } from "./intent";
export type { Project, Job, UserDocument } from "../../shared/contracts";

export function handoffBody(draft: Draft) {
  const apps = selectedApps(draft);
  if (!draft.name.trim()) throw new Error("Give your app a name first.");
  if (!apps.length || apps.length > 5) throw new Error("Choose one to five reference apps for this build.");
  if (apps.some(a => !a.market || !a.market.listedFeatures)) throw new Error("Choose live apps with completed feature summaries to build an Android app.");
  const scans = Object.values(draft.market || {}).filter(s => apps.some(a => s.apps.some(x => x.appId === a.id && !x.retained)));
  if (!scans.length || scans.some(s => !s.scanId) || apps.some(a => !scans.some(s => s.apps.some(x => x.appId === a.id && !x.retained)))) throw new Error("Rescan your domains to save the references for this build.");
  return {
    brief: { input: (draft.discoverySource !== "domains" ? intentBrief(draft.intent) : "") || draft.goal || draft.description || `Build ${draft.name} from the selected features.`, name: draft.name.trim(), audience: draft.audience, purpose: draft.description, goal: draft.goal, style: draft.style, domains: draft.domains },
    scanIds: scans.map(s => s.scanId!),
    references: apps.map(a => ({ appId: a.id, features: a.features.filter(f => draft.selected[a.id]?.includes(f.id)).map(({ id, name, description }) => ({ id, name, description })) })),
  };
}
export async function handoffKey(body: unknown) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body)));
  const hex = [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
