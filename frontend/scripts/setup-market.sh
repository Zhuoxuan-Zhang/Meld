#!/bin/bash
# Installs the market-signal scanner (new_app_agent) into its own virtual
# environment so Meld's local server can run it. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
# The scanner repository this folder sits in, or third_parties/new_app_agent.
if [ -n "${MELD_MARKET_DIR:-}" ]; then
  DIR="$MELD_MARKET_DIR"
elif [ -d ../app_market ]; then
  DIR=..
else
  DIR=../third_parties/new_app_agent
fi
if [ ! -f "$DIR/pyproject.toml" ]; then
  echo "Market scanner not found at $DIR. Set MELD_MARKET_DIR to its folder."
  exit 1
fi
# A Python 3.10+ from PATH or a usual install location; uv (if present) can
# provide one otherwise.
find_python() {
  local dir name candidate
  for dir in "" /opt/homebrew/bin /usr/local/bin "$HOME/.pyenv/shims" \
    /Library/Frameworks/Python.framework/Versions/Current/bin; do
    for name in python3.14 python3.13 python3.12 python3.11 python3.10 python3; do
      candidate="${dir:+$dir/}$name"
      if command -v "$candidate" >/dev/null 2>&1 &&
        "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
        echo "$candidate"
        return 0
      fi
    done
  done
  return 1
}
find_uv() {
  command -v uv 2>/dev/null ||
    { [ -x "$HOME/.local/bin/uv" ] && echo "$HOME/.local/bin/uv"; } ||
    { [ -x "$HOME/.cargo/bin/uv" ] && echo "$HOME/.cargo/bin/uv"; }
}
if [ ! -x "$DIR/.venv/bin/python" ] ||
  ! "$DIR/.venv/bin/python" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
  rm -rf "$DIR/.venv"
  if PYTHON="$(find_python)"; then
    "$PYTHON" -m venv "$DIR/.venv"
  elif UV="$(find_uv)"; then
    echo "No Python 3.10+ found; uv is creating the environment with its own Python."
    "$UV" venv --quiet --seed --python 3.12 "$DIR/.venv"
  else
    echo "Market signals need Python 3.10 or newer. Install it, then run this again."
    exit 1
  fi
fi
"$DIR/.venv/bin/python" -m pip install --quiet --disable-pip-version-check -e "$DIR"
"$DIR/.venv/bin/python" -c 'import app_market.scanner'
touch "$DIR/.venv/.meld-ready"
echo "Market scanner ready: $DIR/.venv/bin/python"
