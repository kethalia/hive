#!/bin/bash
set -euo pipefail
umask 077

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
unset BASH_ENV ENV CDPATH LD_LIBRARY_PATH LD_PRELOAD
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
unset CLAUDE_CONFIG_DIR CLAUDE_SECURESTORAGE_CONFIG_DIR
unset GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN
unset SSH_AUTH_SOCK SSH_AGENT_PID

status_directory="/run/hive-interview-claude"
trusted_helper="/opt/hive-interview-tools/interview-claude"
installed_helper="$HOME/.local/bin/interview-claude"
playwright_mcp_version="0.0.79"
staged_playwright_root="/opt/hive-interview-mcp/playwright-mcp-$playwright_mcp_version"
staged_playwright_mcp="$staged_playwright_root/node_modules/.bin/playwright-mcp"
installed_playwright_mcp="$HOME/.local/bin/playwright-mcp"
playwright_mcp_config="$HOME/.claude.json"

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
if [ ! -L "$installed_playwright_mcp" ] \
  || [ "$(/usr/bin/readlink -- "$installed_playwright_mcp")" != "$staged_playwright_mcp" ] \
  || [ ! -x "$staged_playwright_mcp" ]; then
  exit 1
fi
resolved_playwright_mcp="$(/usr/bin/readlink -f -- "$staged_playwright_mcp")" || exit 1
case "$resolved_playwright_mcp" in
  "$staged_playwright_root"/*) ;;
  *) exit 1 ;;
esac
if ! "$staged_playwright_mcp" --version 2>/dev/null \
  | /usr/bin/grep -qF -- "$playwright_mcp_version"; then
  exit 1
fi
if [ ! -f "$playwright_mcp_config" ] || [ -L "$playwright_mcp_config" ]; then
  exit 1
fi
if ! /usr/bin/python3 -I - "$playwright_mcp_config" <<'PYTHONMCP'
import json
import sys
from pathlib import Path

expected = {
    "mcpServers": {
        "playwright": {
            "type": "stdio",
            "command": "/home/coder/.local/bin/playwright-mcp",
            "args": ["--browser", "chrome", "--headless", "--no-sandbox", "--isolated"],
            "env": {},
        }
    }
}
try:
    actual = json.loads(Path(sys.argv[1]).read_text())
except (OSError, UnicodeDecodeError, json.JSONDecodeError):
    raise SystemExit(1)
if actual != expected:
    raise SystemExit(1)
PYTHONMCP
then
  exit 1
fi

temporary_status="$(/usr/bin/mktemp "$status_directory/.ready.XXXXXX")"
/usr/bin/printf 'isolated-claude-agent-ready-v2 %s\n' "$(/usr/bin/date +%s)" > "$temporary_status"
/usr/bin/chmod 0444 "$temporary_status"
/usr/bin/mv -fT -- "$temporary_status" "$status_directory/ready"
