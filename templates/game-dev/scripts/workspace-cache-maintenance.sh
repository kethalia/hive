#!/usr/bin/env bash
# Run only npm's own cache verification/garbage collection as the workspace owner.
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$PATH"
if ! command -v npm >/dev/null; then
  echo 'SKIP: npm is not installed in this workspace.'
  exit 0
fi
cache=$(npm config get cache)
expected_cache="$HOME/.npm"
if [[ "$cache" != "$expected_cache" || -L "$expected_cache" ]]; then
  echo 'Refusing a nonstandard or symlinked npm cache.' >&2
  exit 1
fi
if [[ ! -d "$cache" ]]; then
  echo 'SKIP: no npm cache exists.'
  exit 0
fi
# npm verifies _cacache; _npx legitimately contains executable symlinks and is
# outside this check. Refuse redirected cache objects or npm's default log dir.
if [[ -L "$cache/_cacache" || -L "$cache/_logs" ]]; then
  echo 'Refusing redirected npm cache objects or logs.' >&2
  exit 1
fi
if [[ -d "$cache/_cacache" && -n "$(find "$cache/_cacache" -type l -print -quit)" ]]; then
  echo 'Refusing symbolic links inside npm cache objects.' >&2
  exit 1
fi
before=$(du -sk "$cache" | awk '{print $1}')
printf 'npm cache maintenance started: %s; before=%s KiB\n' "$(date -u +%FT%TZ)" "$before"
# Bound the operation even when run manually, and avoid competing with builds.
timeout --signal=TERM --kill-after=15s 540s nice -n 15 npm cache verify --cache "$cache"
after=$(du -sk "$cache" | awk '{print $1}')
printf 'npm cache maintenance completed: %s; after=%s KiB; net reclaimed=%s KiB\n' \
  "$(date -u +%FT%TZ)" "$after" "$((before - after))"
