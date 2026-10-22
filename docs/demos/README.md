# App comparison videos

Each comparison pairs a real base reference with the generated Android app, then labels the shared foundation and proposed adaptation. Videos and posters live in `frontend/public/demos/` and are linked from the root README. The website serves an accessible player at `/demos/index.html`.

- **Focus Grove:** Forest Google Play store screenshots on the left; real generated APK recording and device captures on the right. No original Forest runtime recording is claimed. Shared: tree-growing timer, forest, sounds and statistics. Adaptation: task-list workflow and custom minute-goal integration.
- **Pocket Ledger:** official Cashew 5.3.4+396 Android release on the left; generated Pocket Ledger APK on the right. Cashew is in its own built-in Preview Demo mode with sample transactions. Shared: spending overview, category budgets and daily allowance. Proposed integration: a non-destructive purchase sandbox followed by explicit recording.

The published videos are 45 seconds (Focus Grove) and 48 seconds (Pocket Ledger), with silent footage and English captions. Both played in browser verification.

Footage is composed and captioned, not a claim of pixel equivalence. Any condensed waiting or reused still is labeled. Source images/recordings and APKs remain in ignored `outputs/` directories; the published manifest records their hashes, device context and scene timing. Original app names identify references, not endorsement.

Re-render from the delivery workspace with:

```bash
python3 scripts/demos/render-comparisons.py
```

The renderer uses Pillow, DejaVu Sans and FFmpeg. See `storyboard.json` for editable scene content and `frontend/public/demos/provenance.json` for the published source manifest. Generated screen images are captures of the APK, not manually redrawn product mockups.
