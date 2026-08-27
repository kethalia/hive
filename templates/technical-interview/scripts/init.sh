#!/bin/bash
set -euo pipefail
umask 077

unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
unset GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN
unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN

ensure_interview_local_directory() {
  local target=$1 current remainder component

  if [ -L "$HOME" ] || [ ! -d "$HOME" ]; then
    printf 'WARNING: interview home is not a local directory: %s\n' "$HOME" >&2
    return 1
  fi
  case "$target" in
    "$HOME") return 0 ;;
    "$HOME"/*) ;;
    *)
      printf 'WARNING: refusing to prepare a directory outside the interview home: %s\n' \
        "$target" >&2
      return 1
      ;;
  esac

  current="$HOME"
  remainder="$${target#"$HOME"/}"
  while [ -n "$remainder" ]; do
    component="$${remainder%%/*}"
    if [ "$component" = "$remainder" ]; then
      remainder=""
    else
      remainder="$${remainder#*/}"
    fi
    current="$current/$component"
    if [ -L "$current" ] || { [ -e "$current" ] && [ ! -d "$current" ]; }; then
      printf 'WARNING: unsafe interview directory was preserved: %s\n' "$current" >&2
      return 1
    fi
    [ -d "$current" ] || mkdir -- "$current" || return 1
  done
}

interview_local_tools_safe=true
if ! ensure_interview_local_directory "$HOME/.local/bin"; then
  interview_local_tools_safe=false
fi

initialize_workspace_home() {
  local initialization_marker="$HOME/.workspace_initialized"
  local readme="$HOME/README.md"
  local temporary_file

  if [ -L "$initialization_marker" ] \
    || { [ -e "$initialization_marker" ] && [ ! -f "$initialization_marker" ]; }; then
    printf 'WARNING: unsafe workspace initialization marker was preserved: %s\n' \
      "$initialization_marker" >&2
    return 0
  fi
  [ ! -f "$initialization_marker" ] || return 0

  echo "First-time workspace setup..."
  for directory in "$HOME/projects" "$HOME/bin" "$HOME/.config"; do
    if ! ensure_interview_local_directory "$directory"; then
      printf 'WARNING: workspace directory could not be prepared; readiness will fail: %s\n' \
        "$directory" >&2
    fi
  done

  if [ -L "$readme" ] || { [ -e "$readme" ] && [ ! -f "$readme" ]; }; then
    printf 'WARNING: unsafe workspace README was preserved: %s\n' "$readme" >&2
  elif [ ! -f "$readme" ]; then
    temporary_file="$(mktemp "$HOME/.README.md.XXXXXX")"
    if ! cat > "$temporary_file" << 'EOFREADME'
${workspace_readme_content}

## Workspace identity

- Name: ${workspace_name}
EOFREADME
    then
      rm -f -- "$temporary_file"
      return 1
    fi
    chmod 600 "$temporary_file"
    if ! mv -fT -- "$temporary_file" "$readme"; then
      rm -f -- "$temporary_file"
      return 1
    fi
  fi

  temporary_file="$(mktemp "$HOME/.workspace_initialized.XXXXXX")"
  chmod 600 "$temporary_file"
  if ! mv -fT -- "$temporary_file" "$initialization_marker"; then
    rm -f -- "$temporary_file"
    return 1
  fi
}

initialize_workspace_home

export PATH="$HOME/.local/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"
export HIVE_BROWSER_TOOLS_ENABLED="${enable_browser}"

