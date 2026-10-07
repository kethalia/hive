#!/bin/bash
set -euo pipefail

# Coder runs startup and module scripts concurrently; another writer may hold
# Git's global-config lock briefly. Retry only lock contention, never delete it.
configure_git_alias() {
  local attempt delay=1 output status
  for attempt in 1 2 3 4 5 6; do
    if output=$(LC_ALL=C git config --global "$@" 2>&1); then
      return 0
    else
      status=$?
    fi
    if [[ "$output" != *"could not lock config file"* || "$output" != *"File exists"* ]]; then
      printf '%s\n' "$output" >&2
      return "$status"
    fi
    if [ "$attempt" -eq 6 ]; then
      printf '%s\n' "$output" >&2
      return "$status"
    fi
    sleep "$delay"
    delay=$((delay * 2))
  done
}

if [ ! -f "$HOME/.workspace_initialized" ]; then
  echo "First-time workspace setup..."
  mkdir -p "$HOME/projects" "$HOME/bin" "$HOME/.config" "$HOME/.local/bin"
  configure_git_alias alias.st status
  configure_git_alias alias.co checkout
  configure_git_alias alias.br branch
  configure_git_alias alias.cm commit
  configure_git_alias alias.lg "log --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset' --abbrev-commit"

  if [ ! -f "$HOME/README.md" ]; then
    cat > "$HOME/README.md" << 'EOFREADME'
${workspace_readme_content}

## Workspace identity

- Name: ${workspace_name}
- Owner: ${owner_name}
- Email: ${owner_email}
EOFREADME
  fi

  touch "$HOME/.workspace_initialized"
fi

export PATH="$HOME/.local/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"
export HIVE_BROWSER_TOOLS_ENABLED="${enable_browser}"

if [ -n "$${HIVE_IMAGE_VARIANT:-}" ] \
  && [ "$HIVE_IMAGE_VARIANT" != "$${HIVE_EXPECTED_IMAGE_VARIANT:-}" ]; then
  printf 'ERROR: workspace profile expects image variant %s, but image reports %s\n' \
    "$${HIVE_EXPECTED_IMAGE_VARIANT:-unset}" "$HIVE_IMAGE_VARIANT" >&2
  exit 1
fi

configure_codex_mcp() {
  mkdir -p "$HOME/.codex"
  python3 - <<'PYCODEX'
import os
import tomllib
from pathlib import Path

config = Path(os.environ["HOME"]) / ".codex" / "config.toml"
if config.exists():
    config.chmod(0o600)
existing = config.read_text() if config.exists() else ""
try:
    settings = tomllib.loads(existing)
except tomllib.TOMLDecodeError:
    print(f"WARNING: preserving invalid Codex config: {config}")
    raise SystemExit(0)

mcp_servers = settings.get("mcp_servers", {})
if not isinstance(mcp_servers, dict):
    print(f"WARNING: preserving Codex config; mcp_servers must be a table: {config}")
    raise SystemExit(0)

start = "# >>> hive-managed-codex-mcp"
end = "# <<< hive-managed-codex-mcp"
browser_enabled = os.environ.get("HIVE_BROWSER_TOOLS_ENABLED") == "true"
block = f'''{start}
[mcp_servers.hive_playwright]
command = "npx"
args = ["-y", "@playwright/mcp", "--no-sandbox"]

[mcp_servers.hive_playwright.env]
DISPLAY = ":1"
{end}''' if browser_enabled else ""

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
updated = base
# Register the server explicitly for `codex mcp login cloudflare-api`. Plugin
# installation alone may not expose its MCP server to the standalone CLI.
# Seed a default only; existing URLs, credentials, and enabled flags are owned
# by the user. OAuth remains an interactive step after workspace startup.
if "cloudflare-api" not in mcp_servers:
    updated = (updated + "\n\n" if updated else "") + '''[mcp_servers.cloudflare-api]
url = "https://mcp.cloudflare.com/mcp"'''
if block:
    updated = (updated + "\n\n" if updated else "") + block
updated = updated + "\n" if updated else ""

# Preserve configurations whose table layout cannot accept the added defaults
# (for example, an inline mcp_servers table) instead of writing invalid TOML.
try:
    tomllib.loads(updated)
except tomllib.TOMLDecodeError:
    print(f"WARNING: preserving Codex config; MCP defaults could not be added: {config}")
    raise SystemExit(0)

if updated != existing:
    config.write_text(updated)
elif not config.exists():
    config.touch(mode=0o600)
PYCODEX
  chmod 600 "$HOME/.codex/config.toml"
}

