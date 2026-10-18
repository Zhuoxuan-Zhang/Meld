# Meld backend

The project API owns saved profiles, workflow jobs, research, initial conflict decisions, versioned design changes and Android build artifacts. Public contracts are in `shared/`; the analysis/design engine remains in `pipeline/`.

Run `npm run setup` and `npm run dev` from the repository root. To start only the API after installing/building the pipeline:

```bash
npm --prefix pipeline run build
npm --prefix backend run dev
```

The standard `npm run dev` launcher hosts the studio and project API together on port 4173. The standalone API command above uses port 3001 (`MELD_API_PORT` overrides it) and is optional. The integrated studio does not need a second API process.

See [project workflow and contracts](../docs/project-workflow.md) for routes, state, setup and verification. `src/adapters/` keeps compatibility with the earlier scanner/provider/design endpoints; new screens use the project API.

Market scans match the studio's expanded search: 90 candidates by default (`MELD_MARKET_CANDIDATES` overrides it), with up to 200 ranked results preserved in immutable snapshots. Legacy reports containing only `top_five` still work. Confirmed search phrases have separate cache entries and can span store categories. Research summarizes listings in batches of five; this batch size does not limit the number of reference results.

The design selection template lives in [`frontend/prompts/design-selection/prompt.md`](../frontend/prompts/design-selection/prompt.md). Keep exactly one `{{selection_json}}` placeholder. The pipeline adapter fills it with the app brief, selected feature IDs/names/descriptions, and their reference package IDs. Explicit reference choices stay separate from other ranked apps supplied for analysis. Only selected features enter the request block. Core tasks follow those features, or the app brief when no features are selected.

The rendered template is saved as `brief.scope`. It reaches APK analysis, comparison, design, review, document revisions, and the approved build input. REA provides static APK evidence; Claude Code CLI handles reasoning and design by default. Model review checks each selection for a design mapping or an explicit gap. This remains prompt guidance, not a strict feature-inclusion guarantee.

Template edits apply to new analysis runs without restarting the server. A retry reuses its saved brief. Scope is bounded at 20,000 characters through revision storage. User descriptions remain preferences and never establish source-app behavior or runtime verification.

Android screenshot comparison and bounded UI repair can be enabled with `MELD_UI_VALIDATION_CONFIG`; reference capture uses `MELD_REA_OBSERVATION_CONFIG`. See [REA UI observation](../docs/rea-ui-observation.md) for scenario plans, evidence replay and native-analysis boundaries.

An opt-in device harness can be selected with `MELD_NATIVE_SMOKE_PROJECT`, `MELD_NATIVE_SMOKE_ADB`, `MELD_NATIVE_SMOKE_SERIAL`, `MELD_NATIVE_SMOKE_SCRIPT` and `MELD_NATIVE_SMOKE_OUTPUT`. The default script remains the puzzle regression. Scripts receive the exact APK path and generated package ID, plus `MELD_ANDROID_ADB`, `MELD_ANDROID_SERIAL` and `MELD_NATIVE_QA_OUTPUT`; a passing `runtime-report.json` must match the APK hash and package. `frontend/tests/image-editor-native.py` provides the image-editor regression and requires Python Pillow; saved fixtures can be supplied with `MELD_IMAGE_EDITOR_FIXTURES`.

Build gates run in this order: Gradle compilation/unit tests/lint, implementation review, configured device regression, configured screenshot comparison, then hash-checked publication. A rejected implementation cannot reach device checks. Split-file repairs can remove obsolete generated modules, and interrupted-run recovery preserves recorded native and visual failures.

Build generation and implementation review default to Claude Code. Set `MELD_BUILD_PROVIDER=codex_cli` and optionally `MELD_CODEX_BUILD_MODEL=gpt-6.1-sol` to select the existing ChatGPT-authenticated Codex CLI explicitly. This does not change saved design provenance or the provider used for new outlines. Screen comparison selects its provider/model separately in the UI validation config. Provider quota errors preserve reset information and saved progress; they are not retried as malformed model output.
