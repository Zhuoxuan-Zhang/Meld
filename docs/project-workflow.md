# Project workspace and API

The default studio has three steps: **Describe your app → Review and customize → Get your app**. Its persistent sidebar shows the same app profile throughout. Market evidence, reference apps, conflict choices, design changes and Android builds belong to one server-owned project.

## Run from the repository root

Use Node 24 and Python 3.10+. Install with `npm run setup`, then run:

```bash
npm run dev
npm run build
npm test
```

Development serves the frontend at **http://127.0.0.1:4173** and the backend at **http://127.0.0.1:3001**. Vite proxies `/api` to the backend, so the browser uses one address. Set `MELD_API_PORT` in `frontend/.env.local` if 3001 is occupied; this workspace uses **3101**. `npm --prefix backend run dev` starts the API alone. Production should serve static frontend files and proxy `/api` through one HTTPS domain; 3001 is an internal port.

`frontend/` contains React and its typed API client. `backend/` owns HTTP routes, profiles, jobs, research and builds. `pipeline/` contains the existing analysis/design engine. `shared/` contains public contracts and catalog normalization. Compatibility exports and provider endpoints remain for existing integrations; the old four-step UI is available at `/?legacy=1`. The default UI does not call provider-specific APIs.

## Saved state and progress

The browser stores only the current project ID and temporary UI state. The server persists the brief, reference snapshots, selected/custom features, pending decisions, current/approved design revisions and latest build. Every mutation carries `expectedVersion`; outdated writes return `stale_project`. Actions also carry `requestKey`; retry the same body and key to reuse the saved job.

Long-running actions return HTTP **202** and a job. Poll `GET /api/jobs/{jobId}`. Status is `queued`, `running`, `waiting_inputs`, `waiting_user`, `succeeded` or `failed`. Errors use `{ "error": { "code": "...", "message": "..." } }`. Model work continues independently of the browser connection.

Research can scan two topics; the review suggests features from at most five ranked references. Selected references receive priority when the analysis worker chooses its five inputs. Initial APK analysis pauses after comparison. Users confirm saved option IDs before the engine generates its first design. Subsequent requests produce proposals or clarification; proposals do not publish revisions until selected changes are confirmed. The readable document is regenerated from the validated detailed design. History remains immutable, and restore publishes another revision. Profile snapshots preserve the corresponding brief/evidence/preferences for restoration.

## Public API

| Method and route | Purpose |
| --- | --- |
| `GET /api/status` | Workflow availability and optional example |
| `POST /api/projects` | Create from `{requestKey, brief}`; optional configured `exampleId` |
| `GET /api/projects` | List saved apps |
| `GET /api/projects/{id}` | Profile, document, pending decision and build |
| `PATCH /api/projects/{id}` | `{expectedVersion, brief?, featurePreferences?}` |
| `POST /api/projects/{id}/research` | `{requestKey, expectedVersion}` → market and listing-feature job |
| `POST /api/projects/{id}/design` | Analyze selected reference files and begin merge decisions |
| `POST /api/projects/{id}/changes` | Action fields plus `baseRevision`, `text`, `edits` |
| `POST /api/projects/{id}/decisions/{decisionId}/confirm` | Action fields plus `selections` or `baseRevision`/`selectedChangeIds` |
| `POST /api/projects/{id}/decisions/{decisionId}/dismiss` | Dismiss a change proposal using `expectedVersion` |
| `GET /api/projects/{id}/revisions` | History across project design lineages |
| `POST /api/projects/{id}/restore` | Action fields plus `baseRevision`, `targetRevision` |
| `POST /api/projects/{id}/builds` | Action fields plus the exact `revision` to approve/build |
| `GET /api/projects/{id}/build-input` | Authoritative detailed design, brief, choices and hash |
| `GET /api/projects/{id}/references/{refId}?kind=feature&revision={rev}` | Developer evidence for a document item |
| `GET /api/projects/{id}/artifacts/{revision}/{name}` | Verified design artifacts |
| `GET /api/projects/{id}/builds/{jobId}/artifacts/{name}` | Owned, hash-verified APK and build files |
| `GET /api/jobs/{jobId}` | Unified progress |
| `POST /api/jobs/{jobId}/resume` | Recheck reference files and resume analysis |

`brief` includes `input`, `name`, `audience`, `purpose`, `goal`, `style` and `domains`. Only `input` is required when creating it; other fields have defaults. Research can infer an English profile, search topics, category-specific `coreTasks` and applicable `requiredStates`. These optional brief fields also accept explicit product requirements; games are not forced through notes-only tasks. `featurePreferences` contains `selections` keyed by reference app ID and `customRequests` as `{id, name, description}`. Public change proposals contain explanations and IDs; compiled patch operations remain internal.

## APK analysis and Android builds

Set `MELD_APK_DIR` to standalone `<package.name>.apk` files. Missing files produce resumable `waiting_inputs`; market listings never substitute for static APK evidence. Automatic store APK acquisition is not implemented. Configure pinned REA tools with `npm --prefix pipeline run setup`, or point `MELD_PIPELINE_TOOL_ROOT` at an existing installation.

