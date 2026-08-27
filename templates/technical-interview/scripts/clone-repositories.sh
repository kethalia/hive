#!/bin/bash
set -uo pipefail
umask 077

unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
unset OPENAI_API_KEY OPENAI_API_TOKEN CODEX_API_KEY
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
unset CLAUDE_CONFIG_DIR CLAUDE_SECURESTORAGE_CONFIG_DIR
unset NPM_TOKEN NODE_AUTH_TOKEN NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG
unset npm_config_userconfig npm_config_globalconfig
unset PIP_CONFIG_FILE PIP_INDEX_URL PIP_EXTRA_INDEX_URL PIP_TRUSTED_HOST
unset PIP_CERT PIP_CLIENT_CERT PIP_KEYRING_PROVIDER PIP_PROXY
unset GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN
unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE
unset AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE AWS_WEB_IDENTITY_TOKEN_FILE
unset GOOGLE_APPLICATION_CREDENTIALS CLOUDSDK_AUTH_ACCESS_TOKEN
unset AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TENANT_ID
unset ARM_CLIENT_ID ARM_CLIENT_SECRET ARM_TENANT_ID ARM_SUBSCRIPTION_ID
unset KUBECONFIG

INTERVIEW_TRUSTED_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH="$INTERVIEW_TRUSTED_PATH"

repositories_file="${REPOSITORIES_FILE:-$HOME/repositories.txt}"
expected_repository="prmsolutions/interview-template"
expected_destination="prmsolutions/interview-template"
expected_origin="https://github.com/$expected_repository.git"
destination="$HOME/projects/$expected_destination"
destination_parent="$HOME/projects/prmsolutions"
state_directory="$HOME/.local/state/hive/technical-interview"
git_binary="${INTERVIEW_GIT_BIN:-/usr/bin/git}"

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
  remainder="${target#"$HOME"/}"
  while [ -n "$remainder" ]; do
    component="${remainder%%/*}"
    if [ "$component" = "$remainder" ]; then
      remainder=""
    else
      remainder="${remainder#*/}"
    fi
    current="$current/$component"
    if [ -L "$current" ] || { [ -e "$current" ] && [ ! -d "$current" ]; }; then
      printf '[error] unsafe interview directory was preserved: %s\n' "$current" >&2
      return 1
    fi
    [ -d "$current" ] || mkdir -- "$current" || return 1
  done
}

anonymous_git() {
  local anonymous_home status

  ensure_interview_local_directory "$state_directory" || return 1
  chmod 700 "$state_directory"
  anonymous_home="$(mktemp -d "$state_directory/.anonymous-git.XXXXXX")" || return 1
  chmod 700 "$anonymous_home"
  if (
    cd "$anonymous_home"
    env \
      -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
      -u CLAUDE_CODE_OAUTH_TOKEN -u CLAUDE_CODE_OAUTH_REFRESH_TOKEN \
      -u CLAUDE_CODE_OAUTH_SCOPES \
      -u CLAUDE_CONFIG_DIR -u CLAUDE_SECURESTORAGE_CONFIG_DIR \
      -u NPM_TOKEN -u NODE_AUTH_TOKEN \
      -u NPM_CONFIG_USERCONFIG -u NPM_CONFIG_GLOBALCONFIG \
      -u npm_config_userconfig -u npm_config_globalconfig \
      -u GH_TOKEN -u GITHUB_TOKEN \
      -u CODER_AGENT_TOKEN -u CODER_SESSION_TOKEN \
      -u REALM_VISUAL_REVIEW_API_KEY -u RUNCOMFY_API_TOKEN \
      -u GIT_CONFIG -u GIT_CONFIG_COUNT -u GIT_CONFIG_PARAMETERS \
      -u GIT_CONFIG_SYSTEM -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR \
      -u GIT_TEMPLATE_DIR -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY \
      -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_NAMESPACE \
      -u GIT_PROXY_COMMAND -u GIT_SSH -u GIT_SSH_VARIANT \
      -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
      -u http_proxy -u https_proxy -u all_proxy -u NO_PROXY -u no_proxy \
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
      "$git_binary" -c credential.helper= "$@"
  ); then
    status=0
  else
    status=$?
  fi
  rm -rf -- "$anonymous_home"
  return "$status"
}

