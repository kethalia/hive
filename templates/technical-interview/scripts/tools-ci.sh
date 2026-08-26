#!/bin/bash
# shellcheck disable=SC2154 # Values are populated by Terraform templatefile().
set -uo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RESET='\033[0m'

unset ANTHROPIC_API_KEY GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN
unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN

mkdir -p "$HOME/.local/bin" "$HOME/.local/libexec/hive" "$HOME/.local/state/hive/technical-interview"

# This credential belongs to an unrelated optional workspace integration. It
# must not survive inside the isolated interview home.
if [ -f "$HOME/.runcomfy-api-token" ]; then
  rm -f -- "$HOME/.runcomfy-api-token"
fi

printf '%s' "${clone_repositories_script_b64}" | base64 -d > "$HOME/clone-repositories.sh"
chmod 700 "$HOME/clone-repositories.sh"
printf '%s' "${repositories_manifest_b64}" | base64 -d > "$HOME/repositories.txt"
chmod 600 "$HOME/repositories.txt"
printf '%s' "${bootstrap_script_b64}" | base64 -d > "$HOME/.local/libexec/hive/interview-bootstrap"
chmod 700 "$HOME/.local/libexec/hive/interview-bootstrap"

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
