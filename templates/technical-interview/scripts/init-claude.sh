#!/bin/bash
set -euo pipefail
umask 077

# This container is the credential boundary for the temporary Anthropic key.
# Keep its startup independent from every candidate-writable command path.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
unset BASH_ENV ENV CDPATH LD_LIBRARY_PATH LD_PRELOAD
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
unset GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN
unset GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_PROXY_COMMAND GIT_SSH
unset SSH_AUTH_SOCK SSH_AGENT_PID SSH_ASKPASS_REQUIRE
unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_ASKPASS=/bin/false
export GIT_SSH_COMMAND=/bin/false
export GIT_TERMINAL_PROMPT=0
export SSH_ASKPASS=/bin/false

interview_repository="/workspace/projects/prmsolutions/interview-template"
trusted_helper="/opt/hive-interview-tools/interview-claude"
status_directory="/run/hive-interview-claude"
playwright_mcp_version="0.0.79"
staged_playwright_root="/opt/hive-interview-mcp/playwright-mcp-$playwright_mcp_version"
staged_playwright_mcp="$staged_playwright_root/node_modules/.bin/playwright-mcp"
claude_user_config="$HOME/.claude.json"

for directory in "$HOME/.local" "$HOME/.local/bin" "$HOME/.claude"; do
  if [ -L "$directory" ] || { [ -e "$directory" ] && [ ! -d "$directory" ]; }; then
    printf 'ERROR: isolated Claude home contains an unsafe path: %s\n' "$directory" >&2
    exit 1
  fi
  /usr/bin/mkdir -p -- "$directory"
done

if [ ! -f "$trusted_helper" ] || [ -L "$trusted_helper" ] || [ ! -x "$trusted_helper" ]; then
  printf 'ERROR: immutable interview-claude launcher is unavailable\n' >&2
  exit 1
fi

link_staging="$(/usr/bin/mktemp -d "$HOME/.local/bin/.interview-claude.XXXXXX")"
/usr/bin/ln -s -- "$trusted_helper" "$link_staging/interview-claude"
/usr/bin/mv -fT -- "$link_staging/interview-claude" "$HOME/.local/bin/interview-claude"
/usr/bin/rmdir -- "$link_staging"

playwright_mcp_ready() {
  local resolved_playwright_mcp
  [ -x "$staged_playwright_mcp" ] || return 1
  resolved_playwright_mcp="$(/usr/bin/readlink -f -- "$staged_playwright_mcp")" || return 1
  case "$resolved_playwright_mcp" in
    "$staged_playwright_root"/*) ;;
    *) return 1 ;;
  esac
  "$staged_playwright_mcp" --version 2>/dev/null \
    | /usr/bin/grep -qF -- "$playwright_mcp_version"
}

if ! playwright_mcp_ready; then
  printf 'ERROR: trusted init did not provide the isolated Playwright MCP payload\n' >&2
  exit 1
fi

playwright_link_staging="$(/usr/bin/mktemp -d "$HOME/.local/bin/.playwright-mcp.XXXXXX")"
/usr/bin/ln -s -- "$staged_playwright_mcp" "$playwright_link_staging/playwright-mcp"
/usr/bin/mv -fT -- "$playwright_link_staging/playwright-mcp" "$HOME/.local/bin/playwright-mcp"
/usr/bin/rmdir -- "$playwright_link_staging"

if [ -L "$claude_user_config" ] \
  || { [ -e "$claude_user_config" ] && [ ! -f "$claude_user_config" ]; }; then
  printf 'ERROR: isolated Claude home contains an unsafe user configuration path\n' >&2
  exit 1
fi

projects_link_staging="$(/usr/bin/mktemp -d "$HOME/.projects.XXXXXX")"
/usr/bin/ln -s -- /workspace/projects "$projects_link_staging/projects"
/usr/bin/mv -fT -- "$projects_link_staging/projects" "$HOME/projects"
/usr/bin/rmdir -- "$projects_link_staging"

temporary_context="$(/usr/bin/mktemp "$HOME/.claude/.CLAUDE.md.XXXXXX")"
if ! /usr/bin/base64 --decode > "$temporary_context" <<'CLAUDECONTEXTEOF'
${base64encode(claude_md_content)}
CLAUDECONTEXTEOF
then
  /usr/bin/rm -f -- "$temporary_context"
  exit 1
fi
/usr/bin/chmod 600 "$temporary_context"
/usr/bin/mv -fT -- "$temporary_context" "$HOME/.claude/CLAUDE.md"

temporary_mcp="$(/usr/bin/mktemp "$HOME/.claude.json.XXXXXX")"
/usr/bin/printf '%s\n' \
  '{"mcpServers":{"playwright":{"type":"stdio","command":"/home/coder/.local/bin/playwright-mcp","args":["--browser","chrome","--headless","--no-sandbox","--isolated"],"env":{}}}}' \
  > "$temporary_mcp"
/usr/bin/chmod 600 "$temporary_mcp"
/usr/bin/mv -fT -- "$temporary_mcp" "$claude_user_config"

temporary_readme="$(/usr/bin/mktemp "$HOME/.README.XXXXXX")"
/usr/bin/printf '%s\n' \
  'Isolated Claude interview agent' \
  '' \
  'Run interview-claude from this terminal when the interviewer provides the temporary key.' \
  'Playwright MCP uses the image Chrome with browser state confined to this ephemeral home.' \
  'Only /workspace/projects is shared with the main development container.' \
  > "$temporary_readme"
/usr/bin/chmod 600 "$temporary_readme"
/usr/bin/mv -fT -- "$temporary_readme" "$HOME/README.md"

if [ -L "$status_directory" ] || [ ! -d "$status_directory" ]; then
  printf 'ERROR: isolated Claude status volume is unavailable\n' >&2
  exit 1
fi
temporary_status="$(/usr/bin/mktemp "$status_directory/.ready.XXXXXX")"
/usr/bin/printf 'isolated-claude-agent-ready-v2 %s\n' "$(/usr/bin/date +%s)" > "$temporary_status"
/usr/bin/chmod 0444 "$temporary_status"
/usr/bin/mv -fT -- "$temporary_status" "$status_directory/ready"

printf 'Isolated Claude launcher ready for %s\n' "$interview_repository"
