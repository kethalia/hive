#!/bin/bash
set -euo pipefail

filebrowser_version="2.63.18"
filebrowser_port="${FILEBROWSER_PORT:-13339}"
filebrowser_root="${HIVE_PROJECTS_ROOT:-$HOME}"
binary="$HOME/.local/bin/filebrowser"
database="$HOME/.config/filebrowser/filebrowser.db"
log_file="$HOME/.local/state/filebrowser/filebrowser.log"
version_marker="$HOME/.local/share/filebrowser-version"

case "$filebrowser_root" in
  /*) ;;
  *)
    printf '[error] HIVE_PROJECTS_ROOT must be an absolute POSIX path: %s\n' "$filebrowser_root" >&2
    exit 1
    ;;
esac

if [ ! -d "$filebrowser_root" ]; then
  printf '[error] File Browser root does not exist: %s\n' "$filebrowser_root" >&2
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

mkdir -p "$HOME/.local/bin" "$HOME/.local/share" "$HOME/.local/state/filebrowser" "$(dirname "$database")"

installed_version=""
if [ -f "$version_marker" ]; then
  installed_version="$(cat "$version_marker")"
fi

if [ ! -x "$binary" ] || [ "$installed_version" != "$filebrowser_version" ]; then
  temp_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_dir"' EXIT
  download_url="https://github.com/filebrowser/filebrowser/releases/download/v${filebrowser_version}/${archive}"

  curl -fsSLo "$temp_dir/$archive" --retry 3 --retry-delay 2 "$download_url"
  printf '%s  %s\n' "$checksum" "$temp_dir/$archive" | sha256sum --check --status
  tar -xzf "$temp_dir/$archive" -C "$temp_dir" filebrowser
  cp "$temp_dir/filebrowser" "$binary"
  chmod 0755 "$binary"
  printf '%s\n' "$filebrowser_version" > "$version_marker"
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
