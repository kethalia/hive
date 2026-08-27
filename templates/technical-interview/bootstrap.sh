#!/bin/bash
set -euo pipefail

umask 077

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
unset BASH_ENV ENV CDPATH LD_LIBRARY_PATH LD_PRELOAD
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
unset CLAUDE_CONFIG_DIR CLAUDE_SECURESTORAGE_CONFIG_DIR
unset NPM_TOKEN NODE_AUTH_TOKEN
unset NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG
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

interview_bin_dir="$HOME/.local/bin"
interview_libexec_dir="$HOME/.local/libexec/hive/technical-interview"
interview_state_dir="$HOME/.local/state/hive/technical-interview"
interview_ripgrep_version="1.18.0"
interview_codex_version="0.149.1"
interview_playwright_mcp_version="0.0.79"
interview_bun_version="1.4.0"
interview_pnpm_version="10.32.1"

interview_ensure_local_directory() {
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

interview_ensure_local_directory "$interview_bin_dir"
interview_ensure_local_directory "$interview_libexec_dir"
interview_ensure_local_directory "$interview_state_dir"
chmod 700 "$interview_bin_dir" "$interview_libexec_dir" "$interview_state_dir"

install_interview_file() {
  local destination=$1
  local mode=$2
  local destination_directory temporary_file

  destination_directory="$(dirname -- "$destination")"
  interview_ensure_local_directory "$destination_directory" || return 1
  temporary_file="$(mktemp "$destination_directory/.hive-interview.XXXXXX")"
  if ! command cat > "$temporary_file"; then
    rm -f -- "$temporary_file"
    return 1
  fi
  chmod "$mode" "$temporary_file"
  if ! mv -fT -- "$temporary_file" "$destination"; then
    rm -f -- "$temporary_file"
    return 1
  fi
}

install_interview_symlink() {
  local destination=$1 target=$2
  local destination_directory staging_directory staged_link

  destination_directory="$(dirname -- "$destination")"
  interview_ensure_local_directory "$destination_directory" || return 1
  staging_directory="$(mktemp -d "$destination_directory/.hive-interview-link.XXXXXX")"
  staged_link="$staging_directory/$(basename -- "$destination")"
  ln -s -- "$target" "$staged_link"
  if ! mv -fT -- "$staged_link" "$destination"; then
    rm -f -- "$staged_link"
    rmdir -- "$staging_directory"
    return 1
  fi
  rmdir -- "$staging_directory"
}

install_interview_file "$interview_bin_dir/interview-claude" 700 <<'CLAUDEHANDOFFEOF'
#!/bin/bash
# hive-managed-interview-claude-handoff:v1
set -eu

exec /opt/hive-interview-tools/interview-claude \
  --client /run/hive-interview-launch/claude.sock -- "$@"
CLAUDEHANDOFFEOF

install_interview_file "$interview_libexec_dir/common.sh" 600 <<'COMMONEOF'
#!/bin/bash

INTERVIEW_TRUSTED_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH="$INTERVIEW_TRUSTED_PATH"

INTERVIEW_REPOSITORY="$HOME/projects/prmsolutions/interview-template"
INTERVIEW_EXPECTED_ORIGIN="https://github.com/prmsolutions/interview-template.git"
INTERVIEW_BACKEND="$INTERVIEW_REPOSITORY/backend"
INTERVIEW_FRONTEND="$INTERVIEW_REPOSITORY/frontend"
INTERVIEW_VENV="$INTERVIEW_BACKEND/.venv"
INTERVIEW_STATE_DIR="$HOME/.local/state/hive/technical-interview"
INTERVIEW_REPORT="$HOME/INTERVIEW_READY.md"
INTERVIEW_SESSION="interview"
INTERVIEW_VIRTUALENV_VERSION="20.35.4"
INTERVIEW_CODEX_VERSION="0.149.1"
INTERVIEW_PLAYWRIGHT_MCP_VERSION="0.0.79"
INTERVIEW_BUN_VERSION="1.4.0"
INTERVIEW_PNPM_VERSION="10.32.1"
INTERVIEW_RIPGREP_VERSION="1.18.0"
INTERVIEW_CODEX_BASELINE_TARGET="../lib/node_modules/@openai/codex/bin/codex.js"
INTERVIEW_BUN_BASELINE_TARGET="$HOME/.bun/bin/bun"
INTERVIEW_CLAUDE_BIN="/opt/hive-interview-tools/claude"
INTERVIEW_CLAUDE_LAUNCHER="/opt/hive-interview-tools/interview-claude"
INTERVIEW_CLAUDE_GUARD="/opt/hive-interview-tools/claude-guard.so"
INTERVIEW_CLAUDE_STATUS="/run/hive-interview-claude/ready"
INTERVIEW_CHROME_BIN="/usr/bin/google-chrome-stable"
INTERVIEW_CODEX_BIN="$HOME/.local/bin/codex"
INTERVIEW_PLAYWRIGHT_MCP_BIN="$HOME/.local/bin/playwright-mcp"
INTERVIEW_BUN_BIN="$HOME/.local/bin/bun"
INTERVIEW_PNPM_BIN="$HOME/.local/bin/pnpm"
INTERVIEW_SQLITE_BIN="$(command -v sqlite3 2>/dev/null || printf '%s' "$HOME/.local/bin/sqlite3")"
INTERVIEW_RG_BIN="$(command -v rg 2>/dev/null || printf '%s' "$HOME/.local/bin/rg")"
INTERVIEW_FORBIDDEN_CREDENTIALS=(
  ANTHROPIC_API_KEY
  ANTHROPIC_AUTH_TOKEN
  CLAUDE_CODE_OAUTH_TOKEN
  CLAUDE_CODE_OAUTH_REFRESH_TOKEN
  CLAUDE_CODE_OAUTH_SCOPES
  CLAUDE_CONFIG_DIR
  CLAUDE_SECURESTORAGE_CONFIG_DIR
  NPM_TOKEN
  NODE_AUTH_TOKEN
  NPM_CONFIG_USERCONFIG
  NPM_CONFIG_GLOBALCONFIG
  npm_config_userconfig
  npm_config_globalconfig
  PIP_CONFIG_FILE
  PIP_INDEX_URL
  PIP_EXTRA_INDEX_URL
  PIP_TRUSTED_HOST
  PIP_CERT
  PIP_CLIENT_CERT
  PIP_KEYRING_PROVIDER
  PIP_PROXY
  GH_TOKEN
  GITHUB_TOKEN
  CODER_AGENT_TOKEN
  CODER_SESSION_TOKEN
  GIT_CONFIG
  GIT_CONFIG_COUNT
  GIT_CONFIG_PARAMETERS
  GIT_PROXY_COMMAND
  GIT_SSH
  SSH_AUTH_SOCK
  SSH_AGENT_PID
  SSH_ASKPASS_REQUIRE
  REALM_VISUAL_REVIEW_API_KEY
  RUNCOMFY_API_TOKEN
  AWS_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY
  AWS_SESSION_TOKEN
  AWS_PROFILE
  AWS_CONFIG_FILE
  AWS_SHARED_CREDENTIALS_FILE
  AWS_WEB_IDENTITY_TOKEN_FILE
  GOOGLE_APPLICATION_CREDENTIALS
  CLOUDSDK_AUTH_ACCESS_TOKEN
  AZURE_CLIENT_ID
  AZURE_CLIENT_SECRET
  AZURE_TENANT_ID
  ARM_CLIENT_ID
  ARM_CLIENT_SECRET
  ARM_TENANT_ID
  ARM_SUBSCRIPTION_ID
  KUBECONFIG
)

interview_ensure_local_directory() {
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

interview_local_directory_chain_ready() {
  local target=$1 current remainder component

  [ -d "$HOME" ] && [ ! -L "$HOME" ] || return 1
  case "$target" in
    "$HOME") return 0 ;;
    "$HOME"/*) ;;
    *) return 1 ;;
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
      return 1
    fi
    # A missing component means the rest of the path cannot exist yet. Its
    # eventual creator still has to use the validated local parent.
    [ -d "$current" ] || return 0
  done
}

interview_ensure_local_directory "$INTERVIEW_STATE_DIR"
chmod 700 "$INTERVIEW_STATE_DIR"

interview_scrub_credentials() {
  local variable_name
  for variable_name in "${INTERVIEW_FORBIDDEN_CREDENTIALS[@]}"; do
    unset "$variable_name"
  done
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_NOSYSTEM=1
  export GIT_ASKPASS=/bin/false
  export GIT_SSH_COMMAND=/bin/false
  export GIT_TERMINAL_PROMPT=0
  export SSH_ASKPASS=/bin/false
}

interview_pip() {
  local python_command=$1
  shift

  "$python_command" -m pip \
    --isolated \
    --disable-pip-version-check \
    --no-input \
    --keyring-provider disabled \
    "$@"
}

interview_tool_version_matches() {
  local command_path=$1
  local expected_version=$2
  local actual_version version_output

  [ -x "$command_path" ] || return 1
  version_output="$("$command_path" --version 2>/dev/null)" || return 1
  actual_version="$(printf '%s\n' "$version_output" | awk 'NF {print $NF; exit}')"
  [ "$actual_version" = "$expected_version" ]
}

interview_tool_runtime_works() {
  local command_name=$1
  local command_path=$2

  case "$command_name" in
    pnpm)
      /usr/bin/timeout 10s "$command_path" help >/dev/null 2>&1
      ;;
    codex | playwright-mcp | bun)
      /usr/bin/timeout 10s "$command_path" --help >/dev/null 2>&1
      ;;
    *)
      return 1
      ;;
  esac
}

interview_npm() {
  env \
    -u NPM_TOKEN -u NODE_AUTH_TOKEN \
    -u NPM_CONFIG_GLOBALCONFIG \
    -u npm_config_userconfig -u npm_config_globalconfig \
    NPM_CONFIG_USERCONFIG=/dev/null \
    npm "$@"
}

interview_tool_payload_hash() {
  local payload_root=$1

  /usr/bin/python3 -I - "$payload_root" <<'PYTOOLINTEGRITY'
import hashlib
import os
import stat
import sys
from pathlib import Path


root = Path(sys.argv[1])
try:
    root_metadata = root.lstat()
    resolved_root = root.resolve(strict=True)
    digest = hashlib.sha256()

    def add(value: bytes) -> None:
        digest.update(len(value).to_bytes(8, "big"))
        digest.update(value)

    def add_file(path: Path, metadata: os.stat_result) -> None:
        add(b"file")
        add(str(stat.S_IMODE(metadata.st_mode) & 0o111).encode())
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)

    def visit(directory: Path, relative_directory: Path) -> None:
        with os.scandir(directory) as entries:
            ordered = sorted(entries, key=lambda entry: os.fsencode(entry.name))
        for entry in ordered:
            path = Path(entry.path)
            relative = relative_directory / entry.name
            metadata = entry.stat(follow_symlinks=False)
            add(os.fsencode(str(relative)))
            if stat.S_ISDIR(metadata.st_mode):
                add(b"directory")
                visit(path, relative)
            elif stat.S_ISREG(metadata.st_mode):
                add_file(path, metadata)
            elif stat.S_ISLNK(metadata.st_mode):
                add(b"symlink")
                add(os.fsencode(os.readlink(path)))
                path.resolve(strict=True).relative_to(resolved_root)
            else:
                raise ValueError(f"unsupported tool payload entry: {relative}")

    if stat.S_ISDIR(root_metadata.st_mode):
        add(b"root-directory")
        visit(root, Path())
    elif stat.S_ISREG(root_metadata.st_mode):
        add(b"root-file")
        add_file(root, root_metadata)
    else:
        raise ValueError("tool payload root is not a regular file or directory")
    print(digest.hexdigest())
except (OSError, RuntimeError, ValueError):
    raise SystemExit(1)
PYTOOLINTEGRITY
}

interview_tool_payload_root() {
  local command_name=$1
  local actual_target=$2
  local expected_binary=$3
  local baseline_target=${4:-}
  local managed_binary=$5

  if [ "$actual_target" = "$expected_binary" ]; then
    printf '%s\n' "${expected_binary%%/node_modules/*}/node_modules"
    return 0
  fi
  [ -n "$baseline_target" ] && [ "$actual_target" = "$baseline_target" ] || return 1
  case "$command_name" in
    codex)
      printf '%s\n' "$HOME/.local/lib/node_modules/@openai/codex"
      ;;
    bun)
      /usr/bin/readlink -f -- "$managed_binary"
      ;;
    *)
      return 1
      ;;
  esac
}

interview_tool_payload_ready() {
  local command_name=$1
  local expected_version=$2
  local payload_root=$3
  local current_hash stored_hash

  current_hash="$(interview_tool_payload_hash "$payload_root" 2>/dev/null || true)"
  stored_hash="$(
    interview_read_state "tool-$command_name-$expected_version.sha256" 2>/dev/null || true
  )"
  [ -n "$current_hash" ] && [ "$current_hash" = "$stored_hash" ]
}

interview_record_tool_payload() {
  local command_name=$1
  local expected_version=$2
  local payload_root=$3
  local payload_hash

  payload_hash="$(interview_tool_payload_hash "$payload_root")" || return 1
  [ -n "$payload_hash" ] || return 1
  interview_write_state "tool-$command_name-$expected_version.sha256" "$payload_hash"
}

interview_managed_tool_ready() {
  local command_name=$1
  local expected_version=$2
  local package_binary=$3
  local baseline_target=${4:-}
  local managed_binary="$HOME/.local/bin/$command_name"
  local expected_binary="$INTERVIEW_STATE_DIR/tools/$command_name-$expected_version/node_modules/$package_binary"
  local actual_target payload_root

  [ -L "$managed_binary" ] || return 1
  actual_target="$(readlink -- "$managed_binary")"
  if [ "$actual_target" != "$expected_binary" ] \
    && { [ -z "$baseline_target" ] || [ "$actual_target" != "$baseline_target" ]; }; then
    return 1
  fi
  interview_tool_version_matches "$managed_binary" "$expected_version" || return 1
  interview_tool_runtime_works "$command_name" "$managed_binary" || return 1
  payload_root="$(
    interview_tool_payload_root \
      "$command_name" "$actual_target" "$expected_binary" "$baseline_target" "$managed_binary"
  )" || return 1
  interview_tool_payload_ready "$command_name" "$expected_version" "$payload_root"
}

interview_scrub_credentials

interview_ok() {
  printf '[ok] %s\n' "$*"
}

interview_warn() {
  printf '[warn] %s\n' "$*" >&2
}

interview_error() {
  printf '[error] %s\n' "$*" >&2
}

interview_origin_is_expected() {
  local origin
  [ -d "$INTERVIEW_REPOSITORY/.git" ] \
    && [ ! -L "$INTERVIEW_REPOSITORY/.git" ] \
    && [ -f "$INTERVIEW_REPOSITORY/.git/config" ] \
    && [ ! -L "$INTERVIEW_REPOSITORY/.git/config" ] || return 1
  origin="$(
    /usr/bin/timeout 3s /usr/bin/git config \
      --file "$INTERVIEW_REPOSITORY/.git/config" \
      --no-includes \
      --get remote.origin.url 2>/dev/null || true
  )"
  case "$origin" in
    https://github.com/prmsolutions/interview-template | https://github.com/prmsolutions/interview-template.git)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

interview_python_supported() {
  python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)' >/dev/null 2>&1
}

interview_node_supported() {
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1
}

interview_backend_hash() {
  local python_runtime
  [ -f "$INTERVIEW_BACKEND/requirements.txt" ] || return 1
  python_runtime="$(
    python3 -c 'import sys, sysconfig; print("{}|cache:{}|abi:{}".format(sys.version.split()[0], sys.implementation.cache_tag or "unknown", sysconfig.get_config_var("SOABI") or "unknown"))'
  )" || return 1
  (
    cd "$INTERVIEW_REPOSITORY"
    {
      sha256sum backend/requirements.txt
      printf 'python-runtime:%s\n' "$python_runtime"
    }
  ) | sha256sum | awk '{print $1}'
}

interview_frontend_hash() {
  local manifests=(frontend/package.json)
  local node_runtime
  [ -f "$INTERVIEW_FRONTEND/package.json" ] || return 1
  [ ! -f "$INTERVIEW_FRONTEND/package-lock.json" ] || manifests+=(frontend/package-lock.json)
  [ ! -f "$INTERVIEW_FRONTEND/npm-shrinkwrap.json" ] || manifests+=(frontend/npm-shrinkwrap.json)
  node_runtime="$(node -p '`${process.version}|abi:${process.versions.modules || "unknown"}`')" \
    || return 1
  (
    cd "$INTERVIEW_REPOSITORY"
    {
      sha256sum "${manifests[@]}"
      printf 'node-runtime:%s\n' "$node_runtime"
    }
  ) | sha256sum | awk '{print $1}'
}

interview_frontend_install_hash() {
  local node_modules="$INTERVIEW_FRONTEND/node_modules"

  interview_local_directory_chain_ready "$node_modules" || return 1
  [ -d "$node_modules" ] && [ ! -L "$node_modules" ] || return 1
  /usr/bin/python3 - "$node_modules" <<'PYFRONTENDINTEGRITY'
import hashlib
import os
import stat
import sys
from pathlib import Path


root = Path(sys.argv[1])
try:
    resolved_root = root.resolve(strict=True)
    digest = hashlib.sha256()

    def add(value: bytes) -> None:
        digest.update(len(value).to_bytes(8, "big"))
        digest.update(value)

    def visit(directory: Path, relative_directory: Path) -> None:
        with os.scandir(directory) as entries:
            ordered = sorted(entries, key=lambda entry: os.fsencode(entry.name))
        for entry in ordered:
            if not relative_directory.parts and entry.name in {
                ".cache",
                ".vite",
                ".vue-global-types",
            }:
                continue
            path = Path(entry.path)
            relative = relative_directory / entry.name
            metadata = entry.stat(follow_symlinks=False)
            add(os.fsencode(str(relative)))
            if stat.S_ISDIR(metadata.st_mode):
                add(b"directory")
                visit(path, relative)
            elif stat.S_ISREG(metadata.st_mode):
                add(b"file")
                add(str(stat.S_IMODE(metadata.st_mode) & 0o111).encode())
                with path.open("rb") as handle:
                    for block in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(block)
            elif stat.S_ISLNK(metadata.st_mode):
                add(b"symlink")
                add(os.fsencode(os.readlink(path)))
                path.resolve(strict=True).relative_to(resolved_root)
            else:
                raise ValueError(f"unsupported dependency entry: {relative}")

    visit(root, Path())
    print(digest.hexdigest())
except (OSError, RuntimeError, ValueError):
    raise SystemExit(1)
PYFRONTENDINTEGRITY
}

interview_read_state() {
  local state_name=$1
  [ -f "$INTERVIEW_STATE_DIR/$state_name" ] || return 1
  command cat "$INTERVIEW_STATE_DIR/$state_name"
}

interview_write_state() {
  local state_name=$1
  local value=$2
  local temporary_file

  temporary_file="$(mktemp "$INTERVIEW_STATE_DIR/.state.XXXXXX")"
  printf '%s\n' "$value" > "$temporary_file"
  chmod 600 "$temporary_file"
  mv -fT -- "$temporary_file" "$INTERVIEW_STATE_DIR/$state_name"
}

interview_python_distributions_intact() {
  "$INTERVIEW_VENV/bin/python" - <<'PYDISTINTEGRITY'
import base64
import hashlib
import importlib.metadata
import sys
from pathlib import Path


venv = Path(sys.prefix).resolve()
try:
    distributions = list(importlib.metadata.distributions())
    if not distributions:
        raise ValueError("the virtual environment has no installed distributions")
    for distribution in distributions:
        files = distribution.files
        if files is None:
            raise ValueError(f"distribution has no installed-file record: {distribution}")
        for installed_file in files:
            expected_hash = installed_file.hash
            if expected_hash is None:
                continue
            path = Path(distribution.locate_file(installed_file))
            if path.is_symlink() or not path.is_file():
                raise ValueError(f"installed dependency file is missing or linked: {path}")
            path.resolve().relative_to(venv)
            digest = hashlib.new(expected_hash.mode)
            with path.open("rb") as handle:
                for block in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(block)
            actual_hash = base64.urlsafe_b64encode(digest.digest()).rstrip(b"=").decode()
            if actual_hash != expected_hash.value:
                raise ValueError(f"installed dependency file failed integrity validation: {path}")
except (OSError, ValueError):
    raise SystemExit(1)
PYDISTINTEGRITY
}

interview_backend_environment_ready() {
  local report_file status=0

  interview_local_directory_chain_ready "$INTERVIEW_VENV/bin" || return 1
  [ -x "$INTERVIEW_VENV/bin/python" ] || return 1
  interview_pip "$INTERVIEW_VENV/bin/python" check >/dev/null 2>&1 || return 1

  report_file="$(mktemp "$INTERVIEW_STATE_DIR/.pip-dry-run.XXXXXX")" || return 1
  if ! interview_pip "$INTERVIEW_VENV/bin/python" install \
    --dry-run \
    --no-cache-dir \
    --quiet \
    --report "$report_file" \
    -r "$INTERVIEW_BACKEND/requirements.txt" >/dev/null 2>&1; then
    status=1
  elif ! /usr/bin/python3 - "$report_file" <<'PYPIPREPORT'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        report = json.load(handle)
    if not isinstance(report, dict) or report.get("install") != []:
        raise ValueError("the requirements would change the environment")
except (OSError, ValueError, TypeError, json.JSONDecodeError):
    raise SystemExit(1)
PYPIPREPORT
  then
    status=1
  elif ! interview_python_distributions_intact; then
    status=1
  fi
  rm -f -- "$report_file"
  return "$status"
}

interview_backend_dependencies_ready() {
  local current_hash stored_hash
  interview_backend_environment_ready || return 1
  current_hash="$(interview_backend_hash 2>/dev/null || true)"
  stored_hash="$(interview_read_state backend-requirements.sha256 2>/dev/null || true)"
  [ -n "$current_hash" ] && [ "$current_hash" = "$stored_hash" ]
}

interview_frontend_dependencies_ready() {
  local current_hash stored_hash current_install_hash stored_install_hash
  interview_local_directory_chain_ready "$INTERVIEW_FRONTEND/node_modules" || return 1
  [ -x "$INTERVIEW_FRONTEND/node_modules/.bin/vite" ] || return 1
  current_hash="$(interview_frontend_hash 2>/dev/null || true)"
  stored_hash="$(interview_read_state frontend-manifests.sha256 2>/dev/null || true)"
  [ -n "$current_hash" ] && [ "$current_hash" = "$stored_hash" ] || return 1
  current_install_hash="$(interview_frontend_install_hash 2>/dev/null || true)"
  stored_install_hash="$(interview_read_state frontend-install.sha256 2>/dev/null || true)"
  [ -n "$current_install_hash" ] \
    && [ "$current_install_hash" = "$stored_install_hash" ] || return 1
  (
    cd "$INTERVIEW_FRONTEND"
    interview_npm ls --all --silent >/dev/null 2>&1
  )
}

interview_git_clean() {
  [ -d "$INTERVIEW_REPOSITORY/.git" ] || return 1
  interview_git_transport_credentials_absent || return 1
  [ -z "$(
    /usr/bin/timeout 10s /usr/bin/git \
      -c core.fsmonitor=false \
      -c core.hooksPath=/dev/null \
      -C "$INTERVIEW_REPOSITORY" \
      status --short --untracked-files=all 2>/dev/null
  )" ]
}

interview_anonymous_git() {
  local anonymous_home status

  anonymous_home="$(mktemp -d "$INTERVIEW_STATE_DIR/.anonymous-git.XXXXXX")" || return 1
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
      timeout 12s git -c credential.helper= "$@"
  ); then
    status=0
  else
    status=$?
  fi
  rm -rf -- "$anonymous_home"
  return "$status"
}

interview_remote_default_state() {
  local local_commit remote_commit
  local_commit="$(interview_repository_commit 2>/dev/null || true)"
  remote_commit="$(
    { interview_anonymous_git ls-remote "$INTERVIEW_EXPECTED_ORIGIN" HEAD 2>/dev/null || true; } \
      | awk 'NR == 1 {print $1}'
  )"
  if [ -z "$remote_commit" ]; then
    printf 'Remote default branch could not be checked; the existing checkout was preserved.'
  elif [ "$remote_commit" = "$local_commit" ]; then
    printf 'Checkout matches the current remote default-branch commit.'
  else
    printf 'Remote default branch is at %s; checkout %s was preserved without updating.' \
      "$remote_commit" "$local_commit"
  fi
}

interview_repository_commit() {
  interview_git_transport_credentials_absent || return 1
  /usr/bin/timeout 3s /usr/bin/git \
    -c core.fsmonitor=false \
    -c core.hooksPath=/dev/null \
    -C "$INTERVIEW_REPOSITORY" \
    rev-parse HEAD
}

interview_forbidden_environment_present() {
  local variable_name
  for variable_name in "${INTERVIEW_FORBIDDEN_CREDENTIALS[@]}"; do
    if printenv "$variable_name" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

interview_forbidden_tmux_environment_present() {
  local scope variable_name
  tmux has-session -t "$INTERVIEW_SESSION" 2>/dev/null || return 1
  for variable_name in "${INTERVIEW_FORBIDDEN_CREDENTIALS[@]}"; do
    for scope in "-t $INTERVIEW_SESSION" "-g"; do
      # shellcheck disable=SC2086 # Scope intentionally expands into tmux options.
      if tmux show-environment $scope "$variable_name" >/dev/null 2>&1; then
        return 0
      fi
    done
  done
  return 1
}

interview_hive_github_helper_present() {
  local config_file helper_output

  [ -e "$HOME/.local/bin/coder-github-credential" ] && return 0
  for config_file in "$HOME/.gitconfig" "$HOME/.config/git/config"; do
    [ -f "$config_file" ] && [ ! -L "$config_file" ] || continue
    helper_output="$(
      /usr/bin/timeout 3s /usr/bin/git config --file "$config_file" --no-includes \
        --get-all credential.https://github.com.helper 2>/dev/null || true
    )"
    if grep -Fqx -- "$HOME/.local/bin/coder-github-credential" <<< "$helper_output"; then
      return 0
    fi
  done
  return 1
}

interview_git_config_contains_transport_auth() {
  local config_file=$1 status

  if [ ! -e "$config_file" ] && [ ! -L "$config_file" ]; then
    return 1
  fi
  [ -f "$config_file" ] && [ ! -L "$config_file" ] || return 0
  if /usr/bin/timeout 3s /usr/bin/git config \
    --file "$config_file" \
    --no-includes \
    --name-only \
    --get-regexp \
    '^(credential($|\.)|http\..*(extraheader|proxy|cookiefile|savecookies|sslcert|sslkey)$|core\.(attributesfile|fsmonitor|gitproxy|sshcommand)$|filter\..*\.(clean|process|smudge)$|diff\..*\.(command|textconv)$|remote\..*\.proxy$|url\..*\.insteadof$|include($|\.)|includeif\.)' \
    >/dev/null 2>&1; then
    status=0
  else
    status=$?
  fi
  case "$status" in
    0) return 0 ;;
    1) return 1 ;;
    *) return 0 ;;
  esac
}

interview_git_transport_credentials_absent() {
  local credential_path config_file ssh_directory="$HOME/.ssh"
  local remote_line remote_url

  for credential_path in \
    "$HOME/.git-credentials" \
    "$HOME/.netrc" \
    "$HOME/.authinfo" \
    "$HOME/.config/git/credentials" \
    "$HOME/.config/gh/hosts.yml" \
    "$HOME/.cache/git/credential"; do
    if [ -e "$credential_path" ] || [ -L "$credential_path" ]; then
      return 1
    fi
  done

  if [ -e "$ssh_directory" ] || [ -L "$ssh_directory" ]; then
    [ -d "$ssh_directory" ] && [ ! -L "$ssh_directory" ] || return 1
    if ! (
      shopt -s dotglob nullglob
      for credential_path in "$ssh_directory"/*; do
        case "${credential_path##*/}" in
          authorized_keys | known_hosts | known_hosts.old | *.pub)
            [ -f "$credential_path" ] && [ ! -L "$credential_path" ] || exit 1
            ;;
          *) exit 1 ;;
        esac
      done
    ); then
      return 1
    fi
  fi

  for config_file in \
    "$HOME/.gitconfig" \
    "$HOME/.config/git/config" \
    "$INTERVIEW_REPOSITORY/.git/config"; do
    if interview_git_config_contains_transport_auth "$config_file"; then
      return 1
    fi
  done

  if [ -f "$INTERVIEW_REPOSITORY/.git/config" ] \
    && [ ! -L "$INTERVIEW_REPOSITORY/.git/config" ]; then
    while IFS= read -r remote_line; do
      remote_url="${remote_line#* }"
      case "$remote_url" in
        https://github.com/prmsolutions/interview-template | "$INTERVIEW_EXPECTED_ORIGIN") ;;
        *) return 1 ;;
      esac
    done < <(
      /usr/bin/timeout 3s /usr/bin/git config \
        --file "$INTERVIEW_REPOSITORY/.git/config" \
        --no-includes \
        --get-regexp '^remote\..*\.url$' 2>/dev/null || true
    )
  fi

  [ "${GIT_CONFIG_GLOBAL:-}" = /dev/null ] \
    && [ "${GIT_CONFIG_NOSYSTEM:-}" = 1 ] \
    && [ "${GIT_ASKPASS:-}" = /bin/false ] \
    && [ "${GIT_SSH_COMMAND:-}" = /bin/false ] \
    && [ "${GIT_TERMINAL_PROMPT:-}" = 0 ] \
    && [ "${SSH_ASKPASS:-}" = /bin/false ]
}

