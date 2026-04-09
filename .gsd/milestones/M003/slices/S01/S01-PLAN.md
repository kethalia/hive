# S01: Base Image & CI

**Goal:** A shared `hive-base` Docker image built on `debian:trixie` containing KasmVNC+Openbox, Chrome, Node.js 24, Docker CE, Claude CLI, Obsidian, notesmd-cli, and act — published to GHCR via GitHub Actions CI on every merge to main.
**Demo:** After this: `docker run --rm ghcr.io/<owner>/hive-base:latest claude --version` exits 0; `notesmd-cli --version` exits 0; GitHub Actions pushes the image on merge to main.

## Must-Haves

- `docker build -t hive-base:local docker/hive-base/` succeeds (Dockerfile is syntactically valid and all layers install without error)
- `docker run --rm hive-base:local claude --version` exits 0
- `docker run --rm hive-base:local notesmd-cli --version` exits 0
- `docker run --rm hive-base:local act --version` exits 0
- `docker run --rm hive-base:local which vncserver` exits 0
- `docker run --rm hive-base:local which openbox` exits 0
- `docker run --rm hive-base:local bash -c '! which fluxbox'` exits 0
- `.github/workflows/build-base-image.yml` exists and is valid YAML
- Workflow uses `docker/build-push-action`, pushes to `ghcr.io/kethalia/hive-base:latest` on merge to main, and includes smoke tests

## Proof Level

- This slice proves: This slice proves: integration (Dockerfile builds and all tool binaries are functional inside the container). Real runtime required: yes (Docker build + container exec). Human/UAT required: no.

## Integration Closure

- Upstream surfaces consumed: `templates/hive-council/Dockerfile` (reference structure), `templates/hive-council/scripts/claude-install.sh` (Claude CLI install pattern), `templates/hive-council/scripts/tools-ci.sh` (act install pattern), `templates/ai-dev/scripts/browser-serve.sh` (KasmVNC startup pattern)
- New wiring introduced: `docker/hive-base/Dockerfile` (new image definition), `.github/workflows/build-base-image.yml` (CI pipeline)
- What remains: S02 migrates all templates to `FROM ghcr.io/kethalia/hive-base:latest`, S03+ adds Obsidian autostart/vault config

## Verification

- Runtime signals: GitHub Actions workflow logs; Docker build layer cache hits/misses
- Inspection surfaces: `docker run --rm ghcr.io/kethalia/hive-base:latest <tool> --version` for any tool; GitHub Actions run history
- Failure visibility: Docker build step that failed (layer number + error message); CI workflow run status in GitHub UI
- Redaction constraints: GITHUB_TOKEN used in CI is auto-provided, not stored in repo secrets

## Tasks

- [x] **T01: Write the hive-base Dockerfile on debian:trixie with all shared tooling** `est:1h`
  Create `docker/hive-base/Dockerfile` by adapting the existing `templates/hive-council/Dockerfile` (131 lines, ubuntu:24.04) to Debian 13 trixie. This is the core artifact — the single shared base image that all Hive templates will extend.

## Steps

