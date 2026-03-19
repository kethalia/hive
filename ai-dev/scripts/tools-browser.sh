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

# Detect chromium binary path (varies by distro/install method)
CHROMIUM_BIN=""
for bin in /usr/bin/chromium-browser /usr/bin/chromium /snap/bin/chromium; do
  if [ -x "$bin" ]; then
    CHROMIUM_BIN="$bin"
    break
  fi
done
if [ -z "$CHROMIUM_BIN" ]; then
  printf "${YELLOW}[warn] Chromium not found, Playwright MCP will use its own browser${RESET}\n"
  CHROMIUM_BIN=""
fi
echo "Chromium binary: ${CHROMIUM_BIN:-not found}"

# Playwright MCP CLI args
# --browser chromium: explicit browser type
# --executable-path: use system chromium instead of downloading
# --no-sandbox: required in Docker (no suid sandbox)
if [ -n "$CHROMIUM_BIN" ]; then
  PLAYWRIGHT_ARGS="--browser chromium --executable-path $CHROMIUM_BIN --no-sandbox"
else
  PLAYWRIGHT_ARGS="--no-sandbox"
fi

# The MCP config JSON for Claude Code settings.json
CLAUDE_MCP_JSON=$(cat << MCPJSON
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp", "--browser", "chromium"${CHROMIUM_BIN:+, "--executable-path", "$CHROMIUM_BIN"}, "--no-sandbox"],
      "env": {
        "DISPLAY": ":99",
        "PLAYWRIGHT_BROWSERS_PATH": "0",
        "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1"
      }
    }
  }
}
MCPJSON
)

# Configure Claude Code MCP
printf "${BOLD}[browser] Configuring Claude Code MCP...${RESET}\n"

# Wait for claude binary (installed concurrently by claude-install.sh)
for i in $(seq 1 30); do
  command -v claude &>/dev/null && break
  sleep 2
done

CLAUDE_MCP_DONE=false

if command -v claude &>/dev/null; then
  # Try 'claude mcp add' first (proper way)
  echo "Trying 'claude mcp add'..."
  if claude mcp add playwright -- npx -y @playwright/mcp $PLAYWRIGHT_ARGS 2>&1; then
    CLAUDE_MCP_DONE=true
    printf "${GREEN}[ok] Claude Code MCP added via 'claude mcp add'${RESET}\n"
  else
    echo "claude mcp add failed, trying settings.json..."
  fi
fi

if [ "$CLAUDE_MCP_DONE" = "false" ]; then
  # Write to settings.json directly
  mkdir -p "$HOME/.claude"
  CLAUDE_SETTINGS="$HOME/.claude/settings.json"

  if [ -f "$CLAUDE_SETTINGS" ]; then
    # Merge into existing settings
    MERGED=$(jq '.mcpServers.playwright = {
      "command": "npx",
      "args": ["-y", "@playwright/mcp", "--browser", "chromium"'"${CHROMIUM_BIN:+, \"--executable-path\", \"$CHROMIUM_BIN\"}"', "--no-sandbox"],
      "env": {"DISPLAY": ":99", "PLAYWRIGHT_BROWSERS_PATH": "0", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1"}
    }' "$CLAUDE_SETTINGS" 2>/dev/null) && echo "$MERGED" > "$CLAUDE_SETTINGS" || {
      echo "$CLAUDE_MCP_JSON" > "$CLAUDE_SETTINGS"
    }
  else
    echo "$CLAUDE_MCP_JSON" > "$CLAUDE_SETTINGS"
  fi
  echo "Wrote Claude settings.json"
fi

# Also write .mcp.json in home dir as fallback (Claude Code reads this from cwd)
cat > "$HOME/.mcp.json" << MCPFILE
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp", "--browser", "chromium"${CHROMIUM_BIN:+, "--executable-path", "$CHROMIUM_BIN"}, "--no-sandbox"],
      "env": {
        "DISPLAY": ":99",
        "PLAYWRIGHT_BROWSERS_PATH": "0",
        "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1"
      }
    }
  }
}
MCPFILE
echo "Wrote ~/.mcp.json fallback"

