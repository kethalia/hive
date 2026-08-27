#!/bin/bash
# shellcheck disable=SC2154 # Values are populated by Terraform templatefile().
set -uo pipefail
umask 077

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RESET='\033[0m'

unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
unset GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN
unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN

ensure_interview_local_directory() {
  local target=$1 current remainder component

  if [ -L "$HOME" ] || [ ! -d "$HOME" ]; then
    printf '[error] interview home is not a local directory: %s\n' "$HOME" >&2
    return 1
  fi
  case "$target" in
    "$HOME") return 0 ;;
    "$HOME"/*) ;;
    *)
      printf '[error] refusing to prepare a directory outside the interview home: %s\n' \
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
      printf '[error] unsafe interview directory was preserved: %s\n' "$current" >&2
      return 1
    fi
    [ -d "$current" ] || mkdir -- "$current" || return 1
  done
}

directories_ready=true
ensure_interview_local_directory "$HOME/.local/bin" || directories_ready=false
ensure_interview_local_directory "$HOME/.local/libexec/hive" || directories_ready=false
ensure_interview_local_directory "$HOME/.local/state/hive/technical-interview" \
  || directories_ready=false
if [ "$directories_ready" != true ]; then
  printf '%b[warn] Interview managed directories are unsafe; no generated input was written.%b\n' \
    "$YELLOW" "$RESET" >&2
  exit 0
fi

# This credential belongs to an unrelated optional workspace integration. It
# must not survive inside the isolated interview home.
if [ -f "$HOME/.runcomfy-api-token" ]; then
  rm -f -- "$HOME/.runcomfy-api-token"
fi

write_embedded_file() {
  local encoded=$1 destination=$2 mode=$3 destination_directory temporary_file

  destination_directory="$(dirname -- "$destination")"
  ensure_interview_local_directory "$destination_directory" || return 1
  temporary_file="$(mktemp "$destination_directory/.hive-interview-input.XXXXXX")" || return 1
  if ! printf '%s' "$encoded" | base64 -d > "$temporary_file"; then
    rm -f -- "$temporary_file"
    return 1
  fi
  if ! chmod "$mode" "$temporary_file" \
    || ! mv -fT -- "$temporary_file" "$destination"; then
    rm -f -- "$temporary_file"
    return 1
  fi
}

inputs_ready=true
write_embedded_file "${clone_repositories_script_b64}" "$HOME/clone-repositories.sh" 700 \
  || inputs_ready=false
write_embedded_file "${repositories_manifest_b64}" "$HOME/repositories.txt" 600 \
  || inputs_ready=false
write_embedded_file "${bootstrap_script_b64}" \
  "$HOME/.local/libexec/hive/interview-bootstrap" 700 \
  || inputs_ready=false

if [ "$inputs_ready" != true ]; then
  printf '%b[warn] Interview setup inputs could not be installed safely; no generated input was executed.%b\n' \
    "$YELLOW" "$RESET" >&2
  exit 0
fi

if ! "$HOME/clone-repositories.sh"; then
  printf '%b[warn] Interview repository clone failed; candidate files were not modified.%b\n' \
    "$YELLOW" "$RESET" >&2
fi

if "$HOME/.local/libexec/hive/interview-bootstrap"; then
  printf '%b[ok] Interview workspace bootstrap complete%b\n' "$GREEN" "$RESET"
else
  printf '%b[warn] Interview setup needs attention; run interview-check for details.%b\n' \
    "$YELLOW" "$RESET" >&2
fi

# Keep the Coder terminal available even when setup or application health fails.
exit 0
