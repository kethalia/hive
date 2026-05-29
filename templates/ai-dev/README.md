# AI-Assisted Full-Stack Development - Coder Template

A production-ready Coder template for AI-assisted full-stack development. Features Claude Code and Codex with OpenGSD core slash commands, the OpenGSD Pi CLI, comprehensive tooling, Docker, Node.js, Foundry, and everything you need for modern development.

## Features

### AI-Assisted Development
- **Claude Code** - Anthropic's coding agent with CLI and web interface
- **Codex CLI** - OpenAI's local coding agent with Playwright MCP and vault skills wired
- **OpenGSD core + Pi** - Maintained GSD slash commands for Claude Code and Codex plus the standalone `gsd` CLI from OpenGSD
- **Browser Vision** - Claude Code and Codex can see what they're developing in a headed browser
- All AI tools are configurable via template variables

### Development Environment
- **Docker** - Full Docker + Compose + act (run GitHub Actions locally)
- **Node.js** - Multiple versions (18, 20, 22, 24) via version switcher
- **Package Managers** - PNPM, Yarn, and Bun
- **Foundry** - Complete Ethereum development toolkit
- **Git** - Latest version with productivity aliases
- **GitHub CLI** - Pre-authenticated via Coder external auth
- **ZSH** - Oh My Zsh with Starship prompt, autosuggestions, and syntax highlighting
- **tmux** - Session persistence for long-running agent sessions
- **direnv** - Per-project environment management

### VS Code Integration
- 20 curated extensions including Solidity, Tailwind CSS, GraphQL, Prisma, GitLens, Docker, Error Lens, and more
- Pre-configured settings for formatting, themes, and terminal

### Performance & Reliability
- **Resource limits** - 12GB RAM, 6 CPU cores, 32GB total memory (with swap)
- **Health checks** - Automatic container health monitoring
- **Monitoring** - Built-in CPU, RAM, disk, and swap metrics
- **Persistent volume** - Home directory survives workspace restarts

## Quick Start

### Prerequisites
- Coder v2.x deployed and running
- Docker available on Coder host
- GitHub external auth configured (id: `primary-github`)

### Installation

```bash
git clone <this-repo>
cd ai-dev
coder templates push ai-dev
```

### Updating Existing Workspaces to OpenGSD

The previous template installed the abandoned pre-OpenGSD packages. Push this
updated template, rebuild each workspace, then verify the maintained packages are
first on PATH.

```bash
# Push the updated template version from this repository
coder templates push ai-dev --directory templates/ai-dev --yes

# Rebuild an existing workspace onto the active template version
coder update <workspace-name>

# Inside the rebuilt workspace, verify OpenGSD and Codex are active
gsd --version
codex --version
npm list -g --depth=0 | grep -E '@opengsd|@openai/codex'
grep -q 'mcp_servers.hive_playwright' ~/.codex/config.toml
test -d ~/.agents/skills
```

If you cannot rebuild a workspace immediately, run the repair commands inside
that workspace:

```bash
export PATH="$HOME/.local/bin:$PATH"
export npm_config_prefix="$HOME/.local"

# Repair persistent Node shims first. This fixes old workspaces that show
# `env: ‘node’: Too many levels of symbolic links` during npm installs.
mkdir -p "$HOME/.local/bin"
rm -f "$HOME/.local/bin/node" "$HOME/.local/bin/npm" "$HOME/.local/bin/npx" "$HOME/.local/bin/corepack"
for bin in node npm npx corepack; do
  for candidate in /usr/bin/$bin /usr/local/bin/$bin /opt/node*/bin/$bin; do
    if [ -x "$candidate" ]; then
      ln -sf "$candidate" "$HOME/.local/bin/$bin"
      break
    fi
  done
done
hash -r 2>/dev/null || true
node --version
npm --version

npm uninstall -g get-shit-done-cc get-shit-done-redux gsd-pi @gsd-build/sdk @gsd-redux/sdk @gsd-redux/get-shit-done-redux || true
npm install -g @openai/codex@latest @opengsd/get-shit-done-redux@latest @opengsd/gsd-pi@latest
get-shit-done-redux --claude --global
get-shit-done-redux --codex --global
codex mcp add hive_obsidian -- npx -y @bitbonsai/mcpvault@1.0.4 /home/coder/vault || true
codex mcp add hive_playwright --env DISPLAY=:1 -- npx -y @playwright/mcp --no-sandbox || true
if [ -f "$HOME/vault/Agents/AGENTS.md" ]; then mkdir -p "$HOME/.codex" && cp "$HOME/vault/Agents/AGENTS.md" "$HOME/.codex/AGENTS.md"; fi
bash "$HOME/sync-vault.sh" || true
gsd --version
codex --version
```

