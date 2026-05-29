# OpenGSD Coder Workspace Update

**Reader:** a Hive operator who maintains the Coder templates.

**Post-read action:** publish the OpenGSD template update, rebuild existing
workspaces, and verify that each workspace resolves the maintained `@opengsd`
packages plus Codex instead of the abandoned pre-OpenGSD packages.

## What changed

The Coder templates now install Codex and the maintained OpenGSD packages:

- `@opengsd/get-shit-done-redux` for Claude Code slash commands and the
  `gsd-sdk`/`gsd-tools` shims used by hooks.
- `@opengsd/gsd-pi` for the standalone `gsd` and `gsd-cli` commands.
- `@openai/codex` for the Codex CLI.

The templates uninstall the old packages first so stale `gsd` or `gsd-sdk` shims
cannot stay first on `PATH`. Startup also writes Codex MCP configuration for
Obsidian and headed Playwright at `~/.codex/config.toml`, while vault skills are
synced to `~/.agents/skills`, the user skill path Codex scans.

## Publish updated templates

From a checkout of Hive with Coder CLI credentials configured:

```bash
coder templates push hive --directory templates/hive --yes \
  --message "Install OpenGSD packages"

coder templates push ai-dev --directory templates/ai-dev --yes \
  --message "Install OpenGSD packages"
```

If you use the Hive web UI template push workflow, push both known templates and
wait for each push stream to finish with `[exit:0]`.

## Update existing workspaces

Rebuild each workspace onto the active template version:

```bash
coder update <workspace-name>
```

`coder update` stops a running workspace if needed, applies the active template
version, runs the startup scripts, and starts it again.

## Repair a workspace without rebuilding

If a workspace cannot be rebuilt immediately, run this inside the workspace:

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

npm uninstall -g \
  get-shit-done-cc \
  get-shit-done-redux \
  gsd-pi \
  @gsd-build/sdk \
  @gsd-redux/sdk \
  @gsd-redux/get-shit-done-redux \
  || true

npm install -g @openai/codex@latest @opengsd/get-shit-done-redux@latest @opengsd/gsd-pi@latest
get-shit-done-redux --claude --global
get-shit-done-redux --codex --global
codex mcp add hive_obsidian -- npx -y @bitbonsai/mcpvault@1.0.4 /home/coder/vault || true
codex mcp add hive_playwright --env DISPLAY=:1 -- npx -y @playwright/mcp --no-sandbox || true
if [ -f "$HOME/vault/Agents/AGENTS.md" ]; then mkdir -p "$HOME/.codex" && cp "$HOME/vault/Agents/AGENTS.md" "$HOME/.codex/AGENTS.md"; fi
bash "$HOME/sync-vault.sh" || true
```

## Verify each workspace

Inside the workspace:

```bash
which gsd
which gsd-sdk
which codex
gsd --version
codex --version
npm list -g --depth=0 | grep -E '@opengsd|@openai/codex'
grep -q 'mcp_servers.hive_playwright' ~/.codex/config.toml
test -d ~/.agents/skills
```

Expected result:

- `gsd` resolves from the user-writable global npm prefix, normally
  `$HOME/.local/bin/gsd`.
- `gsd-sdk` resolves from the same prefix, normally `$HOME/.local/bin/gsd-sdk`.
- `codex` resolves from the same prefix, normally `$HOME/.local/bin/codex`.
- `npm list -g --depth=0` includes `@opengsd/gsd-pi`,
  `@opengsd/get-shit-done-redux`, and `@openai/codex`.
- `~/.codex/config.toml` contains the managed `hive_playwright` MCP server
  with `DISPLAY = ":1"`.
- `~/.agents/skills` exists for Codex user-skill discovery.
- Claude Code and Codex have GSD slash commands such as `/gsd-new-project` and
  `/gsd-progress` available after restart.

## Migrate legacy project state

For projects that still have legacy `.planning` artifacts from old GSD core,
open a GSD session in that project and run:

```text
/gsd migrate
/gsd doctor
```

`/gsd migrate` imports the old planning tree into the new `.gsd` structure and
`/gsd doctor` checks the migrated database and markdown projections.