interview_claude_authentication_absent() {
  local credential_path

  # Claude Code's supported Linux credential store is the first path. The
  # second is a legacy compatibility path still found in persisted homes.
  # Preserve either user-owned path, but fail readiness rather than allowing
  # the image-baked main-container Claude binary to reuse a personal login.
  for credential_path in \
    "$HOME/.claude/.credentials.json" \
    "$HOME/.config/claude-code/auth.json"; do
    if [ -e "$credential_path" ] || [ -L "$credential_path" ]; then
      return 1
    fi
  done
  return 0
}

interview_package_authentication_absent() {
  local configuration_path

  # npm and pip per-user configuration can contain registry bearer tokens or
  # embedded index credentials. Preserve each user-owned path, but fail
  # readiness without reading it.
  for configuration_path in \
    "$HOME/.npmrc" \
    "$HOME/.config/pip/pip.conf" \
    "$HOME/.pip/pip.conf"; do
    if [ -e "$configuration_path" ] || [ -L "$configuration_path" ]; then
      return 1
    fi
  done
  return 0
}

interview_github_auth_json() {
  command -v gh >/dev/null 2>&1 || return 1
  timeout 5s env -u GH_TOKEN -u GITHUB_TOKEN \
    gh auth status --json hosts 2>/dev/null
}