For projects that still have legacy `.planning` artifacts, open `gsd` in the
project and run `/gsd migrate`, then `/gsd doctor`.

For the operator runbook covering both Hive and ai-dev templates, see
`docs/opengsd-coder-workspaces.md`.

### Create a Workspace

```bash
coder create --template ai-dev my-workspace
coder ssh my-workspace
```

### Verify

```bash
claude --version          # Claude Code
codex --version           # Codex CLI
gsd --version             # OpenGSD Pi CLI
docker ps                 # Docker access
node --version            # Node.js
bun --version             # Bun
yarn --version            # Yarn
forge --version           # Foundry
gh auth status            # GitHub CLI
starship --version        # Starship prompt
chromium-browser --version # Headless browser
browser-screenshot --help  # Screenshot tool
```

## Configuration

### Template Variables

All AI tools can be configured when creating or updating a workspace:

| Variable | Default | Description |
|----------|---------|-------------|
| `docker_socket` | `""` | Custom Docker socket URI |
| `dotfiles_uri` | `""` | Git URI for dotfiles repository |
| `claude_code_model` | `"claude-sonnet-4-6"` | Default model for Claude Code |
| `claude_code_system_prompt` | `""` | Custom system prompt |

### Resource Limits

Default container limits (edit `main.tf` to change):

```hcl
memory      = 12288   # 12GB RAM (in MiB)
memory_swap = 32768   # 32GB total (RAM + swap, in MiB)
cpu_shares  = 6144    # 6 CPU cores (relative weight)
```

## Architecture

```
+---------------------------------------------+
|   Coder Workspace Container                  |
|                                              |
|  +----------------------------------------+  |
|  |  AI Agents                             |  |
|  |  - Claude Code (CLI + web)             |  |
|  |  - Codex CLI                           |  |
|  |  - OpenGSD (slash commands + CLI)      |  |
|  |  - Playwright MCP (browser vision)     |  |
|  +----------------------------------------+  |
|                                              |
|  +----------------------------------------+  |
|  |  User Environment                      |  |
|  |  - ZSH + Oh My Zsh + Starship         |  |
|  |  - Node.js + PNPM/Yarn/Bun            |  |
|  |  - Foundry + Solidity                  |  |
|  |  - tmux + direnv                       |  |
|  +----------------------------------------+  |
|                                              |
|  +----------------------------------------+  |
|  |  Services                              |  |
|  |  - VS Code Server                      |  |
|  |  - File Browser                        |  |
|  +----------------------------------------+  |
|                                              |
|  +------------------+                        |
|  |  Docker Socket   |                        |
|  +------------------+                        |
+---------------------------------------------+
           |
           v
    +--------------+
    |  Host Docker |
    |  Daemon      |
    +--------------+
```

## Accessible Apps

| App | Access | Description |
|-----|--------|-------------|
| VS Code | Subdomain | Full IDE with extensions |
| Claude Code | Web app via module | Claude Code web interface |
| Browser | Subdomain (`:6080`) | Watch AI agents interact with the browser |
| File Browser | Subdomain | Web-based file management |

## Browser Vision

Claude Code and Codex can visually inspect what they're developing via a headed Chromium browser on the KasmVNC display.

### How It Works

A virtual display (Xvfb) runs a headed Chromium browser that Claude Code controls via Playwright MCP. A noVNC web UI lets you watch the browser in real-time from the Coder dashboard.

