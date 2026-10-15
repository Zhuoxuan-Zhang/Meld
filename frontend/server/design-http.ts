import type { IncomingMessage, ServerResponse } from "node:http";
type ApiHost = { httpServer?: { once(event: "close", listener: () => void): unknown } | null; middlewares: { use(fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): void } };
export type ApiPlugin = { name: string; configureServer(server: ApiHost): void; configurePreviewServer(server: ApiHost): void };
