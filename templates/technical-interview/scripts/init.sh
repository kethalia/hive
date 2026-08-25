#!/bin/bash
set -euo pipefail

if [ ! -f "$HOME/.workspace_initialized" ]; then
  echo "First-time workspace setup..."
  mkdir -p "$HOME/projects" "$HOME/bin" "$HOME/.config" "$HOME/.local/bin"

  if [ ! -f "$HOME/README.md" ]; then
    cat > "$HOME/README.md" << 'EOFREADME'
${workspace_readme_content}

## Workspace identity

- Name: ${workspace_name}
EOFREADME
  fi

  touch "$HOME/.workspace_initialized"
fi

export PATH="$HOME/.local/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"
export HIVE_BROWSER_TOOLS_ENABLED="${enable_browser}"

configure_interview_environment() {
  local shell_file
  mkdir -p "$HOME/.config/hive"
  cat > "$HOME/.config/hive/interview-env.sh" <<'EOFENV'
# hive-managed-interview-environment:v1
unset ANTHROPIC_API_KEY GH_TOKEN GITHUB_TOKEN CODER_SESSION_TOKEN
unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN
EOFENV
  chmod 600 "$HOME/.config/hive/interview-env.sh"

  for shell_file in "$HOME/.zshenv" "$HOME/.bashrc" "$HOME/.profile"; do
    if [ ! -e "$shell_file" ]; then
      touch "$shell_file"
    fi
    if [ ! -L "$shell_file" ] \
      && ! grep -qF '# hive-interview-environment' "$shell_file" 2>/dev/null; then
      cat >> "$shell_file" <<'EOFSHELL'

# hive-interview-environment
[ ! -f "$HOME/.config/hive/interview-env.sh" ] || . "$HOME/.config/hive/interview-env.sh"
EOFSHELL
    fi
  done

  rm -f -- "$HOME/.runcomfy-api-token"
  unset ANTHROPIC_API_KEY GH_TOKEN GITHUB_TOKEN CODER_SESSION_TOKEN
  unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN
}

configure_interview_environment

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
from pathlib import Path

config = Path(os.environ["HOME"]) / ".codex" / "config.toml"
if config.exists():
    config.chmod(0o600)
existing = config.read_text() if config.exists() else ""
start = "# >>> hive-managed-codex-mcp"
end = "# <<< hive-managed-codex-mcp"
browser_enabled = os.environ.get("HIVE_BROWSER_TOOLS_ENABLED") == "true"
playwright_command = str(Path(os.environ["HOME"]) / ".local" / "bin" / "playwright-mcp")
block = f'''{start}
[mcp_servers.hive_playwright]
command = "{playwright_command}"
args = ["--browser", "chrome", "--no-sandbox", "--isolated"]

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
if block:
    updated = (updated + "\n\n" if updated else "") + block
updated = updated + "\n" if updated else ""

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
    "command": str(home / ".local" / "bin" / "playwright-mcp"),
    "args": ["--browser", "chrome", "--no-sandbox", "--isolated"],
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
    legacy_playwright = servers.get("playwright")
    legacy_hive_entry = (
        isinstance(legacy_playwright, dict)
        and legacy_playwright.get("command") == "npx"
        and legacy_playwright.get("args") == ["-y", "@playwright/mcp", "--no-sandbox"]
        and legacy_playwright.get("env") == {"DISPLAY": ":1"}
    )
    if legacy_playwright == playwright or legacy_hive_entry:
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
