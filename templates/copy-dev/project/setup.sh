#!/bin/bash
set -euo pipefail

project_dir="$HOME/projects/lunarresearcher/copy"
setup_state="$HOME/.local/state/hive/copy-dev"

if [ ! -e "$project_dir/.git" ] || [ ! -f "$project_dir/package.json" ]; then
  printf '[error] COPY checkout is missing. Fix GitHub authentication and rerun ~/clone-repositories.sh, then ~/.local/libexec/hive-project-setup.\n' >&2
  exit 1
fi

cd "$project_dir"
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) { console.error("COPY requires Node.js 20 or newer"); process.exit(1); }'
mkdir -p "$setup_state" "$HOME/.local/bin"

# Create configuration once without sourcing it or changing existing credentials and state.
if [ ! -e .env ] && [ ! -L .env ]; then
  (umask 077; set -o noclobber; cat .env.example > .env)
fi

# Upstream currently has no dependencies or lockfile. Do not generate an untracked lockfile.
# Reinstall only when dependency manifests or the Node/npm versions change, or modules are missing.
manifests=(package.json)
if [ -f package-lock.json ]; then
  manifests+=(package-lock.json)
fi
fingerprint="$( { sha256sum "${manifests[@]}"; node --version; npm --version; } | sha256sum | cut -d ' ' -f 1)"
installed_fingerprint="$(cat "$setup_state/dependencies.sha256" 2>/dev/null || true)"
if [ "$fingerprint" != "$installed_fingerprint" ] || [ ! -d node_modules ]; then
  if [ -f package-lock.json ]; then
    npm ci --ignore-scripts --no-audit --no-fund
  else
    npm install --ignore-scripts --no-audit --no-fund --package-lock=false
  fi
  mkdir -p node_modules
  printf '%s\n' "$fingerprint" > "$setup_state/dependencies.sha256"
fi

# COPY resolves .env, server.mjs, and data files from cwd; a symlink to bin/copy.mjs is insufficient.
cat > "$HOME/.local/bin/copy" <<'COPY_LAUNCHER'
#!/bin/bash
set -euo pipefail
cd "$HOME/projects/lunarresearcher/copy"
exec node bin/copy.mjs "$@"
COPY_LAUNCHER
chmod 755 "$HOME/.local/bin/copy"

printf '[ok] COPY is ready at %s. Run copy terminal --demo, copy terminal, or copy web.\n' "$project_dir"
