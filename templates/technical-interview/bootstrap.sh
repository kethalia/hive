#!/usr/bin/env bash
set -euo pipefail

umask 077

interview_bin_dir="$HOME/.local/bin"
interview_libexec_dir="$HOME/.local/libexec/hive/technical-interview"
interview_state_dir="$HOME/.local/state/hive/technical-interview"

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

mkdir -p "$INTERVIEW_STATE_DIR"
chmod 700 "$INTERVIEW_STATE_DIR"

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
  [ -f "$INTERVIEW_BACKEND/requirements.txt" ] || return 1
  (
    cd "$INTERVIEW_REPOSITORY"
    sha256sum backend/requirements.txt
  ) | sha256sum | awk '{print $1}'
}

interview_frontend_hash() {
  local manifests=(frontend/package.json)
  [ -f "$INTERVIEW_FRONTEND/package.json" ] || return 1
  [ ! -f "$INTERVIEW_FRONTEND/package-lock.json" ] || manifests+=(frontend/package-lock.json)
  [ ! -f "$INTERVIEW_FRONTEND/npm-shrinkwrap.json" ] || manifests+=(frontend/npm-shrinkwrap.json)
  (
    cd "$INTERVIEW_REPOSITORY"
    sha256sum "${manifests[@]}"
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
  [ -n "$current_hash" ] && [ "$current_hash" = "$stored_hash" ]
}

interview_git_clean() {
  [ -d "$INTERVIEW_REPOSITORY/.git" ] || return 1
  [ -z "$(git -C "$INTERVIEW_REPOSITORY" status --short --untracked-files=all)" ]
}

interview_remote_default_state() {
  local local_commit remote_commit
  local_commit="$(git -C "$INTERVIEW_REPOSITORY" rev-parse HEAD 2>/dev/null || true)"
  remote_commit="$(
    timeout 12s env -u GH_TOKEN -u GITHUB_TOKEN GIT_TERMINAL_PROMPT=0 \
      git -c credential.helper= ls-remote "$INTERVIEW_EXPECTED_ORIGIN" HEAD 2>/dev/null \
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
  for variable_name in ANTHROPIC_API_KEY GH_TOKEN GITHUB_TOKEN; do
    if printenv "$variable_name" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

interview_forbidden_tmux_environment_present() {
  local scope variable_name
  tmux has-session -t "$INTERVIEW_SESSION" 2>/dev/null || return 1
  for variable_name in ANTHROPIC_API_KEY GH_TOKEN GITHUB_TOKEN; do
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

interview_github_authenticated() {
  command -v gh >/dev/null 2>&1 || return 1
  timeout 5s env -u GH_TOKEN -u GITHUB_TOKEN gh auth status >/dev/null 2>&1
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

if [ ! -x "$INTERVIEW_VENV/bin/python" ]; then
  if [ -e "$INTERVIEW_VENV" ] || [ -L "$INTERVIEW_VENV" ]; then
    interview_error "Preserving an existing but unusable backend virtual environment: $INTERVIEW_VENV"
    interview_error "Move it aside manually after reviewing it, then rerun interview-setup."
    exit 1
  fi

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
fi

backend_hash="$(interview_backend_hash)"
stored_backend_hash="$(interview_read_state backend-requirements.sha256 2>/dev/null || true)"
if [ "$backend_hash" != "$stored_backend_hash" ] \
  || ! "$INTERVIEW_VENV/bin/python" -c 'import fastapi, httpx, pytest, uvicorn' >/dev/null 2>&1; then
  interview_ok "Installing backend dependencies"
  "$INTERVIEW_VENV/bin/python" -m pip install \
    --disable-pip-version-check \
    --no-input \
    -r "$INTERVIEW_BACKEND/requirements.txt"
  interview_write_state backend-requirements.sha256 "$backend_hash"
else
  interview_ok "Backend dependencies match the stored manifest hash"
fi

frontend_hash="$(interview_frontend_hash)"
stored_frontend_hash="$(interview_read_state frontend-manifests.sha256 2>/dev/null || true)"
if [ "$frontend_hash" != "$stored_frontend_hash" ] \
  || [ ! -x "$INTERVIEW_FRONTEND/node_modules/.bin/vite" ]; then
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

api_command="exec env -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN '$INTERVIEW_VENV/bin/uvicorn' app.main:app --reload --host 0.0.0.0 --port 8000"
web_command="exec env -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN npm run dev -- --host 0.0.0.0 --port 3000"

tmux_without_credentials() {
  env -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN tmux "$@"
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
for forbidden_name in ANTHROPIC_API_KEY GH_TOKEN GITHUB_TOKEN; do
  tmux set-environment -t "$INTERVIEW_SESSION" -u "$forbidden_name" 2>/dev/null || true
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

api_command="exec env -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN '$INTERVIEW_VENV/bin/uvicorn' app.main:app --reload --host 0.0.0.0 --port 8000"
web_command="exec env -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN npm run dev -- --host 0.0.0.0 --port 3000"

restart_service_window() {
  local window_name=$1
  local working_directory=$2
  local service_command=$3
  if tmux list-windows -t "$INTERVIEW_SESSION" -F '#{window_name}' | grep -Fqx -- "$window_name"; then
    env -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN \
      tmux respawn-window -k -t "$INTERVIEW_SESSION:$window_name" \
      -c "$working_directory" "$service_command"
  else
    env -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN \
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
printf '  Chrome: %s\n' "$(interview_version_or_missing google-chrome-stable google-chrome-stable --version)"
printf '  tmux: %s\n' "$(interview_version_or_missing tmux tmux -V)"

printf 'Forbidden credential variables present (names only):'
credential_count=0
for credential_name in ANTHROPIC_API_KEY GH_TOKEN GITHUB_TOKEN; do
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
else
  printf 'GitHub CLI authentication: absent\n'
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

use_environment_key=false
claude_arguments=()
while (($# > 0)); do
  case "$1" in
    --use-env-key)
      use_environment_key=true
      shift
      ;;
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

if [ "$use_environment_key" = "true" ]; then
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    interview_error "--use-env-key requires ANTHROPIC_API_KEY to already be set."
    exit 1
  fi
  interview_key=$ANTHROPIC_API_KEY
else
  unset ANTHROPIC_API_KEY
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
fi

cd "$INTERVIEW_REPOSITORY"
unset GH_TOKEN GITHUB_TOKEN
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
  ! interview_github_authenticated
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
run_check "Claude Code is installed" check_command claude
run_check "Codex is installed" check_command codex
run_check "Chrome is installed" check_command google-chrome-stable
run_check "tmux is installed" check_command tmux
run_check "SQLite CLI is installed" check_command sqlite3
run_check "API responds at /hello" check_api
run_check "frontend responds on port 3000" check_frontend
run_check "working tree contains no unexpected files" interview_git_clean
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
  printf '`ANTHROPIC_API_KEY`, `GH_TOKEN`, and `GITHUB_TOKEN` absent; GitHub and Coder CLIs unauthenticated.\n'
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

if [ "${HIVE_INTERVIEW_SKIP_AUTOSTART:-false}" = "true" ]; then
  printf '[ok] Interview helper commands installed; automatic checks skipped by test mode\n'
  exit 0
fi

setup_status=0
start_status=0
check_status=0
"$interview_bin_dir/interview-setup" || setup_status=$?
"$interview_bin_dir/interview-start" || start_status=$?

# Codex is installed by the shared AI-tools startup script. Coder runs startup
# scripts independently, so wait boundedly for that sibling script before
# producing the final readiness report.
if ! command -v codex >/dev/null 2>&1; then
  for ((codex_attempt = 1; codex_attempt <= 90; codex_attempt += 1)); do
    sleep 2
    command -v codex >/dev/null 2>&1 && break
  done
fi
"$interview_bin_dir/interview-check" || check_status=$?

if ((setup_status != 0 || start_status != 0 || check_status != 0)); then
  printf '[warn] Interview workspace startup completed with readiness failures.\n' >&2
  printf '[warn] Review ~/INTERVIEW_READY.md and rerun interview-setup, interview-start, and interview-check.\n' >&2
else
  printf '[ok] INTERVIEW WORKSPACE READY\n'
fi

# Readiness failures stay visible without blocking terminal access.
exit 0
