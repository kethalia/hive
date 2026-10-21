#!/bin/bash
# Optional integrations must not delay terminal login or change disabled plugins.
set -u
export PATH="$HOME/.local/bin:$PATH"
export npm_config_prefix="$HOME/.local"
if [ "${HIVE_WORKSPACE_PROFILE:-}" != "software" ]; then exit 0; fi

if [ -n "${HIVE_AGENT_TOOLS_SOURCE_B64:-}" ]; then
  printf '%s' '{"operation":"configure-coder"}' | python3 -c \
    "$(printf '%s' "$HIVE_AGENT_TOOLS_SOURCE_B64" | base64 -d)"
fi

if ! command -v typescript-language-server >/dev/null 2>&1; then
  timeout --signal=TERM --kill-after=10s 90s npm install -g \
    typescript-language-server@5.1.3 typescript@5.9.3 \
    --fetch-retries=1 --fetch-timeout=20000 || \
    printf '%s\n' '[warn] TypeScript language server setup deferred.'
fi

claude_plugins="$(timeout 10s claude plugin list --json 2>/dev/null || true)"
if printf '%s' "$claude_plugins" | python3 -c '
import json, sys
try:
    plugins = json.load(sys.stdin)
    if not isinstance(plugins, list): raise ValueError()
    sys.exit(1 if any(p.get("id") == "typescript-lsp@claude-plugins-official" for p in plugins) else 0)
except (ValueError, TypeError, AttributeError):
    sys.exit(2)
'; then
  # The native CLI adds the official marketplace on first interactive startup.
  # Before that, leave setup for /plugin instead of overwriting marketplace choices.
  timeout --signal=TERM --kill-after=10s 60s claude plugin install \
    typescript-lsp@claude-plugins-official --scope user || \
    printf '%s\n' '[warn] Install typescript-lsp@claude-plugins-official from Claude /plugin to finish setup.'
fi
