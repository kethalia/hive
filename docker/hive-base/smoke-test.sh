#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: smoke-test.sh <image> <variant>}
variant=${2:?Usage: smoke-test.sh <image> <variant>}

run() {
  docker run --rm "$image" "$@"
}

expect_command() {
  local command_name=$1
  run sh -lc "command -v '$command_name' >/dev/null"
}

expect_absent() {
  local command_name=$1
  if run sh -lc "command -v '$command_name' >/dev/null"; then
    printf 'Unexpected command in %s image: %s\n' "$variant" "$command_name" >&2
    return 1
  fi
}

expect_output() {
  local expected=$1 actual
  shift
  actual=$(run "$@")
  if [ "$actual" != "$expected" ]; then
    printf 'Expected %s, got %s from %s\n' "$expected" "$actual" "$*" >&2
    return 1
  fi
}

expect_infrastructure_tools_absent() {
  expect_absent terraform
  expect_absent kubectl
  expect_absent helm
  expect_absent argocd
}

actual_variant=$(run sh -lc 'printf %s "$HIVE_IMAGE_VARIANT"')
if [ "$actual_variant" != "$variant" ]; then
  printf 'Expected image variant %s, got %s\n' "$variant" "$actual_variant" >&2
  exit 1
fi

run claude --version
run notesmd-cli --version
run act --version
expect_command node
expect_command npx
expect_command hive-audio
expect_command pulseaudio
expect_command pacat
expect_command pactl
run bash -lc 'export PULSE_SERVER="$(hive-audio prepare smoke)"; pactl info >/dev/null; python3 - <<"PY"
import ctypes
library = ctypes.CDLL("libasound.so.2")
for direction in (0, 1):
    handle = ctypes.c_void_p()
    result = library.snd_pcm_open(ctypes.byref(handle), b"default", direction, 0)
    assert result == 0, (direction, result)
    library.snd_pcm_close(handle)
print("Default virtual microphone and speaker opened without /dev/snd")
PY'
expect_absent obsidian

case "$variant" in
  cli)
    expect_absent vncserver
    expect_absent xfce4-session
    expect_absent google-chrome-stable
    expect_absent unityhub
    expect_absent blender
    expect_absent kicad-cli
    expect_infrastructure_tools_absent
    ;;
  infrastructure)
    run terraform version
    run kubectl version --client=true
    run helm version --short
    run argocd version --client
    expect_absent vncserver
    expect_absent xfce4-session
    expect_absent google-chrome-stable
    expect_absent unityhub
    expect_absent blender
    expect_absent kicad-cli
    ;;
  game)
    expect_command vncserver
    expect_command xfce4-session
    expect_command unityhub
    run blender --version
    run google-chrome-stable --version
    run desktop-file-validate /usr/share/applications/google-chrome.desktop /usr/share/applications/unityhub.desktop
    expect_output google-chrome.desktop xdg-mime query default x-scheme-handler/http
    expect_output google-chrome.desktop xdg-mime query default x-scheme-handler/https
    expect_output unityhub.desktop xdg-mime query default x-scheme-handler/unityhub
    expect_output yes env XDG_CURRENT_DESKTOP=XFCE xdg-settings check default-web-browser google-chrome.desktop
    expect_absent kicad-cli
    expect_infrastructure_tools_absent
    ;;
  electronics)
    expect_command vncserver
    expect_command xfce4-session
    run kicad-cli version
    expect_absent google-chrome-stable
    expect_absent unityhub
    expect_absent blender
    expect_infrastructure_tools_absent
    ;;
  browser)
    expect_command vncserver
    expect_command xfce4-session
    run google-chrome-stable --version
    expect_absent unityhub
    expect_absent blender
    expect_absent kicad-cli
    expect_infrastructure_tools_absent
    ;;
  *)
    printf 'Unsupported workspace image variant: %s\n' "$variant" >&2
    exit 1
    ;;
esac

printf 'Workspace image smoke test passed: %s\n' "$variant"
