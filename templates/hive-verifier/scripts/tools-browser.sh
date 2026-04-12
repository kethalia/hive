#!/bin/bash
set -e

BOLD='\033[0;1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RESET='\033[0m'

# Ensure PATH includes tool directories
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.claude/local/bin:$PATH"
mkdir -p "$HOME/.local/bin"

# Force npm global installs into ~/.local (user-writable, already on PATH)
export npm_config_prefix="$HOME/.local"

printf "${BOLD}[browser] Setting up browser vision tools...${RESET}\n"

# Chrome is installed in the Docker image; Dockerfile symlinks it to
# /usr/bin/chromium-browser so Playwright finds it without extra config.
CHROME_BIN="/usr/bin/google-chrome-stable"

# Claude Code MCP (obsidian + playwright) is baked into the Docker image
# at ~/.claude/mcp.json — no runtime registration needed.

# Configure OpenCode MCP server for Playwright
OPENCODE_CONFIG="$HOME/.config/opencode/config.json"
if [ -f "$OPENCODE_CONFIG" ] && command -v jq &>/dev/null; then
  MERGED=$(jq '.mcp.playwright = {
    "type": "local",
    "command": ["npx", "-y", "@playwright/mcp", "--no-sandbox"],
    "enabled": true,
    "environment": {"DISPLAY": ":99"}
  }' "$OPENCODE_CONFIG" 2>/dev/null) && echo "$MERGED" > "$OPENCODE_CONFIG" || {
    printf "${YELLOW}[warn] Could not merge MCP into OpenCode config${RESET}\n"
  }
else
  mkdir -p "$HOME/.config/opencode"
  cat > "$OPENCODE_CONFIG" << 'OPMCP'
{
  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp", "--no-sandbox"],
      "enabled": true,
      "environment": {
        "DISPLAY": ":99"
      }
    }
  }
}
OPMCP
fi
printf "${GREEN}[ok] OpenCode MCP configured for Playwright${RESET}\n"

# Create screenshot helper using Google Chrome (for Pi/GSD agents without MCP)
cat > "$HOME/.local/bin/browser-screenshot" << SCREENSHOT
#!/bin/bash
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
chmod +x "$HOME/.local/bin/browser-screenshot"

cat > "$HOME/.local/bin/browser-html" << BROWSERHTML
#!/bin/bash
set -e
URL="\${1:?Usage: browser-html <url>}"
$CHROME_BIN \\
  --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \\
  --dump-dom "\$URL" 2>/dev/null
BROWSERHTML
chmod +x "$HOME/.local/bin/browser-html"
echo "Helper scripts using: $CHROME_BIN"

printf "${GREEN}[ok] Browser vision tools ready${RESET}\n"
printf "  Claude Code: Playwright MCP via ~/.claude/mcp.json (baked into image)\n"
printf "  OpenCode: Playwright MCP via config.json\n"
printf "  Pi & GSD: browser-screenshot <url> and browser-html <url>\n"
