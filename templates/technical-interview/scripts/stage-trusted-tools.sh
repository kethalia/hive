#!/bin/sh
set -eu

umask 022

# This script runs in an init container before the persistent home is mounted.
# Copy the image-baked Claude executable into a pod-local volume which the
# workspace container mounts read-only. The temporary interview key is then
# exposed only to this immutable copy, never to a candidate-writable PATH entry.
image_claude_link="/home/coder/.local/bin/claude"
trusted_tools_dir="/trusted-tools"
trusted_claude="$trusted_tools_dir/claude"
trusted_helper="$trusted_tools_dir/interview-claude"

if [ -z "${HIVE_INTERVIEW_CLAUDE_HELPER_B64:-}" ]; then
  printf '[error] trusted interview-claude helper payload is missing\n' >&2
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
cleanup_trusted_tool() {
  /usr/bin/rm -f -- "$temporary_claude"
  /usr/bin/rm -f -- "$temporary_helper"
}
trap cleanup_trusted_tool EXIT HUP INT TERM

/usr/bin/cp -- "$image_claude" "$temporary_claude"
/usr/bin/chmod 0555 "$temporary_claude"
"$temporary_claude" --version >/dev/null

printf '%s' "$HIVE_INTERVIEW_CLAUDE_HELPER_B64" \
  | /usr/bin/base64 --decode > "$temporary_helper"
unset HIVE_INTERVIEW_CLAUDE_HELPER_B64
/usr/bin/chmod 0555 "$temporary_helper"
/bin/dash -n "$temporary_helper"

/usr/bin/mv -fT -- "$temporary_claude" "$trusted_claude"
temporary_claude=""
/usr/bin/mv -fT -- "$temporary_helper" "$trusted_helper"
temporary_helper=""
trap - EXIT HUP INT TERM

printf '[ok] staged image-baked Claude and its launcher for read-only workspace mounts\n'
