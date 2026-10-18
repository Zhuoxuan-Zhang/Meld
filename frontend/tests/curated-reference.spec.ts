import { test, expect } from "@playwright/test";
import { parseMarketResult as parseFrontend, buildCatalog } from "../src/market";
import { parseMarketResult as parseBackend } from "../../shared/market";
import { marketResult } from "./market-data";

for (const [side, parse] of [["frontend", parseFrontend], ["backend", parseBackend]] as const) {
  test(`${side} preserves curated APK provenance without inventing market signals`, () => {
    const source = marketResult("Minesweeper", { indexes: [1] });
    source.apps[0].provenance = "curated_apk";
    source.apps[0].score = 0;
    const restored = parse(JSON.parse(JSON.stringify(source)));
    expect(restored.apps[0].provenance).toBe("curated_apk");
    expect(restored.apps[0].score).toBe(0);
    expect(buildCatalog(["Minesweeper"], { Minesweeper: restored })[0].market?.provenance).toBe("curated_apk");
  });

  test(`${side} rejects zero market scores without explicit curated APK provenance`, () => {
    const source = marketResult("Minesweeper", { indexes: [1] });
    source.apps[0].score = 0;
    expect(() => parse(source)).toThrow("Invalid market app");
    expect(() => parse({ ...source, apps: [{ ...source.apps[0], provenance: "unknown" }] })).toThrow("Invalid market app");
  });
}
