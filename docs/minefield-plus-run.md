# Minefield Plus: standalone Android delivery

The new app is a single offline Minesweeper game, based on the existing Antimine-first brief, with one-step reveal/flag undo adapted from 2048 and personal numeric pencil marks adapted from Sudoku. It does not include the older Puzzle Harbor game's other modes. The implementation lives in [minefield-plus-android](../minefield-plus-android/README.md).

## Inputs and authorship

The source draft is `pipeline/runs/2026-10-16T22-29-31-419Z-96344b/synthesis/design-draft-1792190960620.json`. The scoped brief, comparison, decisions and draft have their SHA-256 hashes recorded in [provenance](../minefield-plus-android/docs/provenance.json). The current structural design check returned no errors. The source APKs have static analysis evidence; their runtime behavior was not verified.

The saved run could not resume because its fingerprint did not match the current configuration/prompts/tool environment. This app was implemented directly by Codex from the saved design. It is not a successful Claude pipeline generation or independent model review, and the original run has not been marked successful. Prior model responses and failures remain intact. Clarified gesture, undo, statistics and save semantics are documented in [implementation decisions](../minefield-plus-android/docs/design-decisions.md).

## Implemented behavior

- 9×9 board, exactly ten mines, safe first reveal and flood expansion.
- Tap reveal, long-press flagging, explicit Reveal/Flag/Pencil modes and larger selected-cell controls.
- One undo slot restoring board, annotations and timer; terminal undo retracts the corresponding unique game result.
- Personal 1–8 pencil marks, clear-mark action, confirmed replacement and persisted pause.
- Atomic complete-session saves, error/retry handling, interrupted-write recovery and explicit archival recovery for unreadable data.
- Local completed-game statistics, win rate, best winning time and persistent light/dark/system settings.

## Actual validation

The delivered APK is `com.meld.minefield`, version `1.0.0`, min API 26, target API 35, with a development debug signature. APK SHA-256: `a52d2ecafcfaa027f3ee610a4a06ea0c9475db77647ab11839d296f2ea433dfd`.

- Gradle `assembleDebug`, `testDebugUnitTest` and `lintDebug`: passed on JDK 21 / SDK 35.
- JVM unit tests: 37 passed (17 game tests, 20 storage/codec tests). Includes 3,240 seed/first-cell combinations, independent flood reachability, long action sequences, exact undo, terminal statistics, malformed data and failed-save transactions.
- Android lint: zero errors, seven warnings (pinned dependency/wrapper update notices and backup configuration advice).
- Design color check: seven selected shipped color pairs passed their contrast thresholds. Screenshots record the board, loss, win, statistics, theme, 200% text and save-failure state. Board, win/loss, large text and save-failure screenshots were visually inspected. This is not a complete automated accessibility audit.
- Real Android emulator: 11 regression groups passed on API 33 / x86_64 / 1080×1920, with the exact APK hash above. Checks include real UI win/loss, undo, force-stop recovery, durable settings/outcomes, 200% font scaling, forced file-write failure, incomplete `.new` recovery, legacy `.bak` recovery and explicit corrupt-save archival. The harness restores font scale and app-directory permissions.
- Supplemental real gestures: long-press flag/unflag, flag-mode tap, protection against revealing flagged cells and safe reveal passed on the same installed APK. The supplemental script independently verifies the installed APK hash before interacting.

Full native reports, APK, signature receipt, test XML, lint XML and screenshots are in ignored `outputs/minefield-plus/`; intermediate build logs, failed/interrupted attempts and prior APK test inputs remain in ignored `minefield-plus-android/artifacts/`. The packaging command rejects missing/failed checks, an APK hash mismatch, or replacement of an existing delivery directory.

## Local artifacts

- [Installable development APK](../outputs/minefield-plus/minefield-plus-v1.apk)
- [Release receipt](../outputs/minefield-plus/release-v1.json)
- [Native regression report](../outputs/minefield-plus/runtime-report.json)
- [Game screenshot](../outputs/minefield-plus/screenshots/10-playing.png)
- [Win screenshot](../outputs/minefield-plus/screenshots/04-win.png)
- [Dark theme / 200% font screenshot](../outputs/minefield-plus/screenshots/07-large-font.png)

These local artifacts are intentionally outside Git. Physical devices, the complete supported Android-version range and store release signing have not been verified or performed. See the app README for reproducible build and emulator commands.

## Web integration (2026-10-17)

The app is also saved in the web project history as **Minefield Plus**, project `project-c5807b8e-f6f8-40f4-8506-966b751fe176`. Open [the web project](http://127.0.0.1:4173/?project=project-c5807b8e-f6f8-40f4-8506-966b751fe176). Imported build `job-072531a1-038c-42a4-ad9b-7d824b1b93ef` and design `v0001-c3dbfcfa` reference the exact APK hash above. The readable design explains Antimine, 2048 undo and LibreSudoku pencil marks; developer files include the implementation clarifications and actual screenshots.

`backend/src/import-minefield.ts` imports the existing verified delivery without model calls or rebuilding the APK. It validates schema/references and receipts, publishes the project only after its design and artifacts exist, and refuses to overwrite an import changed by the user. Re-running it reuses the same project. Original pipeline status is preserved. Reference contributions are explicitly curated APK inputs; unavailable market metrics are hidden.

From `backend/`, with Node 22.19+:

```bash
node --import ../pipeline/node_modules/tsx/dist/loader.mjs src/import-minefield.ts
```

`frontend/tests/minefield-web-live.mjs` passed against the running web UI: history visibility, base/feature selections, readable/developer design, browser APK download with matching hash, 320/390px layout, reload persistence, and actual Android preview/pointer input. Its screenshots and report are in ignored `outputs/minefield-plus-web/`. The new import uses the existing project/download/preview APIs.

During this integration the user reported `Endpoint not found` after entering `a study timer`. The standalone backend lacked the `/api/intent/` registration used by the idea panel; it now registers the existing clarification handler. A real follow-up exposed the CLI rejecting Zod's default 2020-12 JSON Schema, so backend model requests now emit draft-7 and still validate parsed responses with Zod. The real browser input returned HTTP 200 and two clarification questions without starting a market search. The standalone-route and intent regression suite passed 19 tests; live model evidence and its earlier failure are preserved under ignored `outputs/intent-routing-fix/`.
