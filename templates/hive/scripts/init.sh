#!/bin/bash
set -euo pipefail

mkdir -p "$HOME/projects" "$HOME/bin" "$HOME/.config" "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"

if [ -n "$HIVE_REPO_URL" ]; then
  if [ ! -d /home/coder/project ]; then
    git clone "$HIVE_REPO_URL" /home/coder/project
  fi
  if [ -n "$HIVE_BRANCH_NAME" ] && [ -d /home/coder/project ]; then
    cd /home/coder/project
    git checkout -b "$HIVE_BRANCH_NAME" 2>/dev/null || git checkout "$HIVE_BRANCH_NAME"
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
PYCONFIG

rm -f "$HOME/sync-vault.sh" "$HOME/.config/hive/vault-repository" "$HOME/.config/autostart/obsidian.desktop"
mkdir -p "$HOME/.claude"
if [ ! -f "$HOME/.claude/CLAUDE.md" ] || grep -qF 'personal knowledge vault at `~/vault`' "$HOME/.claude/CLAUDE.md"; then
  cat > "$HOME/.claude/CLAUDE.md" << 'CLAUDEEOF'
${claude_md_content}
CLAUDEEOF
fi

echo "Hive worker workspace is ready."
