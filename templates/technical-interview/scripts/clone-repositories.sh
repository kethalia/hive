#!/bin/bash
set -uo pipefail

repositories_file="${REPOSITORIES_FILE:-$HOME/repositories.txt}"
expected_repository="prmsolutions/interview-template"
expected_destination="prmsolutions/interview-template"
destination="$HOME/projects/$expected_destination"
state_directory="$HOME/.local/state/hive/technical-interview"

anonymous_git() {
  local anonymous_home status

  mkdir -p "$state_directory"
  chmod 700 "$state_directory"
  anonymous_home="$(mktemp -d "$state_directory/.anonymous-git.XXXXXX")" || return 1
  chmod 700 "$anonymous_home"
  if (
    cd "$anonymous_home"
    env \
      -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
      -u CLAUDE_CODE_OAUTH_TOKEN -u CLAUDE_CODE_OAUTH_REFRESH_TOKEN \
      -u CLAUDE_CODE_OAUTH_SCOPES -u GH_TOKEN -u GITHUB_TOKEN \
      -u CODER_AGENT_TOKEN -u CODER_SESSION_TOKEN \
      -u REALM_VISUAL_REVIEW_API_KEY -u RUNCOMFY_API_TOKEN \
      -u GIT_CONFIG -u GIT_CONFIG_COUNT -u GIT_CONFIG_PARAMETERS \
      -u GIT_CONFIG_SYSTEM -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR \
      -u GIT_PROXY_COMMAND -u GIT_SSH -u GIT_SSH_VARIANT \
      -u SSH_AUTH_SOCK -u SSH_AGENT_PID -u SSH_ASKPASS_REQUIRE \
      HOME="$anonymous_home" \
      XDG_CONFIG_HOME="$anonymous_home/.config" \
      GIT_CONFIG_GLOBAL=/dev/null \
      GIT_CONFIG_NOSYSTEM=1 \
      GIT_CEILING_DIRECTORIES="$anonymous_home" \
      GIT_ASKPASS=/bin/false \
      GIT_SSH_COMMAND=/bin/false \
      GIT_TERMINAL_PROMPT=0 \
      SSH_ASKPASS=/bin/false \
      git -c credential.helper= "$@"
  ); then
    status=0
  else
    status=$?
  fi
  rm -rf -- "$anonymous_home"
  return "$status"
}

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
if anonymous_git clone "https://github.com/$expected_repository.git" "$destination"; then
  printf '[ok] anonymous interview repository clone complete\n'
else
  printf '[error] public HTTPS clone failed; rerun ~/clone-repositories.sh\n' >&2
  exit 1
fi
