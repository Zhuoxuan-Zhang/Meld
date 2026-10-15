#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
backend_revision="ab005dd"
if [ -f "$PWD/pipeline/src/integration.ts" ] && [ -d "$PWD/backend" ]; then
  backend_dir="$PWD"
else
  backend_dir="$PWD/third_parties/new_app_agent"
  if [ ! -e "$backend_dir/.git" ]; then
    git clone https://github.com/Zhuoxuan-Zhang/new_app_agent.git "$backend_dir"
    git -C "$backend_dir" checkout --detach "$backend_revision"
  fi
fi
if [ ! -f "$backend_dir/pipeline/src/integration.ts" ]; then
  echo "The backend checkout needs Zhuoxuan's design pipeline (937eee7 or later)."
  exit 1
fi
pipeline_dir="$backend_dir/pipeline"
# Newer upstream includes the scope-aware engine. Preserve the local merged
# selection guidance; replaying older patches would conflict with this version.
if [ ! -f "$backend_dir/backend/src/high-level.ts" ]; then
  echo "Update the backend checkout to origin/zhuoxuan (ab005dd or later)."
  exit 1
fi
workflow_patch="$PWD/frontend/patches/meld-workflow.patch"
# Meld's frontend is synced separately. Backend setup must not replay the
# upstream UI/test hunks over the current studio or its Playwright settings.
if ! git -C "$backend_dir" apply '--exclude=frontend/*' --reverse --check "$workflow_patch" 2>/dev/null; then
  git -C "$backend_dir" apply '--exclude=frontend/*' --check "$workflow_patch"
  git -C "$backend_dir" apply '--exclude=frontend/*' "$workflow_patch"
fi
selection_prompt="$backend_dir/frontend/prompts/design-selection/prompt.md"
if [ ! -f "$selection_prompt" ]; then
  mkdir -p "$(dirname "$selection_prompt")"
  cp "$PWD/frontend/prompts/design-selection/prompt.md" "$selection_prompt"
fi
if [ ! -f "$pipeline_dir/node_modules/.package-lock.json" ] || [ "$pipeline_dir/package-lock.json" -nt "$pipeline_dir/node_modules/.package-lock.json" ]; then
  npm --prefix "$pipeline_dir" ci --no-audit --no-fund
fi
npm --prefix "$pipeline_dir" run build
if [ "${MELD_EMULATOR_ENABLED:-true}" != "false" ]; then
  bash "$backend_dir/scripts/setup-browser-emulator.sh" || echo "Browser preview is not configured. APK downloads still work."
fi
echo "Design backend ready. APK analysis tools: npm run setup:analysis"
