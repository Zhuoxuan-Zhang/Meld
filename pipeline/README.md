# Design pipeline

Source-only port of the existing APK analysis pipeline and interactive document core. No APKs, credentials, reference-app source, original run artifacts or standalone frontend are bundled. Meld’s React frontend and local API integrate this package through its compiled `integration` entry point.

```bash
npm ci
npm run build
npm test
```

Set up the pinned REA/JADX/Apktool installation with `JAVA_HOME` and `npm run setup`, or use `MELD_PIPELINE_TOOL_ROOT` for an existing installation. Analyze one to five actual standalone APKs:

```bash
npm run mvp -- run --apks a.apk b.apk c.apk d.apk e.apk \
  --brief config/brief.notes.json --config config/runtime.pipeline.json
npm run mvp -- resume --run runs/<id>
```

The market adapter also supplies `--market-input <file>` and an explicit new run directory. It verifies package identities and expected hashes; it does not download arbitrary APKs from store descriptions. Scan snapshots express public market signals, while source-app behavior requires retained static evidence. Original interrupted stages resume with the existing engine’s fingerprint checks.

`src/workbench/` manages readable projections, proposal operations, validation, hashes, transactions, reviews and history. It exposes no separate product UI or standalone web server. See [the integration guide](../docs/design-doc-interaction.md) for APIs, Notes import and the app-generation boundary.
