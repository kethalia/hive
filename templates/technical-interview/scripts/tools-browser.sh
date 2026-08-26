#!/bin/bash
set -e
umask 077

unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
unset GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN
unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN

# Coder startup scripts inherit the image PATH, which may contain persistent,
# candidate-writable directories. Do not resolve setup commands through them.
INTERVIEW_TRUSTED_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH="$INTERVIEW_TRUSTED_PATH"

BOLD='\033[0;1m'
GREEN='\033[0;32m'
RESET='\033[0m'

ensure_interview_local_directory() {
  local target=$1 current remainder component

  if [ -L "$HOME" ] || [ ! -d "$HOME" ]; then
    printf '[error] interview home is not a local directory: %s\n' "$HOME" >&2
    return 1
  fi
  case "$target" in
    "$HOME") return 0 ;;
    "$HOME"/*) ;;
    *)
      printf '[error] refusing to prepare a directory outside the interview home: %s\n' \
        "$target" >&2
      return 1
      ;;
  esac

  current="$HOME"
  remainder="${target#"$HOME"/}"
  while [ -n "$remainder" ]; do
    component="${remainder%%/*}"
    if [ "$component" = "$remainder" ]; then
      remainder=""
    else
      remainder="${remainder#*/}"
    fi
    current="$current/$component"
    if [ -L "$current" ] || { [ -e "$current" ] && [ ! -d "$current" ]; }; then
      printf '[error] unsafe interview directory was preserved: %s\n' "$current" >&2
      return 1
    fi
    [ -d "$current" ] || mkdir -- "$current" || return 1
  done
}

ensure_interview_local_directory "$HOME/.local/bin"

printf '%b[browser] Setting up browser vision tools...%b\n' "$BOLD" "$RESET"

install_browser_helper() {
  local destination=$1 temporary_file

  temporary_file="$(mktemp "$HOME/.local/bin/.hive-browser-helper.XXXXXX")"
  if ! cat > "$temporary_file"; then
    rm -f -- "$temporary_file"
    return 1
  fi
  if ! chmod 755 "$temporary_file" \
    || ! mv -fT -- "$temporary_file" "$destination"; then
    rm -f -- "$temporary_file"
    return 1
  fi
}

# Chrome is installed in the image. The symlink setup exposes a user-writable
# chromium-browser compatibility command without modifying the root filesystem.
CHROME_BIN="/usr/bin/google-chrome-stable"
if [ ! -x "$CHROME_BIN" ]; then
  printf '[error] Browser image is missing %s\n' "$CHROME_BIN" >&2
  exit 1
fi
ln -sfnT "$CHROME_BIN" "$HOME/.local/bin/chromium-browser"

# Claude Code and Codex Playwright MCP entries are managed by init.sh and point
# at the pinned user-space package prepared by the interview bootstrap.

# Create screenshot helper using Google Chrome (CLI fallback for scripts).
# Same-directory temporary files ensure a candidate-created symlink is replaced
# instead of following it into the preserved assessment checkout.
install_browser_helper "$HOME/.local/bin/browser-screenshot" << SCREENSHOT
#!/bin/bash
# hive-managed-browser-helper:v1
set -e
URL="\${1:?Usage: browser-screenshot <url> [output-path]}"
OUTPUT="\${2:-/tmp/screenshot-\$(date +%s).png}"
VIEWPORT="\${BROWSER_VIEWPORT:-1280x720}"
WIDTH=\$(echo "\$VIEWPORT" | cut -dx -f1)
HEIGHT=\$(echo "\$VIEWPORT" | cut -dx -f2)
$CHROME_BIN \\
  --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \\
  --window-size="\$WIDTH,\$HEIGHT" --screenshot="\$OUTPUT" --hide-scrollbars \\
  "\$URL" 2>/dev/null
[ -f "\$OUTPUT" ] && echo "\$OUTPUT" || { echo "ERROR: Screenshot failed" >&2; exit 1; }
SCREENSHOT

install_browser_helper "$HOME/.local/bin/browser-html" << BROWSERHTML
#!/bin/bash
# hive-managed-browser-helper:v1
set -e
URL="\${1:?Usage: browser-html <url>}"
$CHROME_BIN \\
  --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \\
  --dump-dom "\$URL" 2>/dev/null
BROWSERHTML
echo "Helper scripts using: $CHROME_BIN"

printf '%b[ok] Browser vision tools ready%b\n' "$GREEN" "$RESET"
printf "  Claude Code: Playwright MCP via ~/.claude/mcp.json (managed at startup)\n"
printf "  Codex: Playwright MCP via ~/.codex/config.toml (managed at startup)\n"
printf "  CLI helpers: browser-screenshot <url> and browser-html <url>\n"
