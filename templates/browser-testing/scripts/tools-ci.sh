#!/bin/bash
# shellcheck disable=SC2034,SC2154 # Variables are referenced or populated after Terraform rendering.
set -e

${git_config_retry_script}

BOLD='\033[0;1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RESET='\033[0m'

command_exists() {
  command -v "$1" &> /dev/null
}

install_if_missing() {
  local name=$1
  local check_cmd=$2
  local check_path=$3
  local install_cmd=$4

  if [ -n "$check_cmd" ] && command_exists "$check_cmd"; then
    printf '%b[ok] %s already installed%b\n' "$${GREEN}" "$name" "$${RESET}"
    return 0
  elif [ -n "$check_path" ] && [ -e "$check_path" ]; then
    printf '%b[ok] %s already installed%b\n' "$${GREEN}" "$name" "$${RESET}"
    return 0
  fi

  printf '%b[install] %s...%b\n' "$${BOLD}" "$name" "$${RESET}"
  if eval "$install_cmd"; then
    printf '%b[ok] %s installed successfully%b\n\n' "$${GREEN}" "$name" "$${RESET}"
  else
    printf '%b[warn] %s installation failed, continuing...%b\n\n' "$${YELLOW}" "$name" "$${RESET}"
  fi
}

# act is pinned and preinstalled in hive-base. Install GitHub CLI into the
# persistent home without requiring root or privilege escalation.
mkdir -p "$HOME/.local/bin" "$HOME/.local/libexec"
# shellcheck disable=SC2016 # The command is intentionally evaluated after Terraform rendering.
install_if_missing "GitHub CLI" "" "$HOME/.local/libexec/gh" '
  GH_VERSION=2.96.0 &&
  GH_ARCHIVE="gh_$${GH_VERSION}_linux_amd64.tar.gz" &&
  curl -fsSLo "/tmp/$${GH_ARCHIVE}" "https://github.com/cli/cli/releases/download/v$${GH_VERSION}/$${GH_ARCHIVE}" &&
  printf "%s  %s\n" "83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60" "/tmp/$${GH_ARCHIVE}" | sha256sum --check --status &&
  tar -xzf "/tmp/$${GH_ARCHIVE}" -C /tmp &&
  install -m 0755 "/tmp/gh_$${GH_VERSION}_linux_amd64/bin/gh" "$HOME/.local/libexec/gh" &&
  rm -rf "/tmp/$${GH_ARCHIVE}" "/tmp/gh_$${GH_VERSION}_linux_amd64"
'

# shellcheck disable=SC2154 # Values below are populated by Terraform templatefile().
printf '%s' "${github_cli_script_b64}" | base64 -d > "$HOME/.local/bin/gh"
chmod +x "$HOME/.local/bin/gh"
printf '%s' "${github_credential_script_b64}" | base64 -d > "$HOME/.local/bin/coder-github-credential"
chmod +x "$HOME/.local/bin/coder-github-credential"
configure_git_global --replace-all credential.https://github.com.helper "$HOME/.local/bin/coder-github-credential"

printf '%s' "${clone_repositories_script_b64}" | base64 -d > "$HOME/clone-repositories.sh"
chmod +x "$HOME/clone-repositories.sh"
# Seed once: local edits, including an intentionally empty manifest, are user-owned.
# Linking a private temporary file publishes it without replacing an existing file or symlink.
manifest_seed=$(mktemp "$HOME/.hive-repositories.XXXXXX")
printf '%s' "${repositories_manifest_b64}" | base64 -d > "$manifest_seed"
chmod 600 "$manifest_seed"
if ln "$manifest_seed" "$HOME/repositories.txt" 2>/dev/null; then
  printf '[ok] seeded repository manifest\n'
elif [ -e "$HOME/repositories.txt" ] || [ -L "$HOME/repositories.txt" ]; then
  printf '[ok] preserving local repository manifest\n'
else
  rm -f -- "$manifest_seed"
  printf '[error] could not seed repository manifest\n' >&2
  exit 1
fi
rm -f -- "$manifest_seed"

worktree_helper=$(mktemp "$HOME/.local/bin/.hive-worktree.XXXXXX")
printf '%s' "${worktree_lifecycle_script_b64}" | base64 -d > "$worktree_helper"
chmod 755 "$worktree_helper"
mv -fT -- "$worktree_helper" "$HOME/.local/bin/hive-worktree"
export GH_TOKEN="${github_token}"
"$HOME/clone-repositories.sh"
