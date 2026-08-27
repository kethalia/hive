#!/bin/sh
set -eu

umask 022

unset NPM_TOKEN NODE_AUTH_TOKEN
unset NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG
unset npm_config_userconfig npm_config_globalconfig

# This script runs in a credential-free sidecar without the persistent home.
# Copy the image-baked Claude executable and install the pinned Playwright MCP
# into pod-local volumes. Runtime mounts are read-only and the candidate
# container never mounts the MCP volume, so candidate processes cannot replace
# either trusted payload. Kubernetes retries this sidecar after a transient
# staging failure without blocking the main recovery terminal.
image_claude_link="/home/coder/.local/bin/claude"
trusted_tools_dir="/trusted-tools"
trusted_mcp_dir="/trusted-mcp"
trusted_claude="$trusted_tools_dir/claude"
trusted_helper="$trusted_tools_dir/interview-claude"
trusted_guard="$trusted_tools_dir/claude-guard.so"
playwright_mcp_version="0.0.79"
trusted_playwright_root="$trusted_mcp_dir/playwright-mcp-$playwright_mcp_version"
trusted_playwright_mcp="$trusted_playwright_root/node_modules/.bin/playwright-mcp"

if [ -z "${HIVE_INTERVIEW_CLAUDE_HELPER_B64:-}" ]; then
  printf '[error] trusted interview-claude helper payload is missing\n' >&2
  exit 1
fi
if [ -z "${HIVE_INTERVIEW_CLAUDE_GUARD_B64:-}" ]; then
  printf '[error] trusted Claude process guard payload is missing\n' >&2
  exit 1
fi

if [ ! -L "$image_claude_link" ] && [ ! -f "$image_claude_link" ]; then
  printf '[error] image-baked Claude entrypoint is missing: %s\n' "$image_claude_link" >&2
  exit 1
fi

image_claude="$(/usr/bin/readlink -f -- "$image_claude_link")"
case "$image_claude" in
  /home/coder/.local/share/claude/versions/*) ;;
  *)
    printf '[error] image-baked Claude entrypoint resolved outside its version store: %s\n' \
      "$image_claude" >&2
    exit 1
    ;;
esac
if [ ! -f "$image_claude" ] || [ ! -x "$image_claude" ] || [ -L "$image_claude" ]; then
  printf '[error] image-baked Claude executable is not a regular executable: %s\n' \
    "$image_claude" >&2
  exit 1
fi

temporary_claude="$(/usr/bin/mktemp "$trusted_tools_dir/.claude.XXXXXX")"
temporary_helper="$(/usr/bin/mktemp "$trusted_tools_dir/.interview-claude.XXXXXX")"
temporary_guard_source="$(/usr/bin/mktemp "$trusted_tools_dir/.claude-guard.XXXXXX.c")"
temporary_guard="$(/usr/bin/mktemp "$trusted_tools_dir/.claude-guard.XXXXXX.so")"
temporary_playwright_root=""
cleanup_trusted_tool() {
  /usr/bin/rm -f -- "$temporary_claude"
  /usr/bin/rm -f -- "$temporary_helper"
  /usr/bin/rm -f -- "$temporary_guard_source"
  /usr/bin/rm -f -- "$temporary_guard"
  if [ -n "$temporary_playwright_root" ]; then
    /usr/bin/rm -rf -- "$temporary_playwright_root"
  fi
}
trap cleanup_trusted_tool EXIT HUP INT TERM

/usr/bin/cp -- "$image_claude" "$temporary_claude"
/usr/bin/chmod 0555 "$temporary_claude"
"$temporary_claude" --version >/dev/null

printf '%s' "$HIVE_INTERVIEW_CLAUDE_HELPER_B64" \
  | /usr/bin/base64 --decode > "$temporary_helper"
unset HIVE_INTERVIEW_CLAUDE_HELPER_B64
/usr/bin/chmod 0555 "$temporary_helper"
/usr/bin/python3 -I - "$temporary_helper" <<'PYTHONCHECK'
from pathlib import Path
import sys

compile(Path(sys.argv[1]).read_bytes(), sys.argv[1], "exec")
PYTHONCHECK

printf '%s' "$HIVE_INTERVIEW_CLAUDE_GUARD_B64" \
  | /usr/bin/base64 --decode > "$temporary_guard_source"
unset HIVE_INTERVIEW_CLAUDE_GUARD_B64
/usr/bin/cc -shared -fPIC -O2 -Wall -Wextra -Werror \
  -Wl,-z,relro,-z,now -o "$temporary_guard" "$temporary_guard_source" -ldl
/usr/bin/chmod 0555 "$temporary_guard"
/usr/bin/rm -f -- "$temporary_guard_source"
temporary_guard_source=""

playwright_mcp_ready() {
  playwright_root=$1
  playwright_command="$playwright_root/node_modules/.bin/playwright-mcp"
  [ -x "$playwright_command" ] || return 1
  resolved_playwright="$(/usr/bin/readlink -f -- "$playwright_command")" || return 1
  case "$resolved_playwright" in
    "$playwright_root"/*) ;;
    *) return 1 ;;
  esac
  "$playwright_command" --version 2>/dev/null \
    | /usr/bin/grep -qF -- "$playwright_mcp_version"
}

if ! playwright_mcp_ready "$trusted_playwright_root"; then
  /usr/bin/rm -rf -- "$trusted_playwright_root"
  temporary_playwright_root="$(/usr/bin/mktemp -d "$trusted_mcp_dir/.playwright-mcp.XXXXXX")"
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NPM_CONFIG_USERCONFIG=/dev/null \
    /usr/bin/npm install \
      --prefix "$temporary_playwright_root" \
      --ignore-scripts \
      --no-audit \
      --no-fund \
      --no-package-lock \
      --no-save \
      "@playwright/mcp@$playwright_mcp_version" >/dev/null
  if ! playwright_mcp_ready "$temporary_playwright_root"; then
    printf '[error] pinned Playwright MCP staging validation failed\n' >&2
    exit 1
  fi
  /usr/bin/mv -T -- "$temporary_playwright_root" "$trusted_playwright_root"
  temporary_playwright_root=""
fi

/usr/bin/mv -fT -- "$temporary_claude" "$trusted_claude"
temporary_claude=""
/usr/bin/mv -fT -- "$temporary_helper" "$trusted_helper"
temporary_helper=""
/usr/bin/mv -fT -- "$temporary_guard" "$trusted_guard"
temporary_guard=""
trap - EXIT HUP INT TERM

printf '[ok] staged Claude, credential broker, process guard, and Playwright MCP for read-only mounts\n'

if [ "${1:-}" = "--stay-alive" ]; then
  printf '[ok] trusted interview payload is ready; keeping staging sidecar available\n'
  while :; do
    /usr/bin/sleep 3600
  done
fi
