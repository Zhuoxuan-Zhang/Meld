import path from "node:path";
import { json, write, exists, semanticHash, WorkbenchError } from "../../../pipeline/dist/src/integration.js";
import { parseMarketResult } from "../../../shared/market";
import type { MarketResult } from "../../../shared/market";

// The frontend sends scan IDs, never its own replacement for market evidence.
export class SignalsStore {
  constructor(readonly directory: string) {}
  async record(input: MarketResult): Promise<MarketResult> {
    const { scanId: _scanId, ...result } = parseMarketResult(input);
    const apps = result.apps.filter(app => !app.retained);
    if (apps.length > 5) throw new Error("A scanner report may contain at most five apps");
    const snapshot = { ...result, apps };
    const scanId = `scan-${semanticHash(snapshot)}`;
    const file = path.join(this.directory, `${scanId}.json`);
    if (!(await exists(file))) await write(file, snapshot);
    return { ...snapshot, scanId };
  }
  async read(id: string): Promise<MarketResult> {
    if (!/^scan-[a-f\d]{64}$/.test(id)) throw new WorkbenchError("invalid_scan", "Refresh your market signals before creating a design.");
    let value;
    try { value = parseMarketResult(await json(path.join(this.directory, `${id}.json`))); }
    catch { throw new WorkbenchError("missing_scan", "This market scan is no longer available. Refresh it and try again.", 409); }
    const { scanId: _scanId, ...snapshot } = value;
    if (`scan-${semanticHash(snapshot)}` !== id) throw new WorkbenchError("changed_scan", "Market evidence changed. Collect a new scan.", 409);
    return { ...snapshot, scanId: id };
  }
}
