#!/bin/bash
set -uo pipefail

repositories_file="${REPOSITORIES_FILE:-$HOME/repositories.txt}"
expected_repository="prmsolutions/interview-template"
expected_destination="prmsolutions/interview-template"
destination="$HOME/projects/$expected_destination"

if [ ! -f "$repositories_file" ]; then
  printf '[error] repository manifest not found: %s\n' "$repositories_file" >&2
  exit 1
fi

manifest_entry="$(sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$repositories_file")"
if [ "$manifest_entry" != "$expected_repository|$expected_destination" ]; then
  printf '[error] interview repository manifest must contain only %s|%s\n' \
    "$expected_repository" "$expected_destination" >&2
  exit 1
fi

if [ -d "$destination/.git" ]; then
  printf '[skip] preserving existing interview repository: %s\n' "$destination"
  exit 0
fi
if [ -e "$destination" ] || [ -L "$destination" ]; then
  printf '[error] preserving unexpected destination: %s\n' "$destination" >&2
  exit 1
fi

mkdir -p "$(dirname "$destination")"
printf '[clone] %s\n' "$expected_repository"
if env \
  -u ANTHROPIC_API_KEY \
  -u GH_TOKEN \
  -u GITHUB_TOKEN \
  -u CODER_SESSION_TOKEN \
  -u REALM_VISUAL_REVIEW_API_KEY \
  -u RUNCOMFY_API_TOKEN \
  GIT_TERMINAL_PROMPT=0 \
  git -c credential.helper= clone \
    "https://github.com/$expected_repository.git" "$destination"; then
  printf '[ok] anonymous interview repository clone complete\n'
else
  printf '[error] public HTTPS clone failed; rerun ~/clone-repositories.sh\n' >&2
  exit 1
fi
