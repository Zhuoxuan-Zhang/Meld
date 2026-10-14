#!/usr/bin/env bash
# Source from the apk-design-mvp working directory.
if [ -d tools/node/bin ]; then export PATH="$PWD/tools/node/bin:$PATH"; fi
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk-amd64}"
export REA_JADX_MCP_JAR="$PWD/vendor/rea/_reference/apk-integration/jadx-headless-mcp-0.7.1-all.jar"
export REA_APKTOOL_COMMAND="$PWD/tools/apktool"
export REA_JADX_HEAP_MIB="${REA_JADX_HEAP_MIB:-4096}"
export REA_JADX_ACTIVE_PROCESSOR_COUNT="${REA_JADX_ACTIVE_PROCESSOR_COUNT:-4}"
