#!/bin/bash
# The Coder module and Hive's AI Tools script start concurrently. The module
# validates the existing CLI, while Hive owns installation and updates.
set -u
deadline=$((SECONDS + 180))
while (( SECONDS < deadline )); do
  if command -v codex >/dev/null 2>&1 && timeout 2s codex --version >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done
printf '%s\n' 'Codex CLI did not become ready before the startup deadline.' >&2
exit 1
