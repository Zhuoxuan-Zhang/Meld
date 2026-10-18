# REA evidence and Android UI review

New APK analysis runs collect an authenticated REA artifact inventory, project the Android application graph, and save an open reconstruction obligation ledger. Device observation is configured explicitly. The static model-facing REA whitelist remains unchanged; the observation orchestrator owns device installation, startup and evidence acquisition.

The UI improvement path is:

```
Original APK → REA graph + device/screens/logs → actual screenshot model analysis
 → concrete visual rules in the design → Kotlin implementation
 → matching candidate scenarios → screenshot review → targeted code repairs
```

## Reference collection in the web pipeline

Use Node 22.19+ (the pinned local Node is `pipeline/tools/node/bin/node`). REA, Android platform tools and an already-running emulator must be installed; REA does not start an emulator. The same existing CLI login used by the project supplies visual-model access.

Set `MELD_REA_OBSERVATION_CONFIG` to an absolute JSON path before starting the backend. [The example](../pipeline/config/reference-observation.example.json) declares an emulator, allows installing the selected reference APKs, and supplies Antimine game/settings scenarios. It can also be supplied under `reference_observation` in the pipeline runtime config.

Each core workflow needs its own scenario plan. Package text, control names, onboarding, permissions and language differ across apps. `captureLaunchScreen: true` optionally collects a non-required launch-screen observation for packages without a tailored plan; it cannot satisfy a core-workflow comparison. With that option disabled, missing plans produce graph evidence and explicit runtime-unavailable results. Plans do not clear app data, uninstall packages, accept dialogs automatically, or log in. UI text is untrusted data.

Reference evidence is saved under `observations/<app_id>/` with:

- `application-graph.json`: DEX/resource/native component inventory and bridge hypotheses.
- `native-analysis.json`: native inventory, requested probes and unexamined libraries.
- `screens/`: REA PNG captures and independently collected UIAutomator XML.
- `actions/` and `calls/`: bounded UI actions and raw REA requests/results, including failures.
- `visual-brief.json`: actual image analysis when a configured visual model succeeds.
- `evidence-bundle.json`, `rea-obligation-ledger.json`, `manifest.json`: exported evidence, open obligations and artifact hashes.

The per-app manifest binds the plan, APK digest, device, scenarios and file hashes. `reference-observations.json` pins each manifest digest. Resume validates saved captures; it never overwrites sealed observations. A device lock prevents simultaneous observation collectors from mixing scenarios. Other external device controllers must use a separate emulator or remain idle.

The normal static and market-assisted design paths both consume validated observation context, including references whose static AppSpec did not finish. Visual rules remain in the saved brief through design approval and code generation. Static component graphs never establish what a screen looks like.

## Candidate review and repair in web builds

Set `MELD_UI_VALIDATION_CONFIG` to an absolute path. [The build example](../backend/ui-validation.example.json) selects a saved reference by base package; `projects` can override it for a specific project ID. Relative reference directories resolve against this config file. `requireMatch: true` blocks unmatched builds; the default preserves existing build behavior.

For configured builds, the worker verifies the original reference, supplies its visual rules to code generation, compiles the candidate, installs that exact APK, runs the candidate-specific scenario steps, and attaches both sets of PNGs to a fresh visual-model call. Scenario IDs **and goals** must match. Approved appearance and intentional feature adaptations take precedence over copying reference branding or matching pixels.

A failed UI review supplies concrete repair instructions to the existing bounded implementation-repair loop. Missing original/candidate evidence blocks the gate instead of passing it or wasting code-repair attempts. Successful builds publish `ui-validation.json` and a self-contained `ui-comparison.html` alongside the APK. `visualVerified` is distinct from the existing full native smoke result `runtimeVerified`; neither claims complete equivalence.

Untested gestures, persistence and hidden states are listed under `unverifiedBehaviors`, separately from observed UI defects. They never become speculative code-repair instructions. If the required pictured scenario itself is unverified, the gate reports `unknown`. Visual CLI responses are validated under a 12,000-token post-response budget that includes model reasoning; failed attempts remain saved.

## Standalone collection, comparison and replay

Run from `pipeline/`, with the pinned Node directory on `PATH`:

```bash
npm run observe -- collect --plan /absolute/path/reference-plan.json --out /absolute/path/new-reference
npm run observe -- validate --out /absolute/path/new-reference
npm run observe -- replay --out /absolute/path/new-reference
npm run observe -- compare --reference /absolute/path/new-reference --candidate /absolute/path/new-candidate --design /absolute/path/approved-design.json --model claude-sonnet-5 --out /absolute/path/new-comparison
```

