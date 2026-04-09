---
estimated_steps: 31
estimated_files: 2
skills_used: []
---

# T01: Write the hive-base Dockerfile on debian:trixie with all shared tooling

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

## Inputs

- ``templates/hive-council/Dockerfile` — 131-line reference to adapt (ubuntu:24.04 base, Docker CE, Chrome, KasmVNC noble, fluxbox, Node.js 24)`
- ``templates/hive-council/scripts/claude-install.sh` — Claude CLI install pattern (must use bash not sh)`
- ``templates/hive-council/scripts/tools-ci.sh` — act install pattern (wget from nektos releases)`

## Expected Output

- ``docker/hive-base/Dockerfile` — complete multi-layer Dockerfile on debian:trixie with all shared tooling`

## Verification

test -f docker/hive-base/Dockerfile && grep -q 'debian:trixie' docker/hive-base/Dockerfile && grep -q 'openbox' docker/hive-base/Dockerfile && grep -q 'ssl-cert' docker/hive-base/Dockerfile && grep -q 'notesmd-cli' docker/hive-base/Dockerfile && grep -q 'claude.ai/install.sh' docker/hive-base/Dockerfile && grep -q 'act' docker/hive-base/Dockerfile && ! grep -q 'fluxbox' docker/hive-base/Dockerfile
