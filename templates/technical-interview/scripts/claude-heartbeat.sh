#!/bin/bash
set -euo pipefail
umask 077

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
unset BASH_ENV ENV CDPATH LD_LIBRARY_PATH LD_PRELOAD
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
unset GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN
unset SSH_AUTH_SOCK SSH_AGENT_PID

status_directory="/run/hive-interview-claude"
trusted_helper="/opt/hive-interview-tools/interview-claude"
installed_helper="$HOME/.local/bin/interview-claude"

if [ -L "$status_directory" ] || [ ! -d "$status_directory" ]; then
  exit 1
fi
if [ ! -f "$trusted_helper" ] || [ -L "$trusted_helper" ] || [ ! -x "$trusted_helper" ]; then
  exit 1
fi
if [ ! -L "$installed_helper" ] \
  || [ "$(/usr/bin/readlink -- "$installed_helper")" != "$trusted_helper" ]; then
  exit 1
fi

temporary_status="$(/usr/bin/mktemp "$status_directory/.ready.XXXXXX")"
/usr/bin/printf 'isolated-claude-agent-ready-v2 %s\n' "$(/usr/bin/date +%s)" > "$temporary_status"
/usr/bin/chmod 0444 "$temporary_status"
/usr/bin/mv -fT -- "$temporary_status" "$status_directory/ready"
