#!/bin/bash
# Open the tested Forest core in its own Android emulator.
set -euo pipefail
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/launch.py" core "$@"