| Agent | Method | Capabilities |
|-------|--------|--------------|
| Claude Code | Playwright MCP server (headed) | Navigate, screenshot, click, type, inspect elements |
| Codex | Playwright MCP via `hive_playwright` in `~/.codex/config.toml` | Navigate, screenshot, click, type, inspect elements |
| OpenGSD core | Claude Code and Codex slash commands | Same as host agent |

### Web App (KasmVNC)

Open the **Browser** app in the Coder dashboard to watch AI agents interact with pages in real-time. The browser runs on the KasmVNC virtual display (`:1`) and is streamed via KasmVNC on port `6080`.

### Usage Examples

**Claude Code** (automatic via MCP — just ask the agent):
```
> Take a screenshot of http://localhost:3000 and tell me what you see
> Navigate to my app and check if the login form renders correctly
> Click the submit button and screenshot the result
```

**CLI helpers** (for scripts and automation):
```bash
browser-screenshot http://localhost:3000              # Screenshot → /tmp/screenshot-*.png
browser-screenshot http://localhost:3000 ./output.png # Screenshot → custom path
browser-html http://localhost:3000                    # Dump rendered DOM as text
```

### Configuration

The Playwright MCP server is auto-configured for Claude Code (`~/.claude/mcp.json`) and Codex (`~/.codex/config.toml`) during workspace startup. It runs in **headed mode** on display `:1`, so all browser interactions are visible via the KasmVNC web app.

Architecture: `KasmVNC :1` (virtual display + VNC + web viewer on `:6080`) → `openbox` (window manager)

Environment variables:
- `BROWSER_VIEWPORT` - Screenshot/display viewport size (default: `1280x720`)

## Troubleshooting

### AI tool not found after startup
Tools are installed during the development tools script. Check the script logs in Coder UI under the workspace's build logs. If npm-based tools fail, ensure Node.js is available:
```bash
source ~/.zshrc
node --version
```

### Docker not accessible
```bash
ls -l /var/run/docker.sock
groups | grep docker
docker info
```

### OpenGSD commands not available
```bash
# Reinstall the maintained OpenGSD packages and refresh Claude Code commands
export PATH="$HOME/.local/bin:$PATH"
export npm_config_prefix="$HOME/.local"

# Repair persistent Node shims first. This fixes old workspaces that show
# `env: ‘node’: Too many levels of symbolic links` during npm installs.
mkdir -p "$HOME/.local/bin"
rm -f "$HOME/.local/bin/node" "$HOME/.local/bin/npm" "$HOME/.local/bin/npx" "$HOME/.local/bin/corepack"
for bin in node npm npx corepack; do
  for candidate in /usr/bin/$bin /usr/local/bin/$bin /opt/node*/bin/$bin; do
    if [ -x "$candidate" ]; then
      ln -sf "$candidate" "$HOME/.local/bin/$bin"
      break
    fi
  done
done
hash -r 2>/dev/null || true
node --version
npm --version

npm uninstall -g get-shit-done-cc get-shit-done-redux gsd-pi @gsd-build/sdk @gsd-redux/sdk @gsd-redux/get-shit-done-redux || true
npm install -g @openai/codex@latest @opengsd/get-shit-done-redux@latest @opengsd/gsd-pi@latest
get-shit-done-redux --claude --global
get-shit-done-redux --codex --global
codex mcp add hive_obsidian -- npx -y @bitbonsai/mcpvault@1.0.4 /home/coder/vault || true
codex mcp add hive_playwright --env DISPLAY=:1 -- npx -y @playwright/mcp --no-sandbox || true
if [ -f "$HOME/vault/Agents/AGENTS.md" ]; then mkdir -p "$HOME/.codex" && cp "$HOME/vault/Agents/AGENTS.md" "$HOME/.codex/AGENTS.md"; fi
bash "$HOME/sync-vault.sh" || true
gsd --version
codex --version
```

## Security

- Docker socket is mounted — users have full Docker access on the host daemon
- Use in trusted development environments
- Review template access controls in Coder admin

## External Resources

- [Coder Documentation](https://coder.com/docs)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Codex](https://developers.openai.com/codex)
- [OpenGSD](https://www.opengsd.net/)
- [Starship Prompt](https://starship.rs)
- [Foundry Book](https://book.getfoundry.sh)
