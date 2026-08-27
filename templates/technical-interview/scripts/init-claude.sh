#!/bin/bash
set -euo pipefail
umask 077

# This container is the credential boundary for the temporary Anthropic key.
# Keep its startup independent from every candidate-writable command path.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
unset BASH_ENV ENV CDPATH LD_LIBRARY_PATH LD_PRELOAD
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
unset OPENAI_API_KEY OPENAI_API_TOKEN CODEX_API_KEY
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
unset CLAUDE_CONFIG_DIR CLAUDE_SECURESTORAGE_CONFIG_DIR
unset NPM_TOKEN NODE_AUTH_TOKEN NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG
unset npm_config_userconfig npm_config_globalconfig
unset PIP_CONFIG_FILE PIP_INDEX_URL PIP_EXTRA_INDEX_URL PIP_TRUSTED_HOST
unset PIP_CERT PIP_CLIENT_CERT PIP_KEYRING_PROVIDER PIP_PROXY
unset GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN
unset GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_PROXY_COMMAND GIT_SSH
unset SSH_AUTH_SOCK SSH_AGENT_PID SSH_ASKPASS_REQUIRE
unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE
unset AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE AWS_WEB_IDENTITY_TOKEN_FILE
unset GOOGLE_APPLICATION_CREDENTIALS CLOUDSDK_AUTH_ACCESS_TOKEN
unset AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TENANT_ID
unset ARM_CLIENT_ID ARM_CLIENT_SECRET ARM_TENANT_ID ARM_SUBSCRIPTION_ID
unset KUBECONFIG
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_ASKPASS=/bin/false
export GIT_SSH_COMMAND=/bin/false
export GIT_TERMINAL_PROMPT=0
export SSH_ASKPASS=/bin/false

interview_repository="/workspace/projects/prmsolutions/interview-template"
trusted_helper="/opt/hive-interview-tools/interview-claude"
trusted_claude="/opt/hive-interview-tools/claude"
trusted_guard="/opt/hive-interview-tools/claude-guard.so"
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

trusted_payload_ready() {
  [ -f "$trusted_helper" ] \
    && [ ! -L "$trusted_helper" ] \
    && [ -x "$trusted_helper" ] \
    && [ -f "$trusted_claude" ] \
    && [ ! -L "$trusted_claude" ] \
    && [ -x "$trusted_claude" ] \
    && [ -f "$trusted_guard" ] \
    && [ ! -L "$trusted_guard" ] \
    && [ -x "$trusted_guard" ] \
    && playwright_mcp_ready
}

if ! trusted_payload_ready; then
  printf 'Waiting for trusted Claude and Playwright MCP staging; main recovery remains available.\n' >&2
fi
until trusted_payload_ready; do
  /usr/bin/sleep 2
done

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
  'Protected Claude interview runtime' \
  '' \
  'This runtime has no Coder agent, SSH endpoint, or web terminal.' \
  'Use the Interview Claude app; its immutable client relays this runtime PTY.' \
  'Playwright MCP uses the image Chrome with browser state confined to this ephemeral home.' \
  'Only /workspace/projects is shared with the main development container.' \
  > "$temporary_readme"
/usr/bin/chmod 600 "$temporary_readme"
/usr/bin/mv -fT -- "$temporary_readme" "$HOME/README.md"

printf 'Protected shell-inaccessible Claude runtime prepared for %s\n' "$interview_repository"