interview_github_authenticated() {
  local auth_json
  auth_json="$(interview_github_auth_json)" || return 1
  jq -e 'any(.hosts[]?[]?; .state == "success")' \
    >/dev/null 2>&1 <<< "$auth_json"
}

interview_github_unauthenticated() {
  local auth_json
  command -v gh >/dev/null 2>&1 || return 0
  auth_json="$(interview_github_auth_json)" || return 1
  jq -e 'all(.hosts[]?[]?; .state != "success")' \
    >/dev/null 2>&1 <<< "$auth_json"
}

interview_shell_scrub_ready() {
  local environment_file="$HOME/.config/hive/interview-env.sh"
  local shell_file
  local shell_files=("$HOME/.zshenv" "$HOME/.bashrc" "$HOME/.profile")

  [ -f "$environment_file" ] && [ ! -L "$environment_file" ] || return 1
  grep -qF '# hive-managed-interview-environment:v1' "$environment_file" || return 1
  grep -qF \
    'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN' \
    "$environment_file" || return 1
  grep -qF \
    'unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES' \
    "$environment_file" || return 1
  grep -qF \
    'unset CLAUDE_CONFIG_DIR CLAUDE_SECURESTORAGE_CONFIG_DIR' \
    "$environment_file" || return 1
  grep -qF \
    'unset NPM_TOKEN NODE_AUTH_TOKEN NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG' \
    "$environment_file" || return 1
  grep -qF \
    'unset npm_config_userconfig npm_config_globalconfig' \
    "$environment_file" || return 1
  grep -qF \
    'unset PIP_CONFIG_FILE PIP_INDEX_URL PIP_EXTRA_INDEX_URL PIP_TRUSTED_HOST' \
    "$environment_file" || return 1
  grep -qF \
    'unset PIP_CERT PIP_CLIENT_CERT PIP_KEYRING_PROVIDER PIP_PROXY' \
    "$environment_file" || return 1
  grep -qF \
    'unset GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN' \
    "$environment_file" || return 1
  grep -qF 'unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN' \
    "$environment_file" || return 1
  grep -qF \
    'unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE' \
    "$environment_file" || return 1
  grep -qF \
    'unset AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE AWS_WEB_IDENTITY_TOKEN_FILE' \
    "$environment_file" || return 1
  grep -qF \
    'unset GOOGLE_APPLICATION_CREDENTIALS CLOUDSDK_AUTH_ACCESS_TOKEN' \
    "$environment_file" || return 1
  grep -qF \
    'unset AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TENANT_ID' \
    "$environment_file" || return 1
  grep -qF \
    'unset ARM_CLIENT_ID ARM_CLIENT_SECRET ARM_TENANT_ID ARM_SUBSCRIPTION_ID' \
    "$environment_file" || return 1
  grep -qF 'unset KUBECONFIG' "$environment_file" || return 1
  grep -qF \
    'unset GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_PROXY_COMMAND GIT_SSH' \
    "$environment_file" || return 1
  grep -qF 'unset SSH_AUTH_SOCK SSH_AGENT_PID SSH_ASKPASS_REQUIRE' \
    "$environment_file" || return 1
  grep -qF 'export GIT_CONFIG_GLOBAL=/dev/null' "$environment_file" || return 1
  grep -qF 'export GIT_CONFIG_NOSYSTEM=1' "$environment_file" || return 1
  grep -qF 'export GIT_ASKPASS=/bin/false' "$environment_file" || return 1
  grep -qF 'export GIT_SSH_COMMAND=/bin/false' "$environment_file" || return 1

  for shell_file in "$HOME/.bash_profile" "$HOME/.bash_login"; do
    if [ -e "$shell_file" ] || [ -L "$shell_file" ]; then
      shell_files+=("$shell_file")
    fi
  done

  for shell_file in "${shell_files[@]}"; do
    [ -f "$shell_file" ] && [ ! -L "$shell_file" ] || return 1
    [ "$(sed -n '1p' "$shell_file")" = '# hive-interview-environment' ] || return 1
    [ "$(sed -n '2p' "$shell_file")" = \
      '[ ! -f "$HOME/.config/hive/interview-env.sh" ] || . "$HOME/.config/hive/interview-env.sh"' ] \
      || return 1
    [ "$(sed -n '3p' "$shell_file")" = '__hive_interview_preserved_startup() {' ] \
      || return 1
    [ "$(sed -n '4p' "$shell_file")" = '  :' ] || return 1
    [ "$(sed -n '5p' "$shell_file")" = '# >>> hive-interview-preserved-startup' ] \
      || return 1
    [ "$(tail -n 6 "$shell_file" | sed -n '1p')" = \
      '# <<< hive-interview-preserved-startup' ] || return 1
    [ "$(tail -n 6 "$shell_file" | sed -n '2p')" = '}' ] || return 1
    [ "$(tail -n 6 "$shell_file" | sed -n '3p')" = \
      '__hive_interview_preserved_startup' ] || return 1
    [ "$(tail -n 6 "$shell_file" | sed -n '4p')" = \
      'unset -f __hive_interview_preserved_startup 2>/dev/null || true' ] || return 1
    [ "$(tail -n 6 "$shell_file" | sed -n '5p')" = \
      '# hive-interview-environment-final' ] || return 1
    [ "$(tail -n 6 "$shell_file" | sed -n '6p')" = \
      '[ ! -f "$HOME/.config/hive/interview-env.sh" ] || . "$HOME/.config/hive/interview-env.sh"' ] \
      || return 1
  done
}

