#!/bin/bash
set -euo pipefail
umask 077

unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
unset GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN
unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN

# Never resolve startup commands through persistent candidate-writable paths.
INTERVIEW_TRUSTED_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH="$INTERVIEW_TRUSTED_PATH"

filebrowser_version="2.63.18"
filebrowser_port="${FILEBROWSER_PORT:-13339}"
filebrowser_root="${HIVE_PROJECTS_ROOT:-$HOME}"
binary="$HOME/.local/bin/filebrowser"
database="$HOME/.config/filebrowser/filebrowser.db"
log_file="$HOME/.local/state/filebrowser/filebrowser.log"
version_marker="$HOME/.local/share/filebrowser-version"

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

case "$filebrowser_root" in
  /*) ;;
  *)
    printf '[error] HIVE_PROJECTS_ROOT must be an absolute POSIX path: %s\n' "$filebrowser_root" >&2
    exit 1
    ;;
esac

if ! mkdir -p "$filebrowser_root"; then
  printf '[error] File Browser root could not be created: %s\n' "$filebrowser_root" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64)
    archive="linux-amd64-filebrowser.tar.gz"
    checksum="cd599c34afad0e8e61c577d1061c820bccb7feaa3c5a4477a12db586a1cd93ff"
    ;;
  aarch64 | arm64)
    archive="linux-arm64-filebrowser.tar.gz"
    checksum="29b3935c222d91522874e98dfa33195ee7d2acdac5dfbf37c1361a73704a28de"
    ;;
  *)
    printf '[error] unsupported File Browser architecture: %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

ensure_interview_local_directory "$HOME/.local/bin"
ensure_interview_local_directory "$HOME/.local/share"
ensure_interview_local_directory "$HOME/.local/state/filebrowser"
ensure_interview_local_directory "$(dirname "$database")"

if [ -L "$database" ] || { [ -e "$database" ] && [ ! -f "$database" ]; }; then
  printf '[error] unsafe File Browser database was preserved: %s\n' "$database" >&2
  exit 1
fi

installed_version=""
if [ -f "$version_marker" ] && [ ! -L "$version_marker" ]; then
  installed_version="$(cat "$version_marker")"
fi

if [ ! -x "$binary" ] || [ "$installed_version" != "$filebrowser_version" ]; then
  temp_dir="$(mktemp -d)"
  binary_temporary=""
  marker_temporary=""
  cleanup_installation() {
    rm -rf -- "$temp_dir"
    [ -z "$binary_temporary" ] || rm -f -- "$binary_temporary"
    [ -z "$marker_temporary" ] || rm -f -- "$marker_temporary"
  }
  trap cleanup_installation EXIT
  download_url="https://github.com/filebrowser/filebrowser/releases/download/v${filebrowser_version}/${archive}"

  curl -fsSLo "$temp_dir/$archive" --retry 3 --retry-delay 2 "$download_url"
  printf '%s  %s\n' "$checksum" "$temp_dir/$archive" | sha256sum --check --status
  tar -xzf "$temp_dir/$archive" -C "$temp_dir" filebrowser
  binary_temporary="$(mktemp "$(dirname "$binary")/.filebrowser.XXXXXX")"
  cp -- "$temp_dir/filebrowser" "$binary_temporary"
  chmod 0755 "$binary_temporary"
  mv -fT -- "$binary_temporary" "$binary"
  binary_temporary=""

  marker_temporary="$(mktemp "$(dirname "$version_marker")/.filebrowser-version.XXXXXX")"
  printf '%s\n' "$filebrowser_version" > "$marker_temporary"
  chmod 0600 "$marker_temporary"
  mv -fT -- "$marker_temporary" "$version_marker"
  marker_temporary=""
fi

get_login_status() {
  local response
  if response="$(
    curl -sS -o /dev/null -w '%{http_code}' \
      -H 'Content-Type: application/json' \
      --data '{"username":"","password":"","recaptcha":""}' \
      "http://127.0.0.1:${filebrowser_port}/api/login"
  )"; then
    printf '%s' "$response"
  else
    printf '000'
  fi
}

if curl -fsS "http://127.0.0.1:${filebrowser_port}/health" >/dev/null 2>&1; then
  login_status="$(get_login_status)"
  if [ "$login_status" = "200" ]; then
    printf '[ok] File Browser is already running with no-auth access\n'
    exit 0
  fi

  printf '[warn] File Browser login returned HTTP %s; repairing configuration\n' "$login_status" >&2
  pkill -x filebrowser || true
  for _ in {1..20}; do
    if ! curl -fsS "http://127.0.0.1:${filebrowser_port}/health" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  if curl -fsS "http://127.0.0.1:${filebrowser_port}/health" >/dev/null 2>&1; then
    printf '[error] File Browser did not stop for configuration repair\n' >&2
    exit 1
  fi
fi

export FB_DATABASE="$database"
if [ ! -f "$database" ]; then
  "$binary" config init
fi
"$binary" config set \
  --address="127.0.0.1" \
  --port="$filebrowser_port" \
  --auth.method="noauth" \
  --root="$filebrowser_root"

# noauth still needs an internal user to supply scope and permissions. Without
# user ID 1, the web client loops on the login screen and /api/login returns 500.
if ! "$binary" users find 1 >/dev/null 2>&1; then
  internal_password="$(openssl rand -hex 24)"
  "$binary" users add coder "$internal_password" --perm.admin
fi

nohup "$binary" >> "$log_file" 2>&1 &
for _ in {1..40}; do
  if [ "$(get_login_status)" = "200" ]; then
    printf '[ok] File Browser %s started on port %s with no-auth access\n' "$filebrowser_version" "$filebrowser_port"
    exit 0
  fi
  sleep 0.25
done

printf '[error] File Browser did not become ready with no-auth access\n' >&2
exit 1
