# hive-orchestrator

## 2.1.3

### Patch Changes

- a6a3aeb: Seed pi MCP config from `~/.claude/mcp.json` into `~/.mcp.json` (and the cloned project's `.gsd/mcp.json` in Hive workers) so pi picks up playwright/obsidian MCP servers from first boot. Pi only reads project-rooted MCP config, so without seeding it has no MCP tools when launched from `~` or any project without its own config. Also align playwright `DISPLAY` to `:1` (matching the KasmVNC display) across `claude-mcp.json`, both `tools-shell.sh` chrome aliases, and the ai-dev README.

## 2.1.2

### Patch Changes

- 672e7d6: Normalize HCL formatting in ai-dev template and refine VS Code color theme defaults so the template gets pushed to Coder.

## 2.1.1

### Patch Changes

- c1b4d7d: Fix PATH duplication on workspace rebuild by using binary path checks instead of command -v

## 2.1.0

### Minor Changes

- e1a2d80: Add auth service integration with session-based authentication, token lifecycle management, and auth middleware

## 2.0.1

### Patch Changes

- 085623a: Fix PR review findings: VAPID race condition, rate-limit memory leak, task auth scoping, PWA manifest path

## 2.0.0

### Major Changes

- ac09e67: Multi-user Coder authentication: replaced static CODER_URL/CODER_SESSION_TOKEN env vars with per-user, per-deployment credentials stored encrypted in Postgres. Added login/logout flow, session management, token auto-rotation, PWA support with push notifications for token expiry.

## 1.0.1

### Patch Changes

- 81bff95: Multi-target vault sync: copy skills and context files to ~/.claude/, ~/.agents/, ~/.pi/agent/ with independent per-directory manifest cleanup

## 1.0.0

### Major Changes

- 78c7ca4: Release pipeline: multi-stage Docker builds, CI validation, and GHCR publishing via changesets
