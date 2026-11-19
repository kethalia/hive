#!/bin/sh
set -eu

real_gh="${GH_REAL_BIN:-$HOME/.local/libexec/gh}"
if [ ! -x "$real_gh" ]; then
  printf 'GitHub CLI binary not found: %s\n' "$real_gh" >&2
  exit 1
fi

# Native gh sign-in belongs to this workspace. Existing Coder-managed
# workspaces keep their external-auth fallback until they adopt a local login.
config_dir=${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}
if [ "${1:-}" = auth ] || [ -e "$config_dir/.hive-workspace-login" ] || [ -s "$config_dir/hosts.yml" ]; then
  exec "$real_gh" "$@"
fi
if [ -z "${GH_TOKEN:-}" ]; then
  GH_TOKEN="$(coder external-auth access-token github)"
  export GH_TOKEN
fi

exec "$real_gh" "$@"
