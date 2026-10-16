# Meld — small app research, design and builds

Choose domains or describe an idea. Clarify the scope, find reference apps, select features, and review an editable design. Zhuoxuan's coding agent turns the approved design into an Android debug APK. The main workspace follows Zhuoxuan's three-step frontend: Describe your app, Review and customize, Get your app. It keeps our six suggested domains, intent clarification, full eligible app list, whole-card selection, individual feature choices and custom feature requests. Old hash routes and `/legacy` now open this same workspace. The retired four-step pages, preset app catalog, combination form and browser templates have been removed.

## Run

From the repository root:

```sh
scripts/dev.sh
```

Or:

```sh
cd frontend
npm ci
npm run setup:market
npm run setup:design
npm run setup:analysis
npm run dev
```

Open **http://127.0.0.1:4173**. `scripts/dev.sh --restart` restarts an existing server. `--no-open` leaves the browser closed. `MELD_PORT=4180 scripts/dev.sh` uses another port. **Start Meld.command** also starts Meld on macOS.

Running `scripts/dev.sh` again reuses the active server before setup runs, so reopening Meld does not interrupt a design or build job. Use `--restart` when you intend to restart it.

Use Node 22.19+ or a supported newer version, Python 3.10+, and a full JDK 17+ for APK analysis. The setup script finds Android Studio's JDK on this Mac. `setup:analysis` installs the backend's pinned REA, JADX and Apktool tools. Its APK/resource smoke check must pass. Market scanning needs network access. Design generation uses the backend's configured model login.

`setup:design` uses Zhuoxuan's `e54dd1c` revision when cloning a missing backend. It applies `patches/meld-workflow.patch` and builds the pipeline. Existing checkout changes are preserved; an incompatible patch fails instead of replacing local work. The patch keeps selected-feature guidance, portable backend paths, cancellation and approved outline tasks alongside the upstream Claude Code integration. Meld's `ProjectWorkspace`, inline outline editor, visual reference cards and browser emulator follow this upstream frontend. `StudioDiscovery` adds the domain, intent and feature-search tools. The project API and coding worker run in the same local server.

## Idea clarification and feature search

Step 1 still supports selecting or typing up to two domains. **Start with an idea** adds a short agent conversation. Vague ideas receive one or two questions per round. Answers can be selected or typed. The agent returns a scope, audience, desired features, exclusions, assumptions and concrete search phrases. **Confirm and find apps** is required before this idea starts a search. Editing the idea or changing domains cancels a pending response. Ideas, answers and confirmed plans survive reloads. **Explore selected domains** works as soon as one or two domains are selected, even during an unfinished chat. It searches those domains without the chat plan's queries or build instructions. The conversation stays saved. **View app results** returns to the confirmed chat plan and its feature queries. **Use domains only** scrolls to the domain choices without clearing the chat. Switching search routes clears results and feature selections from the previous route so they cannot be mixed.

