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

token="$(coder external-auth access-token github)"
printf 'username=x-access-token\npassword=%s\n' "$token"
