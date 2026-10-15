# Puzzle Harbor: three-reference generation run

The user selected **2048 Open Fun Game**, **Antimine**, and **LibreSudoku** as references for a new offline puzzle arcade. These are curated inputs, not claimed market Top 3 results. Each game keeps its own rules; the proposed app shares navigation, saving, statistics and appearance.

## Pinned inputs

See `pipeline/config/puzzles.apps.lock.json` for package IDs, APK URLs, versions and calculated SHA-256 values. 2048 uses 1.15.1 because 1.16.2 obfuscates business classes and did not produce sufficient inspectable evidence in the initial attempt. Antimine uses the native Android F-Droid release 17.6.3 F; LibreSudoku uses 2.0.2.

## Scope and evidence

`pipeline/config/brief.puzzles.json` defines the target app and a separate analysis scope for each reference. Source analysis covers movement/undo, reveal/flag, and number input/pencil marks respectively. Unconfirmed persistence and other original-app behavior remain explicit unknowns. This scoped static documentation does not establish original-app runtime behavior. The generated app must independently implement and test the full proposed lifecycle, persistence and game rules.

The initial obfuscated attempt and broad-scope partial attempt remain under ignored `pipeline/runs/`. The current run is `pipeline/runs/puzzle-trio-scoped-20261014`. Valid saved 2048 tool artifacts were copied into the scoped run with a recorded checkpoint hash; specification and review calls are fresh. Antimine exposed incorrect Kotlin copy-mask constants in the saved Java decompilation; separately hashed DEX disassembly established the actual reveal/flag mutations. The analyzer now supports an explicit app-local bytecode tool for this class of ambiguity.

## Generation and verification

The analysis engine produces three source specifications, a comparison, recorded model choices and a detailed proposed design. The readable document is generated from that design. The Android worker plans small Kotlin modules, generates them one at a time, compiles/tests/lints them, and uses targeted patches for compiler or design-review findings. It publishes an APK only after all checks pass.

An isolated `MeldPuzzleQA` emulator is used for generated-app interaction checks. On 2026-10-14 the user requested immediate APK delivery without waiting for remaining design edge-case review. Round 3 of build `job-bfc83b61-bb3b-4169-bfa2-c4a3750c312f` was released directly as ignored `frontend/qa-screenshots/puzzle-harbor/puzzle-harbor-v1.apk` (SHA-256 `07c0bbfaad0cc0074260616dcbdfd70f6699be347a533a4f68e8100eabdbab2d`), with successful Gradle build, lint and 74 JUnit tests. This direct release does not mark the automated project job as succeeded. Round 2 passed six Android 13 native cases for its earlier APK; round 3 native verification was still running at release time. The immutable release receipt is `release-v1.json` beside the APK. APKs, model logs and large generated artifacts stay outside Git.

## Reproducing the checks

Download the pinned APKs listed in the lock file and verify their SHA-256 values before running. From `pipeline/`:

```bash
npm run mvp -- run --apks downloads/puzzle-trio/org.andstatus.game2048-v1.15.1.apk downloads/puzzle-trio/dev.lucanlm.antimine.apk downloads/puzzle-trio/com.kaajjo.libresudoku.apk --brief config/brief.puzzles.json --config config/runtime.codex.json
npm run mvp -- validate --run runs/<run_id>
```

`frontend/tests/puzzle-project-live.mjs` imports a validated run into a real project, approves the readable design through the browser, waits for the Android worker, and downloads the APK. Its fixed request key identifies this specific reproducible example.

`frontend/tests/puzzle-native-smoke.py APK GENERATED_PACKAGE_ID` installs the APK on the device selected by `MELD_ANDROID_SERIAL` (default `emulator-5580`). Set `MELD_ANDROID_ADB` when adb is outside PATH. **It clears that isolated generated app's test data.** It checks game interactions, exact undo, independent saved boards, force-stop recovery, appearance persistence, replacement cancellation and durable outcome statistics. Reports and screenshots go to ignored `frontend/qa-screenshots/puzzle-harbor/` or `MELD_NATIVE_QA_OUTPUT`.

## Native publication gate

For this specific three-game fixture, set `MELD_NATIVE_SMOKE_PROJECT` to its project ID, `MELD_NATIVE_SMOKE_ADB` to adb, and optionally `MELD_NATIVE_SMOKE_SERIAL`. The worker runs the native smoke test after Gradle and before final design review. It publishes `runtime-report.json` and marks runtime verification true only after all six cases pass with the exact APK hash and package. Other projects retain the default static-build verification boundary. Use an isolated test emulator: the smoke test clears the generated test app's data.

The run exposed two response-budget failures despite complete, valid model output. Completed batches and ordered repair files can now be revalidated under an explicit 24,000-token recovery budget; original failures, responses and hashes remain intact. Repairs generate one module per call and retain checkpoints. A real emulator check subsequently found a shared button touch regression that compilation and 38 JUnit tests missed. Native findings are retained as repair feedback, and native failures block publication for the configured fixture.

Native test development also caught two harness mistakes: selecting a Minesweeper cell by physically tapping it in Reveal mode, and shadowing a Python helper with a local result variable. These remain documented in the failed build directories. The corrected harness uses bounded selection controls and stable callable references. Harness exceptions stop the job and trigger a rebuild of unchanged accepted source after the harness is fixed; they do not become application-code repair requests. Existing-file repairs now use unique exact text edits, reducing large test-file regeneration and preserving unchanged tests.