1. Create `docker/hive-base/Dockerfile` with `FROM debian:trixie`
2. Adapt the base system layer: change APT sources from Ubuntu to Debian, switch Docker CE repo URL from `download.docker.com/linux/ubuntu` to `download.docker.com/linux/debian`. The `$(. /etc/os-release && echo $VERSION_CODENAME)` pattern works on both — it resolves to `trixie` on Debian 13.
3. Replace `postgresql-16` and `postgresql-contrib-16` with `postgresql` (Debian trixie ships PostgreSQL 17 natively — no version pinning needed).
4. Replace `fluxbox` with `openbox` in the Chrome/KasmVNC layer. Replace KasmVNC .deb URL from `kasmvncserver_noble_1.4.0_amd64.deb` to `kasmvncserver_trixie_1.4.0_amd64.deb` (same v1.4.0 release confirmed to have trixie builds).
5. Add Claude CLI layer: `RUN curl -fsSL https://claude.ai/install.sh | bash` (must use bash, not sh — dash can't parse the installer).
6. Add Obsidian layer: download latest Obsidian .deb from `https://obsidian.md/download` (the amd64 .deb URL pattern is `https://github.com/obsidianmd/obsidian-releases/releases/latest/download/obsidian_<version>_amd64.deb`). Install with `apt-get install -f` to pull Electron dependencies (libnss3, libatk-bridge2.0-0, libgtk-3-0). Pre-create `~/.config/obsidian/obsidian.json` with `{"cli": true}` to enable CLI in headless mode.
7. Add notesmd-cli layer: Build from source using Go (`git clone https://github.com/Yakitrak/notesmd-cli.git && cd notesmd-cli && go build -o /usr/local/bin/notesmd-cli .`). Requires Go toolchain — install `golang-go` in a build stage or install temporarily. Alternative: download pre-built binary from `https://github.com/Yakitrak/notesmd-cli/releases/download/v0.3.4/` (check the exact asset name for Linux amd64). Set `NOTESMD_DEFAULT_VAULT=/home/coder/vault` env var.
8. Add act layer: `wget -qO /tmp/act.tar.gz https://github.com/nektos/act/releases/latest/download/act_Linux_x86_64.tar.gz && tar xf /tmp/act.tar.gz -C /usr/local/bin act && rm /tmp/act.tar.gz` (same pattern as `tools-ci.sh`).
9. Fix user setup: add `ssl-cert` to the `useradd --groups` list (KasmVNC requires this). The existing Dockerfile only has `--groups=docker`; must be `--groups=docker,ssl-cert`.
10. Keep NodeSource Node.js 24 layer, Google Chrome layer, locale setup, coder user setup, .zshenv PATH config, and .bashrc PATH config from the reference Dockerfile.

## Critical constraints
- KasmVNC URL: `https://github.com/kasmtech/KasmVNC/releases/download/v1.4.0/kasmvncserver_trixie_1.4.0_amd64.deb`
- Must use `bash` not `sh` for Claude CLI installer
- `ssl-cert` group is **required** for KasmVNC — the reference Dockerfile is missing this
- Openbox not fluxbox (D019)
- PostgreSQL: use `postgresql` package, not `postgresql-16` (trixie ships v17)
- GitHub org: `kethalia`

## Must-Haves
- [ ] FROM debian:trixie base
- [ ] Docker CE repo uses linux/debian (not linux/ubuntu)
- [ ] KasmVNC trixie .deb installed
- [ ] Openbox installed, fluxbox NOT installed
- [ ] Claude CLI installed via curl | bash
- [ ] Obsidian .deb installed with CLI enabled in config
- [ ] notesmd-cli binary available on PATH
- [ ] act binary available on PATH
- [ ] coder user in ssl-cert group
- [ ] Node.js 24 via NodeSource
- [ ] Google Chrome installed
  - Files: `docker/hive-base/Dockerfile`, `templates/hive-council/Dockerfile`
  - Verify: test -f docker/hive-base/Dockerfile && grep -q 'debian:trixie' docker/hive-base/Dockerfile && grep -q 'openbox' docker/hive-base/Dockerfile && grep -q 'ssl-cert' docker/hive-base/Dockerfile && grep -q 'notesmd-cli' docker/hive-base/Dockerfile && grep -q 'claude.ai/install.sh' docker/hive-base/Dockerfile && grep -q 'act' docker/hive-base/Dockerfile && ! grep -q 'fluxbox' docker/hive-base/Dockerfile

- [x] **T02: Write GitHub Actions workflow to build and push hive-base image to GHCR** `est:30m`
  Create `.github/workflows/build-base-image.yml` that builds `docker/hive-base/Dockerfile`, runs smoke tests, and pushes to `ghcr.io/kethalia/hive-base:latest` on merge to main.

## Steps

1. Create `.github/workflows/build-base-image.yml` with trigger on push to `main` (paths: `docker/hive-base/**`) and `workflow_dispatch` for manual runs.
2. Add permissions: `contents: read`, `packages: write` (required for GHCR push).
3. Use standard Docker build-push pattern:
   - `actions/checkout@v4`
   - `docker/login-action@v3` with `registry: ghcr.io`, `username: ${{ github.actor }}`, `password: ${{ secrets.GITHUB_TOKEN }}`
   - `docker/setup-buildx-action@v3`
   - `docker/build-push-action@v6` with `context: docker/hive-base`, `push: true` (only on main), `tags: ghcr.io/kethalia/hive-base:latest,ghcr.io/kethalia/hive-base:${{ github.sha }}`
4. Add a smoke-test job that runs after build:
   - `docker run --rm ghcr.io/kethalia/hive-base:${{ github.sha }} claude --version`
   - `docker run --rm ghcr.io/kethalia/hive-base:${{ github.sha }} notesmd-cli --version`
   - `docker run --rm ghcr.io/kethalia/hive-base:${{ github.sha }} act --version`
   - `docker run --rm ghcr.io/kethalia/hive-base:${{ github.sha }} which vncserver`
   - `docker run --rm ghcr.io/kethalia/hive-base:${{ github.sha }} which openbox`
5. For PRs: build only (no push), still run smoke tests against the local image.

## Must-Haves
- [ ] Triggers on push to main (path-filtered to docker/hive-base/**) and workflow_dispatch
- [ ] Also triggers on PRs touching docker/hive-base/** (build-only, no push)
- [ ] Uses docker/build-push-action with GHCR login
- [ ] Smoke tests verify claude, notesmd-cli, act, vncserver, and openbox
- [ ] Push only happens on main branch (not PRs)
- [ ] Tags with both :latest and :sha
  - Files: `.github/workflows/build-base-image.yml`
  - Verify: test -f .github/workflows/build-base-image.yml && python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build-base-image.yml'))" && grep -q 'ghcr.io/kethalia/hive-base' .github/workflows/build-base-image.yml && grep -q 'build-push-action' .github/workflows/build-base-image.yml && grep -q 'packages: write' .github/workflows/build-base-image.yml

## Files Likely Touched

- docker/hive-base/Dockerfile
- templates/hive-council/Dockerfile
- .github/workflows/build-base-image.yml