interview_managed_directories_ready() {
  local managed_directory

  for managed_directory in \
    "$HOME/.local" \
    "$HOME/.local/bin" \
    "$HOME/.local/libexec" \
    "$HOME/.local/libexec/hive" \
    "$HOME/.local/libexec/hive/technical-interview" \
    "$HOME/.local/state" \
    "$HOME/.local/state/hive" \
    "$HOME/.local/state/hive/technical-interview"; do
    [ -d "$managed_directory" ] && [ ! -L "$managed_directory" ] || return 1
  done
}

interview_browser_helpers_ready() {
  local chromium="$HOME/.local/bin/chromium-browser"
  local helper

  [ -x "$INTERVIEW_CHROME_BIN" ] || return 1
  [ -L "$chromium" ] || return 1
  [ "$(/usr/bin/readlink -- "$chromium")" = "$INTERVIEW_CHROME_BIN" ] || return 1
  for helper in "$HOME/.local/bin/browser-screenshot" "$HOME/.local/bin/browser-html"; do
    [ -f "$helper" ] && [ ! -L "$helper" ] && [ -x "$helper" ] || return 1
    grep -qF '# hive-managed-browser-helper:v1' "$helper" || return 1
  done
}

interview_claude_ready() {
  local marker timestamp extra now age

  [ -f "$INTERVIEW_CLAUDE_STATUS" ] \
    && [ ! -L "$INTERVIEW_CLAUDE_STATUS" ] \
    && IFS=' ' read -r marker timestamp extra < "$INTERVIEW_CLAUDE_STATUS" \
    && [ "$marker" = 'isolated-claude-runtime-ready-v3' ] \
    && [ -z "$extra" ] \
    && [[ "$timestamp" =~ ^[0-9]+$ ]] \
    && now="$(date +%s)" \
    && ((timestamp <= now + 5)) \
    && age=$((now - timestamp)) \
    && ((age <= 30)) \
    && [ -f "$INTERVIEW_CLAUDE_LAUNCHER" ] \
    && [ ! -L "$INTERVIEW_CLAUDE_LAUNCHER" ] \
    && [ -x "$INTERVIEW_CLAUDE_LAUNCHER" ] \
    && grep -qF '# hive-managed-interview-claude:v5' "$INTERVIEW_CLAUDE_LAUNCHER" \
    && grep -qF 'INTERVIEW_REPOSITORY = Path("/workspace/projects/prmsolutions/interview-template")' \
      "$INTERVIEW_CLAUDE_LAUNCHER" \
    && grep -qF 'TRUSTED_CLAUDE = Path("/opt/hive-interview-tools/claude")' \
      "$INTERVIEW_CLAUDE_LAUNCHER" \
    && grep -qF 'TRUSTED_GUARD = Path("/opt/hive-interview-tools/claude-guard.so")' \
      "$INTERVIEW_CLAUDE_LAUNCHER" \
    && grep -qF 'ANTHROPIC_UPSTREAM_HOST = "api.anthropic.com"' \
      "$INTERVIEW_CLAUDE_LAUNCHER" \
    && grep -qF 'environment["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"] = "0"' \
      "$INTERVIEW_CLAUDE_LAUNCHER" \
    && grep -qF 'socketserver.UnixStreamServer' "$INTERVIEW_CLAUDE_LAUNCHER" \
    && grep -qF 'socket.SO_PEERCRED' "$INTERVIEW_CLAUDE_LAUNCHER" \
    && grep -qF 'serve_launch_socket' "$INTERVIEW_CLAUDE_LAUNCHER" \
    && grep -qF 'run_launch_client' "$INTERVIEW_CLAUDE_LAUNCHER" \
    && grep -qF 'PR_SET_DUMPABLE = 4' "$INTERVIEW_CLAUDE_LAUNCHER" \
    && [ -f "$INTERVIEW_CLAUDE_BIN" ] \
    && [ ! -L "$INTERVIEW_CLAUDE_BIN" ] \
    && [ -x "$INTERVIEW_CLAUDE_BIN" ] \
    && [ -f "$INTERVIEW_CLAUDE_GUARD" ] \
    && [ ! -L "$INTERVIEW_CLAUDE_GUARD" ] \
    && [ -x "$INTERVIEW_CLAUDE_GUARD" ] \
    && "$INTERVIEW_CLAUDE_BIN" --version >/dev/null 2>&1
}

interview_claude_version_or_missing() {
  if interview_claude_ready; then
    "$INTERVIEW_CLAUDE_BIN" --version 2>&1 | sed -n '1p'
  else
    printf 'missing or untrusted'
  fi
}

interview_agent_context_ready() {
  local context_file

  for context_file in "$HOME/.codex/AGENTS.md" "$HOME/.claude/CLAUDE.md"; do
    [ -f "$context_file" ] && [ ! -L "$context_file" ] || return 1
  done
}

interview_mcp_configuration_ready() {
  local configuration_directory

  for configuration_directory in "$HOME/.codex" "$HOME/.claude"; do
    [ -d "$configuration_directory" ] && [ ! -L "$configuration_directory" ] || return 1
  done

  python3 - <<'PYMCPREADY'
import json
import os
import tomllib
from pathlib import Path


home = Path(os.environ["HOME"])
playwright = {
    "command": str(home / ".local" / "bin" / "playwright-mcp"),
    "args": ["--browser", "chrome", "--no-sandbox", "--isolated"],
    "env": {"DISPLAY": ":1"},
}

try:
    codex_config = home / ".codex" / "config.toml"
    if codex_config.is_symlink() or not codex_config.is_file():
        raise ValueError("Codex MCP configuration is not a local regular file")
    with codex_config.open("rb") as handle:
        codex_data = tomllib.load(handle)
    codex_servers = codex_data.get("mcp_servers")
    if (
        not isinstance(codex_servers, dict)
        or codex_servers.get("hive_playwright") != playwright
    ):
        raise ValueError("Codex Playwright MCP configuration is incomplete")

    for json_config in (home / ".claude" / "mcp.json", home / ".mcp.json"):
        if json_config.is_symlink() or not json_config.is_file():
            raise ValueError(f"MCP configuration is not a local regular file: {json_config}")
        with json_config.open() as handle:
            json_data = json.load(handle)
        if not isinstance(json_data, dict):
            raise ValueError(f"MCP configuration root is not an object: {json_config}")
        servers = json_data.get("mcpServers")
        if not isinstance(servers, dict) or servers.get("hive_playwright") != playwright:
            raise ValueError(f"Playwright MCP configuration is incomplete: {json_config}")
except (OSError, ValueError, TypeError, json.JSONDecodeError, tomllib.TOMLDecodeError):
    raise SystemExit(1)
PYMCPREADY
}

interview_coder_auth_state() {
  local auth_output auth_status

  if ! command -v coder >/dev/null 2>&1; then
    printf 'unauthenticated\n'
    return 0
  fi

  if auth_output="$(
    timeout 5s env -u CODER_AGENT_TOKEN -u CODER_SESSION_TOKEN \
      coder whoami --output json 2>&1
  )"; then
    printf 'authenticated\n'
    return 0
  else
    auth_status=$?
  fi

  case "$auth_status" in
    124 | 137)
      printf 'unknown\n'
      return 0
      ;;
  esac

  if grep -Eqi \
    'you are not logged in|not authenticated|authentication (is )?required|unauthori[sz]ed|invalid (session )?token|(^|[^0-9])401([^0-9]|$)' \
    <<< "$auth_output"; then
    printf 'unauthenticated\n'
  else
    printf 'unknown\n'
  fi
}

interview_coder_authenticated() {
  [ "$(interview_coder_auth_state)" = "authenticated" ]
}

interview_coder_unauthenticated() {
  [ "$(interview_coder_auth_state)" = "unauthenticated" ]
}

interview_wait_url() {
  local label=$1
  local url=$2
  local attempts=${3:-45}
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl --fail --silent --show-error --max-time 3 "$url" >/dev/null 2>&1; then
      interview_ok "$label is responding at $url"
      return 0
    fi
    sleep 1
  done
  interview_error "$label did not respond at $url within ${attempts}s"
  return 1
}

interview_version_or_missing() {
  local command_name=$1
  shift
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'missing'
    return 0
  fi
  "$@" 2>&1 | sed -n '1p'
}
COMMONEOF

