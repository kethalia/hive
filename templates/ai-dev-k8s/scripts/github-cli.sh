#!/bin/sh
set -eu

real_gh="${GH_REAL_BIN:-$HOME/.local/libexec/gh}"
if [ ! -x "$real_gh" ]; then
  printf 'GitHub CLI binary not found: %s\n' "$real_gh" >&2
  exit 1
fi

if [ -z "${GH_TOKEN:-}" ]; then
  GH_TOKEN="$(coder external-auth access-token github)"
  export GH_TOKEN
fi

exec "$real_gh" "$@"
