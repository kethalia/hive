#!/bin/bash
set -euo pipefail

if [ ! -f "$HOME/.workspace_initialized" ]; then
  echo "First-time workspace setup..."
  mkdir -p "$HOME/projects" "$HOME/bin" "$HOME/.config" "$HOME/.local/bin"
  git config --global alias.st status
  git config --global alias.co checkout
  git config --global alias.br branch
  git config --global alias.cm commit
  git config --global alias.lg "log --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset' --abbrev-commit"

  if [ ! -f "$HOME/README.md" ]; then
    cat > "$HOME/README.md" << 'EOFREADME'
# ${workspace_name}

## AI-assisted development

- `claude` — Claude Code
- `codex` — Codex CLI with Playwright and the game-development plugin

## Game development

- Open **Desktop** from Coder, then launch **Unity Hub** or **Blender**.
- Sign in to Unity Hub and install the latest Unity 6.3 LTS Editor into the persistent default location.
- Blender 4.5 LTS and its `blender` CLI are preinstalled.
- Unity projects and Editor installs persist under `/home/coder`; GPU-heavy validation may require a GPU-enabled machine.

## Core tools

- Node.js v24; pnpm, Yarn, and Bun
- Foundry and GitHub Actions `act`
- code-server, File Browser, Chrome, tmux, and direnv
- Rootless or remote container builds; no host Docker socket is mounted

### Workspace

- Owner: ${owner_name}
- Email: ${owner_email}
EOFREADME
  fi

  touch "$HOME/.workspace_initialized"
fi

export PATH="$HOME/.local/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"

configure_codex_mcp() {
  mkdir -p "$HOME/.codex"
  python3 - <<'PYCODEX'
import os
from pathlib import Path

config = Path(os.environ["HOME"]) / ".codex" / "config.toml"
existing = config.read_text() if config.exists() else ""
start = "# >>> hive-managed-codex-mcp"
end = "# <<< hive-managed-codex-mcp"
block = f'''{start}
[mcp_servers.hive_playwright]
command = "npx"
args = ["-y", "@playwright/mcp", "--no-sandbox"]

[mcp_servers.hive_playwright.env]
DISPLAY = ":1"
{end}'''

managed_tables = {
    "[mcp_servers.hive_obsidian]",
    "[mcp_servers.hive_playwright]",
    "[mcp_servers.hive_playwright.env]",
}
preserved = []
skip_table = False
for line in existing.splitlines():
    stripped = line.strip()
    if stripped in (start, end):
        continue
    if stripped.startswith("["):
        skip_table = stripped in managed_tables
    if not skip_table:
        preserved.append(line)
base = "\n".join(preserved).strip()
updated = (base + "\n\n" if base else "") + block + "\n"

if updated != existing:
    config.write_text(updated)
PYCODEX
  chmod 600 "$HOME/.codex/config.toml"
}

configure_json_mcp() {
  python3 - <<'PYMCP'
import json
import os
from pathlib import Path

home = Path(os.environ["HOME"])
playwright = {
    "command": "npx",
    "args": ["-y", "@playwright/mcp", "--no-sandbox"],
    "env": {"DISPLAY": ":1"},
}
for config in (home / ".claude" / "mcp.json", home / ".mcp.json"):
    config.parent.mkdir(parents=True, exist_ok=True)
    try:
        data = json.loads(config.read_text()) if config.exists() else {}
    except json.JSONDecodeError:
        print(f"WARNING: preserving invalid MCP config: {config}")
        continue
    servers = data.setdefault("mcpServers", {})
    servers.pop("obsidian", None)
    servers.pop("hive_obsidian", None)
    servers["playwright"] = playwright
    config.write_text(json.dumps(data, indent=2) + "\n")
    config.chmod(0o600)
PYMCP
}

