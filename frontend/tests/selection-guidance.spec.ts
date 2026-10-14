import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { write } from "../../pipeline/dist/src/integration.js";
import { DesignInput, renderSelectionScope, scopedCoreTasks } from "../../backend/src/adapters/pipeline";
import { fromScannerReport } from "../../shared/market";
import { scannerReport } from "./market-data";

const input = () => DesignInput.parse({ request_key: randomUUID(), scan_ids: ["scan-" + "a".repeat(64)],
  brief: { name: "My notes", audience: "People keeping personal notes", purpose: "Keep notes offline", goal: "Find my ideas", style: "sage" },
  preferences: [], requested_features: [], feature_requests: [] });

test("selection JSON preserves exact feature text without labeling other ranked apps as user choices", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meld-selection-prompt-"));
  const file = path.join(directory, "prompt.md");
  try {
    const chosen = { id: "com.example.notes:quick-notes", name: 'Notes with "quotes"', description: "Keep $& and {{selection_json}} as literal text.\nA second line." };
    const ignored = { id: "com.example.notes:unused", name: "Unselected feature", description: "Not part of this request." };
    const body = DesignInput.parse({ ...input(), requested_features: [chosen.id], preferences: [{ app_id: "com.example.notes", feature_ids: [chosen.id] }], feature_requests: [chosen, ignored] });
    const apps = fromScannerReport("Productivity", scannerReport("Productivity")).apps;
    await write(file, "{{selection_json}}");
    const selection = JSON.parse(await renderSelectionScope(body, apps, file));
    expect(selection.app).toEqual(body.brief);
    expect(selection.selected_features).toEqual([{ ...chosen, reference_package_ids: ["com.example.notes"] }]);
    expect(selection.selected_reference_apps.map((app: { package_id: string }) => app.package_id)).toEqual(["com.example.notes"]);
    expect(selection.analysis_reference_apps).toHaveLength(5);
    await write(file, "Updated guidance\n{{selection_json}}");
    expect(await renderSelectionScope(body, apps, file)).toMatch(/^Updated guidance\n/);
    await write(file, "Missing placeholder");
    await expect(renderSelectionScope(body, apps, file)).rejects.toThrow("exactly one");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("selected timer tasks replace the old notes default", () => {
  const body = DesignInput.parse({ ...input(), requested_features: ["timer"] });
  expect(scopedCoreTasks(body)).toEqual(["start", "pause", "resume", "reset", "complete session"]);
  const custom = { id: "custom-counter", name: "Tap counter", description: "Tap to increment a local total." };
  expect(scopedCoreTasks(DesignInput.parse({ ...input(), requested_features: [custom.id], feature_requests: [custom] }))).toEqual([custom.name]);
});

test("projects without feature selections derive tasks from the brief", async () => {
  const body = input(); body.brief.purpose = "A local focus timer"; body.brief.goal = "Complete a session";
  expect(scopedCoreTasks(body)).toEqual(["start", "pause", "resume", "reset", "complete session"]);
  expect(await renderSelectionScope(body, [])).toContain('"selected_features": []');
});
