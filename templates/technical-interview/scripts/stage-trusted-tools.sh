#!/bin/sh
set -eu

umask 022

# This script runs in an init container before the persistent home is mounted.
# Copy the image-baked Claude executable into a pod-local volume which the
# workspace container mounts read-only. The immutable launcher keeps the
# temporary key in its protected broker rather than exposing it to Claude.
image_claude_link="/home/coder/.local/bin/claude"
trusted_tools_dir="/trusted-tools"
trusted_claude="$trusted_tools_dir/claude"
trusted_helper="$trusted_tools_dir/interview-claude"
trusted_guard="$trusted_tools_dir/claude-guard.so"

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
cleanup_trusted_tool() {
  /usr/bin/rm -f -- "$temporary_claude"
  /usr/bin/rm -f -- "$temporary_helper"
  /usr/bin/rm -f -- "$temporary_guard_source"
  /usr/bin/rm -f -- "$temporary_guard"
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
  -Wl,-z,relro,-z,now -o "$temporary_guard" "$temporary_guard_source"
/usr/bin/chmod 0555 "$temporary_guard"
/usr/bin/rm -f -- "$temporary_guard_source"
temporary_guard_source=""

/usr/bin/mv -fT -- "$temporary_claude" "$trusted_claude"
temporary_claude=""
/usr/bin/mv -fT -- "$temporary_helper" "$trusted_helper"
temporary_helper=""
/usr/bin/mv -fT -- "$temporary_guard" "$trusted_guard"
temporary_guard=""
trap - EXIT HUP INT TERM

printf '[ok] staged image-baked Claude, credential broker, and process guard for read-only mounts\n'
