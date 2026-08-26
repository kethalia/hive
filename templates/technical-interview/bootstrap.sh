#!/usr/bin/env bash
set -euo pipefail

umask 077

unset ANTHROPIC_API_KEY GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN
unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN

interview_bin_dir="$HOME/.local/bin"
interview_libexec_dir="$HOME/.local/libexec/hive/technical-interview"
interview_state_dir="$HOME/.local/state/hive/technical-interview"
interview_ripgrep_version="1.18.0"
interview_codex_version="0.149.1"
interview_playwright_mcp_version="0.0.79"
interview_bun_version="1.4.0"
interview_pnpm_version="10.32.1"

mkdir -p "$interview_bin_dir" "$interview_libexec_dir" "$interview_state_dir"
chmod 700 "$interview_bin_dir" "$interview_libexec_dir" "$interview_state_dir"

install_interview_file() {
  local destination=$1
  local mode=$2
  local destination_directory temporary_file

  destination_directory="$(dirname -- "$destination")"
  mkdir -p "$destination_directory"
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

install_interview_file "$interview_libexec_dir/common.sh" 600 <<'COMMONEOF'
#!/usr/bin/env bash

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
INTERVIEW_CODEX_BASELINE_TARGET="../lib/node_modules/@openai/codex/bin/codex.js"
INTERVIEW_BUN_BASELINE_TARGET="$HOME/.bun/bin/bun"
INTERVIEW_FORBIDDEN_CREDENTIALS=(
  ANTHROPIC_API_KEY
  GH_TOKEN
  GITHUB_TOKEN
  CODER_AGENT_TOKEN
  CODER_SESSION_TOKEN
  REALM_VISUAL_REVIEW_API_KEY
  RUNCOMFY_API_TOKEN
)

mkdir -p "$INTERVIEW_STATE_DIR"
chmod 700 "$INTERVIEW_STATE_DIR"

interview_scrub_credentials() {
  local variable_name
  for variable_name in "${INTERVIEW_FORBIDDEN_CREDENTIALS[@]}"; do
    unset "$variable_name"
  done
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

interview_managed_tool_ready() {
  local command_name=$1
  local expected_version=$2
  local package_binary=$3
  local baseline_target=${4:-}
  local managed_binary="$HOME/.local/bin/$command_name"
  local expected_binary="$INTERVIEW_STATE_DIR/tools/$command_name-$expected_version/node_modules/$package_binary"
  local actual_target

  [ -L "$managed_binary" ] || return 1
  actual_target="$(readlink -- "$managed_binary")"
  if [ "$actual_target" != "$expected_binary" ] \
    && { [ -z "$baseline_target" ] || [ "$actual_target" != "$baseline_target" ]; }; then
    return 1
  fi
  interview_tool_version_matches "$managed_binary" "$expected_version"
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
  [ -d "$INTERVIEW_REPOSITORY/.git" ] || return 1
  origin="$(git -C "$INTERVIEW_REPOSITORY" remote get-url origin 2>/dev/null || true)"
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

interview_backend_dependencies_ready() {
  local current_hash stored_hash
  [ -x "$INTERVIEW_VENV/bin/python" ] || return 1
  current_hash="$(interview_backend_hash 2>/dev/null || true)"
  stored_hash="$(interview_read_state backend-requirements.sha256 2>/dev/null || true)"
  [ -n "$current_hash" ] && [ "$current_hash" = "$stored_hash" ]
}

interview_frontend_dependencies_ready() {
  local current_hash stored_hash
  [ -x "$INTERVIEW_FRONTEND/node_modules/.bin/vite" ] || return 1
  current_hash="$(interview_frontend_hash 2>/dev/null || true)"
  stored_hash="$(interview_read_state frontend-manifests.sha256 2>/dev/null || true)"
  [ -n "$current_hash" ] && [ "$current_hash" = "$stored_hash" ] || return 1
  (
    cd "$INTERVIEW_FRONTEND"
    npm ls --all --silent >/dev/null 2>&1
  )
}

interview_git_clean() {
  [ -d "$INTERVIEW_REPOSITORY/.git" ] || return 1
  [ -z "$(git -C "$INTERVIEW_REPOSITORY" status --short --untracked-files=all)" ]
}

interview_anonymous_git() {
  local anonymous_home status

  anonymous_home="$(mktemp -d "$INTERVIEW_STATE_DIR/.anonymous-git.XXXXXX")" || return 1
  chmod 700 "$anonymous_home"
  if (
    cd "$anonymous_home"
    env \
      -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN \
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
  local_commit="$(git -C "$INTERVIEW_REPOSITORY" rev-parse HEAD 2>/dev/null || true)"
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
  [ -e "$HOME/.local/bin/coder-github-credential" ] && return 0
  git config --global --get-all credential.https://github.com.helper 2>/dev/null \
    | grep -Fqx -- "$HOME/.local/bin/coder-github-credential"
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

  [ -f "$environment_file" ] && [ ! -L "$environment_file" ] || return 1
  grep -qF '# hive-managed-interview-environment:v1' "$environment_file" || return 1
  grep -qF \
    'unset ANTHROPIC_API_KEY GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN' \
    "$environment_file" || return 1
  grep -qF 'unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN' \
    "$environment_file" || return 1

  for shell_file in "$HOME/.zshenv" "$HOME/.bashrc" "$HOME/.profile"; do
    [ -f "$shell_file" ] && [ ! -L "$shell_file" ] || return 1
    [ "$(sed -n '1p' "$shell_file")" = '# hive-interview-environment' ] || return 1
    [ "$(sed -n '2p' "$shell_file")" = \
      '[ ! -f "$HOME/.config/hive/interview-env.sh" ] || . "$HOME/.config/hive/interview-env.sh"' ] \
      || return 1
  done
}

interview_mcp_directories_safe() {
  local configuration_directory

  for configuration_directory in "$HOME/.codex" "$HOME/.claude"; do
    [ -d "$configuration_directory" ] && [ ! -L "$configuration_directory" ] || return 1
  done
}

interview_coder_authenticated() {
  command -v coder >/dev/null 2>&1 || return 1
  timeout 5s env -u CODER_AGENT_TOKEN -u CODER_SESSION_TOKEN coder list >/dev/null 2>&1
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
#!/usr/bin/env bash
set -euo pipefail
umask 077

# shellcheck source=/dev/null
source "$HOME/.local/libexec/hive/technical-interview/common.sh"

if [ ! -d "$INTERVIEW_REPOSITORY/.git" ]; then
  interview_error "Expected repository is missing: $INTERVIEW_REPOSITORY"
  interview_error "Rerun the workspace repository bootstrap after public HTTPS access is restored."
  exit 1
fi

if ! interview_origin_is_expected; then
  interview_error "Repository origin is not the expected public Proton.ai repository."
  git -C "$INTERVIEW_REPOSITORY" remote get-url origin 2>/dev/null || true
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
if ! npm --version >/dev/null 2>&1; then
  interview_error "npm is required but is not functional."
  exit 1
fi

mkdir -p "$INTERVIEW_STATE_DIR"
chmod 700 "$INTERVIEW_STATE_DIR"
dependencies_refreshed=false

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
    if [ ! -f "$fallback_root/virtualenv/__main__.py" ]; then
      mkdir -p "$fallback_root"
      python3 -m pip install \
        --disable-pip-version-check \
        --no-input \
        --target "$fallback_root" \
        "virtualenv==$INTERVIEW_VIRTUALENV_VERSION"
    fi
    PYTHONPATH="$fallback_root" python3 -m virtualenv "$INTERVIEW_VENV"
    interview_write_state venv-method "transitional virtualenv $INTERVIEW_VIRTUALENV_VERSION"
  fi
}

if [ ! -x "$INTERVIEW_VENV/bin/python" ]; then
  if [ -e "$INTERVIEW_VENV" ] || [ -L "$INTERVIEW_VENV" ]; then
    interview_error "Preserving an existing but unusable backend virtual environment: $INTERVIEW_VENV"
    interview_error "Move it aside manually after reviewing it, then rerun interview-setup."
    exit 1
  fi

  interview_create_backend_venv
fi

backend_hash="$(interview_backend_hash)"
stored_backend_hash="$(interview_read_state backend-requirements.sha256 2>/dev/null || true)"
if [ -n "$stored_backend_hash" ] && [ "$backend_hash" != "$stored_backend_hash" ]; then
  interview_ok "Recreating the managed backend virtual environment for changed dependencies"
  rm -rf -- "$INTERVIEW_VENV"
  interview_create_backend_venv
fi

if [ "$backend_hash" != "$stored_backend_hash" ] \
  || ! "$INTERVIEW_VENV/bin/python" -c 'import fastapi, httpx, pytest, uvicorn' >/dev/null 2>&1; then
  interview_ok "Installing backend dependencies"
  "$INTERVIEW_VENV/bin/python" -m pip install \
    --disable-pip-version-check \
    --no-input \
    -r "$INTERVIEW_BACKEND/requirements.txt"
  interview_write_state backend-requirements.sha256 "$backend_hash"
  dependencies_refreshed=true
else
  interview_ok "Backend dependencies match the stored manifest hash"
fi

frontend_hash="$(interview_frontend_hash)"
stored_frontend_hash="$(interview_read_state frontend-manifests.sha256 2>/dev/null || true)"
if [ "$frontend_hash" != "$stored_frontend_hash" ] \
  || [ ! -x "$INTERVIEW_FRONTEND/node_modules/.bin/vite" ] \
  || ! (
    cd "$INTERVIEW_FRONTEND"
    npm ls --all --silent >/dev/null 2>&1
  ); then
  interview_ok "Installing frontend dependencies"
  if [ -f "$INTERVIEW_FRONTEND/package-lock.json" ] \
    || [ -f "$INTERVIEW_FRONTEND/npm-shrinkwrap.json" ]; then
    (
      cd "$INTERVIEW_FRONTEND"
      npm ci --no-audit --no-fund
    )
  else
    (
      cd "$INTERVIEW_FRONTEND"
      npm install --no-package-lock --no-audit --no-fund
    )
  fi
  interview_write_state frontend-manifests.sha256 "$frontend_hash"
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
  npm run build
)

if interview_git_clean; then
  interview_ok "Repository working tree remains clean"
else
  interview_warn "Repository has candidate changes or unexpected generated files; preserving them unchanged"
  git -C "$INTERVIEW_REPOSITORY" status --short
fi

if [ "$dependencies_refreshed" = true ] \
  && tmux has-session -t "$INTERVIEW_SESSION" 2>/dev/null; then
  interview_ok "Dependencies changed; restarting only the API and frontend service windows"
  "$HOME/.local/bin/interview-restart"
fi

interview_ok "Interview dependencies and build outputs are ready"
SETUPEOF

install_interview_file "$interview_bin_dir/interview-start" 700 <<'STARTEOF'
#!/usr/bin/env bash
set -euo pipefail
umask 077

# shellcheck source=/dev/null
source "$HOME/.local/libexec/hive/technical-interview/common.sh"

if ! interview_backend_dependencies_ready || ! interview_frontend_dependencies_ready; then
  interview_error "Dependencies are not ready; run interview-setup first."
  exit 1
fi

api_command="exec env -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN -u CODER_AGENT_TOKEN -u CODER_SESSION_TOKEN -u REALM_VISUAL_REVIEW_API_KEY -u RUNCOMFY_API_TOKEN '$INTERVIEW_VENV/bin/uvicorn' app.main:app --reload --host 127.0.0.1 --port 8000"
web_command="exec env -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN -u CODER_AGENT_TOKEN -u CODER_SESSION_TOKEN -u REALM_VISUAL_REVIEW_API_KEY -u RUNCOMFY_API_TOKEN npm run dev -- --host 127.0.0.1 --port 3000"

tmux_without_credentials() {
  env -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN \
    -u CODER_AGENT_TOKEN -u CODER_SESSION_TOKEN \
    -u REALM_VISUAL_REVIEW_API_KEY -u RUNCOMFY_API_TOKEN tmux "$@"
}

window_exists() {
  tmux list-windows -t "$INTERVIEW_SESSION" -F '#{window_name}' 2>/dev/null \
    | grep -Fqx -- "$1"
}

service_window_ready() {
  local window_name=$1
  local working_directory=$2
  local service_command=$3
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
service_window_ready api "$INTERVIEW_BACKEND" "$api_command"
service_window_ready web "$INTERVIEW_FRONTEND" "$web_command"
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
#!/usr/bin/env bash
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

api_command="exec env -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN -u CODER_AGENT_TOKEN -u CODER_SESSION_TOKEN -u REALM_VISUAL_REVIEW_API_KEY -u RUNCOMFY_API_TOKEN '$INTERVIEW_VENV/bin/uvicorn' app.main:app --reload --host 127.0.0.1 --port 8000"
web_command="exec env -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN -u CODER_AGENT_TOKEN -u CODER_SESSION_TOKEN -u REALM_VISUAL_REVIEW_API_KEY -u RUNCOMFY_API_TOKEN npm run dev -- --host 127.0.0.1 --port 3000"

restart_service_window() {
  local window_name=$1
  local working_directory=$2
  local service_command=$3
  if tmux list-windows -t "$INTERVIEW_SESSION" -F '#{window_name}' | grep -Fqx -- "$window_name"; then
    env -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN \
      -u CODER_AGENT_TOKEN -u CODER_SESSION_TOKEN \
      -u REALM_VISUAL_REVIEW_API_KEY -u RUNCOMFY_API_TOKEN \
      tmux respawn-window -k -t "$INTERVIEW_SESSION:$window_name" \
      -c "$working_directory" "$service_command"
  else
    env -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN \
      -u CODER_AGENT_TOKEN -u CODER_SESSION_TOKEN \
      -u REALM_VISUAL_REVIEW_API_KEY -u RUNCOMFY_API_TOKEN \
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
#!/usr/bin/env bash
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
#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=/dev/null
source "$HOME/.local/libexec/hive/technical-interview/common.sh"

printf 'Interview repository: %s\n' "$INTERVIEW_REPOSITORY"
if [ -d "$INTERVIEW_REPOSITORY/.git" ]; then
  printf 'Repository commit: %s\n' "$(git -C "$INTERVIEW_REPOSITORY" rev-parse HEAD 2>/dev/null || printf unknown)"
  if interview_git_clean; then
    printf 'Git status: clean\n'
  else
    printf 'Git status: dirty (preserved)\n'
    git -C "$INTERVIEW_REPOSITORY" status --short
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
printf '  SQLite: %s\n' "$(interview_version_or_missing sqlite3 sqlite3 --version)"
printf '  Git: %s\n' "$(interview_version_or_missing git git --version)"
printf '  make: %s\n' "$(interview_version_or_missing make make --version)"
printf '  ripgrep: %s\n' "$(interview_version_or_missing rg rg --version)"
printf '  Claude Code: %s\n' "$(interview_version_or_missing claude claude --version)"
printf '  Codex: %s\n' "$(interview_version_or_missing codex codex --version)"
printf '  Playwright MCP: %s\n' "$(interview_version_or_missing playwright-mcp playwright-mcp --version)"
printf '  Bun: %s\n' "$(interview_version_or_missing bun bun --version)"
printf '  pnpm: %s\n' "$(interview_version_or_missing pnpm pnpm --version)"
printf '  Chrome: %s\n' "$(interview_version_or_missing google-chrome-stable google-chrome-stable --version)"
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
if interview_coder_authenticated; then
  printf 'Coder orchestration authentication: PRESENT\n'
else
  printf 'Coder orchestration authentication: absent\n'
fi
if interview_hive_github_helper_present; then
  printf 'Hive GitHub credential helper: PRESENT\n'
else
  printf 'Hive GitHub credential helper: absent\n'
fi
STATUSEOF

install_interview_file "$interview_bin_dir/interview-claude" 700 <<'CLAUDEEOF'
#!/usr/bin/env bash
set -euo pipefail
umask 077

# shellcheck source=/dev/null
source "$HOME/.local/libexec/hive/technical-interview/common.sh"

claude_arguments=()
while (($# > 0)); do
  case "$1" in
    --)
      shift
      claude_arguments+=("$@")
      break
      ;;
    *)
      claude_arguments+=("$1")
      shift
      ;;
  esac
done

if [ ! -d "$INTERVIEW_REPOSITORY/.git" ] || ! interview_origin_is_expected; then
  interview_error "Expected interview repository is unavailable or has the wrong origin."
  exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
  interview_error "Claude Code is not installed."
  exit 1
fi

if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
  interview_error "A controlling terminal is required for masked API-key input."
  exit 1
fi
printf 'Temporary Anthropic API key: ' > /dev/tty
IFS= read -r -s interview_key < /dev/tty
printf '\n' > /dev/tty
if [ -z "$interview_key" ]; then
  interview_error "No API key was provided."
  exit 1
fi

cd "$INTERVIEW_REPOSITORY"
unset GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN
unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN
export ANTHROPIC_API_KEY="$interview_key"
unset interview_key
exec claude "${claude_arguments[@]}"
CLAUDEEOF

install_interview_file "$interview_bin_dir/interview-check" 700 <<'CHECKEOF'
#!/usr/bin/env bash
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
  npm --version >/dev/null 2>&1
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
    npm run build
  )
}

check_command() {
  command -v "$1" >/dev/null 2>&1
}

check_version_command() {
  command -v "$1" >/dev/null 2>&1 && "$1" --version >/dev/null 2>&1
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
  ! interview_coder_authenticated
}

check_hive_helper_absent() {
  ! interview_hive_github_helper_present
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
run_check "Claude Code is functional" check_version_command claude
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
run_check "Chrome is installed" check_command google-chrome-stable
run_check "tmux is installed" check_command tmux
run_check "SQLite CLI is installed" check_command sqlite3
run_check "ripgrep is installed" check_command rg
run_check "API responds at /hello" check_api
run_check "frontend responds on port 3000" check_frontend
run_check "working tree contains no unexpected files" interview_git_clean
run_check "interactive shell credential scrub hooks are installed" interview_shell_scrub_ready
run_check "managed MCP configuration directories are local" interview_mcp_directories_safe
run_check "forbidden credential variables are absent" check_forbidden_credentials_absent
run_check "GitHub CLI is not authenticated" check_github_not_authenticated
run_check "Coder CLI is not authenticated for orchestration" check_coder_not_authenticated
run_check "Hive GitHub credential helper is absent" check_hive_helper_absent

report_temporary="$(mktemp "$HOME/.INTERVIEW_READY.XXXXXX")"
repository_commit="$(git -C "$INTERVIEW_REPOSITORY" rev-parse HEAD 2>/dev/null || printf unavailable)"
venv_method="$(interview_read_state venv-method 2>/dev/null || printf unavailable)"
if ((check_failures == 0)); then
  report_result="INTERVIEW WORKSPACE READY"
  remaining_action="At interview time, run interview-claude and enter the temporary key at the masked prompt."
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
  printf -- '- SQLite: %s\n' "$(interview_version_or_missing sqlite3 sqlite3 --version)"
  printf -- '- Git: %s\n' "$(interview_version_or_missing git git --version)"
  printf -- '- make: %s\n' "$(interview_version_or_missing make make --version)"
  printf -- '- ripgrep: %s\n' "$(interview_version_or_missing rg rg --version)"
  printf -- '- Claude Code: %s\n' "$(interview_version_or_missing claude claude --version)"
  printf -- '- Codex: %s\n' "$(interview_version_or_missing codex codex --version)"
  printf -- '- Playwright MCP: %s\n' "$(interview_version_or_missing playwright-mcp playwright-mcp --version)"
  printf -- '- Bun: %s\n' "$(interview_version_or_missing bun bun --version)"
  printf -- '- pnpm: %s\n' "$(interview_version_or_missing pnpm pnpm --version)"
  printf -- '- Chrome: %s\n' "$(interview_version_or_missing google-chrome-stable google-chrome-stable --version)"
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
  printf -- '- `interview-setup` — refresh dependencies only when manifests change; test and build\n'
  printf -- '- `interview-start` — create or preserve the detached `interview` tmux session\n'
  printf -- '- `interview-restart` — restart only API and frontend windows\n'
  printf -- '- `interview-stop` — stop only the interview session\n'
  printf -- '- `interview-status` — show non-secret state\n'
  printf -- '- `interview-check` — rerun this strict readiness check\n'
  printf -- '- `interview-claude` — prompt securely for the temporary Anthropic key and launch Claude Code\n'
  printf '\n## Credential state\n\n'
  printf 'Only credential names are reported; values are never recorded. Required pre-interview state: '
  printf '`ANTHROPIC_API_KEY`, GitHub, Coder agent/session, Realm, and RunComfy credentials absent; GitHub and Coder CLIs unauthenticated.\n'
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
#!/usr/bin/env bash
# hive-managed-interview-sqlite:v1
set -euo pipefail
exec python3 -m sqlite3 "$@"
SQLITEEOF
fi

install_interview_ripgrep() {
  local managed_binary="$interview_bin_dir/rg"
  local tool_root="$interview_state_dir/ripgrep-$interview_ripgrep_version"
  local packaged_binary="$tool_root/node_modules/@vscode/ripgrep-linux-x64/bin/rg"
  local system_binary

  for system_binary in /usr/bin/rg /usr/local/bin/rg; do
    if [ -x "$system_binary" ]; then
      if [ -L "$managed_binary" ] \
        && [[ "$(readlink "$managed_binary")" == "$interview_state_dir"/ripgrep-* ]]; then
        rm -f -- "$managed_binary"
      fi
      return 0
    fi
  done

  if command -v rg >/dev/null 2>&1; then
    return 0
  fi
  if [ -e "$managed_binary" ] || [ -L "$managed_binary" ]; then
    interview_warn "Preserving unexpected rg command at $managed_binary"
    return 1
  fi
  if [ ! -x "$packaged_binary" ]; then
    command -v npm >/dev/null 2>&1 || return 1
    mkdir -p "$tool_root"
    npm install \
      --prefix "$tool_root" \
      --ignore-scripts \
      --no-audit \
      --no-fund \
      --no-package-lock \
      --no-save \
      "@vscode/ripgrep@$interview_ripgrep_version" >/dev/null
  fi
  [ -x "$packaged_binary" ] || return 1
  ln -s "$packaged_binary" "$managed_binary"
  "$managed_binary" --version >/dev/null 2>&1
}

if ! install_interview_ripgrep; then
  printf '[warn] ripgrep could not be prepared; interview-check will report it missing.\n' >&2
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
  local existing_target

  if [ -L "$managed_binary" ]; then
    existing_target="$(readlink -- "$managed_binary")"
    if [ "$existing_target" = "$installed_binary" ] \
      && interview_tool_version_matches "$managed_binary" "$package_version"; then
      printf '[ok] %s %s is already available\n' "$label" "$package_version"
      return 0
    fi
    if [ -n "$baseline_target" ] \
      && [ "$existing_target" = "$baseline_target" ] \
      && interview_tool_version_matches "$managed_binary" "$package_version"; then
      printf '[ok] %s %s is provided by the pinned image baseline\n' \
        "$label" "$package_version"
      return 0
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

  if ! interview_tool_version_matches "$installed_binary" "$package_version"; then
    command -v npm >/dev/null 2>&1 || return 1
    if [ -e "$tool_root" ] || [ -L "$tool_root" ]; then
      rm -rf -- "$tool_root"
    fi
    mkdir -p "$tool_root"
    printf '[install] %s %s\n' "$label" "$package_version"
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install \
      --prefix "$tool_root" \
      --ignore-scripts \
      --no-audit \
      --no-fund \
      --no-package-lock \
      --no-save \
      "$package_name@$package_version" >/dev/null
  fi

  [ -x "$installed_binary" ] || return 1
  ln -s -- "$installed_binary" "$managed_binary"
  interview_tool_version_matches "$managed_binary" "$package_version"
}

tool_failures=0
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

"$interview_bin_dir/interview-check" || check_status=$?

if ((setup_status != 0 || start_status != 0 || check_status != 0)); then
  printf '[warn] Interview workspace startup completed with readiness failures.\n' >&2
  printf '[warn] Review ~/INTERVIEW_READY.md and rerun interview-setup, interview-start, and interview-check.\n' >&2
else
  printf '[ok] INTERVIEW WORKSPACE READY\n'
fi

# Readiness failures stay visible without blocking terminal access.
exit 0
