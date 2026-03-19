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

# Simple MCP args — no --executable-path needed thanks to the symlink
MCP_ARGS='["-y", "@playwright/mcp", "--no-sandbox"]'

# Configure Claude Code MCP
printf "${BOLD}[browser] Waiting for Claude Code to be installed...${RESET}\n"
for i in $(seq 1 30); do
  command -v claude &>/dev/null && break
  sleep 2
done

CLAUDE_MCP_DONE=false

if command -v claude &>/dev/null; then
  # Always remove first to clear stale config from previous builds
  claude mcp remove playwright 2>/dev/null || true
  echo "Trying 'claude mcp add'..."
  if claude mcp add playwright -e DISPLAY=:99 -- npx -y @playwright/mcp --no-sandbox 2>&1; then
    CLAUDE_MCP_DONE=true
    printf "${GREEN}[ok] Claude Code MCP added via 'claude mcp add'${RESET}\n"
  else
    echo "claude mcp add failed, trying settings.json..."
  fi
fi

if [ "$CLAUDE_MCP_DONE" = "false" ]; then
  mkdir -p "$HOME/.claude"
  CLAUDE_SETTINGS="$HOME/.claude/settings.json"
  if [ -f "$CLAUDE_SETTINGS" ] && command -v jq &>/dev/null; then
    MERGED=$(jq '.mcpServers.playwright = {
      "command": "npx",
      "args": ["-y", "@playwright/mcp", "--no-sandbox"],
      "env": {"DISPLAY": ":99"}
    }' "$CLAUDE_SETTINGS" 2>/dev/null) && echo "$MERGED" > "$CLAUDE_SETTINGS" || {
      printf "${YELLOW}[warn] Could not merge MCP into Claude settings.json${RESET}\n"
    }
  else
    cat > "$CLAUDE_SETTINGS" << 'SETTINGS'
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp", "--no-sandbox"],
      "env": {
        "DISPLAY": ":99"
      }
    }
  }
}
SETTINGS
  fi
  echo "Wrote Claude settings.json"
fi

# Write .mcp.json as fallback (Claude Code reads this from cwd)
cat > "$HOME/.mcp.json" << 'MCPFILE'
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp", "--no-sandbox"],
      "env": {
        "DISPLAY": ":99"
      }
    }
  }
}
MCPFILE
echo "Wrote ~/.mcp.json fallback"
printf "${GREEN}[ok] Claude Code MCP configured for Playwright${RESET}\n"

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
printf "  Claude Code & OpenCode: Playwright MCP (navigate, screenshot, click, type)\n"
printf "  Pi & GSD: browser-screenshot <url> and browser-html <url>\n"
