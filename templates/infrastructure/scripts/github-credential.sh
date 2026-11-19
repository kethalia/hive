#!/bin/sh
set -eu

operation=${1:-}
host=""
while IFS='=' read -r key value; do
  case "$key" in
    host) host=$value ;;
  esac
done

[ "$operation" = "get" ] || exit 0
[ "$host" = "github.com" ] || exit 0

token=${GH_TOKEN:-}
if [ -z "$token" ]; then
  config_dir=${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}
  if [ -e "$config_dir/.hive-workspace-login" ] || [ -s "$config_dir/hosts.yml" ]; then
    token="$("${GH_REAL_BIN:-$HOME/.local/libexec/gh}" auth token --hostname github.com)" || exit 1
  else
    command -v coder >/dev/null 2>&1 || exit 1
    token="$(coder external-auth access-token github)"
  fi
fi
printf 'username=x-access-token\npassword=%s\n' "$token"