# shellcheck source=/dev/null
source "$interview_libexec_dir/common.sh"

install_interview_file "$interview_bin_dir/interview-setup" 700 <<'SETUPEOF'
#!/bin/bash
set -euo pipefail
umask 077

# shellcheck source=/dev/null
source "$HOME/.local/libexec/hive/technical-interview/common.sh"

tool_preparer="$HOME/.local/libexec/hive/technical-interview/prepare-tools.sh"
if [ ! -f "$tool_preparer" ] || [ -L "$tool_preparer" ] || [ ! -x "$tool_preparer" ]; then
  interview_error "Managed interview tool recovery command is unavailable."
  exit 1
fi
if ! "$tool_preparer"; then
  interview_error "Interview tool preparation failed; restore network access and rerun interview-setup."
  exit 1
fi

if [ ! -d "$INTERVIEW_REPOSITORY/.git" ]; then
  interview_error "Expected repository is missing: $INTERVIEW_REPOSITORY"
  interview_error "Rerun the workspace repository bootstrap after public HTTPS access is restored."
  exit 1
fi

if ! interview_origin_is_expected; then
  interview_error "Repository origin is not the expected public Proton.ai repository."
  exit 1
fi

if ! interview_python_supported; then
  interview_error "Python 3.12 or newer is required."
  exit 1
fi
if ! interview_node_supported; then
  interview_error "Node.js 20 or newer is required."
  exit 1
fi
if ! interview_npm --version >/dev/null 2>&1; then
  interview_error "npm is required but is not functional."
  exit 1
fi

interview_ensure_local_directory "$INTERVIEW_STATE_DIR"
chmod 700 "$INTERVIEW_STATE_DIR"
dependencies_refreshed=false
backend_venv_created=false

if ! interview_local_directory_chain_ready "$INTERVIEW_VENV/bin"; then
  interview_error "Preserving an unsafe linked or non-directory backend virtual environment chain: $INTERVIEW_VENV"
  exit 1
fi

interview_virtualenv_fallback_ready() {
  local fallback_root=$1 validation_root version_output status=0

  [ -d "$fallback_root" ] && [ ! -L "$fallback_root" ] || return 1
  version_output="$(
    PYTHONPATH="$fallback_root" python3 -m virtualenv --version 2>/dev/null
  )" || return 1
  case " $version_output " in
    *" $INTERVIEW_VIRTUALENV_VERSION "*) ;;
    *) return 1 ;;
  esac

  validation_root="$(mktemp -d "$INTERVIEW_STATE_DIR/.virtualenv-validation.XXXXXX")" \
    || return 1
  if ! PYTHONPATH="$fallback_root" \
    python3 -m virtualenv "$validation_root/venv" >/dev/null 2>&1; then
    status=1
  fi
  rm -rf -- "$validation_root"
  return "$status"
}

interview_install_virtualenv_fallback() {
  local fallback_root=$1 candidate_root

  candidate_root="$(mktemp -d "$INTERVIEW_STATE_DIR/.virtualenv-install.XXXXXX")" \
    || return 1
  if ! interview_pip python3 install \
    --target "$candidate_root" \
    "virtualenv==$INTERVIEW_VIRTUALENV_VERSION"; then
    rm -rf -- "$candidate_root"
    return 1
  fi
  if ! interview_virtualenv_fallback_ready "$candidate_root"; then
    interview_error "Pinned virtualenv fallback failed validation after installation."
    rm -rf -- "$candidate_root"
    return 1
  fi

  if [ -e "$fallback_root" ] || [ -L "$fallback_root" ]; then
    if [ -L "$fallback_root" ] || [ ! -d "$fallback_root" ]; then
      interview_error "Preserving unsafe virtualenv fallback state: $fallback_root"
      rm -rf -- "$candidate_root"
      return 1
    fi
    if ! rm -rf -- "$fallback_root"; then
      rm -rf -- "$candidate_root"
      return 1
    fi
  fi
  if ! mv -T -- "$candidate_root" "$fallback_root"; then
    rm -rf -- "$candidate_root"
    return 1
  fi
}

interview_create_backend_venv() {
  local fallback_root venv_probe
  venv_probe="$(mktemp -d "$INTERVIEW_STATE_DIR/.venv-probe.XXXXXX")"
  if python3 -m venv "$venv_probe/venv" >/dev/null 2>&1; then
    rm -rf -- "$venv_probe"
    interview_ok "Creating backend virtual environment with python3 -m venv"
    python3 -m venv "$INTERVIEW_VENV"
    interview_write_state venv-method "standard python3 -m venv"
  else
    rm -rf -- "$venv_probe"
    fallback_root="$INTERVIEW_STATE_DIR/virtualenv-$INTERVIEW_VIRTUALENV_VERSION"
    interview_warn "Standard venv creation is unavailable; using pinned non-root virtualenv $INTERVIEW_VIRTUALENV_VERSION"
    if [ -e "$fallback_root" ] || [ -L "$fallback_root" ]; then
      interview_ensure_local_directory "$fallback_root"
    fi
    if ! interview_virtualenv_fallback_ready "$fallback_root"; then
      interview_warn "Installing or repairing the pinned virtualenv fallback"
      interview_install_virtualenv_fallback "$fallback_root"
    fi
    PYTHONPATH="$fallback_root" python3 -m virtualenv "$INTERVIEW_VENV"
    interview_write_state venv-method "transitional virtualenv $INTERVIEW_VIRTUALENV_VERSION"
  fi
  backend_venv_created=true
}

if [ ! -x "$INTERVIEW_VENV/bin/python" ]; then
  if [ -e "$INTERVIEW_VENV" ] || [ -L "$INTERVIEW_VENV" ]; then
    if [ -L "$INTERVIEW_VENV" ] || [ ! -d "$INTERVIEW_VENV" ]; then
      interview_error "Preserving an unsafe backend virtual environment: $INTERVIEW_VENV"
      exit 1
    fi
    interview_ok "Recreating the managed backend virtual environment after an interrupted creation"
    rm -rf -- "$INTERVIEW_VENV"
  fi

  interview_create_backend_venv
fi

backend_hash="$(interview_backend_hash)"
stored_backend_hash="$(interview_read_state backend-requirements.sha256 2>/dev/null || true)"
if [ -n "$stored_backend_hash" ] && [ "$backend_hash" != "$stored_backend_hash" ]; then
  interview_ok "Recreating the managed backend virtual environment for changed dependencies"
  rm -rf -- "$INTERVIEW_VENV"
  interview_create_backend_venv
elif [ -n "$stored_backend_hash" ] && ! interview_backend_environment_ready; then
  interview_ok "Recreating the managed backend virtual environment to repair incomplete or damaged dependencies"
  rm -rf -- "$INTERVIEW_VENV"
  interview_create_backend_venv
  stored_backend_hash=""
elif [ -z "$stored_backend_hash" ] && [ "$backend_venv_created" != true ]; then
  interview_ok "Recreating the unmanaged backend virtual environment before the initial dependency install"
  rm -rf -- "$INTERVIEW_VENV"
  interview_create_backend_venv
fi

if [ "$backend_hash" != "$stored_backend_hash" ]; then
  interview_ok "Installing backend dependencies"
  interview_pip "$INTERVIEW_VENV/bin/python" install \
    -r "$INTERVIEW_BACKEND/requirements.txt"
  if ! interview_backend_environment_ready; then
    interview_error "Backend dependencies failed complete requirement and installed-file validation."
    exit 1
  fi
  interview_write_state backend-requirements.sha256 "$backend_hash"
  dependencies_refreshed=true
else
  interview_ok "Backend dependencies match the stored manifest hash"
fi

frontend_hash="$(interview_frontend_hash)"
if ! interview_local_directory_chain_ready "$INTERVIEW_FRONTEND/node_modules"; then
  interview_error "Preserving an unsafe linked or non-directory frontend dependency chain: $INTERVIEW_FRONTEND/node_modules"
  exit 1
fi
if [ -e "$INTERVIEW_FRONTEND/node_modules" ] \
  && { [ -L "$INTERVIEW_FRONTEND/node_modules" ] \
    || [ ! -d "$INTERVIEW_FRONTEND/node_modules" ]; }; then
  interview_error "Preserving unsafe frontend dependency state: $INTERVIEW_FRONTEND/node_modules"
  exit 1
fi

if ! interview_frontend_dependencies_ready; then
  interview_ok "Installing frontend dependencies"
  if [ -d "$INTERVIEW_FRONTEND/node_modules" ]; then
    /usr/bin/rm -rf -- "$INTERVIEW_FRONTEND/node_modules"
  fi
  if [ -f "$INTERVIEW_FRONTEND/package-lock.json" ] \
    || [ -f "$INTERVIEW_FRONTEND/npm-shrinkwrap.json" ]; then
    (
      cd "$INTERVIEW_FRONTEND"
      interview_npm ci --no-audit --no-fund
    )
  else
    (
      cd "$INTERVIEW_FRONTEND"
      interview_npm install --no-package-lock --no-audit --no-fund
    )
  fi
  if ! (
    cd "$INTERVIEW_FRONTEND"
    interview_npm ls --all --silent >/dev/null 2>&1
  ); then
    interview_error "Frontend dependencies are incomplete after installation."
    exit 1
  fi
  frontend_install_hash="$(interview_frontend_install_hash)" || {
    interview_error "Frontend dependencies failed installed-file integrity validation."
    exit 1
  }
  interview_write_state frontend-manifests.sha256 "$frontend_hash"
  interview_write_state frontend-install.sha256 "$frontend_install_hash"
  dependencies_refreshed=true
else
  interview_ok "Frontend dependencies match the stored manifest hash"
fi

interview_ok "Running backend tests"
(
  cd "$INTERVIEW_BACKEND"
  "$INTERVIEW_VENV/bin/pytest" -q
)

interview_ok "Running frontend production build"
(
  cd "$INTERVIEW_FRONTEND"
  interview_npm run build
)
if ! interview_frontend_dependencies_ready; then
  interview_error "Frontend dependencies changed or failed integrity validation during the build."
  exit 1
fi

if interview_git_clean; then
  interview_ok "Repository working tree remains clean"
else
  interview_warn "Repository has candidate changes or unexpected generated files; preserving them unchanged"
  /usr/bin/git -c core.fsmonitor=false -c core.hooksPath=/dev/null \
    -C "$INTERVIEW_REPOSITORY" status --short
fi

if [ "$dependencies_refreshed" = true ] \
  && tmux has-session -t "$INTERVIEW_SESSION" 2>/dev/null; then
  interview_ok "Dependencies changed; restarting only the API and frontend service windows"
  "$HOME/.local/bin/interview-restart"
fi

interview_ok "Interview dependencies and build outputs are ready"
SETUPEOF

install_interview_file "$interview_bin_dir/interview-start" 700 <<'STARTEOF'
#!/bin/bash
set -euo pipefail
umask 077

# shellcheck source=/dev/null
source "$HOME/.local/libexec/hive/technical-interview/common.sh"

if ! interview_backend_dependencies_ready || ! interview_frontend_dependencies_ready; then
  interview_error "Dependencies are not ready; run interview-setup first."
  exit 1
fi

credential_unsets=""
credential_env_arguments=()
for forbidden_name in "${INTERVIEW_FORBIDDEN_CREDENTIALS[@]}"; do
  credential_unsets+=" -u $forbidden_name"
  credential_env_arguments+=(-u "$forbidden_name")