configure_json_mcp() {
  python3 - <<'PYMCP'
import json
import os
from pathlib import Path

home = Path(os.environ["HOME"])
browser_enabled = os.environ.get("HIVE_BROWSER_TOOLS_ENABLED") == "true"
playwright = {
    "command": "npx",
    "args": ["-y", "@playwright/mcp", "--no-sandbox"],
    "env": {"DISPLAY": ":1"},
}
for config in (home / ".claude" / "mcp.json", home / ".mcp.json"):
    config.parent.mkdir(parents=True, exist_ok=True)
    if config.exists():
        config.chmod(0o600)
    try:
        data = json.loads(config.read_text()) if config.exists() else {}
    except json.JSONDecodeError:
        print(f"WARNING: preserving invalid MCP config: {config}")
        continue
    servers = data.setdefault("mcpServers", {})
    servers.pop("obsidian", None)
    servers.pop("hive_obsidian", None)

    # Older Hive workspaces managed the generic `playwright` key. Remove it
    # only when its complete definition still matches the one Hive generated;
    # a differently configured entry belongs to the user.
    if servers.get("playwright") == playwright:
        servers.pop("playwright")

    # The Hive-specific key is an ownership marker, so it is safe to replace or
    # remove without touching a user-owned `playwright` server.
    servers.pop("hive_playwright", None)
    if browser_enabled:
        servers["hive_playwright"] = playwright
    config.write_text(json.dumps(data, indent=2) + "\n")
    config.chmod(0o600)
PYMCP
}

remove_hive_browser_helpers() {
  local helper_path legacy_sha actual_sha

  while IFS='|' read -r helper_path legacy_sha; do
    [ -f "$helper_path" ] || continue

    if [ "$(sed -n '2p' "$helper_path")" = "# hive-managed-browser-helper:v1" ]; then
      rm -f -- "$helper_path"
      continue
    fi

    actual_sha="$(sha256sum "$helper_path" | cut -d ' ' -f 1)"
    if [ "$actual_sha" = "$legacy_sha" ]; then
      rm -f -- "$helper_path"
    fi
  done <<EOFHELPERS
$HOME/.local/bin/browser-screenshot|e68578dca9a11321a94e71c2f961a832de20d43e3701aa3ae3ad0defc29d2d31
$HOME/.local/bin/browser-html|cedaea62386815c93c096a1b42d581255f7015630a68de0f1e0ece101608e08d
EOFHELPERS
}

remove_vault_managed_context() {
  local skills_root manifest managed_name agent_file vault_agent_file
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
    vault_agent_file="$HOME/vault/Agents/$${agent_file##*/}"
    if [ -f "$agent_file" ] && { { [ -f "$vault_agent_file" ] && cmp -s "$vault_agent_file" "$agent_file"; } || grep -qF '## Vault Context Layer' "$agent_file" || grep -qF 'personal knowledge vault at' "$agent_file"; }; then
      write_managed_agent_context "$agent_file"
    fi
  done
}

write_managed_agent_context() {
  local agent_directory agent_file="$1" agent_tmp

  agent_directory="$(dirname -- "$agent_file")"
  if [ -L "$agent_directory" ]; then
    printf 'WARNING: preserving symlinked agent directory without refreshing context: %s\n' \
      "$agent_directory" >&2
    return 0
  fi
  mkdir -p "$agent_directory"
  agent_tmp="$(mktemp "$agent_directory/.hive-agent-context.XXXXXX")"
  if ! cat > "$agent_tmp" << 'AGENTEOF'
${claude_md_content}
AGENTEOF
  then
    rm -f -- "$agent_tmp"
    return 1
  fi
  chmod 600 "$agent_tmp"
  if ! mv -fT -- "$agent_tmp" "$agent_file"; then
    rm -f -- "$agent_tmp"
    return 1
  fi
}

initialize_agent_context() {
  # These are workspace-profile defaults managed by Hive. Preserve linked configuration directories;
  # otherwise atomic replacement prevents a context symlink from redirecting writes or chmod.
  write_managed_agent_context "$HOME/.codex/AGENTS.md"
  write_managed_agent_context "$HOME/.claude/CLAUDE.md"
}

configure_codex_mcp
configure_json_mcp
remove_vault_managed_context
initialize_agent_context

if [ "$HIVE_BROWSER_TOOLS_ENABLED" != "true" ]; then
  remove_hive_browser_helpers
  if [ -L "$HOME/.local/bin/chromium-browser" ] \
    && [ "$(readlink "$HOME/.local/bin/chromium-browser")" = "/usr/bin/google-chrome-stable" ]; then
    rm -f "$HOME/.local/bin/chromium-browser"
  fi
fi

# Remove only files previously generated by Hive's vault integration. The vault
# and Obsidian application remain untouched.
rm -f "$HOME/sync-vault.sh" \
  "$HOME/.config/hive/vault-repository" \
  "$HOME/.config/autostart/obsidian.desktop"

echo "Workspace is ready. Check ~/README.md for the profile quick start."
