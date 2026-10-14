# Meld — a local app studio demo

The [interactive design document](../docs/design-doc-interaction.md) is now integrated into Review. It supports real pipeline output, a readable English explanation, feature settings and free text, selectable proposals, confirmation, version recovery and approved developer-design exports. It uses the server’s Codex CLI login separately from optional OpenRouter planning. Market results are handed off as server-owned scan IDs; actual APK files are required for the analysis stage.

Choose domains (suggested ones or any words you type), see the hot apps in them from live Google Play market signals with the features their store listings describe, get an AI suggestion for combining features, review the plan, and export an interactive browser demo. You can also select features yourself.

## Run locally

From the repository root, one command sets everything up and opens Meld in your browser:

```sh
scripts/dev.sh
```

It installs the frontend dependencies when they are missing or out of date, sets up the market-signal scanner (new_app_agent) in its own `.venv`, starts the local server at **http://127.0.0.1:4173** and opens it. It is safe to run again: when Meld is already running it just opens the page. The server binds to this computer only; press Control-C to stop it.

| Command | What it does |
| --- | --- |
| `scripts/dev.sh` | Set up what is missing, start Meld, open the browser |
| `scripts/dev.sh --restart` | Replace a Meld server that is already running |
| `scripts/dev.sh --no-open` | Start without opening the browser |
| `scripts/dev.sh --check` | Set up, then run the test suite |
| `MELD_PORT=4180 scripts/dev.sh` | Use another port |

