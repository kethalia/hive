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
  command -v coder >/dev/null 2>&1 || exit 1
  token="$(coder external-auth access-token github)"
fi
printf 'username=x-access-token\npassword=%s\n' "$token"
