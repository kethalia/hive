#!/bin/bash
set -e
umask 077

unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
unset OPENAI_API_KEY OPENAI_API_TOKEN CODEX_API_KEY
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
unset CLAUDE_CONFIG_DIR CLAUDE_SECURESTORAGE_CONFIG_DIR
unset NPM_TOKEN NODE_AUTH_TOKEN NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG
unset npm_config_userconfig npm_config_globalconfig
unset PIP_CONFIG_FILE PIP_INDEX_URL PIP_EXTRA_INDEX_URL PIP_TRUSTED_HOST
unset PIP_CERT PIP_CLIENT_CERT PIP_KEYRING_PROVIDER PIP_PROXY
unset GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN
unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE
unset AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE AWS_WEB_IDENTITY_TOKEN_FILE
unset GOOGLE_APPLICATION_CREDENTIALS CLOUDSDK_AUTH_ACCESS_TOKEN
unset AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TENANT_ID
unset ARM_CLIENT_ID ARM_CLIENT_SECRET ARM_TENANT_ID ARM_SUBSCRIPTION_ID
unset KUBECONFIG

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

if ! ensure_interview_local_directory "$HOME/.local/bin" \
  || ! ensure_interview_local_directory "$HOME/.local/share/applications" \
  || ! ensure_interview_local_directory "$HOME/.cache/hive-interview-browser"; then
  printf '[warn] Browser helper setup was deferred so workspace login remains available.\n' >&2
  exit 0
fi

printf '%b[browser] Setting up browser vision tools...%b\n' "$BOLD" "$RESET"

install_browser_file() {
  local destination=$1 mode=$2 destination_directory temporary_file

  destination_directory="${destination%/*}"
  temporary_file="$(mktemp "$destination_directory/.hive-browser-file.XXXXXX")"
  if ! cat > "$temporary_file"; then
    rm -f -- "$temporary_file"
    return 1
  fi
  if ! chmod "$mode" "$temporary_file" \
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

browser_helpers_safe=true
for browser_helper in \
  "$HOME/.local/bin/chromium-browser" \
  "$HOME/.local/bin/interview-chrome" \
  "$HOME/.local/bin/browser-screenshot" \
  "$HOME/.local/bin/browser-html" \
  "$HOME/.local/share/applications/google-chrome.desktop"; do
  if { [ -e "$browser_helper" ] || [ -L "$browser_helper" ]; } \
    && [ ! -L "$browser_helper" ] \
    && [ ! -f "$browser_helper" ]; then
    printf '[warn] Non-regular browser helper path was preserved: %s\n' \
      "$browser_helper" >&2
    browser_helpers_safe=false
  fi
done
if [ "$browser_helpers_safe" != true ]; then
  printf '[warn] Browser helper setup was deferred; interview-check will report the affected paths.\n' \
    >&2
  exit 0
fi

install_browser_file "$HOME/.local/bin/interview-chrome" 755 << CHROMEWRAPPER
#!/bin/bash
# hive-managed-interview-chrome:v1
set -euo pipefail
profile_root="\$HOME/.cache/hive-interview-browser/chrome"
if [ -L "\$profile_root" ] || { [ -e "\$profile_root" ] && [ ! -d "\$profile_root" ]; }; then
  printf '[error] unsafe ephemeral Chrome profile path: %s\\n' "\$profile_root" >&2
  exit 1
fi
mkdir -p -- "\$profile_root"
exec "$CHROME_BIN" \\
  --user-data-dir="\$profile_root" \\
  --no-first-run --no-default-browser-check "\$@"
CHROMEWRAPPER

install_browser_file "$HOME/.local/bin/chromium-browser" 755 <<'CHROMIUMWRAPPER'
#!/bin/bash
# hive-managed-interview-chrome:v1
set -euo pipefail
exec "$HOME/.local/bin/interview-chrome" "$@"
CHROMIUMWRAPPER

# Override the image desktop entry so normal headed launches use only the
# pod-ephemeral profile mounted inside the workspace home.
install_browser_file "$HOME/.local/share/applications/google-chrome.desktop" 644 <<'CHROMEDESKTOP'
[Desktop Entry]
Version=1.0
Name=Google Chrome (Interview)
GenericName=Web Browser
Exec=/home/coder/.local/bin/interview-chrome %U
Terminal=false
Icon=google-chrome
Type=Application
Categories=Network;WebBrowser;
MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;
CHROMEDESKTOP

# Claude Code and Codex Playwright MCP entries are managed by init.sh and point
# at the pinned user-space package prepared by the interview bootstrap.

# Create screenshot helper using Google Chrome (CLI fallback for scripts).
# Same-directory temporary files ensure a candidate-created symlink is replaced
# instead of following it into the preserved assessment checkout.
install_browser_file "$HOME/.local/bin/browser-screenshot" 755 << SCREENSHOT
#!/bin/bash
# hive-managed-browser-helper:v1
set -euo pipefail
URL="\${1:?Usage: browser-screenshot <url> [output-path]}"
OUTPUT="\${2:-/tmp/screenshot-\$(date +%s).png}"
VIEWPORT="\${BROWSER_VIEWPORT:-1280x720}"
WIDTH=\$(echo "\$VIEWPORT" | cut -dx -f1)
HEIGHT=\$(echo "\$VIEWPORT" | cut -dx -f2)
PROFILE=\$(mktemp -d "\$HOME/.cache/hive-interview-browser/screenshot.XXXXXX")
trap 'rm -rf -- "\$PROFILE"' EXIT
$CHROME_BIN \\
  --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \\
  --user-data-dir="\$PROFILE" \\
  --window-size="\$WIDTH,\$HEIGHT" --screenshot="\$OUTPUT" --hide-scrollbars \\
  "\$URL" 2>/dev/null
[ -f "\$OUTPUT" ] && echo "\$OUTPUT" || { echo "ERROR: Screenshot failed" >&2; exit 1; }
SCREENSHOT

install_browser_file "$HOME/.local/bin/browser-html" 755 << BROWSERHTML
#!/bin/bash
# hive-managed-browser-helper:v1
set -euo pipefail
URL="\${1:?Usage: browser-html <url>}"
PROFILE=\$(mktemp -d "\$HOME/.cache/hive-interview-browser/html.XXXXXX")
trap 'rm -rf -- "\$PROFILE"' EXIT
$CHROME_BIN \\
  --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \\
  --user-data-dir="\$PROFILE" \\
  --dump-dom "\$URL" 2>/dev/null
BROWSERHTML
echo "Helper scripts using: $CHROME_BIN"

printf '%b[ok] Browser vision tools ready%b\n' "$GREEN" "$RESET"
printf "  Claude Code: Playwright MCP via ~/.claude.json in the isolated agent\n"
printf "  Codex: Playwright MCP via ~/.codex/config.toml (managed at startup)\n"
printf "  CLI helpers: browser-screenshot <url> and browser-html <url>\n"