write_interview_environment() {
  local config_directory="$HOME/.config"
  local hive_config_directory="$HOME/.config/hive"
  local environment_file="$HOME/.config/hive/interview-env.sh"
  local temporary_file

  if [ -L "$config_directory" ] \
    || { [ -e "$config_directory" ] && [ ! -d "$config_directory" ]; }; then
    printf 'WARNING: interview environment directory is unsafe; readiness will fail: %s\n' \
      "$config_directory" >&2
    return 1
  fi
  mkdir -p "$config_directory"

  if [ -L "$hive_config_directory" ] \
    || { [ -e "$hive_config_directory" ] && [ ! -d "$hive_config_directory" ]; }; then
    printf 'WARNING: interview environment directory is unsafe; readiness will fail: %s\n' \
      "$hive_config_directory" >&2
    return 1
  fi
  mkdir -p "$hive_config_directory"

  temporary_file="$(mktemp "$hive_config_directory/.interview-env.XXXXXX")"
  if ! cat > "$temporary_file" <<'EOFENV'
# hive-managed-interview-environment:v1
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
unset GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN
unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN
EOFENV
  then
    rm -f -- "$temporary_file"
    return 1
  fi
  chmod 600 "$temporary_file"
  if ! mv -fT -- "$temporary_file" "$environment_file"; then
    rm -f -- "$temporary_file"
    return 1
  fi
}

configure_interview_environment() {
  if ! write_interview_environment; then
    printf 'WARNING: managed credential scrubbing could not be installed; readiness will fail.\n' >&2
  fi

  if ! python3 - <<'PYSHELL'
import os
import stat
import tempfile
from pathlib import Path


home = Path(os.environ["HOME"])
marker = "# hive-interview-environment"
source = '[ ! -f "$HOME/.config/hive/interview-env.sh" ] || . "$HOME/.config/hive/interview-env.sh"'
preserved_start = "# >>> hive-interview-preserved-startup"
preserved_end = "# <<< hive-interview-preserved-startup"
function_name = "__hive_interview_preserved_startup"
function_start = f"{function_name}() {{"
function_noop = "  :"
function_unset = f"unset -f {function_name} 2>/dev/null || true"
final_marker = "# hive-interview-environment-final"
legacy_managed_lines = {marker, source}
shell_files = [home / ".zshenv", home / ".bashrc", home / ".profile"]
shell_files.extend(
    shell_file
    for shell_file in (home / ".bash_profile", home / ".bash_login")
    if shell_file.exists() or shell_file.is_symlink()
)

for shell_file in shell_files:
    if shell_file.is_symlink():
        print(
            "WARNING: linked shell configuration bypasses credential scrubbing; "
            f"readiness will fail: {shell_file}",
            file=os.sys.stderr,
        )
        continue
    if shell_file.exists() and not shell_file.is_file():
        print(
            "WARNING: non-regular shell configuration bypasses credential scrubbing; "
            f"readiness will fail: {shell_file}",
            file=os.sys.stderr,
        )
        continue

    try:
        existing = shell_file.read_text() if shell_file.exists() else ""
    except (OSError, UnicodeDecodeError):
        print(
            "WARNING: non-UTF-8 shell configuration bypasses credential scrubbing; "
            f"readiness will fail: {shell_file}",
            file=os.sys.stderr,
        )
        continue
    existing_lines = existing.splitlines(keepends=True)
    line_values = [line.rstrip("\r\n") for line in existing_lines]

    def find_line(value, start=0):
        return next(
            (index for index in range(start, len(line_values)) if line_values[index] == value),
            None,
        )

    managed_start_index = find_line(marker)
    preserved_start_index = find_line(
        preserved_start,
        (managed_start_index + 1) if managed_start_index is not None else 0,
    )
    preserved_end_index = find_line(
        preserved_end,
        (preserved_start_index + 1) if preserved_start_index is not None else 0,
    )
    managed_end_index = None
    if (
        managed_start_index is not None
        and preserved_start_index == managed_start_index + 4
        and preserved_end_index is not None
        and preserved_end_index + 5 < len(line_values)
        and line_values[managed_start_index + 1] == source
        and line_values[managed_start_index + 2] == function_start
        and line_values[managed_start_index + 3] == function_noop
        and line_values[preserved_end_index + 1] == "}"
        and line_values[preserved_end_index + 2] == function_name
        and line_values[preserved_end_index + 3] == function_unset
        and line_values[preserved_end_index + 4] == final_marker
        and line_values[preserved_end_index + 5] == source
    ):
        managed_end_index = preserved_end_index + 6

    if managed_end_index is not None:
        # Shell tooling may append setup before or after Hive's managed block.
        # Fold all unmanaged content into the guarded function so it survives
        # restarts and the final credential scrub still runs after it returns.
        preserved = "".join(
            existing_lines[:managed_start_index]
            + existing_lines[preserved_start_index + 1 : preserved_end_index]
            + existing_lines[managed_end_index:]
        )
    else:
        preserved = "".join(
            line
            for line in existing_lines
            if line.rstrip("\r\n") not in legacy_managed_lines
        )
    if preserved and not preserved.endswith(("\n", "\r")):
        preserved += "\n"
    updated = (
        f"{marker}\n{source}\n{function_start}\n{function_noop}\n"
        f"{preserved_start}\n{preserved}{preserved_end}\n}}\n"
        f"{function_name}\n{function_unset}\n{final_marker}\n{source}\n"
    )
    mode = stat.S_IMODE(shell_file.stat().st_mode) if shell_file.exists() else 0o600
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{shell_file.name}.", dir=home
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w") as handle:
            handle.write(updated)
        temporary.chmod(mode)
        os.replace(temporary, shell_file)
    finally:
        temporary.unlink(missing_ok=True)
PYSHELL
  then
    printf 'WARNING: interactive shell credential scrubbing could not be refreshed; readiness will fail.\n' >&2
  fi

  rm -f -- "$HOME/.runcomfy-api-token"
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
  unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
  unset GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN
  unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN

  # Unsafe persistent shell configuration must remain visible without making
  # the Coder terminal inaccessible. interview-check performs the strict gate.
  return 0
}