validate_checkout() {
  local checkout=$1 origin git_directory git_config

  git_directory="$checkout/.git"
  git_config="$git_directory/config"
  [ -d "$git_directory" ] && [ ! -L "$git_directory" ] || return 1
  [ -f "$git_config" ] && [ ! -L "$git_config" ] || return 1
  if anonymous_git config --file "$git_config" --no-includes --name-only --get-regexp \
    '^(credential($|\.)|http\..*(extraheader|proxy|cookiefile|savecookies|sslcert|sslkey)$|core\.(attributesfile|fsmonitor|gitproxy|sshcommand)$|filter\..*\.(clean|process|smudge)$|diff\..*\.(command|textconv)$|remote\..*\.proxy$|url\..*\.insteadof$|include($|\.)|includeif\.)' \
    >/dev/null 2>&1; then
    return 1
  fi
  [ "$(
    anonymous_git -c core.fsmonitor=false -c core.hooksPath=/dev/null \
      -C "$checkout" rev-parse --is-inside-work-tree 2>/dev/null
  )" = true ] \
    || return 1
  origin="$(
    anonymous_git config --file "$git_config" --no-includes --get remote.origin.url 2>/dev/null
  )" || return 1
  [ "$origin" = "$expected_origin" ] || return 1
  anonymous_git -c core.fsmonitor=false -c core.hooksPath=/dev/null \
    -C "$checkout" rev-parse --verify 'HEAD^{commit}' >/dev/null 2>&1
}

if [ ! -x "$git_binary" ]; then
  printf '[error] trusted Git executable is unavailable: %s\n' "$git_binary" >&2
  exit 1
fi

if [ -L "$repositories_file" ] || [ ! -f "$repositories_file" ]; then
  printf '[error] repository manifest not found: %s\n' "$repositories_file" >&2
  exit 1
fi

manifest_entry="$(sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$repositories_file")"
if [ "$manifest_entry" != "$expected_repository|$expected_destination" ]; then
  printf '[error] interview repository manifest must contain only %s|%s\n' \
    "$expected_repository" "$expected_destination" >&2
  exit 1
fi

if ! ensure_interview_local_directory "$destination_parent"; then
  printf '[error] repository parent directory is unsafe; clone was not attempted\n' >&2
  exit 1
fi

if [ -L "$destination" ]; then
  printf '[error] preserving linked interview repository destination: %s\n' "$destination" >&2
  exit 1
fi
if [ -e "$destination" ]; then
  if validate_checkout "$destination"; then
    printf '[skip] preserving existing interview repository: %s\n' "$destination"
    exit 0
  fi
  printf '[error] preserving incomplete or invalid interview repository: %s\n' \
    "$destination" >&2
  exit 1
fi

temporary_destination="$(mktemp -d "$destination_parent/.interview-template.clone.XXXXXX")" \
  || exit 1
cleanup_clone() {
  [ -z "$temporary_destination" ] || rm -rf -- "$temporary_destination"
}
trap cleanup_clone EXIT
trap 'cleanup_clone; exit 1' HUP INT TERM

printf '[clone] %s\n' "$expected_repository"
if ! anonymous_git clone "$expected_origin" "$temporary_destination"; then
  printf '[error] public HTTPS clone failed; rerun ~/clone-repositories.sh\n' >&2
  exit 1
fi
if ! validate_checkout "$temporary_destination"; then
  printf '[error] cloned repository failed validation; destination was not installed\n' >&2
  exit 1
fi
if [ -e "$destination" ] || [ -L "$destination" ]; then
  printf '[error] preserving destination created while the clone was in progress: %s\n' \
    "$destination" >&2
  exit 1
fi
if ! mv -T -- "$temporary_destination" "$destination"; then
  printf '[error] validated clone could not be installed at %s\n' "$destination" >&2
  exit 1
fi
temporary_destination=""
printf '[ok] anonymous interview repository clone complete\n'
