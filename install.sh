#!/usr/bin/env bash
set -euo pipefail

if [ -f package.json ]; then
  npm install --omit=dev --no-audit --no-fund
fi

echo "install complete"