done
api_command="exec env${credential_unsets} '$INTERVIEW_VENV/bin/uvicorn' app.main:app --reload --host 127.0.0.1 --port 8000"
web_command="exec env${credential_unsets} NPM_CONFIG_USERCONFIG=/dev/null npm run dev -- --host 127.0.0.1 --port 3000"

tmux_without_credentials() {
  env "${credential_env_arguments[@]}" tmux "$@"
}

window_exists() {
  tmux list-windows -t "$INTERVIEW_SESSION" -F '#{window_name}' 2>/dev/null \
    | grep -Fqx -- "$1"
}

service_window_ready() {
  local window_name=$1
  local working_directory=$2
  local service_command=$3
  local service_url=$4
  local pane_dead

  if ! window_exists "$window_name"; then
    tmux_without_credentials new-window -d -t "$INTERVIEW_SESSION:" -n "$window_name" \
      -c "$working_directory" "$service_command"
    interview_ok "Created tmux window: $window_name"
    return 0
  fi

  pane_dead="$(tmux list-panes -t "$INTERVIEW_SESSION:$window_name" -F '#{pane_dead}' | sed -n '1p')"
  if [ "$pane_dead" = "1" ]; then
    tmux_without_credentials respawn-window -k -t "$INTERVIEW_SESSION:$window_name" \
      -c "$working_directory" "$service_command"
    interview_ok "Restarted stopped tmux service window: $window_name"
  elif ! curl --fail --silent --max-time 3 "$service_url" >/dev/null 2>&1; then
    tmux_without_credentials respawn-window -k -t "$INTERVIEW_SESSION:$window_name" \
      -c "$working_directory" "$service_command"
    interview_ok "Restarted unhealthy tmux service window: $window_name"
  else
    interview_ok "Preserving active tmux window: $window_name"
  fi
}

interactive_window_present() {
  local window_name=$1
  if window_exists "$window_name"; then
    interview_ok "Preserving tmux window and history: $window_name"
  else
    tmux_without_credentials new-window -d -t "$INTERVIEW_SESSION:" -n "$window_name" \
      -c "$INTERVIEW_REPOSITORY"
    interview_ok "Created tmux window: $window_name"
  fi
}

if tmux has-session -t "$INTERVIEW_SESSION" 2>/dev/null; then
  interview_ok "Preserving existing tmux session: $INTERVIEW_SESSION"
else
  tmux_without_credentials new-session -d -s "$INTERVIEW_SESSION" -n work \
    -c "$INTERVIEW_REPOSITORY"
  interview_ok "Created tmux session: $INTERVIEW_SESSION"
fi

tmux set-option -t "$INTERVIEW_SESSION" remain-on-exit on
for forbidden_name in "${INTERVIEW_FORBIDDEN_CREDENTIALS[@]}"; do
  tmux set-environment -t "$INTERVIEW_SESSION" -u "$forbidden_name" 2>/dev/null || true
  tmux set-environment -g -u "$forbidden_name" 2>/dev/null || true
done

interactive_window_present work
service_window_ready api "$INTERVIEW_BACKEND" "$api_command" "http://127.0.0.1:8000/hello"
service_window_ready web "$INTERVIEW_FRONTEND" "$web_command" "http://127.0.0.1:3000"
interactive_window_present ai
tmux select-window -t "$INTERVIEW_SESSION:work" 2>/dev/null || true

service_failures=0
interview_wait_url "API" "http://127.0.0.1:8000/hello" 60 || service_failures=$((service_failures + 1))
interview_wait_url "Frontend" "http://127.0.0.1:3000" 60 || service_failures=$((service_failures + 1))

if ((service_failures > 0)); then
  interview_error "One or more services failed to become ready; inspect tmux windows api and web."
  exit 1
fi

interview_ok "Interview tmux session is ready"
STARTEOF

install_interview_file "$interview_bin_dir/interview-restart" 700 <<'RESTARTEOF'
#!/bin/bash
set -euo pipefail
umask 077

# shellcheck source=/dev/null
source "$HOME/.local/libexec/hive/technical-interview/common.sh"

if ! tmux has-session -t "$INTERVIEW_SESSION" 2>/dev/null; then
  interview_error "Interview tmux session does not exist; run interview-start."
  exit 1
fi
if ! interview_backend_dependencies_ready || ! interview_frontend_dependencies_ready; then
  interview_error "Dependencies are not ready; run interview-setup first."
  exit 1
fi

credential_unsets=""
credential_env_arguments=()
for forbidden_name in "${INTERVIEW_FORBIDDEN_CREDENTIALS[@]}"; do
  credential_unsets+=" -u $forbidden_name"
  credential_env_arguments+=(-u "$forbidden_name")
done
api_command="exec env${credential_unsets} '$INTERVIEW_VENV/bin/uvicorn' app.main:app --reload --host 127.0.0.1 --port 8000"
web_command="exec env${credential_unsets} NPM_CONFIG_USERCONFIG=/dev/null npm run dev -- --host 127.0.0.1 --port 3000"

restart_service_window() {
  local window_name=$1
  local working_directory=$2
  local service_command=$3
  if tmux list-windows -t "$INTERVIEW_SESSION" -F '#{window_name}' | grep -Fqx -- "$window_name"; then
    env "${credential_env_arguments[@]}" \
      tmux respawn-window -k -t "$INTERVIEW_SESSION:$window_name" \
      -c "$working_directory" "$service_command"
  else
    env "${credential_env_arguments[@]}" \
      tmux new-window -d -t "$INTERVIEW_SESSION:" -n "$window_name" \
      -c "$working_directory" "$service_command"
  fi
  interview_ok "Restarted interview service window: $window_name"
}

restart_service_window api "$INTERVIEW_BACKEND" "$api_command"
restart_service_window web "$INTERVIEW_FRONTEND" "$web_command"

interview_wait_url "API" "http://127.0.0.1:8000/hello" 60
interview_wait_url "Frontend" "http://127.0.0.1:3000" 60
interview_ok "Working and AI windows were preserved"
RESTARTEOF

install_interview_file "$interview_bin_dir/interview-stop" 700 <<'STOPEOF'
#!/bin/bash
set -euo pipefail

# shellcheck source=/dev/null
source "$HOME/.local/libexec/hive/technical-interview/common.sh"

if tmux has-session -t "$INTERVIEW_SESSION" 2>/dev/null; then
  tmux kill-session -t "$INTERVIEW_SESSION"
  interview_ok "Stopped only the $INTERVIEW_SESSION tmux session"
else
  interview_ok "Interview tmux session is already stopped"
fi
STOPEOF

install_interview_file "$interview_bin_dir/interview-status" 700 <<'STATUSEOF'
#!/bin/bash
set -euo pipefail

# shellcheck source=/dev/null
source "$HOME/.local/libexec/hive/technical-interview/common.sh"

printf 'Interview repository: %s\n' "$INTERVIEW_REPOSITORY"
if [ -d "$INTERVIEW_REPOSITORY/.git" ]; then
  printf 'Repository commit: %s\n' "$(interview_repository_commit 2>/dev/null || printf unknown)"
  if interview_git_clean; then
    printf 'Git status: clean\n'
  else
    printf 'Git status: dirty (preserved)\n'
    /usr/bin/git -c core.fsmonitor=false -c core.hooksPath=/dev/null \
      -C "$INTERVIEW_REPOSITORY" status --short
  fi
  printf 'Remote state: %s\n' "$(interview_remote_default_state)"
else
  printf 'Repository commit: missing\n'
  printf 'Git status: unavailable\n'
fi

if interview_backend_dependencies_ready; then
  printf 'Backend dependencies: ready\n'
else
  printf 'Backend dependencies: refresh required\n'
fi
if interview_frontend_dependencies_ready; then
  printf 'Frontend dependencies: ready\n'
else
  printf 'Frontend dependencies: refresh required\n'
fi
printf 'Virtual environment: %s\n' "$(interview_read_state venv-method 2>/dev/null || printf unknown)"

if tmux has-session -t "$INTERVIEW_SESSION" 2>/dev/null; then
  printf 'tmux session: running\n'
  tmux list-windows -t "$INTERVIEW_SESSION" -F '  #{window_name}: pane_dead=#{pane_dead}'
else
  printf 'tmux session: stopped\n'
fi

if curl --fail --silent --max-time 3 http://127.0.0.1:8000/hello >/dev/null 2>&1; then
  printf 'API: responding\n'
else
  printf 'API: unavailable\n'
fi
if curl --fail --silent --max-time 3 http://127.0.0.1:3000 >/dev/null 2>&1; then
  printf 'Frontend: responding\n'
else
  printf 'Frontend: unavailable\n'
fi

printf 'Tool versions:\n'
printf '  Python: %s\n' "$(interview_version_or_missing python3 python3 --version)"
printf '  Node: %s\n' "$(interview_version_or_missing node node --version)"
printf '  npm: %s\n' "$(interview_version_or_missing npm npm --version)"
printf '  SQLite: %s\n' "$(interview_version_or_missing "$INTERVIEW_SQLITE_BIN" "$INTERVIEW_SQLITE_BIN" --version)"
printf '  Git: %s\n' "$(interview_version_or_missing git git --version)"
printf '  make: %s\n' "$(interview_version_or_missing make make --version)"
printf '  ripgrep: %s\n' "$(interview_version_or_missing "$INTERVIEW_RG_BIN" "$INTERVIEW_RG_BIN" --version)"
printf '  Claude Code: %s\n' "$(interview_claude_version_or_missing)"
printf '  Codex: %s\n' "$(interview_version_or_missing "$INTERVIEW_CODEX_BIN" "$INTERVIEW_CODEX_BIN" --version)"
printf '  Playwright MCP: %s\n' "$(interview_version_or_missing "$INTERVIEW_PLAYWRIGHT_MCP_BIN" "$INTERVIEW_PLAYWRIGHT_MCP_BIN" --version)"
printf '  Bun: %s\n' "$(interview_version_or_missing "$INTERVIEW_BUN_BIN" "$INTERVIEW_BUN_BIN" --version)"
printf '  pnpm: %s\n' "$(interview_version_or_missing "$INTERVIEW_PNPM_BIN" "$INTERVIEW_PNPM_BIN" --version)"
printf '  Chrome: %s\n' "$(interview_version_or_missing "$INTERVIEW_CHROME_BIN" "$INTERVIEW_CHROME_BIN" --version)"
printf '  tmux: %s\n' "$(interview_version_or_missing tmux tmux -V)"

printf 'Forbidden credential variables present (names only):'
credential_count=0
for credential_name in "${INTERVIEW_FORBIDDEN_CREDENTIALS[@]}"; do
  if printenv "$credential_name" >/dev/null 2>&1 \
    || { tmux has-session -t "$INTERVIEW_SESSION" 2>/dev/null \
      && tmux show-environment -t "$INTERVIEW_SESSION" "$credential_name" >/dev/null 2>&1; } \
    || { tmux has-session -t "$INTERVIEW_SESSION" 2>/dev/null \
      && tmux show-environment -g "$credential_name" >/dev/null 2>&1; }; then
    printf ' %s' "$credential_name"
    credential_count=$((credential_count + 1))
  fi
