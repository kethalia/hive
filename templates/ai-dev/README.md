# AI-Assisted Full-Stack Development - Coder Template

A production-ready Coder template for AI-assisted full-stack development. Features Claude Code with GSD, comprehensive tooling, Docker, Node.js, Foundry, and everything you need for modern development.

## Features

### AI-Assisted Development
- **Claude Code** - Anthropic's coding agent with CLI and web interface
- **GSD (get-shit-done)** - Meta-prompting system for Claude Code
- **Browser Vision** - Claude Code can see what it's developing in a headless browser
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

### Create a Workspace

```bash
coder create --template ai-dev my-workspace
coder ssh my-workspace
```

### Verify

```bash
claude --version          # Claude Code
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
|  |  - GSD (slash commands)                |  |
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

Claude Code can visually inspect what it's developing via a headless Chromium browser.

### How It Works

A virtual display (Xvfb) runs a headed Chromium browser that Claude Code controls via Playwright MCP. A noVNC web UI lets you watch the browser in real-time from the Coder dashboard.

| Agent | Method | Capabilities |
|-------|--------|--------------|
| Claude Code | Playwright MCP server (headed) | Navigate, screenshot, click, type, inspect elements |
| GSD | Inherits from Claude Code | Same as Claude Code |

### Web App (KasmVNC)

Open the **Browser** app in the Coder dashboard to watch AI agents interact with pages in real-time. The browser runs on a virtual display (`:99`) and is streamed via KasmVNC on port `6080`.

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

The Playwright MCP server is auto-configured for Claude Code (`~/.claude/mcp.json`) during workspace startup. It runs in **headed mode** on display `:99`, so all browser interactions are visible via the KasmVNC web app.

Architecture: `KasmVNC :99` (virtual display + VNC + web viewer on `:6080`) → `fluxbox` (window manager)

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

### GSD commands not available
```bash
# Reinstall for Claude Code
npx get-shit-done-cc@latest --claude --global
```

## Security

- Docker socket is mounted — users have full Docker access on the host daemon
- Use in trusted development environments
- Review template access controls in Coder admin

## External Resources

- [Coder Documentation](https://coder.com/docs)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [GSD (get-shit-done)](https://github.com/gsd-build/get-shit-done)
- [Starship Prompt](https://starship.rs)
- [Foundry Book](https://book.getfoundry.sh)
