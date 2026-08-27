#!/bin/bash
# shellcheck disable=SC2154 # Values are populated by Terraform templatefile().
set -uo pipefail
umask 077

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RESET='\033[0m'

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
unset BASH_ENV ENV CDPATH LD_LIBRARY_PATH LD_PRELOAD
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
unset OPENAI_API_KEY OPENAI_API_TOKEN CODEX_API_KEY
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
unset CLAUDE_CONFIG_DIR CLAUDE_SECURESTORAGE_CONFIG_DIR
unset NPM_TOKEN NODE_AUTH_TOKEN NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG
unset npm_config_userconfig npm_config_globalconfig
unset PIP_CONFIG_FILE PIP_INDEX_URL PIP_EXTRA_INDEX_URL PIP_TRUSTED_HOST
unset PIP_CERT PIP_CLIENT_CERT PIP_KEYRING_PROVIDER PIP_PROXY
unset GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN
unset GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_PROXY_COMMAND GIT_SSH
unset SSH_AUTH_SOCK SSH_AGENT_PID SSH_ASKPASS_REQUIRE
unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE
unset AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE AWS_WEB_IDENTITY_TOKEN_FILE
unset GOOGLE_APPLICATION_CREDENTIALS CLOUDSDK_AUTH_ACCESS_TOKEN
unset AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TENANT_ID
unset ARM_CLIENT_ID ARM_CLIENT_SECRET ARM_TENANT_ID ARM_SUBSCRIPTION_ID
unset KUBECONFIG
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_ASKPASS=/bin/false
export GIT_SSH_COMMAND=/bin/false
export GIT_TERMINAL_PROMPT=0
export SSH_ASKPASS=/bin/false

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
  local encoded=$1 destination=$2 mode=$3 encoding=$4 destination_directory temporary_file

  destination_directory="$(dirname -- "$destination")"
  ensure_interview_local_directory "$destination_directory" || return 1
  temporary_file="$(mktemp "$destination_directory/.hive-interview-input.XXXXXX")" || return 1
  case "$encoding" in
    base64)
      if ! printf '%s' "$encoded" | base64 -d > "$temporary_file"; then
        rm -f -- "$temporary_file"
        return 1
      fi
      ;;
    base64gzip)
      # Keep the rendered coder_script comfortably below Linux's per-argument
      # exec limit as the standalone bootstrap grows.
      if ! printf '%s' "$encoded" | base64 -d | gzip -d > "$temporary_file"; then
        rm -f -- "$temporary_file"
        return 1
      fi
      ;;
    *)
      rm -f -- "$temporary_file"
      return 1
      ;;
  esac
  if ! chmod "$mode" "$temporary_file" \
    || ! mv -fT -- "$temporary_file" "$destination"; then
    rm -f -- "$temporary_file"
    return 1
  fi
}

inputs_ready=true
write_embedded_file "${clone_repositories_script_b64}" "$HOME/clone-repositories.sh" 700 base64 \
  || inputs_ready=false
write_embedded_file "${repositories_manifest_b64}" "$HOME/repositories.txt" 600 base64 \
  || inputs_ready=false
write_embedded_file "${bootstrap_script_b64gzip}" \
  "$HOME/.local/libexec/hive/interview-bootstrap" 700 base64gzip \
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
