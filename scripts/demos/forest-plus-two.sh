#!/bin/bash
# Open the tested Forest core + checklist + reflections in its own emulator.
set -euo pipefail
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/launch.py" plus-two "$@"