configure_interview_environment

if [ -n "$${HIVE_IMAGE_VARIANT:-}" ] \
  && [ "$HIVE_IMAGE_VARIANT" != "$${HIVE_EXPECTED_IMAGE_VARIANT:-}" ]; then
  printf 'ERROR: workspace profile expects image variant %s, but image reports %s\n' \
    "$${HIVE_EXPECTED_IMAGE_VARIANT:-unset}" "$HIVE_IMAGE_VARIANT" >&2
  exit 1
fi

configure_codex_mcp() {
  if [ -L "$HOME/.codex" ] \
    || { [ -e "$HOME/.codex" ] && [ ! -d "$HOME/.codex" ]; }; then
    printf 'WARNING: unsafe Codex configuration directory; MCP configuration was not changed and readiness will fail: %s\n' \
      "$HOME/.codex" >&2
    return 0
  fi
  mkdir -p "$HOME/.codex"
  python3 - <<'PYCODEX'
import os
import tempfile
from pathlib import Path


def atomic_write(path: Path, contents: str) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w") as handle:
            handle.write(contents)
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


config = Path(os.environ["HOME"]) / ".codex" / "config.toml"
linked_config = config.is_symlink()
if linked_config:
    print(f"WARNING: replacing linked Codex config without reading its target: {config}")
elif config.exists() and not config.is_file():
    print(
        f"WARNING: preserving non-regular Codex MCP config; readiness will fail: {config}",
        file=os.sys.stderr,
    )
    raise SystemExit(0)
try:
    existing = config.read_text() if config.exists() and not linked_config else ""
except (OSError, UnicodeDecodeError):
    print(
        f"WARNING: preserving non-UTF-8 Codex MCP config; readiness will fail: {config}",
        file=os.sys.stderr,
    )
    raise SystemExit(0)
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

if linked_config or updated != existing or not config.exists():
    atomic_write(config, updated)
else:
    config.chmod(0o600)
PYCODEX
}

