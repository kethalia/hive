#!/bin/bash
set -euo pipefail

mkdir -p "$HOME/projects" "$HOME/bin" "$HOME/.config" "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"

if [ -n "$HIVE_REPO_URL" ]; then
  if [ ! -d /home/coder/project ]; then
    git clone "$HIVE_REPO_URL" /home/coder/project
  fi
  if [ -n "$HIVE_BRANCH_NAME" ] && [ -d /home/coder/project ]; then
    if ! git -C /home/coder/project checkout -b "$HIVE_BRANCH_NAME" 2>/dev/null \
      && ! git -C /home/coder/project checkout "$HIVE_BRANCH_NAME" 2>/dev/null; then
      printf 'Warning: could not checkout branch %s; keeping the current worktree\n' "$HIVE_BRANCH_NAME" >&2
    fi
  fi
fi

python3 - <<'PYCONFIG'
import json
import os
from pathlib import Path

home = Path(os.environ["HOME"])
config = home / ".codex" / "config.toml"
config.parent.mkdir(parents=True, exist_ok=True)
existing = config.read_text() if config.exists() else ""
start, end = "# >>> hive-managed-codex-mcp", "# <<< hive-managed-codex-mcp"
block = f'''{start}
[mcp_servers.hive_playwright]
command = "npx"
args = ["-y", "@playwright/mcp", "--no-sandbox"]

[mcp_servers.hive_playwright.env]
DISPLAY = ":1"
{end}'''
managed_tables = {"[mcp_servers.hive_obsidian]", "[mcp_servers.hive_playwright]", "[mcp_servers.hive_playwright.env]"}
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
config.write_text(updated)
config.chmod(0o600)

playwright = {"command": "npx", "args": ["-y", "@playwright/mcp", "--no-sandbox"], "env": {"DISPLAY": ":1"}}
for path in (home / ".claude" / "mcp.json", home / ".mcp.json"):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        data = json.loads(path.read_text()) if path.exists() else {}
    except json.JSONDecodeError:
        continue
    servers = data.setdefault("mcpServers", {})
    servers.pop("obsidian", None)
    servers.pop("hive_obsidian", None)
    servers["playwright"] = playwright
    path.write_text(json.dumps(data, indent=2) + "\n")
    path.chmod(0o600)

project_config = home / "project" / ".gsd" / "mcp.json"
if project_config.exists():
    try:
        project_data = json.loads(project_config.read_text())
    except json.JSONDecodeError:
        print(f"WARNING: preserving invalid MCP config: {project_config}")
    else:
        project_servers = project_data.setdefault("mcpServers", {})
        project_servers.pop("obsidian", None)
        project_servers.pop("hive_obsidian", None)
        project_config.write_text(json.dumps(project_data, indent=2) + "\n")
        project_config.chmod(0o600)
PYCONFIG

remove_vault_managed_context() {
  local skills_root manifest managed_name agent_file
  for skills_root in "$HOME/.agents/skills" "$HOME/.claude/skills" "$HOME/.pi/agent/skills"; do
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
    "$HOME/.agents/CLAUDE.md" \
    "$HOME/.pi/agent/AGENTS.md" \
    "$HOME/.pi/agent/CLAUDE.md"; do
    if [ -f "$agent_file" ] && { grep -qF '## Vault Context Layer' "$agent_file" || grep -qF 'personal knowledge vault at' "$agent_file"; }; then
      cat > "$agent_file" << 'AGENTEOF'
${claude_md_content}
AGENTEOF
    fi
  done
}

remove_vault_managed_context
rm -f "$HOME/sync-vault.sh" "$HOME/.config/hive/vault-repository" "$HOME/.config/autostart/obsidian.desktop"
mkdir -p "$HOME/.claude"
if [ ! -f "$HOME/.claude/CLAUDE.md" ] || grep -qF 'personal knowledge vault at' "$HOME/.claude/CLAUDE.md"; then
  cat > "$HOME/.claude/CLAUDE.md" << 'CLAUDEEOF'
${claude_md_content}
CLAUDEEOF
fi

echo "Hive worker workspace is ready."
