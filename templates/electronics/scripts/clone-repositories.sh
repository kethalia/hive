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

if ((${#failures[@]} > 0)); then
  printf '[warn] failed to clone: %s\n' "${failures[*]}" >&2
  printf '[warn] verify GitHub external authentication, then rerun %s\n' "$HOME/clone-repositories.sh" >&2
  printf '[warn] repository bootstrap completed with %d failure(s)\n' "${#failures[@]}" >&2
else
  printf '[ok] repository bootstrap complete\n'
fi
