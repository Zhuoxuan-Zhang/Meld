import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DesignService, pipelineRoot } from "../../pipeline/dist/src/integration.js";
import { designApi } from "../server/design";
import { SignalsStore } from "../server/signals";
import { FixtureModel, sourceFixture } from "../../pipeline/tests/fixtures/workbench";
import type { PipelineRunner } from "../server/pipeline";
export async function designServer(options: { runner?: PipelineRunner; apkDir?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "meld-design-test-")); const model = new FixtureModel();
  const service = new DesignService(pipelineRoot, path.join(root, "designs"), model), signals = new SignalsStore(path.join(root, "signals"));
  await sourceFixture(path.join(root, "run")); await service.initialize("notes", path.join(root, "run"), {}, path.join(root, "run/final/final-design.json"));
  const plugin = designApi({ root: service.store.root, service, signals, available: true, exampleId: "notes", pipeline: { directory: path.join(root, "pipeline"), runner: options.runner, apkDir: options.apkDir } });
  let middleware!: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  (plugin.configureServer as (server: unknown) => void)({ middlewares: { use(handler: typeof middleware) { middleware = handler; } } });
  const server = createServer((req, res) => { void middleware(req, res, () => { res.statusCode = 404; res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { root, address, service, signals, model, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}
