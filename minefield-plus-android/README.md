# Minefield Plus

A standalone offline Android Minesweeper app: 9×9, ten mines, safe first reveal, flood reveal, flags, one-step undo and personal pencil marks. Game, Statistics and Settings share saved state and light/dark/system appearance. No network permission, ads or accounts.

This implementation continues the existing Minefield Plus design rather than the older Puzzle Harbor three-game app. It is authored directly in this checkout; it is **not** a successful execution of the Claude generation pipeline. See [design decisions](docs/design-decisions.md) and [provenance](docs/provenance.json).

## Build and tests

Requires JDK 21 (17+ bytecode target), Android SDK platform/build-tools 35, network access for initial Gradle dependencies, and the included Gradle wrapper. Set `JAVA_HOME` and `ANDROID_HOME`, or configure `local.properties` with `sdk.dir`.

```bash
./gradlew --no-daemon :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

Install the resulting debug-signed development APK:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.meld.minefield/.MainActivity
```

The package is `com.meld.minefield`, min API 26, target API 35. Debug signing is suitable for local installation; this is not a store-signed release.

## Native regression

Use an isolated emulator. The script installs the APK and **clears only `com.meld.minefield` test data**. It operates real UI controls, reads committed app-private saves through `run-as`, records APK hashes, and saves screenshots and a report. It also temporarily changes and restores system font scale. It never reads credentials or reference-app private data.

```bash
MELD_ANDROID_ADB="$ANDROID_HOME/platform-tools/adb" \
MELD_ANDROID_SERIAL=emulator-5580 \
python3 scripts/native-smoke.py app/build/outputs/apk/debug/app-debug.apk artifacts/native
MELD_ANDROID_ADB="$ANDROID_HOME/platform-tools/adb" \
python3 scripts/native-gestures.py artifacts/native
```

`artifacts/`, Gradle build outputs and APKs are ignored. Final APKs/reports/screenshots can be copied to the repository's ignored `outputs/minefield-plus/` delivery directory. JVM rules/storage tests, Android lint, native interaction results and model execution status are reported separately; passing one does not imply the others.

After native checks, `scripts/package-delivery.py NATIVE_RESULTS NEW_OUTPUT_DIRECTORY` verifies the APK hash, 37+ passing JVM tests, lint, contrast and signature evidence before creating a new delivery bundle. It refuses to replace an existing bundle. Prepare the contrast and signature receipts first:

```bash
python3 scripts/check-contrast.py
sha256sum app/build/outputs/apk/debug/app-debug.apk > artifacts/apk-signature.txt
"$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --verbose --print-certs \
  app/build/outputs/apk/debug/app-debug.apk >> artifacts/apk-signature.txt
python3 scripts/package-delivery.py artifacts/native ../outputs/minefield-plus
```

## Code map

- `Game.kt`: immutable pure Kotlin rules and state validation; seeded placement defers until the first reveal.
- `SessionCodec.kt`: versioned JSON with strict scalar types and semantic consistency checks.
- `SessionStore.kt`: atomic file persistence and retryable transactions.
- `GameViewModel.kt`: serialized background commands and lifecycle-gated timer.
- `MainActivity.kt`: Compose board, input modes, confirmations, statistics, recovery and preferences.

The full session (board, undo snapshot, settings and game-ID-keyed outcomes) commits as one atomic file after each move and each active timer tick. Interrupted writes recover through Android `AtomicFile`. Unreadable data is not silently overwritten: the recovery screen can archive it before starting fresh.
