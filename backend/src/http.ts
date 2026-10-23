import type { IncomingMessage, ServerResponse } from "node:http";
import { WorkbenchError } from "../../pipeline/dist/src/integration.js";

export type Middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => void | Promise<void>;
export type ApiHost = { httpServer?: { once(event: "close", listener: () => void): unknown } | null; middlewares: { use: (middleware: Middleware) => void } };
export type ApiPlugin = { name: string; configureServer: (server: ApiHost) => void; configurePreviewServer?: (server: ApiHost) => void };
export function send(response: ServerResponse, status: number, data: unknown) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(data));
}
export async function readBody(request: IncomingMessage) {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new WorkbenchError("content_type", "Send a JSON request.", 415);
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 65536) throw new WorkbenchError("body_too_large", "This request is too long.", 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new WorkbenchError("invalid_json", "The request could not be read."); }
}
