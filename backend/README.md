# Meld backend

The project API owns saved profiles, workflow jobs, research, initial conflict decisions, versioned design changes and Android build artifacts. Public contracts are in `shared/`; the analysis/design engine remains in `pipeline/`.

Run `npm run setup` and `npm run dev` from the repository root. To start only the API after installing/building the pipeline:

```bash
npm --prefix pipeline run build
npm --prefix backend run dev
```

The standard `npm run dev` launcher hosts the studio and project API together on port 4173. The standalone API command above uses port 3001 (`MELD_API_PORT` overrides it) and is optional. The integrated studio does not need a second API process.

See [project workflow and contracts](../docs/project-workflow.md) for routes, state, setup and verification. `src/adapters/` keeps compatibility with the earlier scanner/provider/design endpoints; new screens use the project API.

The design selection template lives in [`frontend/prompts/design-selection/prompt.md`](../frontend/prompts/design-selection/prompt.md). Keep exactly one `{{selection_json}}` placeholder. The pipeline adapter fills it with the app brief, selected feature IDs/names/descriptions, and their reference package IDs. Explicit reference choices stay separate from other ranked apps supplied for analysis. Only selected features enter the request block. Core tasks follow those features, or the app brief when no features are selected.

The rendered template is saved as `brief.scope`. It reaches APK analysis, comparison, design, review, document revisions, and the approved build input. REA provides static APK evidence; Claude Code CLI handles reasoning and design by default. Model review checks each selection for a design mapping or an explicit gap. This remains prompt guidance, not a strict feature-inclusion guarantee.

Template edits apply to new analysis runs without restarting the server. A retry reuses its saved brief. Scope is bounded at 20,000 characters through revision storage. User descriptions remain preferences and never establish source-app behavior or runtime verification.
