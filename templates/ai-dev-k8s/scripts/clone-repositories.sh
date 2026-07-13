#!/bin/bash
set -uo pipefail

repositories_file="${REPOSITORIES_FILE:-$HOME/repositories.txt}"
if [ ! -f "$repositories_file" ]; then
  printf '[error] repository manifest not found: %s\n' "$repositories_file" >&2
  exit 1
fi

if [ -z "${GH_TOKEN:-}" ] && command -v coder >/dev/null 2>&1; then
  GH_TOKEN="$(coder external-auth access-token github)" || true
  export GH_TOKEN
fi

if ! command -v gh >/dev/null 2>&1 || [ -z "${GH_TOKEN:-}" ]; then
  printf '[error] GitHub CLI or external-auth token is unavailable\n' >&2
  exit 1
fi

mkdir -p "$HOME/projects"
failures=()

while IFS= read -r entry || [ -n "$entry" ]; do
  [ -n "$entry" ] || continue
  case "$entry" in
    \#*) continue ;;
  esac

  if [[ "$entry" != *"|"* ]]; then
    printf '[warn] invalid repository manifest entry: %s\n' "$entry" >&2
    failures+=("$entry")
    continue
  fi

  repository="${entry%%|*}"
  relative_destination="${entry#*|}"
  destination="$HOME/projects/$relative_destination"
  if [ -d "$destination/.git" ]; then
    printf '[skip] %s already exists\n' "$repository"
    continue
  fi

  mkdir -p "$(dirname "$destination")"
  printf '[clone] %s\n' "$repository"
  if ! gh repo clone "$repository" "$destination"; then
    failures+=("$repository")
  fi
done < "$repositories_file"

vault_repository="${VAULT_REPOSITORY:-}"
if [ -n "$vault_repository" ]; then
  if [ -d "$HOME/vault/.git" ]; then
    printf '[skip] vault checkout already exists; preserving local changes\n'
    git -C "$HOME/vault" fetch --prune || failures+=("$vault_repository (vault fetch)")
  elif [ -d "$HOME/vault/.obsidian" ] && [ -z "$(find "$HOME/vault" -mindepth 1 -maxdepth 1 ! -name .obsidian -print -quit)" ]; then
    vault_clone_tmp="$(mktemp -d)"
    if gh repo clone "$vault_repository" "$vault_clone_tmp/repository"; then
      rm -rf "$vault_clone_tmp/repository/.obsidian"
      cp -a "$vault_clone_tmp/repository/." "$HOME/vault/" || failures+=("$vault_repository (vault copy)")
    else
      failures+=("$vault_repository (vault)")
    fi
    rm -rf "$vault_clone_tmp"
  elif [ -e "$HOME/vault" ] && [ -n "$(find "$HOME/vault" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    printf '[warn] refusing to overwrite non-empty non-Git vault directory\n' >&2
    failures+=("$vault_repository (vault destination occupied)")
  else
    mkdir -p "$HOME/vault"
    rmdir "$HOME/vault" 2>/dev/null || true
    gh repo clone "$vault_repository" "$HOME/vault" || failures+=("$vault_repository (vault)")
  fi

  if [ -x "$HOME/sync-vault.sh" ] && [ -d "$HOME/vault/.git" ]; then
    "$HOME/sync-vault.sh"
  fi
fi

if ((${#failures[@]} > 0)); then
  printf '[warn] failed to clone: %s\n' "${failures[*]}" >&2
  printf '[warn] verify GitHub external authentication, then rerun %s\n' "$HOME/clone-repositories.sh" >&2
  exit 1
fi

printf '[ok] repository bootstrap complete\n'