done
if ((credential_count == 0)); then
  printf ' none'
fi
printf '\n'

if interview_github_authenticated; then
  printf 'GitHub CLI authentication: PRESENT\n'
elif interview_github_unauthenticated; then
  printf 'GitHub CLI authentication: absent\n'
else
  printf 'GitHub CLI authentication: UNKNOWN (readiness fails)\n'
fi
coder_auth_state="$(interview_coder_auth_state)"
case "$coder_auth_state" in
  authenticated) printf 'Coder orchestration authentication: PRESENT\n' ;;
  unauthenticated) printf 'Coder orchestration authentication: absent\n' ;;
  *) printf 'Coder orchestration authentication: UNKNOWN (readiness fails)\n' ;;
esac
if interview_hive_github_helper_present; then
  printf 'Hive GitHub credential helper: PRESENT\n'
else
  printf 'Hive GitHub credential helper: absent\n'
fi
if interview_git_transport_credentials_absent; then
  printf 'Persisted Git transport credentials: absent\n'
else
  printf 'Persisted Git transport credentials: PRESENT or unsafe (names only; readiness fails)\n'
fi
if interview_claude_authentication_absent; then
  printf 'Persisted Claude authentication: absent\n'
else
  printf 'Persisted Claude authentication: PRESENT or unsafe (path names only; readiness fails)\n'
fi
if interview_package_authentication_absent; then
  printf 'Persisted package-manager authentication: absent\n'
else
  printf 'Persisted package-manager authentication: PRESENT or unsafe (path names only; readiness fails)\n'
fi
STATUSEOF

install_interview_file "$interview_bin_dir/interview-check" 700 <<'CHECKEOF'
#!/bin/bash
set -uo pipefail
umask 077

# shellcheck source=/dev/null
source "$HOME/.local/libexec/hive/technical-interview/common.sh"

check_failures=0
check_results=()

run_check() {
  local label=$1
  shift
  if "$@"; then
    printf '[PASS] %s\n' "$label"
    check_results+=("PASS|$label")
  else
    printf '[FAIL] %s\n' "$label" >&2
    check_results+=("FAIL|$label")
    check_failures=$((check_failures + 1))
  fi
}

check_repository_exists() {
  [ -d "$INTERVIEW_REPOSITORY/.git" ]
}

check_npm() {
  interview_npm --version >/dev/null 2>&1
}

check_backend_imports() {
  (
    cd "$INTERVIEW_BACKEND" 2>/dev/null || exit 1
    "$INTERVIEW_VENV/bin/python" -c 'import fastapi, httpx, pytest, uvicorn; import app.main'
  ) >/dev/null 2>&1
}

check_backend_tests() {
  (
    cd "$INTERVIEW_BACKEND" 2>/dev/null || exit 1
    "$INTERVIEW_VENV/bin/pytest" -q
  )
}

check_frontend_build() {
  (
    cd "$INTERVIEW_FRONTEND" 2>/dev/null || exit 1
    interview_npm run build
  )
}

check_command() {
  command -v "$1" >/dev/null 2>&1
}

check_api() {
  curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8000/hello >/dev/null
}

check_frontend() {
  curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3000 >/dev/null
}

check_forbidden_credentials_absent() {
  ! interview_forbidden_environment_present && ! interview_forbidden_tmux_environment_present
}

check_github_not_authenticated() {
  interview_github_unauthenticated
}

check_coder_not_authenticated() {
  interview_coder_unauthenticated
}

check_hive_helper_absent() {
  ! interview_hive_github_helper_present
}

check_git_transport_credentials_absent() {
  interview_git_transport_credentials_absent
}

check_claude_authentication_absent() {
  interview_claude_authentication_absent
}

check_package_authentication_absent() {
  interview_package_authentication_absent
}

run_check "expected repository exists" check_repository_exists
run_check "origin is the expected public HTTPS repository" interview_origin_is_expected
run_check "Python is at least 3.12" interview_python_supported
run_check "Node.js is at least 20" interview_node_supported
run_check "npm is functional" check_npm
run_check "backend virtual environment exists" test -x "$INTERVIEW_VENV/bin/python"
run_check "backend dependency hash is current" interview_backend_dependencies_ready
run_check "required Python modules import" check_backend_imports
run_check "backend pytest suite passes" check_backend_tests
run_check "frontend dependency hash is current" interview_frontend_dependencies_ready
run_check "frontend production build passes" check_frontend_build
run_check "shell-inaccessible read-only Claude runtime is ready" interview_claude_ready
run_check "Codex $INTERVIEW_CODEX_VERSION is pinned" \
  interview_managed_tool_ready \
  codex "$INTERVIEW_CODEX_VERSION" .bin/codex "$INTERVIEW_CODEX_BASELINE_TARGET"
run_check "Playwright MCP $INTERVIEW_PLAYWRIGHT_MCP_VERSION is pinned" \
  interview_managed_tool_ready \
  playwright-mcp "$INTERVIEW_PLAYWRIGHT_MCP_VERSION" .bin/playwright-mcp
run_check "Bun $INTERVIEW_BUN_VERSION is pinned" \
  interview_managed_tool_ready \
  bun "$INTERVIEW_BUN_VERSION" @oven/bun-linux-x64/bin/bun "$INTERVIEW_BUN_BASELINE_TARGET"
run_check "pnpm $INTERVIEW_PNPM_VERSION is pinned" \
  interview_managed_tool_ready pnpm "$INTERVIEW_PNPM_VERSION" .bin/pnpm
run_check "Chrome is installed" test -x "$INTERVIEW_CHROME_BIN"
run_check "managed browser helper paths are ready" interview_browser_helpers_ready
run_check "tmux is installed" check_command tmux
run_check "SQLite CLI is installed" test -x "$INTERVIEW_SQLITE_BIN"
run_check "ripgrep is installed" test -x "$INTERVIEW_RG_BIN"
run_check "API responds at /hello" check_api
run_check "frontend responds on port 3000" check_frontend
run_check "working tree contains no unexpected files" interview_git_clean
run_check "interactive shell credential scrub hooks are installed" interview_shell_scrub_ready
run_check "managed tool directory chains are local" interview_managed_directories_ready
run_check "managed agent context paths are ready" interview_agent_context_ready
run_check "managed Playwright MCP configuration is ready" interview_mcp_configuration_ready
run_check "forbidden credential variables are absent" check_forbidden_credentials_absent
run_check "GitHub CLI is not authenticated" check_github_not_authenticated
run_check "Coder CLI is not authenticated for orchestration" check_coder_not_authenticated
run_check "Hive GitHub credential helper is absent" check_hive_helper_absent
run_check "persisted Git and SSH transport credentials are absent" \
  check_git_transport_credentials_absent
run_check "persisted Claude authentication is absent" \
  check_claude_authentication_absent
run_check "persisted package-manager authentication is absent" \
  check_package_authentication_absent

report_temporary="$(mktemp "$HOME/.INTERVIEW_READY.XXXXXX")"
repository_commit="$(interview_repository_commit 2>/dev/null || printf unavailable)"
venv_method="$(interview_read_state venv-method 2>/dev/null || printf unavailable)"
if ((check_failures == 0)); then
  report_result="INTERVIEW WORKSPACE READY"
  remaining_action="At interview time, open the owner-only Interview Claude app and enter the temporary key at the masked prompt."
else
  report_result="INTERVIEW WORKSPACE NOT READY"
  remaining_action="Resolve the failed checks above, then rerun interview-setup, interview-start, and interview-check."
fi

{
  printf '# Interview Workspace Readiness\n\n'
  printf -- '- Generated: %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  printf -- '- Result: **%s**\n' "$report_result"
  printf -- '- Repository: `%s`\n' "$INTERVIEW_REPOSITORY"
  printf -- '- Commit: `%s`\n' "$repository_commit"
  printf -- '- Virtual environment: %s\n' "$venv_method"
  if [ -d "$INTERVIEW_REPOSITORY/.git" ]; then
    printf -- '- Remote state: %s\n' "$(interview_remote_default_state)"
  fi
  printf '\n## Versions\n\n'
  printf -- '- Python: %s\n' "$(interview_version_or_missing python3 python3 --version)"
  printf -- '- Node: %s\n' "$(interview_version_or_missing node node --version)"
  printf -- '- npm: %s\n' "$(interview_version_or_missing npm npm --version)"
  printf -- '- SQLite: %s\n' "$(interview_version_or_missing "$INTERVIEW_SQLITE_BIN" "$INTERVIEW_SQLITE_BIN" --version)"
  printf -- '- Git: %s\n' "$(interview_version_or_missing git git --version)"
  printf -- '- make: %s\n' "$(interview_version_or_missing make make --version)"
  printf -- '- ripgrep: %s\n' "$(interview_version_or_missing "$INTERVIEW_RG_BIN" "$INTERVIEW_RG_BIN" --version)"
  printf -- '- Claude Code: %s\n' "$(interview_claude_version_or_missing)"
  printf -- '- Codex: %s\n' "$(interview_version_or_missing "$INTERVIEW_CODEX_BIN" "$INTERVIEW_CODEX_BIN" --version)"
  printf -- '- Playwright MCP: %s\n' "$(interview_version_or_missing "$INTERVIEW_PLAYWRIGHT_MCP_BIN" "$INTERVIEW_PLAYWRIGHT_MCP_BIN" --version)"
  printf -- '- Bun: %s\n' "$(interview_version_or_missing "$INTERVIEW_BUN_BIN" "$INTERVIEW_BUN_BIN" --version)"
  printf -- '- pnpm: %s\n' "$(interview_version_or_missing "$INTERVIEW_PNPM_BIN" "$INTERVIEW_PNPM_BIN" --version)"
  printf -- '- Chrome: %s\n' "$(interview_version_or_missing "$INTERVIEW_CHROME_BIN" "$INTERVIEW_CHROME_BIN" --version)"
  printf -- '- tmux: %s\n' "$(interview_version_or_missing tmux tmux -V)"
  printf '\n## Checks performed\n\n'
  for result_entry in "${check_results[@]}"; do
    printf -- '- [%s] %s\n' "${result_entry%%|*}" "${result_entry#*|}"
  done
  printf '\n## Services\n\n'
  printf -- '- Interview App: http://localhost:3000\n'
  printf -- '- API Docs: http://localhost:8000/docs\n'
  printf -- '- API health: http://127.0.0.1:8000/hello\n'
  printf '\n## Helper commands\n\n'
  printf -- '- `interview-setup` — repair pinned tools, refresh changed dependencies, test, and build\n'
  printf -- '- `interview-start` — create or preserve the detached `interview` tmux session\n'
  printf -- '- `interview-restart` — restart only API and frontend windows\n'
  printf -- '- `interview-stop` — stop only the interview session\n'
  printf -- '- `interview-status` — show non-secret state\n'
  printf -- '- `interview-check` — rerun this strict readiness check\n'
  printf -- '- `interview-claude` or the **Interview Claude** Coder app — use the immutable client to reach the shell-inaccessible protected runtime\n'
  printf '\n## Credential state\n\n'
  printf 'Only credential names are reported; values are never recorded. Required pre-interview state: '
  printf 'Anthropic API/auth and Claude OAuth credentials (environment and persisted login), package-manager authentication, GitHub, Coder agent/session, Git/SSH transport, Realm, and RunComfy credentials absent; GitHub and Coder CLIs unauthenticated.\n'
  printf '\n## Remaining action\n\n%s\n' "$remaining_action"
} > "$report_temporary"
chmod 600 "$report_temporary"
mv -fT -- "$report_temporary" "$INTERVIEW_REPORT"

