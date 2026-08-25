#!/bin/bash
set -uo pipefail

repositories_file="${REPOSITORIES_FILE:-$HOME/repositories.txt}"
github_auth_enabled="${HIVE_GITHUB_AUTH_ENABLED:-true}"
if [ ! -f "$repositories_file" ]; then
  printf '[error] repository manifest not found: %s\n' "$repositories_file" >&2
  exit 1
fi

case "$github_auth_enabled" in
  true)
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
    ;;
  false)
    unset GH_TOKEN GITHUB_TOKEN
    if ! command -v git >/dev/null 2>&1; then
      printf '[error] Git is unavailable for anonymous repository cloning\n' >&2
      exit 1
    fi
    ;;
  *)
    printf '[error] HIVE_GITHUB_AUTH_ENABLED must be true or false\n' >&2
    exit 1
    ;;
esac

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
  if [[ ! "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
    || [[ ! "$relative_destination" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    printf '[warn] unsafe repository manifest entry: %s\n' "$entry" >&2
    failures+=("$entry")
    continue
  fi
  destination="$HOME/projects/$relative_destination"
  if [ -d "$destination/.git" ]; then
    printf '[skip] %s already exists\n' "$repository"
    continue
  fi
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    printf '[warn] preserving unexpected destination: %s\n' "$destination" >&2
    failures+=("$repository")
    continue
  fi

  mkdir -p "$(dirname "$destination")"
  printf '[clone] %s\n' "$repository"
  if [ "$github_auth_enabled" = "true" ]; then
    clone_command=(gh repo clone "$repository" "$destination")
  else
    clone_command=(env -u GH_TOKEN -u GITHUB_TOKEN GIT_TERMINAL_PROMPT=0 git -c credential.helper= clone "https://github.com/$repository.git" "$destination")
  fi
  if ! "${clone_command[@]}"; then
    failures+=("$repository")
  fi
done < "$repositories_file"

if ((${#failures[@]} > 0)); then
  printf '[warn] failed to clone: %s\n' "${failures[*]}" >&2
  if [ "$github_auth_enabled" = "true" ]; then
    printf '[warn] verify GitHub external authentication, then rerun %s\n' "$HOME/clone-repositories.sh" >&2
  else
    printf '[warn] verify public HTTPS access, then rerun %s\n' "$HOME/clone-repositories.sh" >&2
  fi
  printf '[warn] repository bootstrap completed with %d failure(s)\n' "${#failures[@]}" >&2
else
  printf '[ok] repository bootstrap complete\n'
fi
