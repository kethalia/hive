#!/bin/bash
set -uo pipefail

repositories_file="${REPOSITORIES_FILE:-$HOME/repositories.txt}"
if [ ! -f "$repositories_file" ]; then
  printf '[error] repository manifest not found: %s\n' "$repositories_file" >&2
  exit 1
fi

if [ -z "${GH_TOKEN:-}" ] && command -v coder >/dev/null 2>&1; then
  external_auth_token=""
  if external_auth_token="$(coder external-auth access-token github)"; then
    GH_TOKEN="$external_auth_token"
    export GH_TOKEN
  fi
fi

if ! command -v gh >/dev/null 2>&1 || [ -z "${GH_TOKEN:-}" ]; then
  printf '[error] GitHub CLI or external-auth token is unavailable\n' >&2
  exit 1
fi

mkdir -p "$HOME/projects"
failures=()

normalize_github_repository() {
  local repository="$1"
  repository="${repository#https://github.com/}"
  repository="${repository#git@github.com:}"
  repository="${repository#ssh://git@github.com/}"
  repository="${repository%.git}"
  printf '%s\n' "$repository"
}

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

vault_repository_file="${VAULT_REPOSITORY_FILE:-$HOME/.config/hive/vault-repository}"
vault_repository="${VAULT_REPOSITORY:-}"
if [ -z "$vault_repository" ] && [ -f "$vault_repository_file" ]; then
  IFS= read -r vault_repository < "$vault_repository_file" || true
fi

if [ -n "$vault_repository" ]; then
  vault_ready=false
  if [ -d "$HOME/vault/.git" ]; then
    vault_origin="$(git -C "$HOME/vault" remote get-url origin 2>/dev/null || true)"
    if [ -z "$vault_origin" ]; then
      printf '[warn] vault checkout has no origin remote; refusing to update\n' >&2
      failures+=("$vault_repository (vault origin missing)")
    elif [ "$(normalize_github_repository "$vault_origin")" != "$(normalize_github_repository "$vault_repository")" ]; then
      printf '[warn] vault origin does not match configured repository; refusing to update\n' >&2
      failures+=("$vault_repository (vault origin mismatch)")
    else
      vault_branch="$(git -C "$HOME/vault" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
      if [ -z "$vault_branch" ]; then
        printf '[warn] vault checkout has no current branch; refusing to update\n' >&2
        failures+=("$vault_repository (vault branch missing)")
      elif git -C "$HOME/vault" pull --ff-only origin "$vault_branch"; then
        printf '[update] fast-forwarded vault checkout\n'
        vault_ready=true
      else
        printf '[warn] vault checkout is dirty or diverged; preserving local state\n' >&2
        failures+=("$vault_repository (vault update)")
      fi
    fi
  elif [ -d "$HOME/vault/.obsidian" ] && [ -z "$(find "$HOME/vault" -mindepth 1 -maxdepth 1 ! -name .obsidian -print -quit)" ]; then
    vault_clone_tmp="$(mktemp -d)"
    if gh repo clone "$vault_repository" "$vault_clone_tmp/repository"; then
      rm -rf "$vault_clone_tmp/repository/.obsidian"
      if cp -a "$vault_clone_tmp/repository/." "$HOME/vault/"; then
        vault_ready=true
      else
        failures+=("$vault_repository (vault copy)")
      fi
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
    if gh repo clone "$vault_repository" "$HOME/vault"; then
      vault_ready=true
    else
      failures+=("$vault_repository (vault)")
    fi
  fi

  if [ "$vault_ready" = true ] && [ -x "$HOME/sync-vault.sh" ]; then
    "$HOME/sync-vault.sh"
  fi
fi

if ((${#failures[@]} > 0)); then
  printf '[warn] failed to clone: %s\n' "${failures[*]}" >&2
  printf '[warn] verify GitHub external authentication, then rerun %s\n' "$HOME/clone-repositories.sh" >&2
  printf '[warn] repository bootstrap completed with %d failure(s)\n' "${#failures[@]}" >&2
else
  printf '[ok] repository bootstrap complete\n'
fi
