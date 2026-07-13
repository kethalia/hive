#!/bin/bash
set -e

BOLD='\033[0;1m'
GREEN='\033[0;32m'
RESET='\033[0m'

# Ensure PATH includes tool directories
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.claude/local/bin:$PATH"
mkdir -p "$HOME/.local/bin"

# Force npm global installs into ~/.local (user-writable, already on PATH)
export npm_config_prefix="$HOME/.local"

printf '%b[browser] Setting up browser vision tools...%b\n' "$BOLD" "$RESET"

# Chrome is installed in the image. The symlink setup exposes a user-writable
# chromium-browser compatibility command without modifying the root filesystem.
CHROME_BIN="/usr/bin/google-chrome-stable"

# Claude Code MCP (obsidian + playwright) is baked into the Docker image
# at ~/.claude/mcp.json. Codex MCP is managed at startup in ~/.codex/config.toml.

# Create screenshot helper using Google Chrome (CLI fallback for scripts)
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

printf '%b[ok] Browser vision tools ready%b\n' "$GREEN" "$RESET"
printf "  Claude Code: Playwright MCP via ~/.claude/mcp.json (baked into image)\n"
printf "  Codex: Playwright MCP via ~/.codex/config.toml (managed at startup)\n"
printf "  CLI helpers: browser-screenshot <url> and browser-html <url>\n"
