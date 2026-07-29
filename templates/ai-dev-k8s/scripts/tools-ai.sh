#!/bin/bash
set -e

BOLD='\033[0;1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RESET='\033[0m'

command_exists() {
  command -v "$1" &> /dev/null
}

run_step() {
  local name=$1
  local install_cmd=$2

  printf '%b[install] %s...%b\n' "$BOLD" "$name" "$RESET"
  if eval "$install_cmd"; then
    printf '%b[ok] %s completed successfully%b\n\n' "$GREEN" "$name" "$RESET"
  else
    printf '%b[warn] %s failed, continuing...%b\n\n' "$YELLOW" "$name" "$RESET"
  fi
}

repair_node_shims() {
  mkdir -p "$HOME/.local/bin"

  # Existing persistent homes can contain self-referential node/npm shims from an
  # older symlink pass. If those stay first on PATH, every npm install fails with
  # "env: ‘node’: Too many levels of symbolic links".
  for bin in node npm npx corepack; do
    local shim="$HOME/.local/bin/$bin"
    if [ -L "$shim" ]; then
      local target
      target="$(readlink "$shim" 2>/dev/null || true)"
      if [ "$target" = "$shim" ] || [ "$target" = "$HOME/.local/bin/$bin" ]; then
        rm -f "$shim"
      fi
    fi
  done

  local node_dir=""
  for candidate in /usr/bin/node /usr/local/bin/node /opt/node*/bin/node; do
    if [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
      node_dir="$(dirname "$candidate")"
      break
    fi
  done

  if [ -z "$node_dir" ]; then
    printf '%b[warn] Node.js runtime not found; npm-based AI installs may fail%b\n' "$YELLOW" "$RESET"
    return 1
  fi

  for bin in node npm npx corepack; do
    if [ -x "$node_dir/$bin" ]; then
      ln -sf "$node_dir/$bin" "$HOME/.local/bin/$bin"
    fi
  done

  hash -r 2>/dev/null || true

  if ! node --version >/dev/null 2>&1 || ! npm --version >/dev/null 2>&1; then
    printf '%b[warn] Node.js shims are still not usable; npm-based AI installs may fail%b\n' "$YELLOW" "$RESET"
    return 1
  fi
}

npm_global_has() {
  npm list -g --depth=0 "$1" >/dev/null 2>&1
}

checkout_pinned_repo() {
  local source_root=$1
  local repository_url=$2
  local repository_ref=$3
  shift 3
  local checkout_parent checkout_tmp

  if [ -d "$source_root/.git" ] \
    && [ "$(git -C "$source_root" rev-parse HEAD 2>/dev/null || true)" = "$repository_ref" ]; then
    return 0
  fi

  # Revision-specific destinations are immutable. Preserve an unexpected path
  # for inspection instead of replacing it during workspace startup.
  if [ -e "$source_root" ] || [ -L "$source_root" ]; then
    return 1
  fi

  checkout_parent="${source_root%/*}"
  mkdir -p "$checkout_parent"
  checkout_tmp="$(mktemp -d "$checkout_parent/.checkout.XXXXXX")"

  if git -C "$checkout_tmp" init --quiet \
    && git -C "$checkout_tmp" remote add origin "$repository_url" \
    && git -C "$checkout_tmp" sparse-checkout init --cone \
    && git -C "$checkout_tmp" sparse-checkout set "$@" \
    && git -C "$checkout_tmp" fetch --quiet --depth=1 origin "$repository_ref" \
    && git -C "$checkout_tmp" checkout --quiet --detach FETCH_HEAD; then
    mv "$checkout_tmp" "$source_root"
    return 0
  fi

  rm -rf -- "$checkout_tmp"
  return 1
}

install_official_skills() {
  local skills_cli_version="1.5.20"
  local openai_skills_ref="49f948faa9258a0c61caceaf225e179651397431"
  local vercel_skills_ref="7c180d9044c9ae2b442b567aad4e42a28dd5ed62"
  local openai_root="$HOME/.local/share/hive/official-skills/openai-$openai_skills_ref"
  local vercel_root="$HOME/.local/share/hive/official-skills/vercel-$vercel_skills_ref"
  local managed_manifest="$HOME/.agents/skills/.hive-official"
  local expected_manifest source_path skill_name
  local -a skill_sources=(
    "$openai_root/skills/.curated/cloudflare-deploy"
    "$openai_root/skills/.curated/security-best-practices"
    "$openai_root/skills/.curated/security-threat-model"
    "$vercel_root/skills/react-best-practices"
    "$vercel_root/skills/composition-patterns"
    "$vercel_root/skills/web-design-guidelines"
  )

  mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills" "$HOME/.codex/skills"

  expected_manifest="skills-cli=$skills_cli_version
openai-skills=$openai_skills_ref
vercel-skills=$vercel_skills_ref"
  if [ -f "$managed_manifest" ] \
    && [ "$(cat "$managed_manifest")" = "$expected_manifest" ] \
    && [ -f "$HOME/.agents/skills/cloudflare-deploy/SKILL.md" ] \
    && [ -f "$HOME/.agents/skills/security-best-practices/SKILL.md" ] \
    && [ -f "$HOME/.agents/skills/security-threat-model/SKILL.md" ] \
    && [ -f "$HOME/.agents/skills/vercel-react-best-practices/SKILL.md" ] \
    && [ -f "$HOME/.agents/skills/vercel-composition-patterns/SKILL.md" ] \
    && [ -f "$HOME/.agents/skills/web-design-guidelines/SKILL.md" ]; then
    printf '%b[ok] Official Claude and Codex skills already installed%b\n' "$GREEN" "$RESET"
    return 0
  fi

  if ! checkout_pinned_repo "$openai_root" https://github.com/openai/skills.git "$openai_skills_ref" \
    skills/.curated/cloudflare-deploy \
    skills/.curated/security-best-practices \
    skills/.curated/security-threat-model; then
    printf '%b[warn] OpenAI skill checkout failed; continuing without those skills%b\n' "$YELLOW" "$RESET"
  fi

  if ! checkout_pinned_repo "$vercel_root" https://github.com/vercel-labs/agent-skills.git "$vercel_skills_ref" \
    skills/react-best-practices \
    skills/composition-patterns \
    skills/web-design-guidelines; then
    printf '%b[warn] Vercel skill checkout failed; continuing without those skills%b\n' "$YELLOW" "$RESET"
  fi

  for source_path in "${skill_sources[@]}"; do
    [ -f "$source_path/SKILL.md" ] || continue
    skill_name="${source_path##*/}"
    printf '%b[install] Official agent skill: %s...%b\n' "$BOLD" "$skill_name" "$RESET"
    if npx --yes "skills@$skills_cli_version" add "$source_path" \
      --global \
      --agent claude-code \
      --agent codex \
      --yes; then
      printf '%b[ok] %s is available to Claude and Codex%b\n\n' "$GREEN" "$skill_name" "$RESET"
    else
      printf '%b[warn] %s installation failed; continuing%b\n\n' "$YELLOW" "$skill_name" "$RESET"
    fi
  done

  if [ -f "$HOME/.agents/skills/cloudflare-deploy/SKILL.md" ] \
    && [ -f "$HOME/.agents/skills/security-best-practices/SKILL.md" ] \
    && [ -f "$HOME/.agents/skills/security-threat-model/SKILL.md" ] \
    && [ -f "$HOME/.agents/skills/vercel-react-best-practices/SKILL.md" ] \
    && [ -f "$HOME/.agents/skills/vercel-composition-patterns/SKILL.md" ] \
    && [ -f "$HOME/.agents/skills/web-design-guidelines/SKILL.md" ]; then
    printf '%s\n' "$expected_manifest" > "$managed_manifest"
  fi
}

install_official_github_plugin() {
  local plugins_ref="11c74d6ba24d3a6d48f54a194cd00ef3beea18f9"
  local source_root="$HOME/.local/share/hive/official-plugins/openai-$plugins_ref"
  local marketplace_root="$HOME/.local/share/hive/codex-marketplaces/openai-official"
  local marketplace_name="hive-openai-official"
  local marketplace_list plugin_list

  if ! command_exists codex || ! command_exists git; then
    printf '%b[warn] Codex or Git is unavailable; GitHub plugin installation deferred%b\n' "$YELLOW" "$RESET"
    return 0
  fi

  if [ ! -f "$source_root/plugins/github/.codex-plugin/plugin.json" ]; then
    if ! checkout_pinned_repo "$source_root" https://github.com/openai/plugins.git "$plugins_ref" plugins/github; then
      printf '%b[warn] Official GitHub plugin checkout failed; continuing%b\n' "$YELLOW" "$RESET"
      return 0
    fi
  fi

  mkdir -p "$marketplace_root/.agents/plugins" "$marketplace_root/plugins"
  ln -sfn "$source_root/plugins/github" "$marketplace_root/plugins/github"
  cat > "$marketplace_root/.agents/plugins/marketplace.json" <<'JSON'
{
  "name": "hive-openai-official",
  "interface": {
    "displayName": "Hive pinned OpenAI plugins"
  },
  "plugins": [
    {
      "name": "github",
      "source": {
        "source": "local",
        "path": "./plugins/github"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Developer Tools"
    }
  ]
}
JSON

  marketplace_list="$(codex plugin marketplace list --json 2>/dev/null || true)"
  if printf '%s' "$marketplace_list" | jq -e --arg name "$marketplace_name" \
    '.marketplaces[]? | select(.name == $name)' >/dev/null 2>&1; then
    codex plugin marketplace upgrade "$marketplace_name" --json >/dev/null 2>&1 || true
  elif ! codex plugin marketplace add "$marketplace_root" --json >/dev/null 2>&1; then
    printf '%b[warn] Official GitHub plugin marketplace registration failed; continuing%b\n' "$YELLOW" "$RESET"
    return 0
  fi

  plugin_list="$(codex plugin list --json 2>/dev/null || true)"
  if printf '%s' "$plugin_list" | jq -e --arg id "github@$marketplace_name" \
    '.installed[]? | select(.pluginId == $id and .installed == true)' >/dev/null 2>&1; then
    printf '%b[ok] Official GitHub Codex plugin already installed%b\n' "$GREEN" "$RESET"
  elif timeout 60s codex plugin add "github@$marketplace_name" --json >/dev/null 2>&1; then
    printf '%b[ok] Official GitHub Codex plugin installed%b\n' "$GREEN" "$RESET"
  else
    printf '%b[warn] GitHub plugin authentication deferred; open /plugins in Codex to finish setup%b\n' "$YELLOW" "$RESET"
  fi
}

# Ensure PATH includes tool directories
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"
mkdir -p "$HOME/.local/bin"

# Force npm global installs into ~/.local (user-writable, already on PATH)
export npm_config_prefix="$HOME/.local"

repair_node_shims || true

# Keep verified persistent installs in place. New packages are installed with
# npm's own replacement handling, so a transient registry failure never starts
# by deleting working command shims.
if npm_global_has "@openai/codex" && command_exists codex; then
  printf '%b[ok] Codex CLI already installed%b\n' "$GREEN" "$RESET"
else
  run_step "Codex CLI" '
    npm install -g --force @openai/codex@latest
  '
fi

hash -r 2>/dev/null || true

codex_path="$(command -v codex 2>/dev/null || true)"

if [ "$codex_path" = "$HOME/.local/bin/codex" ] && npm_global_has "@openai/codex"; then
  printf "${GREEN}[ok] Codex CLI available: %s${RESET}\n" "$codex_path"
elif [ -n "$codex_path" ]; then
  printf "${YELLOW}[warn] codex is present but @openai/codex is not verified: %s${RESET}\n" "$codex_path"
else
  printf '%b[warn] codex was not found on PATH after installation%b\n' "$YELLOW" "$RESET"
fi

install_official_skills
install_official_github_plugin
