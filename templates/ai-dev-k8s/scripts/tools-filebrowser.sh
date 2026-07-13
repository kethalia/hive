#!/bin/bash
set -euo pipefail

filebrowser_version="2.63.18"
filebrowser_port="${FILEBROWSER_PORT:-13339}"
binary="$HOME/.local/bin/filebrowser"
database="$HOME/.config/filebrowser/filebrowser.db"
log_file="$HOME/.local/state/filebrowser/filebrowser.log"
version_marker="$HOME/.local/share/filebrowser-version"

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

if curl -fsS "http://127.0.0.1:${filebrowser_port}/health" >/dev/null 2>&1; then
  printf '[ok] File Browser is already running\n'
  exit 0
fi

export FB_DATABASE="$database"
if [ ! -f "$database" ]; then
  "$binary" config init
fi
"$binary" config set \
  --address="127.0.0.1" \
  --port="$filebrowser_port" \
  --auth.method="noauth" \
  --root="$HOME"

nohup "$binary" >> "$log_file" 2>&1 &
printf '[ok] File Browser %s started on port %s\n' "$filebrowser_version" "$filebrowser_port"