A collection plan contains `packageName`, `apk`, `role` (`reference` or `candidate`), optional `serial`, explicit `install`, and one to six `scenarios`. APK paths in CLI plans resolve relative to the plan file. Each scenario has a stable `id`, a semantic `goal`, optional exact `expectedText` and `absentText` assertions, and bounded steps: `tap` with exact text/content-description/resource-ID selector, `back`, `wait`, or normalized-coordinate `swipe`. Explicit `ifPresent` taps can handle a known first-launch tutorial; an absent control is recorded, and ambiguous selectors still fail. Each scenario restarts the app but preserves existing data; use a controlled fixture/device state for deterministic behavior tests.

Optional `vision` selects `claude_cli` or `codex_cli`, an available `model`, and `reasoningEffort`. Screenshot content is attached as image input, not just listed as a path in a text prompt. Review schemas and screenshot attachments are retained. Review output cannot pass by omitting required scenarios.

Continuously rendering native surfaces can prevent UIAutomator from reaching an idle state. A scenario can explicitly set `allowVisualOnly: true` to collect its screenshot with independent foreground-window identity when no XML tree is available. Such a capture cannot pass text assertions or establish accessibility semantics. Optional taps whose presence cannot be observed are recorded as `not_observable`, never as executed. The resulting review remains a screenshot-quality review. This is required for the active Antimine board on the tested emulator; the settings screen and our Compose candidate retain normal hierarchy evidence.

Replay verifies all bound artifact hashes, imports the exported bundle into a fresh REA session, and checks that the Evidence ID set is preserved. This is evidence integrity replay; it does not rerun app interactions or close behavioral obligations. Replays are additive and preserve the original capture.

## Native analysis and reconstruction boundaries

The application graph exposes native libraries and path-based DEX/native hypotheses. To inspect a specific library, add `native` probes to a collection plan (or a package config):

```json
{
  "native": [{ "path": "lib/x86_64/libsgtatham.so", "provider": "ghidra", "addresses": [] }]
}
```

Only inventoried members are extracted, with a 64 MiB per-library bound, ELF magic and digest verification. The orchestrator requests REA binary layout and the configured native provider's overview; explicit addresses request bounded decompilation. A provider must already be installed and configured according to the pinned REA documentation. Missing Ghidra/pwntools or unsupported analysis records `unavailable`, and unexamined libraries remain listed. These static results do not prove individual JNI bindings or runtime semantics.

Android graphs do not automatically create the upstream JavaScript reconstruction obligations. We explicitly add required UI scenario obligations using real session Evidence. They remain open until implementation owners, original cases, candidate fixtures and authenticated comparable verifiers are bound. A visual-model pass is a finite UI-quality review, not a forged REA reconstruction-closure claim. Screenshots cannot establish undo correctness, persistence, native ABI equivalence or unobserved failure paths; keep the existing native behavioral tests.

To evaluate actual implementation bindings later, run `npm run observe -- ledger --request /absolute/path/request.json --out /absolute/path/new-ledger`. The request contains the upstream `evidence_bundle`, `reviewed_obligations` and `manifest` fields. REA authenticates the bundle and validates every binding; the saved result reports `ready`, `open`, `failed` or `unknown`. This command consumes recorded verifier Evidence; it does not invent passing verifiers or execute arbitrary commands from a manifest.

## Validation record

Policy unit tests are in `pipeline/tests/observation.test.ts`; they cover tampered and missing evidence, scope/serial restrictions, ambiguous selectors, incomplete scenarios and false passes. Actual local emulator/model runs are saved separately in `outputs/rea-ui-integration/`. Unit mocks are not evidence of a live end-to-end build. See that directory's live report for the exercised APKs and scenario results.


Local live verification on 2026-10-17 used Antimine (`dev.lucanlm.antimine`, APK `e7b635b6629bc5b0f59c2700a82079386a90f3a04b39e92e0cf0bb090979e974`) and the delivered Minefield Plus APK (`a52d2ecafcfaa027f3ee610a4a06ea0c9475db77647ab11839d296f2ea433dfd`). The game and settings screens were captured on `emulator-5580`, with exact installed-APK digest checks. The active Antimine board required explicit visual-only scope; its foreground window and REA screenshot were recorded while hierarchy access remained unavailable. The candidate retained hierarchy evidence. Actual model image input, finite two-screen comparison, artifact validation and fresh-session REA evidence import all passed. The self-contained report is `outputs/rea-ui-integration/comparison-final/comparison.html`.

The original graph inventories eight native libraries. A targeted `lib/x86_64/libsgtatham.so` probe preserved its verified extraction and provider-unavailable result because Ghidra is not installed. The REA UI ledger contains two required open obligations and zero verified obligations. These results do not establish JNI semantics, original/candidate functional equivalence, or a newly generated APK. The new Gradle → UI gate → code repair loop is wired into the worker but was not exercised as a complete generated-app build in this verification. Both the website and independent API have the new configuration enabled; the delivered APK was not replaced.
