import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { projectServer } from "../../frontend/tests/project-fixtures";
import { workflowApi, Handoff, importSelection } from "../server/workflow";
import { SignalsStore } from "../server/signals";
import { fromScannerReport } from "../src/market";
import { scannerReport } from "./market-data";
import type { UserDocument, Project } from "../src/workflow";
import type { Middleware } from "../../backend/src/http";
import { handoffBody } from "../src/workflow";
import { emptyDraft } from "../src/state";

export const document: UserDocument = { language: "en", title: "Pocket Notes", summary: "Keep notes offline.", audience: "Students", features: [{ id: "feature-notes", title: "Quick notes", summary: "Write and save notes locally.", steps: ["Write a note", "Save and reopen it"], examples: [], caveats: [], refs: [] }], screens: [{ id: "home", title: "Home", purpose: "Open your notes.", refs: [] }], appearance: "Warm colors.", boundaries: ["One device, no account."], choices: [] };
export async function integrated({ outlineFailures = 0 } = {}) {
  const received: Project[] = [];
  const upstream = await projectServer({ highLevel: async p => { received.push(structuredClone(p)); if (outlineFailures-- > 0) throw new Error("Temporary outline failure"); return { document: structuredClone(document), response: "Review your outline." }; } });
  const signals = new SignalsStore(path.join(upstream.root, "meld-signals"));
  const snapshot = await signals.record(fromScannerReport("Notes & lists", scannerReport("Notes & lists")));
  const scan = { ...snapshot, apps: snapshot.apps.map(a => ({ ...a, listedFeatures: { items: [{ name: "Quick notes", detail: "Write and save notes offline." }], model: "fixture", template: "fixture", generatedAt: snapshot.generatedAt } })) };
  const draft = { ...emptyDraft(), name: "Pocket Notes", domains: ["Notes & lists"], goal: "An offline student notebook", selected: { "com.example.notes": ["com.example.notes:quick-notes"] }, market: { "Notes & lists": scan } };
  let handler!: Middleware;
  workflowApi({}, path.join(upstream.root, "frontend"), signals, upstream.service).configureServer({ middlewares: { use: h => { handler = h; } } });
  const server = createServer((req, res) => void handler(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { ...upstream, signals, scan, draft, received, address: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); await upstream.close(); } };
}
