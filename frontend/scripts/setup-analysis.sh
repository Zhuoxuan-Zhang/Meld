#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ -f "$PWD/pipeline/src/integration.ts" ]; then
  pipeline_dir="$PWD/pipeline"
else
  pipeline_dir="$PWD/third_parties/new_app_agent/pipeline"
fi
if [ -z "${JAVA_HOME:-}" ] && [ -x "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java" ]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi
bash "$pipeline_dir/scripts/setup.sh"