Requirements: Node.js 22.19+ (nvm is loaded automatically when `node` is not on your PATH) and, for market signals, Python 3.10+ or [uv](https://docs.astral.sh/uv/). Without Python, Meld still runs and shows its sample apps.

The same steps by hand, from the repository root:

```sh
npm --prefix pipeline ci
cd frontend
npm ci
npm run setup:market
npm run dev
```

On this Mac, you can also double-click **Start Meld.command**.

## What works

- Six suggested domains and free-text domains: anything you type is scanned as typed. Only a suggested domain's own name (in any case) becomes that suggested domain. Case-insensitive duplicate detection and input validation.
- Live market signals: the top five Google Play apps for each chosen domain, including custom ones, with rank, opportunity score, rating, installs, business model and recent review activity. Scans start as soon as a domain is chosen, can be rescanned or retried per domain, and are cached on this computer for 24 hours.
- App images: each live app shows its real Google Play icon on cards and app pages, and its first four screenshots on its app page. Your browser loads small copies straight from Google's image server (`play-lh.googleusercontent.com`, without sending a referrer); links to any other site are ignored. If an image does not load, the app's first letter is shown instead.
- Store-listing features: your own Claude Code summarizes each scanned app's Google Play description into three to six high-level features. They are the features you choose from on the app cards and app pages, and they go into `DESIGN.md` and AI suggestions.
- A fixed collection of 18 sample apps when the scanner is not set up or a scan finds nothing, domain filters, and search by app, developer, store description or feature.
- Live AI feature combinations through a local OpenRouter endpoint. Each plan includes a concept, feature reasons, and a shared user journey.
- One-click plan approval, undo, retry, cancellation, and six clearly labeled offline example plans.
- Feature selection, expandable user journeys, bulk selection, and persistent choices.
- Separate Select all / Deselect all controls. Catalog actions affect shown apps; the selection panel can clear the whole mix.
- Search, domain filters, and catalog scroll position survive a trip to an app's detail page.
- A selection panel, per-app review, and merging repeated features while preserving their sources.
- App name, audience, purpose, and three visual styles.
- Interactive preview, opening the demo in a new tab, and downloading a ZIP.
- README and design document previews and downloads.
- A complete export: `index.html`, `README.md`, `DESIGN.md`, individual `designs/*.md`, and `project.json`.
- Keyboard navigation, responsive layouts, readable colors, route guards, and clear empty states.

The exported demo supports 16 feature types. These include a focus timer, garden, tasks, habits, notes, breathing, journaling, workouts, goals, flashcards, reading lists, budgets, expenses, idea boards, bookmarks, and progress summaries. The exported `index.html` runs offline without dependencies.

## Market signals

Meld's local server runs the new_app_agent scanner (`python -m app_market scan`) for each chosen domain and reads its JSON report. The scanner needs no API key or account; it reads public Google Play listings and reviews, so it needs a network connection. A first scan takes about 5–15 seconds.

| Domain | Google Play genre | Search phrases |
| --- | --- | --- |
| Productivity | PRODUCTIVITY | to do list, notes, focus timer |
| Wellness | HEALTH_AND_FITNESS | meditation, mindfulness, mood tracker |
| Learning | EDUCATION | language learning, flashcards, learn |
| Finance | FINANCE | budget planner, expense tracker, personal finance |
| Fitness | HEALTH_AND_FITNESS | workout, fitness tracker, running |
| Creativity | ART_AND_DESIGN | drawing, graphic design, mood board |
| Custom tags | none | the tag itself |

The mapping lives in `src/market.ts`. Each scan collects up to 30 candidates in the US English store.

**Selectable features come from the store listing.** Once Claude Code has summarized an app's listing, its features are the choices. Until then, or without Claude Code, an app offers only Meld's sample features whose words appear in its title or summary, so a game never shows note-taking features; an app whose listing mentions none shows no features. Sample features you already chose stay when the summary arrives. The browser demo builds only Meld's built-in features: a chosen listing feature appears in the demo as described but not built, and `DESIGN.md` marks its user journey as still to be designed.

**What stays honest.** The opportunity score (1–15) is the scanner's proxy from public listing data, not revenue. A scan with failed requests or fewer than five matches is labeled as such. Apps that drop out of a rescan stay visible while they have selected features, and plans that no longer fit the shown apps are cleared. Selected live apps, their market evidence and the scan metadata are included in `DESIGN.md`, the per-app briefs and `project.json`.

Local endpoints: `GET /api/market/status` and `POST /api/market/scan` with `{"domain": "Finance", "refresh": false}`. The browser sends at most two scans at a time and shows the others as waiting; the server also runs at most two at once. Results are cached in `frontend/.meld-cache/`, which Git ignores. An app that ranks in two chosen domains is listed once and appears under both domain filters.

Optional settings in `.env.local` or the shell:

```dotenv
# Another scanner checkout, or a Python that has app_market installed.
# Default: the repository that contains this folder when it is new_app_agent,
# otherwise ../third_parties/new_app_agent.
MELD_MARKET_DIR=
MELD_MARKET_PYTHON=
# Candidates per scan (5–200) and cache lifetime.
MELD_MARKET_CANDIDATES=30
MELD_MARKET_CACHE_HOURS=24
```

## Store-listing features (Claude Code)

Google Play has no feature list, only the developer's free-text description. Meld's local server sends the five descriptions of each scanned domain to your own Claude Code in non-interactive mode (`claude -p`), on your Claude subscription, and shows the features it returns. One call per domain takes about 5–15 seconds.

- **Stored prompt template.** The prompt lives in `prompts/app-features/`: `system.md`, `prompt.md` (with `{{domain}}` and `{{apps}}`) and `schema.json` (the required JSON shape). Its id, such as `app-features@83dbcfb1bca3`, names the folder and a hash of the three files, so any edit is a new template.
- **Fixed command.** `claude -p --safe-mode --setting-sources "" --tools "" --strict-mcp-config --no-session-persistence --output-format json --model claude-haiku-5-5 --effort low --system-prompt <system.md> --json-schema <schema.json>`, with the filled-in prompt on standard input. Claude gets no tools, and no hooks, plugins, MCP servers, CLAUDE.md or settings files are loaded, so store text cannot make it act on your computer and your personal Claude Code settings do not change results. `--dangerously-skip-permissions` is not needed: there are no tools to approve.
- **Reproducible results.** Each run is saved in `.meld-cache/features/` with the template id, model, exact command, filled-in prompt, raw output and cleaned features. The same template, command, model and listings return the saved result instead of a new run. Each feature also records its model and template id, shown on the app page and in `DESIGN.md`.
- **Honest labels.** These are what each developer says about the app, not verified analysis. REA can verify them later.

Meld finds `claude` on your PATH, in `~/.local/bin`, `~/.claude/local`, Homebrew, npm or nvm folders. Settings in `.env.local`:

```dotenv
# The CLI, if Meld cannot find it.
MELD_CLAUDE_BIN=
# Which login: the CLAUDE_CONFIG_DIR of a logged-in Claude Code account,
# for example the folder an alias like `CLAUDE_CONFIG_DIR=~/.claude claude` uses.
MELD_CLAUDE_CONFIG_DIR=
MELD_CLAUDE_MODEL=claude-haiku-5-5
```

Check a login with `CLAUDE_CONFIG_DIR=<folder> claude auth status`. Without Claude Code, or when it is not logged in, Meld says so in the market panel and on each app page, and offers only the sample features each listing mentions. Endpoints: `GET /api/claude/status` and `POST /api/claude/features` with `{"domain": "Finance", "apps": [{"appId", "title", "summary", "description"}], "refresh": false}`; at most two runs at once.

## Connect AI suggestions

Create `frontend/.env.local` from `.env.example`, add your OpenRouter key, and restart the local server:

```dotenv
OPENROUTER_API_KEY=your-key-here
MELD_AI_MODEL=nvidia/nemotron-3-super-120b-a12b:free
```

The model setting is optional. The default uses a free OpenRouter model; provider availability and limits still apply. You can choose another OpenRouter model that supports structured JSON outputs. Existing shell variables take precedence over `.env.local`.

The key stays on the local server. Do not prefix it with `VITE_` or put it in browser storage. `.env.local` is ignored by Git. The key is never included in the browser bundle or project downloads.

Click **Suggest a combination** to send your goal, chosen domains, and the shown apps with their feature IDs to OpenRouter. The app validates returned feature IDs before showing the plan. **Use this plan** applies the full mix and fills empty app-brief fields. It preserves a name or brief you already wrote. Suggestions do not change your selection until you apply them. **Undo** restores the prior mix. Manual feature edits clear the approved combination so an outdated plan is not exported.

Without a key or network connection, **Try an example** demonstrates the same approval flow. It is labeled **Example plan**, not AI. Unknown custom domains remain saved, but need a catalog domain before a feature plan can be suggested.

The local endpoints are `GET /api/ai/status` and `POST /api/ai/suggest`. They run with both `npm run dev` and `npm run preview`. Requests are bounded, cancelable, and limited to one concurrent generation per server. Provider failures leave the current selection unchanged.

## Demo boundary

Market signals are real when the scanner is set up: the shown apps and their numbers come from live Google Play data. Their features are Claude Code summaries of what each developer says in the store listing, or sample feature briefs matched to the listing where no summary exists. Neither is verified analysis of those apps. The fallback catalog is a curated example. AI feature planning is real when connected. REA analysis and autonomous coding are not connected. “Create my app” assembles a local browser template. It does not generate or compile an Android APK. A suggested journey is a design proposal; the template demonstrates its chosen features as separate modules.

The brief for each source app and the combined design document are ready for a future backend integration. `src/artifacts.ts` is the current export boundary. A real workflow service can replace the template step and supply build artifacts and status.

## Data

Workspace choices and the latest scan for each domain are saved in this browser under `meld.workspace.v1`. Removing a domain also removes its selections and scan results. New project asks before clearing the workspace. If storage is blocked, the UI explains that changes cannot survive a reload.

The preview frame is isolated. Download or open the demo to use its own browser storage. Exported app data stays local. File-URL storage behavior varies by browser. Timers run while the demo page remains open. Market scans send only search phrases and app IDs to Google Play. Feature summaries send the domain and the apps' public store text to Anthropic through your Claude Code login. AI planning sends only the described request data to OpenRouter when requested. Accounts, cloud storage, and telemetry are not connected.

## Development and verification

```sh
npm run build
npm test
```

The Playwright suite uses the installed Google Chrome browser. It starts a local server when needed. UI tests use the sample catalog and controlled market responses, so they do not contact Google Play. To also check the real scanner end to end, run `MELD_LIVE_MARKET=1 npm test` after `npm run setup:market`; add `MELD_LIVE_CLAUDE=1` to include real Claude Code summaries (this uses your subscription); without it a labeled stand-in names three features per listing. It scans each domain on its own, all six together, overlapping domains, eight domains including unusual custom names, and quick toggling and reloads. Tests cover the five screens, selection persistence, invalid and hostile input, generated ZIP contents, offline exports, all 16 demo features, timer completion, accessibility, and layouts at 320, 390, 768, 1024, and 1440 pixels. Market tests cover the scanner's request arguments and report conversion, caching, scan limits and cancellation, failures, the sample fallback, rescans that keep selected apps, custom domains, and market evidence in exports. The suggestion tests cover suggestion approval, undo, cancellation, retry, malformed responses, catalog navigation, scoped bulk actions, server credential handling, and provider errors. Automated tests use controlled provider responses and do not make paid model calls. Failures retain screenshots and traces.

For visual review:

```sh
npm run dev
node tests/visual-capture.mjs
```

Screenshots are written to the ignored `qa-screenshots/` directory.

## Project structure

- `src/App.tsx` — the five screens and navigation.
- `src/data.ts` — domains, sample apps, and feature briefs.
- `src/state.ts` — validated saved state and feature merging.
- `src/SuggestionPanel.tsx` / `src/suggestions.ts` — suggestion UI, plan validation, and offline examples.
- `server/suggestions.ts` — local API, server-side credentials, bounded model requests, and response validation.
- `server/market.ts` — local market API: runs the scanner, converts and caches its reports, and limits concurrent scans.
- `server/claude.ts` — local Claude Code API: finds the CLI, runs the stored prompt template with `claude -p`, validates and saves each run.
- `prompts/app-features/` — the prompt template, system prompt and output schema for store-listing features.
- `src/useFeatures.ts` — requests feature summaries for each new scan, with retry.
- `src/market.ts` — domain-to-scan mapping, market data validation, store-listing and sample features, and the live catalog.
- `src/useMarket.ts` — starts, cancels and retries scans for the chosen domains.
- `scripts/setup-market.sh` — installs the scanner into its own virtual environment.
- `src/artifacts.ts` — Markdown documents, standalone HTML, and ZIP exports.
- `src/demo-runtime.js` — interactions in the exported app.
- `src/styles.css` / `src/demo.css` — studio and exported app styles.
- `tests/` — browser tests and visual capture script.

## Interface references

The reading hierarchy uses a local copy of Inter, clear headings, neutral surfaces, and consistent coral actions. References: [Linear's issue interface](https://linear.app/docs/my-issues), [Atlassian typography](https://atlassian.design/foundations/typography/), and [NN/g's visual hierarchy guidance](https://www.nngroup.com/articles/visual-hierarchy-ux-definition/).
