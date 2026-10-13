#!/bin/bash
# Double-click to set up and start Meld. Same as running scripts/dev.sh from
# the repository root.
cd "$(dirname "$0")"
bash ../scripts/dev.sh || read -r -p "Press Enter to close. "
