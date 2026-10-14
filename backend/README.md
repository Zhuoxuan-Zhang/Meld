# Meld backend

The project API owns saved profiles, workflow jobs, research, initial conflict decisions, versioned design changes and Android build artifacts. Public contracts are in `shared/`; the analysis/design engine remains in `pipeline/`.

Run `npm run setup` and `npm run dev` from the repository root. To start only the API after installing/building the pipeline:

```bash
npm --prefix pipeline run build
npm --prefix backend run dev
```

The default internal port is 3001 (`MELD_API_PORT` overrides it). Frontend requests use `/api` on port 4173 through Vite's proxy. The launcher stops its own child processes and preserves separately running API services.

See [project workflow and contracts](../docs/project-workflow.md) for routes, state, setup and verification. `src/adapters/` keeps compatibility with the earlier scanner/provider/design endpoints; new screens use the project API.