configure_json_mcp() {
  python3 - <<'PYMCP'
import json
import os
import tempfile
from pathlib import Path


def atomic_write(path: Path, contents: str) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w") as handle:
            handle.write(contents)
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


home = Path(os.environ["HOME"])
browser_enabled = os.environ.get("HIVE_BROWSER_TOOLS_ENABLED") == "true"
playwright = {
    "command": str(home / ".local" / "bin" / "playwright-mcp"),
    "args": ["--browser", "chrome", "--no-sandbox", "--isolated"],
    "env": {"DISPLAY": ":1"},
}
for config in (home / ".claude" / "mcp.json", home / ".mcp.json"):
    if config.parent.is_symlink() or (
        config.parent.exists() and not config.parent.is_dir()
    ):
        print(
            "WARNING: unsafe MCP configuration directory; configuration was not changed "
            f"and readiness will fail: {config.parent}",
            file=os.sys.stderr,
        )
        continue
    config.parent.mkdir(parents=True, exist_ok=True)
    linked_config = config.is_symlink()
    if linked_config:
        print(f"WARNING: replacing linked MCP config without reading its target: {config}")
    elif config.exists() and not config.is_file():
        print(
            f"WARNING: preserving non-regular MCP config; readiness will fail: {config}",
            file=os.sys.stderr,
        )
        continue
    try:
        data = json.loads(config.read_text()) if config.exists() and not linked_config else {}
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        print(f"WARNING: preserving invalid or non-UTF-8 MCP config: {config}")
        continue
    if not isinstance(data, dict):
        print(f"WARNING: preserving MCP config with a non-object root: {config}")
        continue
    if "mcpServers" not in data:
        data["mcpServers"] = {}
    elif not isinstance(data["mcpServers"], dict):
        print(f"WARNING: preserving MCP config with non-object mcpServers: {config}")
        continue
    servers = data["mcpServers"]
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
    atomic_write(config, json.dumps(data, indent=2) + "\n")
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

write_managed_agent_context() {
  local agent_directory agent_file="$1" agent_tmp

  agent_directory="$(dirname -- "$agent_file")"
  if ! ensure_interview_local_directory "$agent_directory"; then
    printf 'WARNING: preserving unsafe agent path without refreshing context: %s\n' \
      "$agent_directory" >&2
    return 0
  fi
  if [ ! -L "$agent_file" ] && [ -e "$agent_file" ] && [ ! -f "$agent_file" ]; then
    printf 'WARNING: preserving non-regular agent context path: %s\n' "$agent_file" >&2
    return 0
  fi
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
  local context_file

  # These are workspace-profile defaults managed by Hive. Preserve linked configuration directories;
  # otherwise atomic replacement prevents a context symlink from redirecting writes or chmod.
  for context_file in "$HOME/.codex/AGENTS.md" "$HOME/.claude/CLAUDE.md"; do
    if ! write_managed_agent_context "$context_file"; then
      printf 'WARNING: agent context could not be refreshed; readiness will fail: %s\n' \
        "$context_file" >&2
    fi
  done
}

if ! configure_codex_mcp; then
  printf 'WARNING: Codex MCP configuration could not be refreshed; readiness will fail.\n' >&2
fi
if ! configure_json_mcp; then
  printf 'WARNING: JSON MCP configuration could not be refreshed; readiness will fail.\n' >&2
fi
initialize_agent_context

if [ "$HIVE_BROWSER_TOOLS_ENABLED" != "true" ] \
  && [ "$interview_local_tools_safe" = true ]; then
  remove_hive_browser_helpers
  if [ -L "$HOME/.local/bin/chromium-browser" ] \
    && [ "$(readlink "$HOME/.local/bin/chromium-browser")" = "/usr/bin/google-chrome-stable" ]; then
    rm -f "$HOME/.local/bin/chromium-browser"
  fi
fi

echo "Workspace is ready. Check ~/README.md for the profile quick start."
