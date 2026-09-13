#!/usr/bin/env bash
set -euo pipefail

plugin_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$plugin_dir"
npm ci
npm run build
npm link

echo "Installed windows-power-mcp from $plugin_dir"