printf "${GREEN}[ok] Claude Code MCP configured for Playwright${RESET}\n"

# Configure OpenCode MCP server for Playwright
OPENCODE_CONFIG="$HOME/.config/opencode/config.json"
OPENCODE_MCP_BLOCK=".mcp.playwright = {
  \"type\": \"local\",
  \"command\": [\"npx\", \"-y\", \"@playwright/mcp\", \"--browser\", \"chromium\"${CHROMIUM_BIN:+, \"--executable-path\", \"$CHROMIUM_BIN\"}, \"--no-sandbox\"],
  \"enabled\": true,
  \"environment\": {
    \"DISPLAY\": \":99\",
    \"PLAYWRIGHT_BROWSERS_PATH\": \"0\",
    \"PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD\": \"1\"
  }
}"

if [ -f "$OPENCODE_CONFIG" ]; then
  MERGED=$(jq "$OPENCODE_MCP_BLOCK" "$OPENCODE_CONFIG" 2>/dev/null) && echo "$MERGED" > "$OPENCODE_CONFIG" || {
    printf "${YELLOW}[warn] Could not merge MCP into OpenCode config${RESET}\n"
  }
else
  mkdir -p "$HOME/.config/opencode"
  cat > "$OPENCODE_CONFIG" << OPMCP
{
  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp", "--browser", "chromium"${CHROMIUM_BIN:+, "--executable-path", "$CHROMIUM_BIN"}, "--no-sandbox"],
      "enabled": true,
      "environment": {
        "DISPLAY": ":99",
        "PLAYWRIGHT_BROWSERS_PATH": "0",
        "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1"
      }
    }
  }
}
OPMCP
fi
printf "${GREEN}[ok] OpenCode MCP configured for Playwright${RESET}\n"

# Create screenshot helper script for Pi and GSD agents
cat > "$HOME/.local/bin/browser-screenshot" << 'SCREENSHOT'
#!/bin/bash
set -e
URL="${1:?Usage: browser-screenshot <url> [output-path]}"
OUTPUT="${2:-/tmp/screenshot-$(date +%s).png}"
VIEWPORT="${BROWSER_VIEWPORT:-1280x720}"
WIDTH=$(echo "$VIEWPORT" | cut -dx -f1)
HEIGHT=$(echo "$VIEWPORT" | cut -dx -f2)
CHROMIUM=""
for bin in /usr/bin/chromium-browser /usr/bin/chromium; do
  [ -x "$bin" ] && CHROMIUM="$bin" && break
done
${CHROMIUM:-chromium-browser} \
  --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --window-size="$WIDTH,$HEIGHT" --screenshot="$OUTPUT" --hide-scrollbars \
  "$URL" 2>/dev/null
[ -f "$OUTPUT" ] && echo "$OUTPUT" || { echo "ERROR: Screenshot failed" >&2; exit 1; }
SCREENSHOT
chmod +x "$HOME/.local/bin/browser-screenshot"

# Create browser-html helper to dump rendered HTML
cat > "$HOME/.local/bin/browser-html" << 'BROWSERHTML'
#!/bin/bash
set -e
URL="${1:?Usage: browser-html <url>}"
CHROMIUM=""
for bin in /usr/bin/chromium-browser /usr/bin/chromium; do
  [ -x "$bin" ] && CHROMIUM="$bin" && break
done
${CHROMIUM:-chromium-browser} \
  --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --dump-dom "$URL" 2>/dev/null
BROWSERHTML
chmod +x "$HOME/.local/bin/browser-html"

printf "${GREEN}[ok] Browser vision tools ready${RESET}\n"
printf "  Claude Code & OpenCode: Playwright MCP (navigate, screenshot, click, type)\n"
printf "  Pi & GSD: browser-screenshot <url> and browser-html <url>\n"
