# UI design and coding skills

The Base App UI Design skill lives in `pipeline/skills/base-ui-design/SKILL.md`. Only high-level and detailed UI design calls load its instructions when original base screenshots are available. It preserves observed hierarchy, navigation and screen anchors while documenting intentional adaptations. It does not claim original-app runtime equivalence from store screenshots.

Android implementation calls load three reviewed compatibility profiles: edge-to-edge, adaptive and jetpack-compose-performance. They apply to planning, source generation, repair and implementation review. They do not enter UI design prompts. Approved designs and reference images remain implementation inputs.

The full upstream sources are retained under `backend/skills/upstream`, pinned to android/skills commit `95ea931a1ad8f9b2be132ae0cfb2aad964d71118` with the Apache 2.0 license. Compact profiles target the existing SDK 35 and Compose BOM 2025.05.01 template. Loading them does not execute upstream migration workflows, introduce Navigation 3 or alpha APIs, or upgrade dependencies.

The registry verifies every file hash and rejects symlink escapes. Each build pins its manifest in `coding-skills.json`; resuming that build with changed skills fails explicitly. Build reports carry the fingerprint, source revision and toolchain. Rule loading adds no model round trip or network fetch.

`MELD_PROJECT_EXAMPLE` selects an existing project for the website homepage. The example appears only after a current-revision APK passes build, unit tests and lint. Opening it reuses saved design and build artifacts. Runtime verification is reported separately; a new app screenshot is never presented as an original Forest runtime capture.

The first live Focus Grove build exposed an invalid initial manifest (source fragments instead of a launcher/test plan). Initial plans now receive the same bounded semantic correction treatment as repair plans: record the rejection, return the exact validation error, allow at most three attempts, and generate no files until the manifest validates. A validated plan is checkpointed before its first source module.

Configured native acceptance now runs before implementation review. Its APK-bound report and up to four verified candidate PNGs are supplied alongside the original base images. The reviewer can assess actual viewport evidence; its decision still gates delivery. Older source-only review rejections may be rechecked once using exactly matching, successfully compiled sources under this evidence context. Failed native cases still trigger repairs; harness failures still stop without app regeneration. Exhausted attempts preserve their final failure stage and round.
