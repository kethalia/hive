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
run python3 -c 'import sys; assert sys.version_info >= (3, 12), sys.version'
run sh -lc 'probe=$(mktemp -d); trap '\''rm -rf -- "$probe"'\'' EXIT; python3 -m venv "$probe/venv"; "$probe/venv/bin/python" -m pip --version'
run node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 20) process.exit(1)'
run npm --version
run sqlite3 --version
run rg --version
expect_command node
expect_command npx
expect_command make
expect_command git
expect_command curl
expect_command jq
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
    expect_absent google-chrome-stable
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
