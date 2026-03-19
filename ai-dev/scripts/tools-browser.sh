#!/bin/bash
set -e

BOLD='\033[0;1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RESET='\033[0m'

# Ensure PATH includes tool directories
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
mkdir -p "$HOME/.local/bin"

# Force npm global installs into ~/.local (user-writable, already on PATH)
export npm_config_prefix="$HOME/.local"

printf "$${BOLD}[browser] Setting up browser vision tools...$${RESET}\n"

# Install Playwright MCP server globally
if ! npm list -g @anthropic-ai/mcp-server-playwright &> /dev/null 2>&1; then
  printf "$${BOLD}[install] Playwright MCP server...$${RESET}\n"
  npm install -g @anthropic-ai/mcp-server-playwright 2>/dev/null || true
fi

# Install Playwright browsers (use system Chromium to save space)
export PLAYWRIGHT_BROWSERS_PATH=0
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Playwright MCP config — runs headed on the virtual display so users can
# watch via noVNC, with headless fallback if DISPLAY isn't available
PLAYWRIGHT_MCP_ENV='{
  "DISPLAY": ":99",
  "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH": "/usr/bin/chromium-browser"
}'

# Configure Claude Code MCP server for Playwright
mkdir -p "$HOME/.claude"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CLAUDE_MCP_BLOCK=$(cat << 'JQEOF'
.mcpServers.playwright = {
  "command": "npx",
  "args": ["-y", "@anthropic-ai/mcp-server-playwright"],
  "env": {
    "DISPLAY": ":99",
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH": "/usr/bin/chromium-browser"
  }
}
JQEOF
)

if [ -f "$CLAUDE_SETTINGS" ]; then
  EXISTING=$(cat "$CLAUDE_SETTINGS")
  echo "$EXISTING" | jq "$CLAUDE_MCP_BLOCK" > "$CLAUDE_SETTINGS" 2>/dev/null || {
    cat > "$CLAUDE_SETTINGS" << 'CLAUDEMCP'
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-server-playwright"],
      "env": {
        "DISPLAY": ":99",
        "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH": "/usr/bin/chromium-browser"
      }
    }
  }
}
CLAUDEMCP
  }
else
  cat > "$CLAUDE_SETTINGS" << 'CLAUDEMCP'
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-server-playwright"],
      "env": {
        "DISPLAY": ":99",
        "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH": "/usr/bin/chromium-browser"
      }
    }
  }
}
CLAUDEMCP
fi
printf "$${GREEN}[ok] Claude Code MCP configured for Playwright (headed on :99)$${RESET}\n"

# Configure OpenCode MCP server for Playwright
OPENCODE_CONFIG="$HOME/.config/opencode/config.json"
OPENCODE_MCP_BLOCK=$(cat << 'JQEOF'
.mcp.playwright = {
  "type": "local",
  "command": ["npx", "-y", "@anthropic-ai/mcp-server-playwright"],
  "enabled": true,
  "environment": {
    "DISPLAY": ":99",
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH": "/usr/bin/chromium-browser"
  }
}
JQEOF
)

if [ -f "$OPENCODE_CONFIG" ]; then
  EXISTING=$(cat "$OPENCODE_CONFIG")
  echo "$EXISTING" | jq "$OPENCODE_MCP_BLOCK" > "$OPENCODE_CONFIG" 2>/dev/null || {
    printf "$${YELLOW}[warn] Could not merge MCP into OpenCode config, skipping$${RESET}\n"
  }
else
  mkdir -p "$HOME/.config/opencode"
  cat > "$OPENCODE_CONFIG" << 'OPMCP'
{
  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@anthropic-ai/mcp-server-playwright"],
      "enabled": true,
      "environment": {
        "DISPLAY": ":99",
        "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH": "/usr/bin/chromium-browser"
      }
    }
  }
}
OPMCP
fi
printf "$${GREEN}[ok] OpenCode MCP configured for Playwright (headed on :99)$${RESET}\n"

# Create screenshot helper script for Pi and GSD agents
# Pi doesn't support MCP natively, so we provide a bash tool it can call
cat > "$HOME/.local/bin/browser-screenshot" << 'SCREENSHOT'
#!/bin/bash
# browser-screenshot - Capture a screenshot of a URL or local dev server
# Usage: browser-screenshot <url> [output-path]
# Examples:
#   browser-screenshot http://localhost:3000
#   browser-screenshot http://localhost:3000 ./screenshot.png
#   browser-screenshot https://example.com /tmp/example.png

set -e

URL="${1:?Usage: browser-screenshot <url> [output-path]}"
OUTPUT="${2:-/tmp/screenshot-$(date +%s).png}"
VIEWPORT="${BROWSER_VIEWPORT:-1280x720}"

WIDTH=$(echo "$VIEWPORT" | cut -dx -f1)
HEIGHT=$(echo "$VIEWPORT" | cut -dx -f2)

chromium-browser \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --window-size="$WIDTH,$HEIGHT" \
  --screenshot="$OUTPUT" \
  --hide-scrollbars \
  "$URL" 2>/dev/null

if [ -f "$OUTPUT" ]; then
  echo "$OUTPUT"
else
  echo "ERROR: Screenshot failed" >&2
  exit 1
fi
SCREENSHOT
chmod +x "$HOME/.local/bin/browser-screenshot"

# Create browser-html helper to dump rendered HTML
cat > "$HOME/.local/bin/browser-html" << 'BROWSERHTML'
#!/bin/bash
# browser-html - Dump rendered DOM/text content of a URL
# Usage: browser-html <url>
# Examples:
#   browser-html http://localhost:3000
#   browser-html https://example.com

set -e

URL="${1:?Usage: browser-html <url>}"

chromium-browser \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --dump-dom \
  "$URL" 2>/dev/null
BROWSERHTML
chmod +x "$HOME/.local/bin/browser-html"

printf "$${GREEN}[ok] Browser vision tools ready$${RESET}\n"
printf "  Claude Code & OpenCode: Playwright MCP (navigate, screenshot, click, type)\n"
printf "  Pi & GSD: browser-screenshot <url> and browser-html <url>\n"
