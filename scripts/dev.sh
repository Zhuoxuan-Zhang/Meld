#!/bin/bash
# Sets up and starts Meld (the local frontend) with one command: installs
# whatever is missing, prepares the market-signal scanner, starts the local
# server and opens it in the browser. Safe to run again at any time.
#
#   scripts/dev.sh              set up if needed, start, open the browser
#   scripts/dev.sh --restart    replace a Meld server that is already running
#   scripts/dev.sh --no-open    do not open the browser
#   scripts/dev.sh --check      set up, then run the test suite instead
#
# Settings: MELD_PORT (default 4173), MELD_MARKET_DIR (scanner checkout).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="$ROOT/frontend"
# The scanner: this repository itself (new_app_agent), or a checkout in
# third_parties/new_app_agent (copy-agent2).
if [ -n "${MELD_MARKET_DIR:-}" ]; then
  SCANNER="$MELD_MARKET_DIR"
elif [ -d "$ROOT/app_market" ]; then
  SCANNER="$ROOT"
else
  SCANNER="$ROOT/third_parties/new_app_agent"
fi
PORT="${MELD_PORT:-4173}"
URL="http://127.0.0.1:$PORT"
OPEN=1
RESTART=0
CHECK=0
for arg in "$@"; do
  case "$arg" in
    --no-open) OPEN=0 ;;
    --restart) RESTART=1 ;;
    --check) CHECK=1 ;;
    -h | --help)
      sed -n '2,11p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (see scripts/dev.sh --help)"
      exit 2
      ;;
  esac
done

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
fail() {
  printf '\033[31m%s\033[0m\n' "$*"
  exit 1
}
open_url() {
  [ "$OPEN" = 1 ] || return 0
  if command -v open >/dev/null 2>&1; then
    open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1 &
  fi
}

# 1. Node.js 22.19+ or 24+. Loads nvm when node is not already on PATH.
if ! command -v node >/dev/null 2>&1; then
  NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  if [ -s "$NVM_SH" ]; then
    set +u
    # shellcheck disable=SC1090
    . "$NVM_SH"
    nvm use --silent default >/dev/null 2>&1 || true
    set -u
  fi
fi
command -v node >/dev/null 2>&1 ||
  fail "Meld needs Node.js 22.19 or newer. Install it from https://nodejs.org and run this again."
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' ||
  fail "Meld needs Node.js 22.19 or newer; this computer has $(node -v)."

# 2. Frontend dependencies, installed again whenever package-lock.json changes.
if [ ! -f "$ROOT/pipeline/node_modules/.package-lock.json" ] || [ "$ROOT/pipeline/package-lock.json" -nt "$ROOT/pipeline/node_modules/.package-lock.json" ]; then
  say "Installing the design pipeline"
  npm --prefix "$ROOT/pipeline" ci --no-audit --no-fund
fi
say "Compiling the design pipeline"
npm --prefix "$ROOT/pipeline" run build
cd "$FRONTEND"
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  say "Installing frontend dependencies"
  npm ci --no-audit --no-fund
fi

# 3. Market-signal scanner. Optional: without it Meld shows its sample apps.
if [ -n "${MELD_MARKET_PYTHON:-}" ]; then
  note "Market scanner: using MELD_MARKET_PYTHON=$MELD_MARKET_PYTHON"
elif [ ! -f "$SCANNER/pyproject.toml" ]; then
  note "Market scanner not found at $SCANNER; Meld will show sample apps."
elif [ ! -f "$SCANNER/.venv/.meld-ready" ] ||
  [ "$SCANNER/pyproject.toml" -nt "$SCANNER/.venv/.meld-ready" ] ||
  ! "$SCANNER/.venv/bin/python" -c 'import app_market.scanner' >/dev/null 2>&1; then
  say "Setting up the market-signal scanner"
  MELD_MARKET_DIR="$SCANNER" bash "$FRONTEND/scripts/setup-market.sh" ||
    note "Market signals are not set up; Meld will show sample apps."
fi
export MELD_MARKET_DIR="$SCANNER"

# 4. AI suggestions are optional and need an OpenRouter key.
if [ -z "${OPENROUTER_API_KEY:-}" ] &&
  ! command grep -qs '^OPENROUTER_API_KEY=.' .env.local; then
  note "AI suggestions are off. Add OPENROUTER_API_KEY to frontend/.env.local to turn them on."
fi

if [ "$CHECK" = 1 ]; then
  say "Running the test suite"
  exec npx playwright test
fi

# 5. Start the local server, or reuse the Meld server already running.
listening() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
  else
    curl -s -o /dev/null -m 2 "$URL"
  fi
}
if listening; then
  if ! curl -s -m 5 "$URL/api/ai/status" | command grep -q '"provider"'; then
    fail "Port $PORT is used by another program. Stop it, or run: MELD_PORT=4180 scripts/dev.sh"
  fi
  if [ "$RESTART" = 0 ] &&
    curl -s -m 30 "$URL/api/market/status" | command grep -q '"source"'; then
    say "Meld is already running at $URL"
    note "To restart it, run scripts/dev.sh --restart"
    open_url "$URL"
    exit 0
  fi
  # A restart was asked for, or the running copy predates market signals.
  say "Stopping the Meld server on port $PORT"
  kill $(lsof -tiTCP:"$PORT" -sTCP:LISTEN) 2>/dev/null || true
  for _ in $(seq 50); do
    listening || break
    sleep 0.2
  done
  listening && fail "The server on port $PORT did not stop. Close it and run this again."
fi

say "Starting Meld at $URL (press Control-C to stop)"
args=(--host 127.0.0.1 --port "$PORT" --strictPort)
[ "$OPEN" = 1 ] && args+=(--open)
exec node "$ROOT/scripts/serve.mjs" "${args[@]}"
