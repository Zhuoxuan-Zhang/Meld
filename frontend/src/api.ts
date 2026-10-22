import type { Project, Job } from "../../shared/contracts";
export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}
export async function api<T>(url: string, body?: unknown, method = body === undefined ? "GET" : "POST", signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(result.error?.code || "request_failed", result.error?.message || "This request could not be completed.", response.status);
  return result;
}
export const projectUrl = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
export const action = (project: Project) => ({ requestKey: crypto.randomUUID(), expectedVersion: project.version });
type FeaturedProject = { id: string; name: string; summary: string; baseAppName: string | null };
export type Availability = { featuredProject?: FeaturedProject | null; featuredProjects?: FeaturedProject[]; emulatorAvailable?: boolean; backgroundReferencesAvailable?: boolean; available: boolean; exampleId: string | null; researchAvailable: boolean; designAvailable: boolean; buildAvailable: boolean };
export type ProjectList = { projects: { id: string; name: string; input: string; updatedAt: string }[] };
export type { Project, Job };
