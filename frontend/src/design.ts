import type { DesignView, ChangeProposal as DesignProposal } from "../../shared/contracts";
export type { DesignView, DesignProposal };
export type DesignConnection = { available: boolean; provider: string; model: string; exampleId: string | null; referenceFilesConfigured: boolean };
export type DesignJob = { id: string; kind?: string; status: "queued" | "running" | "waiting_inputs" | "succeeded" | "failed"; phase?: string; result?: DesignView | DesignProposal;
  missing_apps?: string[]; reference_apps?: { appId: string; title: string; rank: number }[]; error?: { code: string; message: string; status?: number } };
export class DesignRequestError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) { super(message); }
}
export async function designRequest<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new DesignRequestError(value.error?.code || "request_error", value.error?.message || "The design request could not be completed.", response.status);
  return value as T;
}
export const designUrl = (id: string) => `/api/design/designs/${encodeURIComponent(id)}`;
export function jobFailure(job: DesignJob) {
  if (job.error?.code === "stale_revision") return "The design changed while this suggestion was being prepared. Refresh the design and request a new suggestion.";
  if (job.error?.code === "missing_dependency") return "Select the related changes together before confirming.";
  if (job.error?.code === "interrupted") return "The request was interrupted. Your saved design has not changed; retry to continue.";
  return "This change could not be completed or validated. Your saved design is unchanged. You can revise the request and try again.";
}