printf '\n%s\n' "$report_result"
printf 'Readiness report: %s\n' "$INTERVIEW_REPORT"
if ((check_failures > 0)); then
  exit 1
fi
CHECKEOF

# The currently pinned browser image predates the system sqlite3 package. Python
# 3.12+ exposes the same SQLite shell through its standard library, so provide a
# narrow managed compatibility command until the post-merge image digest lands.
sqlite_compatibility_helper="$interview_bin_dir/sqlite3"
if [ -x /usr/bin/sqlite3 ] || [ -x /usr/local/bin/sqlite3 ]; then
  if [ -f "$sqlite_compatibility_helper" ] \
    && [ "$(sed -n '2p' "$sqlite_compatibility_helper")" = "# hive-managed-interview-sqlite:v1" ]; then
    rm -f -- "$sqlite_compatibility_helper"
  fi
elif ! command -v sqlite3 >/dev/null 2>&1; then
  install_interview_file "$sqlite_compatibility_helper" 700 <<'SQLITEEOF'
#!/bin/bash
# hive-managed-interview-sqlite:v1
set -euo pipefail
exec python3 -m sqlite3 "$@"
SQLITEEOF
fi

install_interview_file "$interview_libexec_dir/prepare-tools.sh" 700 <<'TOOLSEOF'
#!/bin/bash
set -euo pipefail
umask 077

unset BASH_ENV ENV CDPATH LD_LIBRARY_PATH LD_PRELOAD
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
unset CLAUDE_CONFIG_DIR CLAUDE_SECURESTORAGE_CONFIG_DIR
unset NPM_TOKEN NODE_AUTH_TOKEN
unset NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG
unset npm_config_userconfig npm_config_globalconfig
unset GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN
unset GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_PROXY_COMMAND GIT_SSH
unset SSH_AUTH_SOCK SSH_AGENT_PID SSH_ASKPASS_REQUIRE
unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN

# shellcheck source=/dev/null
source "$HOME/.local/libexec/hive/technical-interview/common.sh"

interview_bin_dir="$HOME/.local/bin"
interview_state_dir="$INTERVIEW_STATE_DIR"
interview_ripgrep_version="$INTERVIEW_RIPGREP_VERSION"
interview_codex_version="$INTERVIEW_CODEX_VERSION"
interview_playwright_mcp_version="$INTERVIEW_PLAYWRIGHT_MCP_VERSION"
interview_bun_version="$INTERVIEW_BUN_VERSION"
interview_pnpm_version="$INTERVIEW_PNPM_VERSION"

install_interview_ripgrep() {
  local managed_binary="$interview_bin_dir/rg"
  local tool_root="$interview_state_dir/ripgrep-$interview_ripgrep_version"
  local packaged_binary="$tool_root/node_modules/@vscode/ripgrep-linux-x64/bin/rg"
  local existing_target system_binary

  for system_binary in /usr/bin/rg /usr/local/bin/rg; do
    if [ -x "$system_binary" ] && "$system_binary" --version >/dev/null 2>&1; then
      if [ -L "$managed_binary" ] \
        && [[ "$(readlink "$managed_binary")" == "$interview_state_dir"/ripgrep-* ]]; then
        rm -f -- "$managed_binary"
      fi
      return 0
    fi
  done

  if [ -L "$managed_binary" ]; then
    existing_target="$(readlink -- "$managed_binary")"
    if [ "$existing_target" != "$packaged_binary" ]; then
      interview_warn "Preserving unexpected rg command at $managed_binary"
      return 1
    fi
    if [ -x "$packaged_binary" ] && "$packaged_binary" --version >/dev/null 2>&1; then
      return 0
    fi
    rm -f -- "$managed_binary"
  elif [ -e "$managed_binary" ]; then
    interview_warn "Preserving unexpected rg command at $managed_binary"
    return 1
  fi
  interview_ensure_local_directory "$tool_root" || return 1
  if [ ! -x "$packaged_binary" ] || ! "$packaged_binary" --version >/dev/null 2>&1; then
    command -v npm >/dev/null 2>&1 || return 1
    rm -rf -- "$tool_root"
    interview_ensure_local_directory "$tool_root" || return 1
    interview_npm install \
      --prefix "$tool_root" \
      --ignore-scripts \
      --no-audit \
      --no-fund \
      --no-package-lock \
      --no-save \
      "@vscode/ripgrep@$interview_ripgrep_version" >/dev/null
  fi
  if [ ! -x "$packaged_binary" ] || ! "$packaged_binary" --version >/dev/null 2>&1; then
    return 1
  fi
  ln -s -- "$packaged_binary" "$managed_binary"
  "$managed_binary" --version >/dev/null 2>&1
}

tool_failures=0
if ! install_interview_ripgrep; then
  printf '[warn] ripgrep could not be prepared; interview-check will report it missing.\n' >&2
  tool_failures=$((tool_failures + 1))
fi

install_interview_npm_tool() {
  local label=$1
  local command_name=$2
  local package_name=$3
  local package_version=$4
  local package_binary=$5
  local baseline_target=${6:-}
  local managed_binary="$interview_bin_dir/$command_name"
  local tools_root="$interview_state_dir/tools"
  local tool_root="$tools_root/$command_name-$package_version"
  local installed_binary="$tool_root/node_modules/$package_binary"
  local installed_payload="$tool_root/node_modules"
  local existing_target payload_root state_name

  state_name="tool-$command_name-$package_version.sha256"

  interview_ensure_local_directory "$tool_root" || return 1

  if [ -L "$managed_binary" ]; then
    existing_target="$(readlink -- "$managed_binary")"
    if [ "$existing_target" = "$installed_binary" ] \
      && interview_tool_version_matches "$managed_binary" "$package_version" \
      && interview_tool_runtime_works "$command_name" "$managed_binary" \
      && interview_tool_payload_ready \
        "$command_name" "$package_version" "$installed_payload"; then
      printf '[ok] %s %s is already available\n' "$label" "$package_version"
      return 0
    fi
    if [ -n "$baseline_target" ] \
      && [ "$existing_target" = "$baseline_target" ] \
      && interview_tool_version_matches "$managed_binary" "$package_version" \
      && interview_tool_runtime_works "$command_name" "$managed_binary"; then
      payload_root="$(
        interview_tool_payload_root \
          "$command_name" "$existing_target" "$installed_binary" \
          "$baseline_target" "$managed_binary"
      )" || return 1
      if interview_tool_payload_ready "$command_name" "$package_version" "$payload_root"; then
        printf '[ok] %s %s is provided by the pinned image baseline\n' \
          "$label" "$package_version"
        return 0
      fi
      if ! interview_read_state "$state_name" >/dev/null 2>&1; then
        interview_record_tool_payload "$command_name" "$package_version" "$payload_root" \
          || return 1
        printf '[ok] %s %s is provided by the pinned image baseline\n' \
          "$label" "$package_version"
        return 0
      fi
    fi
    if [[ "$existing_target" == "$tools_root"/* ]] \
      || { [ -n "$baseline_target" ] && [ "$existing_target" = "$baseline_target" ]; }; then
      rm -f -- "$managed_binary"
    else
      interview_warn "Preserving unexpected $command_name command at $managed_binary"
      return 1
    fi
  elif [ -e "$managed_binary" ]; then
    interview_warn "Preserving unexpected $command_name command at $managed_binary"
    return 1
  fi

  if ! interview_tool_version_matches "$installed_binary" "$package_version" \
    || ! interview_tool_runtime_works "$command_name" "$installed_binary" \
    || ! interview_tool_payload_ready \
      "$command_name" "$package_version" "$installed_payload"; then
    command -v npm >/dev/null 2>&1 || return 1
    if [ -e "$tool_root" ] || [ -L "$tool_root" ]; then
      rm -rf -- "$tool_root"
    fi
    interview_ensure_local_directory "$tool_root" || return 1
    printf '[install] %s %s\n' "$label" "$package_version"
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 interview_npm install \
      --prefix "$tool_root" \
      --ignore-scripts \
      --no-audit \
      --no-fund \
      --no-package-lock \
      --no-save \
      "$package_name@$package_version" >/dev/null
    interview_record_tool_payload \
      "$command_name" "$package_version" "$installed_payload" || return 1
  fi

  [ -x "$installed_binary" ] || return 1
  ln -s -- "$installed_binary" "$managed_binary"
  interview_tool_version_matches "$managed_binary" "$package_version" \
    && interview_tool_runtime_works "$command_name" "$managed_binary" \
    && interview_tool_payload_ready \
      "$command_name" "$package_version" "$installed_payload"
}

install_interview_npm_tool \
  "Codex CLI" codex @openai/codex "$interview_codex_version" .bin/codex \
  "../lib/node_modules/@openai/codex/bin/codex.js" \
  || tool_failures=$((tool_failures + 1))
install_interview_npm_tool \
  "Playwright MCP" playwright-mcp @playwright/mcp "$interview_playwright_mcp_version" .bin/playwright-mcp \
  || tool_failures=$((tool_failures + 1))
install_interview_npm_tool \
  "Bun" bun @oven/bun-linux-x64 "$interview_bun_version" @oven/bun-linux-x64/bin/bun \
  "$HOME/.bun/bin/bun" \
  || tool_failures=$((tool_failures + 1))
install_interview_npm_tool \
  "pnpm" pnpm pnpm "$interview_pnpm_version" .bin/pnpm \
  || tool_failures=$((tool_failures + 1))
if ((tool_failures > 0)); then
  printf '[warn] %s interview tool(s) could not be prepared; interview-check will report them missing.\n' \
    "$tool_failures" >&2
  exit 1
fi
TOOLSEOF

if ! "$interview_libexec_dir/prepare-tools.sh"; then
  printf '[warn] Interview tools are incomplete; rerun interview-setup after network access is restored.\n' \
    >&2
fi

if [ "${HIVE_INTERVIEW_SKIP_AUTOSTART:-false}" = "true" ]; then
  printf '[ok] Interview helper commands installed; automatic checks skipped by test mode\n'
  exit 0
fi

setup_status=0
start_status=0
check_status=0
"$interview_bin_dir/interview-setup" || setup_status=$?
"$interview_bin_dir/interview-start" || start_status=$?

# The protected runtime stages independently so a registry outage cannot hide
# the main recovery terminal. Give its immutable service a bounded opportunity
# to publish a fresh heartbeat before the final all-or-nothing readiness pass.
for _claude_attempt in {1..60}; do
  interview_claude_ready && break
  sleep 2
done

"$interview_bin_dir/interview-check" || check_status=$?

if ((setup_status != 0 || start_status != 0 || check_status != 0)); then
  printf '[warn] Interview workspace startup completed with readiness failures.\n' >&2
  printf '[warn] Review ~/INTERVIEW_READY.md and rerun interview-setup, interview-start, and interview-check.\n' >&2
else
  printf '[ok] INTERVIEW WORKSPACE READY\n'
fi

# Readiness failures stay visible without blocking terminal access.
exit 0