The clarification call uses the existing Claude Code CLI login at low reasoning effort. It does not search while asking questions. Its prompt and response records are under `.meld-cache/intent/`. Inspired by the question-driven approach in [Grill Me](https://www.aihero.dev/skills-grill-me), with a short app-scoping conversation rather than a long interview.

Confirmed features produce up to four Google Play queries per topic. These queries can span publisher categories. Direct domain scans retain their existing genre filters. Query sets have separate cache entries and are preserved in immutable scan snapshots. Results are deduplicated, then screened by the existing complexity policy. On the app page, listings that mention the planned feature terms rank first; the opportunity score breaks ties. This local ranking is transparent phrase matching over real store text using agent-proposed synonyms. It does not claim semantic verification or hide every unmatched result. `src/relevance.ts` contains this ranking, `server/intent.ts` contains clarification, and `server/market.ts` forwards the search phrases.

## Domain and complexity policy

The default choices are:

| Domain | Scope | Discovery phrases |
| --- | --- | --- |
| Notes & lists | Local notes, search and checklists | offline notepad; simple checklist; plain text notes |
| Focus & habits | Timers, daily check-ins and local progress | pomodoro timer; offline habit tracker; simple focus timer |
| Journals & diaries | Private dated entries, moods and local history | offline diary; private journal; simple diary |
| Flashcards | User-made cards, flip/review and local practice | offline flashcards; make your own flashcards; simple flashcards |
| Reading lists | Manually entered books, reading status and progress | offline book tracker; reading list; reading log |
| Counters & tallies | Manual tap counts, targets and saved totals | simple tally counter; offline counter; multi counter |

During reference discovery, click an app card to select all its features. Click a fully selected card again to clear them. The arrow expands screenshots and individual feature choices. You can also customize a feature or add your own request. Partial selections are marked. Live cards cannot be selected until their feature summaries are ready.

Notes and focus search the PRODUCTIVITY genre. Journals use LIFESTYLE, flashcards use EDUCATION, reading lists use BOOKS_AND_REFERENCE, and counters use TOOLS. Free-text domains remain supported. There are six suggested choices in two rows of three on wide screens, with two columns on smaller screens and one on very narrow screens. New workspaces still choose at most two domains per project. Older saved workspaces remain readable; narrow them before using the design pipeline.

The scanner collects up to **90 candidates per domain** by default. Meld reads the full `ranking` from the CLI report, rather than its legacy `top_five` field. Scores and ranks describe the collected sample, not official Google Play charts or measured revenue. The response preserves collection failures and warnings. Reports are cached for 24 hours. Selected apps from earlier scans remain available when still eligible.

**Include apps needing review** is the default filter. Uncertain candidates stay visible with a review note. **Simple apps only** is available for a narrower list, and saved choices are preserved. Complex apps stay excluded. The filter uses the title, summary and store description. It excludes AI, shared services, financial services, advanced media, hardware/health integrations and broad product suites. Unknown workflows and possible cloud dependencies need review. Each excluded app has a visible reason. Cloud/account/payment/widget features are also removed from selectable store features and design requests.

Free-text domains expand the search topic. Classic Minesweeper, Sudoku, 2048 and tic-tac-toe have local puzzle rules. Other workflows without a matching rule need review and remain visible by default; listings matching an exclusion rule remain hidden. When all results are filtered out, the page shows the ranked and shown counts with the reasons for exclusions. **Include apps needing review** enables summaries for review candidates. It does not mark them as simple or REA-verified. A filtered scan is distinct from a scan that found no apps.

Policy v2 checks relevance to each focused domain. Flashcards must describe creating, editing or importing the user's cards; a fixed alphabet course is not enough. Reading lists must describe manual entry or offline/local use. Shared journals, book clubs, reading services, shared deck libraries and broad study platforms are excluded. For the new domains, offline support alone does not override a sign-in dependency. The same shared rules screen feature choices and the design handoff.

Policy v3 adds Counters & tallies. Listings must describe manual or tap/click counting. Sensor counters, camera/object detection, automatic counting and business inventory systems are excluded. The intended behavior is a small local state change: increment, decrement, reset and save a total. The [Counter project](https://github.com/gentlecat/counter) is one concrete example of this Android workflow; it is not a REA reconstruction case study.

Policy v4 recognizes classic local puzzles and defaults to showing review candidates. Explicit absences such as “no timers” do not establish a workflow. 3D Touch and beveled board cells do not count as advanced rendering. Subscription payment boilerplate does not make a puzzle a financial service. Actual multiplayer, 3D rendering and payment services remain excluded.

These are **scope estimates**, not proof that a whole app can be copied. The intended output contains no accounts, cloud sync, social features, payments or ad systems. APK analysis must establish the selected behavior. Only the features you request belong in the design. Reference cards come only from real Google Play scans, including saved scans. Pending, failed and empty scans never insert preset apps. Pending summaries never insert preset features. Old saved demo selections are discarded; live selections and user text are preserved.

## Why REA fits this scope

The domain choices are an engineering inference from REA's documented capabilities:

- [Notes/Electron guide](https://rea.tools/guides/javascript/): traces a small CSV export through the renderer, preload and main process. This supports studying bounded data workflows.
- [Notes/browser guide](https://rea.tools/guides/browser/): ties an export click to its request and download code. This supports checking observable behavior.
- [Aegis APK case study](https://rea.tools/showcase/aegis/): locates and reconstructs a particular Android calculation. The project reports 133 comparison cases and public reference checks. This demonstrates a feature analysis method; it is not a full authenticator rebuild.
- [Notion clipboard case study](https://rea.tools/showcase/notion/): traces one clipboard feature. It does not establish that Notion's full product is a simple rebuild. Notion is excluded here.

Local checks on 2026-10-14: real Google Play scans ranked 56 Notes & lists apps and 65 Focus & habits apps. Policy v1 kept 24 and 48 simple candidates respectively. Counts change with listings. REA reproduced the documented Notes example's one paired IPC export channel. REA also inspected the [official Notally 6.2 APK](https://github.com/OmGodse/Notally/releases/tag/v6.2) and reported package `com.omgodse.notally`, version 6.2. These static checks establish that the tooling works; they do not establish a complete reconstructed app or runtime equivalence.

The expanded-domain scan on the same date ranked 33 journal apps, 30 flashcard apps and 50 reading apps. Policy v2 kept 19, 4 and 4 simple candidates respectively. Examples include Private Offline Journal, Byheart and Books Tracker: Book Library. Full scans and per-app decisions are saved locally under `.meld-cache/verification/domain-*.json` and `expanded-domains-fit.json`. These are real listing checks, not APK reconstruction tests.

The sixth-domain scan ranked 39 counter apps. Policy v3 kept 22 simple candidates. The raw result and filter decisions are saved in `.meld-cache/verification/domain-counters-tallies.json` and `counters-fit.json`.

The new choices extend the same bounded storage-and-review approach: dated text entries, question/answer pairs, and books with reading status. REA's [Android analysis documentation](https://github.com/morluto/rea/blob/main/docs/android-analysis.md) supports inspecting manifests, classes, methods and references in JVM-based APKs. The [Diary documentation](https://billthefarmer.github.io/diary/) gives a concrete example of plain-text entry storage and search. [Openreads](https://github.com/mateusz-bak/openreads) documents a personal book-tracking workflow, but uses Flutter, which is not evidence that JADX can recover its Dart implementation. These sources inform domain selection; they are not REA case studies of every app shown. Stage 3 must verify the selected APK, implementation stack and exact feature before treating the proposed behavior as established.

## Review and delivery: Zhuoxuan's design and coding workflow

**Confirm features and generate design** hands the exact selected live apps and features to the upstream persistent project API. The server reads immutable scan IDs and checks app ownership and complexity. It preserves the full clarified intent as `brief.input`; selected feature text is explicitly saved as user preferences. It does not rerun upstream research or replace the selected apps with a top-five list. Select one to five reference apps with completed summaries. The first design groups related requests into at most five primary features without silently dropping them.

The first response is a short editable outline. Edit its purpose, audience, features, steps, pages and appearance. Save edits before approving. Free-text changes produce a preview. **Approve design and build app** approves the exact saved version, prepares the detailed specification, starts the coding agent, and opens **Get your app**. Jobs survive browser reloads. Failed jobs show their error and a retry action. A failed detailed design resumes its saved checkpoint if the app profile is unchanged. Completed design sections receive targeted field edits for review findings, with recorded model provenance and a new full review. Failed generator exits cannot publish an older artifact. Changing the profile requires a fresh task. Downloads belong to the current design version.

The worker generates Kotlin modules, runs Gradle build/unit-test/lint checks, reviews the implementation, and repairs affected files. It publishes a debug APK only after the configured gates pass. The UI reports whether device behavior was checked; compiler/model checks alone are not runtime verification.

Reference APKs use `.meld-cache/apks/<package.id>.apk`. The latest backend can obtain missing APKs from Aptoide. Set `MELD_APK_AUTO_DOWNLOAD=false` to disable acquisition. If an APK is unavailable or analysis is incomplete, the backend can continue with a market-assisted design. Listing-based proposals remain distinct from verified static APK findings. REA evidence is never fabricated to fill a missing APK.

The selected-feature prompt remains at `frontend/prompts/design-selection/prompt.md`; new outline approval supersedes original selections when the user edits the design. Saved projects and APK downloads continue to open in the current studio.

**Try app in browser** installs the exact delivered APK in a dedicated Android emulator. Click or swipe its screen, send text, go back, or restart the app. Close preview releases the session and removes that test installation. One preview runs at a time. Trying the app does not mark the build as automatically runtime-verified.

Setup creates the preview AVD from an already installed system image. It detects Apple Silicon even when the shell runs through Rosetta. It does not download a system image automatically. Set `MELD_EMULATOR_ENABLED=false` to disable preview. Export setup overrides in the launching shell: `MELD_EMULATOR_IMAGE`, `MELD_EMULATOR_AVD_HOME`, `MELD_EMULATOR_AVD` and `MELD_EMULATOR_PORT`. The default port is 5582. An unrelated emulator on that port is left alone. APK downloads remain available when preview is unavailable.

Reference APK acquisition and analysis can run while you edit the outline. Approval reuses that saved attempt. Incomplete analysis remains labeled as partial. Editing research keeps the same project and preserves its earlier design revisions. Failed outline generation offers a retry after reload without dropping selected features. Failed detailed generation creates a new retry job using the same pipeline checkpoint, keeping the original failure record and approved outline. Changed profiles cannot resume stale work.

Android builds need SDK platform 35, build-tools 35.0.0 and JDK 17+. On macOS the integration detects `~/Library/Android/sdk` and Android Studio's JDK. Override paths with `MELD_ANDROID_SDK`, `JAVA_HOME` and `MELD_AAPT`. The original `scripts/dev.sh` starts everything on port 4173; no second manual backend launch is needed. Run `scripts/dev.sh --restart` after updating backend code.

## Settings and data

Copy `.env.example` to `.env.local`. Keys stay on the server. Shell variables take precedence. Do not prefix secrets with `VITE_`.

```dotenv
MELD_MARKET_CANDIDATES=90
MELD_MARKET_CACHE_HOURS=24
MELD_MARKET_DIR=
MELD_MARKET_PYTHON=
MELD_APK_DIR=
MELD_PIPELINE_TOOL_ROOT=
MELD_PIPELINE_CONFIG=
MELD_DESIGN_EXAMPLE=
MELD_ANDROID_SDK=
JAVA_HOME=
MELD_APK_AUTO_DOWNLOAD=true
MELD_CLAUDE_BIN=
MELD_CLAUDE_CONFIG_DIR=
MELD_CLAUDE_MODEL=claude-haiku-5-5
```

Live app feature summaries use your Claude Code login. The stored prompt lives in `prompts/app-features/`. Calls have no tools or personal settings. Live features come only from completed Claude summaries. Cards show processing, queue, unavailable, or retry status while waiting. Empty summaries stay empty; keyword guesses and saved sample features never fill the gap. Summaries run in batches of eight eligible listings and are cached with the prompt/model provenance.

The merged backend uses noninteractive Claude Code CLI sessions. Clarification and outline calls default to `claude-sonnet-5` at low effort. Detailed design and review use the pipeline runtime configuration, also Sonnet 5 at low effort. Coding, repairs and implementation review default to Sonnet 5 at medium effort. Export `MELD_CLAUDE_MODEL` in the launching shell to override short backend calls and the default build model, or `MELD_CLAUDE_BUILD_MODEL` for builds only. Feature summaries default to `claude-haiku-5-5` at low effort; their model can also be set in `frontend/.env.local`. These are configuration defaults, not a guarantee of model access for every login.

Choose **Use as base** on a reference card to preserve that app's core purpose, then select features as improvements. The base counts toward the five-app limit and survives reload and outline edits. Without a base, the existing selected-feature workflow remains available. The approved outline remains the scope for detailed design and coding.

Workspace choices live in browser storage under `meld.workspace.v1`. Server scans, model responses, APKs and design revisions live in the ignored `.meld-cache/` folder. Public listing text goes to the configured model when summarized. The analysis pipeline sends selected APK evidence to its model.

## Verification

```sh
npm run build
npm test
npm --prefix ../pipeline test
```

Tests also cover clarification before search, retries, saved answers, feature-query cache separation, selected-reference import, editable outline approval and Android delivery through the real project API with synthetic workers. Tests cover old-bookmark migration, expanded rankings, conservative filtering, persisted live selections, scan and summary failures/retries, API validation, selected-only design handoff, missing APKs, design edits, revisions, exports, accessibility and narrow layouts. Tests for the retired demo/template UI were replaced with current studio coverage. Automated model tests use fixtures. They do not claim to prove a live model-generated design. The real scanner and static REA checks above were run separately.

Integration check on 2026-10-15: 207 frontend, backend and pipeline tests passed; seven opt-in live scans were skipped in the regression suite. A separate live run completed intent clarification, feature-based Google Play search (56 ranked apps, 31 simple candidates), a real listing summary, an edited and approved outline, detailed design, coding, review and APK delivery. The generated notes app passed compilation, lint, 67 unit tests and 14 manual ADB checks on an Android API 36 emulator. The APK downloaded through Meld matched the tested APK's SHA-256. Desktop and mobile delivery pages had no Axe violations or horizontal overflow, and the ready state survived reload.

The reference APK analysis was partial, so this run used a market-assisted design. The manual device checks are recorded separately; they do not change the build worker's `runtimeVerified: false` flag. Results and screenshots are saved locally in `.meld-cache/verification/integration-20261015.json` and `.meld-cache/verification/android-integration-20261015/`.

Latest upstream merge on 2026-10-15: Zhuoxuan's `ab005dd` is merged locally as `e05f67a`. The integrated frontend follows its three-step studio. All 233 automated checks passed: 124 frontend tests, 50 backend/upstream UI tests and 59 pipeline tests. Seven optional live scans were skipped. Production build and clean-checkout patch checks passed. A separate live check opened the previously delivered APK in the browser emulator, created and saved a note through browser controls, checked persistence after restart, and closed the preview. Desktop and mobile preview pages passed accessibility and overflow checks. Evidence is in `.meld-cache/verification/upstream-merge-20261015.json`.