The build worker plans small Kotlin modules and generates each file separately from the approved detailed revision. It runs Gradle `assembleDebug`, `testDebugUnitTest` and `lintDebug`, then reviews the compiled implementation against the design. Repairs update affected files while retaining unchanged modules. Interrupted generation can resume an ordered checkpoint for the same revision and design hash. It checks that tests actually ran, validates the APK archive and publishes hashes. Standard Gradle/manifest scaffolding is supplied; application feature code is generated from the design. Each attempt has its own source directory and logs.

Configure `MELD_ANDROID_SDK` (SDK 35) and `JAVA_HOME` (JDK 17+). The worker produces a **debug APK**. Passing model review and Gradle checks does not establish full runtime behavior; build reports and the UI distinguish device verification. Existing Android source and imported analysis are preserved. A changed design invalidates approval, and an earlier APK is not presented as the current design's result.

All runtime data lives in ignored `frontend/.meld-cache/`. Projects/jobs/profile snapshots/builds are under `workflow/`; validated design workspaces are under `designs/`. Server model calls use the existing Codex CLI login. Credentials and generated run artifacts are excluded from Git.

## Verification

```bash
npm --prefix pipeline test
npm --prefix frontend test
./.venv/bin/python -m unittest discover -s tests -v
```

API/browser tests use explicit synthetic research, model and build providers. `frontend/tests/projects-live.mjs` is an opt-in browser test that forks the real Notes design, confirms a color change with real Codex, builds with the real Android worker and downloads the APK. It consumes model usage and publishes an owned project. Set `MELD_LIVE_PROJECT` to resume the build check for an already-confirmed test project. Reports/screenshots go to ignored `frontend/qa-screenshots/project-flow/`. Live Google Play tests remain opt-in.

### Local verification, 14 October 2026

- Production frontend build and backend typecheck passed.
- 44 pipeline tests, 94 frontend/API/browser tests and 27 scanner tests passed. Twelve opt-in live store tests were skipped. Targeted project API/browser checks were rerun after workflow and recovery changes.
- Real Codex generated a habit-tracker profile and listing summaries for two live store searches. The analysis handoff selected five reference packages, preserved a custom gentle-restart feature and survived browser reload in `waiting_inputs` because their APKs were unavailable.
- Real Codex proposed and confirmed a brown accent revision in a separate Notes workspace. Original source-design hashes stayed unchanged.
- The live Android attempt failed implementation review; a subsequent attempt reached the old model timeout. A further retry uses the saved implementation, higher reasoning effort and a longer time allowance. APK compilation and device behavior have **not** been established by these checks. Synthetic build tests validate orchestration, ownership and downloads, not a real generated app.

Current live progress belongs to saved jobs; consult the delivery page and build report rather than treating this verification snapshot as a successful APK result.

See [the three-game run](puzzle-trio-run.md) for the curated 2048, Antimine and LibreSudoku experiment, source-analysis scopes and runtime verification results.

### Market references and feature confirmation

After research, the review page immediately shows up to five distinct live reference apps, ordered by market-signal score (then scanner rank). The order stays fixed while the user selects features. Every available listing feature is shown under its source app, with listing links, score, rating and explicit feature provenance. These are scanner recommendations, not store chart positions; partial results and keyword fallbacks remain labeled.

Users select features, customize their names and behavior, or add free-text features before clicking **Confirm features and generate design**. The frontend saves preferences through `PATCH /api/projects/:id`, then starts `POST /api/projects/:id/design`. A customized listing feature retains its source feature ID and APK preference; its custom request overrides the original wording in the backend's requested features. Research itself never starts design generation. Design conflicts, when present, are resolved within the same review page.

### Best-effort reference acquisition and simple progress

Design jobs check local APKs, then automatically obtain missing references from Aptoide. Acquisition is best effort: unavailable APKs never pause the workflow. Successfully obtained APKs enter the static pipeline; all selected features and all reference listings remain in the design brief. If no APK is available, or static analysis stops before a valid design exists, a separate market-assisted synthesis run continues using store descriptions, user requests and any individually validated, completed APK specifications. Original failed attempts are preserved. Market-assisted designs do not claim static or runtime verification for unavailable references; their provenance and validation are saved separately from APK end-to-end checks.

The browser shows only five stages: **Get reference apps → Review reference apps → Compare features → Merge the design → Write your design document**. No per-app download list, byte counters or retry step appears in the normal flow. `GET /api/jobs/:id` retains per-app diagnostics for development, including `skipped` analysis status. The pipeline freezes its APK input set once analysis begins so a later download cannot change references during conflict confirmation.

`MELD_APK_AUTO_DOWNLOAD=false` disables network acquisition. `MELD_AAPT` selects the manifest inspection executable, defaulting to SDK `build-tools/35.0.0/aapt2`. Downloads retain restricted HTTPS hosts, three-minute timeouts, a 256 MiB limit, source size/MD5 verification, manifest package checks and SHA-256 provenance. Mirror trust labels are not independent publisher signature verification. [Aptoide API documentation](https://ws2.aptoide.com/api/7/app/getMeta?info=1).
