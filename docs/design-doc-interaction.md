# Interactive design documents

The new default workspace and project-based routes are documented in [project-workflow.md](project-workflow.md). This document describes the underlying design engine and compatibility endpoints, which remain available behind the backend on the frontend’s `/api` proxy.

The design workflow is integrated into Kevin’s existing **Review** page. The detailed developer design remains authoritative. A model generates a shorter English explanation for ordinary users; changes become proposals that require confirmation before updating the detailed design. This checkout now lives directly at the workspace root, without a nested `repo/` folder.

## Run

Use Node **24** (minimum 22.19). From the repository root:

```bash
scripts/dev.sh --no-open
```

The script installs both packages and the market scanner. The frontend’s `dev`, `build` and `preview` commands compile the pipeline package first. For manual setup:

```bash
npm --prefix pipeline ci
npm --prefix frontend ci
npm --prefix frontend run dev
```

Open http://127.0.0.1:4173. Pick domains, select preferences, and continue to Review. **Generate design** saves the server’s market evidence and starts the APK analysis task. After a design exists, use settings or ordinary text, review the proposed changes, and confirm the selected suggestions.

## Notes example

Import an existing completed analysis run without changing its files:

```bash
cd pipeline
npm run import -- --run /path/to/completed-run --id notes \
  --implementation /path/to/android/docs/source-design.json \
  --screenshots /path/to/android/docs/screenshots
```

Set `MELD_DESIGN_EXAMPLE=notes` in `frontend/.env.local` and restart Meld. **Open Notes example** opens the generated explanation. The direct link is http://127.0.0.1:4173/?design=notes#/review and does not require selecting a sample app first. An imported example is explicitly separate from the current market selection.

The example in this checkout uses the actual existing Notes design based on Notally, Fossify Notes and Markor. It does not claim these apps were the current market Top 5. The supplied implementation design hash associates the baseline with the existing Android app. A changed design shows that implementation is pending; it does not modify or rebuild that app.

## Market → pipeline

`server/market.ts` publishes each successful scan through `SignalsStore`. The browser receives a `scanId`; it sends IDs rather than replacement evidence. Saved snapshots retain rankings, titles, metrics, observation times, collection status and warnings. Store descriptions and sample feature selections are explicitly market evidence and user preferences, respectively; neither is APK behavior evidence.

For one domain, all ranked apps, up to five, are passed to the analysis task. Multiple-domain results are deduplicated and limited to five, prioritizing explicitly selected references, then score, rank and package ID. Every scan remains in the handoff. More than five explicitly selected references requires a smaller selection.

Set `MELD_APK_DIR=/path/to/reference-apks`, with one standalone `<package.name>.apk` per selected app. Missing files produce persistent `waiting_inputs` tasks, not invented analysis or an unrelated demo fallback. **Check again** resumes after files become available. Configure the pinned REA toolchain with `npm --prefix pipeline run setup` and the required JDK, or use `MELD_PIPELINE_TOOL_ROOT` for an existing pinned tool installation. Package names and hashes must match the market handoff. Split APKs and malformed archives are rejected.

The source-only existing analysis pipeline is now in `pipeline/`, extended to accept one to five APKs. It performs the real static collection, specification, comparison, choice and developer-design stages. A completed developer design must pass its whole-design review before import. A nonzero CLI exit can still mean independent audit checks remain pending; the design task does not label that run `LIVE_E2E_PASSED` or claim an Android build.

## Frontend/backend contract

All routes use the same local server under `/api/design`. They are available in both Vite development and preview mode. Model work returns `202` with a persisted job; poll until `succeeded`, `failed`, or `waiting_inputs`.

| Route | Meaning |
| --- | --- |
| `GET /status` | Model availability and optional example ID |
| `POST /pipeline` | Server scan IDs + brief + feature preferences → analysis task |
| `POST /pipeline/{jobId}/resume` | Recheck missing reference files or resume an interrupted task |
| `GET /jobs/{jobId}` | Persisted progress, result or failure |
| `GET /designs/{id}` | Read current document, settings, artifacts and implementation status |
| `GET /designs/{id}?revision={rev}` | Read a historical version |
| `POST /designs/{id}/changes` | Interpret free text and/or structured edits into a proposal |
| `GET /designs/{id}/changes/{changeId}` | Read the saved, hash-verified proposal |
| `POST /designs/{id}/changes/{changeId}/apply` | Apply only confirmed change IDs |
| `GET /designs/{id}/references/{refId}?kind=feature&revision={rev}` | Resolve an exact developer reference |
| `GET /designs/{id}/revisions` | Read version history and provenance |
| `POST /designs/{id}/restore` | Create a new version with historical content |
| `GET /designs/{id}/build-input` | Export the authoritative approved design for app generation |
| `GET /designs/{id}/revisions/{rev}/artifacts/{name}` | Read a hash-verified artifact |

