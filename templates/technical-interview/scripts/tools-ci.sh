#!/bin/bash
# shellcheck disable=SC2034,SC2154 # Variables are referenced or populated after Terraform rendering.
set -e

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

# act is pinned and preinstalled in hive-base. Authenticated profiles install
# GitHub CLI into the persistent home without requiring root or privilege
# escalation. Anonymous profiles do not install Hive's token wrapper or
# credential helper.
mkdir -p "$HOME/.local/bin" "$HOME/.local/libexec/hive"
github_auth_enabled="${github_auth_enabled}"

install_hive_managed_script() {
  local destination=$1
  local marker=$2
  local legacy_sha=$3
  local payload=$4
  local mode=$5
  local actual_sha temporary_file

  if [ -e "$destination" ] || [ -L "$destination" ]; then
    actual_sha="$(sha256sum "$destination" 2>/dev/null | awk '{print $1}')"
    if [ "$(sed -n '2p' "$destination" 2>/dev/null || true)" != "$marker" ] \
      && [ "$actual_sha" != "$legacy_sha" ]; then
      printf '%b[warn] Preserving user-owned helper: %s%b\n' \
        "$${YELLOW}" "$destination" "$${RESET}" >&2
      return 1
    fi
  fi

  temporary_file="$(mktemp "$(dirname "$destination")/.hive-managed.XXXXXX")"
  if ! printf '%s' "$payload" | base64 -d > "$temporary_file"; then
    rm -f -- "$temporary_file"
    return 1
  fi
  chmod "$mode" "$temporary_file"
  if ! mv -fT -- "$temporary_file" "$destination"; then
    rm -f -- "$temporary_file"
    return 1
  fi
}

if [ "$github_auth_enabled" = "true" ]; then
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
  install_hive_managed_script \
    "$HOME/.local/bin/gh" \
    "# hive-managed-github-cli:v1" \
    "20048726c1588e66333d4edebb3f9c6c39c5bd12b60d0151b71afba484ca9284" \
    "${github_cli_script_b64}" \
    755 || true
  hive_credential_available=false
  if install_hive_managed_script \
    "$HOME/.local/bin/coder-github-credential" \
    "# hive-managed-github-credential:v1" \
    "b0c26c7d5e1a060e772e98b58f6fd969b6b9ce53b9a3078c4cc48b3c5db5a714" \
    "${github_credential_script_b64}" \
    755; then
    hive_credential_available=true
  fi

  # Preserve user-owned helpers and append Hive's helper only when it is not
  # already configured. Never replace or remove another helper.
  if [ "$hive_credential_available" = "true" ] \
    && ! git config --global --get-all credential.https://github.com.helper 2>/dev/null \
      | grep -Fqx -- "$HOME/.local/bin/coder-github-credential"; then
    git config --global --add credential.https://github.com.helper "$HOME/.local/bin/coder-github-credential"
  fi
fi

printf '%s' "${clone_repositories_script_b64}" | base64 -d > "$HOME/clone-repositories.sh"
chmod +x "$HOME/clone-repositories.sh"
printf '%s' "${repositories_manifest_b64}" | base64 -d > "$HOME/repositories.txt"
chmod 600 "$HOME/repositories.txt"
export HIVE_GITHUB_AUTH_ENABLED="$github_auth_enabled"
if [ "$github_auth_enabled" = "true" ]; then
  export GH_TOKEN="${github_token}"
else
  unset GH_TOKEN GITHUB_TOKEN
fi
"$HOME/clone-repositories.sh"

# Optional profile-owned bootstrap hooks always run after repository cloning.
# The hook lives outside scripts/ so scaffold synchronization preserves the
# profile-specific implementation.
if [ -n "${profile_bootstrap_script_b64}" ]; then
  profile_bootstrap="$HOME/.local/libexec/hive/profile-bootstrap"
  printf '%s' "${profile_bootstrap_script_b64}" | base64 -d > "$profile_bootstrap"
  chmod 700 "$profile_bootstrap"
  if ! "$profile_bootstrap"; then
    printf '%b[warn] Profile bootstrap failed; inspect its output and rerun the profile helper%b\n' \
      "$${YELLOW}" "$${RESET}" >&2
  fi
fi
