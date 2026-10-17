# Forest demos

From the repository root, run either script:

```bash
./scripts/demos/forest-core.sh
./scripts/demos/forest-plus-two.sh
```

Each opens a separate Android emulator window. Both can run at once. First boot can take a minute or two. Later launches keep your data.

| Script | App | Emulator |
| --- | --- | --- |
| `forest-core.sh` | Focus timer, growing/withered tree, garden and session history | `MeldForestCore`, port 5584 |
| `forest-plus-two.sh` | Core plus session task checklists and reflection notes | `MeldForestPlusTwo`, port 5578 |

These are two saved builds of the same Meld project, not two independent Meld projects. Each uses a separate emulator and separate app data because their Android package IDs are the same. The scripts run the exact tested APKs. They do not rebuild or modify app code. Meld and `scripts/dev.sh` do not need to be running.

For a quick look, start a one-minute timer. In the +2 version, add tasks before starting. After the session, open it in History to add a reflection.

Close each Android window when done, or run:

```bash
./scripts/demos/forest-core.sh --stop
./scripts/demos/forest-plus-two.sh --stop
```

Use `--check` to verify the APK, passing test report and Android SDK without starting the app. The pinned build IDs and checksums are in `builds.json`. APKs and reports are copied into `artifacts/` on first use. That folder and emulator data in `.state/` are local and ignored by Git. If the artifacts are missing, the launcher looks for the original files in `frontend/qa-screenshots/forest-cases/` and checks their hashes before copying them.

Requirements: Python 3, Android SDK emulator and platform-tools, and the Android 36 Google Play system image for this Mac's architecture. These are already installed on Kevin's Mac. `ANDROID_HOME` can select another SDK location.

The core demo is a small offline implementation of Forest's focus loop. It does not include Forest's accounts, social rooms, purchases or cloud features.