Pipeline input also accepts `feature_requests`: bounded `{id, name, description}` objects for selected store-listing features. Their IDs may include the package name and need not match the older sample catalog. They are user preferences, kept separately from server-owned market snapshots and APK findings. App-specific selections must refer to that app's feature ID prefix. Existing sample-ID clients remain compatible.

Example change request:

```json
{
  "base_revision": "v0001-example",
  "idempotency_key": "request-001",
  "text": "Pin important notes and use a deep green accent.",
  "edits": [{ "control_id": "primary-color", "value": "#246B4A" }]
}
```

A successful proposal returns `plan.disposition`: `proposal`, `clarification`, or `no_change`. Render each change’s `before`, `after`, `reason`, `impacts`, `refs` and dependencies. Confirm with `base_revision`, a new `idempotency_key`, and `selected_change_ids` taken from that proposal. Clarification answers become a new request; unrelated input has no apply action. Cancel does not publish a revision.

Use a unique key per action and the same body/key for retries. Reusing a key with different content fails. Stale revisions fail with `stale_revision`; refresh and request a new proposal. History is immutable; restoration creates another version. The browser persists design/job/proposal pointers and preserves free text through reloads. API request schemas are Zod objects in `pipeline/src/workbench/schemas.ts` and `frontend/server/pipeline.ts`; client types are in `frontend/src/design.ts`.

## App-generation boundary

`build-input` exports **the confirmed detailed JSON**, its brief, formal choices, revision/hash, market handoff and implementation status. A coding/build worker should consume this object instead of the readable summary or the legacy template’s `DESIGN.md`. `in_sync`, `pending_update`, and `untracked` indicate recorded design alignment, not runtime verification. **Export approved design** downloads that input.

This change implements the interactive design stage and its analysis/app-generation handoffs. It does not add a generic Android coding/build worker. Kevin’s existing browser preview remains available for projects without a linked developer design and is never presented as an Android APK.

## Storage and checks

All generated data stays in ignored `frontend/.meld-cache/`: `signals/` contains immutable scan snapshots; `pipeline/` contains requests, APK checks and analysis runs; `designs/<id>/` contains source snapshots, model attempts, proposals and immutable revisions. Model credentials stay on the server. The default design provider uses the existing Claude Code CLI login; no browser API key is required.

Proposals are compiled and checked **before** being shown. Confirmation applies those exact selected operations, validates references/choices/flows/acceptance/contrast, reviews consistency, and regenerates the readable projection. Blocking issues leave the current design intact. Jobs reconcile committed receipts after interruption. Original APK analysis and Android source are preserved. Model review assists validation; it is not proof of runtime behavior.

```bash
npm --prefix pipeline test
npm --prefix frontend test
./.venv/bin/python -m pip install -e '.[test]'
./.venv/bin/python -m unittest discover -s tests -v
```

Unit/API/browser tests use explicit synthetic model fixtures. The separate `frontend/tests/design-live.mjs` is opt-in: it uses the actual React UI, backend and Codex, and script-confirms a green-accent change in the `notes` workspace. It publishes a design version and consumes model usage; run intentionally. Screenshots and its report are written to `frontend/qa-screenshots/design/`. Live Google Play tests remain opt-in through `MELD_LIVE_MARKET=1`.

After merging the latest frontend and moving to the workspace root: 42 pipeline tests, 27 market-scanner tests, 80 frontend/API cases (including 12 interactive-design cases), and the production build pass. One browser-context teardown timed out in the full run and passed on an isolated rerun; 12 live Google Play cases remain skipped. The original live Notes check used seven real Codex calls to generate, review, change and re-explain the design; scripted confirmation published revision 2 with a green accent. Both saved revisions still validate after relocation and the original source hash is unchanged. The Top 5 runner contract uses a synthetic downstream fixture; fresh five-APK analysis and a generic Android build were not run.