install_game_plugin_source() {
  local root="$HOME/.agents"
  local plugin="$HOME/plugins/game-development"
  mkdir -p "$root/plugins" \
    "$plugin/.codex-plugin" \
    "$plugin/skills/unity-development/agents" \
    "$plugin/skills/blender-asset-pipeline/agents"
  HIVE_GAME_MARKETPLACE_B64="${codex_marketplace_b64}" python3 - <<'PYMARKETPLACE'
import base64
import json
import os
import shutil
from pathlib import Path

target = Path(os.environ["HOME"]) / ".agents" / "plugins" / "marketplace.json"
managed = json.loads(base64.b64decode(os.environ["HIVE_GAME_MARKETPLACE_B64"]))
managed_plugin = next(plugin for plugin in managed["plugins"] if plugin["name"] == "game-development")

existing = {}
if target.exists():
    try:
        existing = json.loads(target.read_text())
        if not isinstance(existing, dict) or not isinstance(existing.get("plugins", []), list):
            raise ValueError("marketplace root and plugins must be objects and arrays")
    except (json.JSONDecodeError, ValueError) as error:
        backup = target.with_name("marketplace.pre-hive-invalid.json")
        if not backup.exists():
            shutil.copyfile(target, backup)
        print(f"WARNING: backed up invalid Codex marketplace: {error}")
        existing = {}

existing.setdefault("name", managed["name"])
existing.setdefault("interface", managed["interface"])
plugins = existing.setdefault("plugins", [])
replacement_index = next(
    (index for index, plugin in enumerate(plugins) if plugin.get("name") == "game-development"),
    len(plugins),
)
plugins[:] = [plugin for plugin in plugins if plugin.get("name") != "game-development"]
plugins.insert(min(replacement_index, len(plugins)), managed_plugin)

temporary = target.with_name("marketplace.hive.tmp.json")
temporary.write_text(json.dumps(existing, indent=2) + "\n")
temporary.chmod(0o600)
temporary.replace(target)
PYMARKETPLACE
  printf '%s' "${game_plugin_manifest_b64}" | base64 -d > "$plugin/.codex-plugin/plugin.json"
  printf '%s' "${unity_skill_b64}" | base64 -d > "$plugin/skills/unity-development/SKILL.md"
  printf '%s' "${unity_skill_metadata_b64}" | base64 -d > "$plugin/skills/unity-development/agents/openai.yaml"
  printf '%s' "${blender_skill_b64}" | base64 -d > "$plugin/skills/blender-asset-pipeline/SKILL.md"
  printf '%s' "${blender_skill_metadata_b64}" | base64 -d > "$plugin/skills/blender-asset-pipeline/agents/openai.yaml"
}

remove_vault_managed_context() {
  local skills_root manifest managed_name agent_file
  for skills_root in "$HOME/.agents/skills" "$HOME/.claude/skills"; do
    manifest="$skills_root/.vault-managed"
    [ -f "$manifest" ] || continue
    while IFS= read -r managed_name; do
      case "$managed_name" in
        "" | */* | ".." | -*)
          printf 'WARNING: ignoring suspicious vault-managed skill: %s\n' "$managed_name" >&2
          continue
          ;;
      esac
      if [ -e "$skills_root/$managed_name" ] || [ -L "$skills_root/$managed_name" ]; then
        rm -rf -- "$skills_root/$managed_name"
      fi
    done < "$manifest"
    rm -f -- "$manifest"
  done

  for agent_file in \
    "$HOME/.codex/AGENTS.md" \
    "$HOME/.claude/AGENTS.md" \
    "$HOME/.agents/AGENTS.md" \
    "$HOME/.claude/CLAUDE.md" \
    "$HOME/.agents/CLAUDE.md"; do
    if [ -f "$agent_file" ] && { grep -qF '## Vault Context Layer' "$agent_file" || grep -qF 'personal knowledge vault at' "$agent_file"; }; then
      cat > "$agent_file" << 'AGENTEOF'
${claude_md_content}
AGENTEOF
    fi
  done
}

configure_codex_mcp
configure_json_mcp
install_game_plugin_source
remove_vault_managed_context

# Remove only files previously generated by Hive's vault integration. The vault
# and Obsidian application remain untouched.
rm -f "$HOME/sync-vault.sh" \
  "$HOME/.config/hive/vault-repository" \
  "$HOME/.config/autostart/obsidian.desktop"

mkdir -p "$HOME/.claude"
if [ ! -f "$HOME/.claude/CLAUDE.md" ] || grep -qF 'personal knowledge vault at' "$HOME/.claude/CLAUDE.md"; then
  cat > "$HOME/.claude/CLAUDE.md" << 'CLAUDEEOF'
${claude_md_content}
CLAUDEEOF
fi

echo "Workspace is ready. Check ~/README.md for the game-development quick start."
