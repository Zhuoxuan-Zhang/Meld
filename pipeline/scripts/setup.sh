#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -d tools/node/bin ]; then export PATH="$PWD/tools/node/bin:$PATH"; fi
node -e 'const v=process.versions.node.split(".").map(Number);if(v[0]<22||(v[0]===22&&v[1]<19))throw Error("Use Node 24.18.0 (see .nvmrc)")'
: "${JAVA_HOME:?Set JAVA_HOME to a full JDK 17+}"
"$JAVA_HOME/bin/java" --list-modules | rg '^jdk.compiler@'
mkdir -p vendor tools downloads setup
for link in vendor/rea node_modules; do
  if [ -L "$link" ] && [ ! -e "$link" ]; then mv "$link" "setup/broken-$(basename "$link")-$(date +%s)"; fi
done
REA_COMMIT=$(node -p 'JSON.parse(require("fs").readFileSync("config/toolchain.lock.json")).rea_commit')
if [ ! -d vendor/rea ]; then git clone https://github.com/morluto/rea.git vendor/rea; fi
if [ -n "$(git -C vendor/rea status --porcelain)" ]; then printf 'REA has local changes; preserve them before setup.\n' >&2; exit 1; fi
if [ "$(git -C vendor/rea rev-parse HEAD)" != "$REA_COMMIT" ]; then
  git -C vendor/rea fetch origin "$REA_COMMIT"
  git -C vendor/rea checkout --detach "$REA_COMMIT"
fi
npm ci
npm --prefix vendor/rea ci
npm --prefix vendor/rea run build:cached
npm --prefix vendor/rea run fixtures:android
if [ ! -f downloads/apktool_3.0.3.jar ]; then
  curl -fsSL --max-time 300 https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar -o downloads/apktool_3.0.3.jar.partial
  mv downloads/apktool_3.0.3.jar.partial downloads/apktool_3.0.3.jar
fi
node -e 'const f=require("fs"),c=require("crypto"),l=JSON.parse(f.readFileSync("config/toolchain.lock.json"));if(c.createHash("sha256").update(f.readFileSync("downloads/apktool_3.0.3.jar")).digest("hex")!==l.apktool_sha256)throw Error("Apktool hash mismatch")'
cat > tools/apktool <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
APK_MVP_ROOT=$(cd "$(dirname "$0")/.." && pwd)
exec "${JAVA_HOME}/bin/java" -jar "$APK_MVP_ROOT/downloads/apktool_3.0.3.jar" "$@"
LAUNCHER
chmod 700 tools/apktool
source scripts/env.sh
npm --prefix vendor/rea run verify:apktool -- --apk "$PWD/vendor/rea/_reference/apk-integration/ApiDemos-debug.apk"
printf 'Setup complete. Run typecheck and tests, then npm run mvp -- run --demo --brief config/brief.notes.json\n'
