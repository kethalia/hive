# S01 — Base Image & CI: Research

**Date:** 2026-04-09

## Summary

S01 creates `docker/hive-base/` (new directory), writes a Dockerfile on `debian:trixie` containing everything from the existing hive-council Dockerfile plus KasmVNC (trixie .deb — confirmed available), Openbox (replacing fluxbox), Claude CLI, Obsidian .deb, notesmd-cli Go binary, and `act`. A GitHub Actions workflow at `.github/workflows/build-base-image.yml` builds and pushes `ghcr.io/kethalia/hive-base:latest` on merge to main.

The codebase has a clear prior art base: `templates/hive-council/Dockerfile` (131 lines, ubuntu:24.04). The Debian 13 migration is straightforward — Docker CE has official trixie support (`https://download.docker.com/linux/debian`), the KasmVNC project **explicitly added a trixie build** in a recent release (confirmed via GitHub Releases page: "Added build for Debian Trixie"). No major blockers — this is construction work, not research work.

The existing `browser-serve.sh` script in `templates/ai-dev/scripts/` already has the complete KasmVNC startup pattern. The base image Dockerfile must include the `ssl-cert` group setup and Openbox instead of fluxbox. The GitHub org is `kethalia` (from `git remote -v`).

## Recommendation

Build the Dockerfile in stages: (1) base OS + APT repos + packages, (2) KasmVNC trixie .deb, (3) Node.js 24 via NodeSource for debian, (4) Claude CLI via `claude.ai/install.sh`, (5) Obsidian .deb download + install, (6) notesmd-cli Go binary from GitHub releases, (7) act binary, (8) user setup. The existing `claude-install.sh` logic should be baked into the Dockerfile `RUN` layer (not a script) for immutability in the base image.

For GitHub Actions: use `docker/build-push-action` (standard pattern, no hand-rolling needed). The workflow needs `packages: write` permission to push to GHCR.

## Implementation Landscape

### Key Files

- `templates/hive-council/Dockerfile` — the 131-line reference. Copy its structure, switch FROM to `debian:trixie`, replace Ubuntu APT sources with Debian sources, replace `noble` KasmVNC .deb with `trixie` .deb, replace `fluxbox` with `openbox`, add Claude + Obsidian + notesmd-cli + act layers. This is the single primary input.
- `templates/ai-dev/scripts/browser-serve.sh` — shows the complete KasmVNC startup pattern (`vncserver -select-de manual`, kasmvnc.yaml config, fluxbox WM start). The new base image needs Openbox in place of fluxbox in this script; the script itself moves to `docker/hive-base/scripts/` and is copied into the image or kept at the template level.
- `templates/hive-council/scripts/claude-install.sh` — Claude CLI install logic to bake into the base Dockerfile as a `RUN` layer.
- `templates/hive-council/scripts/tools-ci.sh` — `act` install pattern (wget from nektos releases). Bake into Dockerfile.
- `.github/` — does NOT exist yet. Must create `.github/workflows/build-base-image.yml`.

### New Files to Create

- `docker/hive-base/Dockerfile` — the new base image definition
- `.github/workflows/build-base-image.yml` — CI/CD workflow

### Build Order

1. **Dockerfile first** — everything else is blocked on this. The CI workflow references the image build path and tests it; the smoke tests can't be written without knowing the Dockerfile is correct.
2. **GitHub Actions workflow second** — once the Dockerfile builds locally, wire up CI. The workflow runs `docker build`, smoke tests (`docker run --rm <image> claude --version` etc.), and pushes on main.
3. **No template migration in S01** — S02 handles the `FROM ghcr.io/kethalia/hive-base:latest` migration.

### Verification Approach

```bash
# Local build check
docker build -t hive-base:local docker/hive-base/

# Smoke tests (same as what CI will run)
docker run --rm hive-base:local claude --version
docker run --rm hive-base:local notesmd-cli --version
docker run --rm hive-base:local act --version
docker run --rm hive-base:local obsidian --version || \
  docker run --rm hive-base:local ls /opt/obsidian/obsidian  # headless verify binary exists

# Verify KasmVNC installed
docker run --rm hive-base:local which vncserver

# Verify Openbox installed (not fluxbox)
docker run --rm hive-base:local which openbox
docker run --rm hive-base:local bash -c "! which fluxbox"
```

## Common Pitfalls

- **Ubuntu vs Debian APT sources** — the existing Dockerfile uses `https://download.docker.com/linux/ubuntu` with `$VERSION_CODENAME`. On Debian 13, `VERSION_CODENAME=trixie` and the URL path must be `linux/debian` not `linux/ubuntu`. Use `$(. /etc/os-release && echo $VERSION_CODENAME)` — this resolves to `trixie` on Debian 13.
- **KasmVNC .deb filename** — the existing Dockerfile uses `kasmvncserver_noble_1.4.0_amd64.deb`. The trixie build has a different name. Search confirmed trixie builds exist in newer KasmVNC releases. The URL pattern is `kasmvncserver_trixie_<version>_amd64.deb`. **Pin the version explicitly** — do not use `latest` redirect.
- **ssl-cert group** — KasmVNC requires the user to be in the `ssl-cert` group. The existing Dockerfile does NOT add coder to this group. Must add `ssl-cert` to the `useradd --groups` list.
- **Claude CLI install** — `claude.ai/install.sh` must be piped through `bash` not `sh` (dash can't parse it — documented in `claude-install.sh`). Baking into Dockerfile: `RUN curl -fsSL https://claude.ai/install.sh | bash`.
- **notesmd-cli config for headless** — requires `~/.config/obsidian/obsidian.json` pre-created with vault entry, or use `--vault` flag. Set `NOTESMD_DEFAULT_VAULT=/home/coder/vault` env var in the base image so Claude can invoke it without flags. The config file approach: create a skeleton `obsidian.json` in the image; S03 will populate the actual vault path at runtime.
- **Obsidian .deb install** — Electron app, needs `libnss3`, `libatk-bridge2.0-0`, `libgtk-3-0` etc. The Obsidian .deb declares these as dependencies; `apt-get install -f` will pull them. Also requires `--no-sandbox` at runtime (not at install time).
- **act binary** — tools-ci.sh installs `act` at workspace start time, not in the Dockerfile. For the base image, bake it in directly using the same `wget` pattern from tools-ci.sh.
- **NodeSource for Debian** — existing Dockerfile uses `setup_24.x` which detects the OS. For Debian trixie this should work correctly; NodeSource supports Debian.
- **postgresql-16 package** — on Debian trixie the package may be `postgresql` (version 17 is in trixie repos). Check if hive-council needs 16 specifically or if latest is fine. Given the base image shouldn't impose a specific PG version, consider dropping PG from the base image entirely and letting templates add it — or use `postgresql` (whatever trixie ships).

## Open Risks

- **KasmVNC trixie .deb exact version/URL** — we know the trixie build exists but the exact version number and URL format need to be verified. The v1.4.0 release did NOT have trixie builds (only noble/jammy/bookworm); a later release added it. Need to check the KasmVNC releases page for the latest version with trixie support. Likely v1.5.0 or v1.4.1+.
- **Obsidian .deb on Debian trixie** — Obsidian is distributed as an Ubuntu-targeted .deb but uses Electron which is generally cross-distro compatible. The `--no-sandbox` flag is required at runtime. The installer itself (apt install of the .deb) should succeed if all native deps are present.
- **GHCR visibility** — image needs to be public OR all `docker_image` resources in Coder templates need credentials. Simpler to make the package public in GitHub settings after first push. The workflow push step itself uses `GITHUB_TOKEN` (automatically available in Actions).

## Sources

- KasmVNC GitHub Releases: "Added build for Debian Trixie" confirmed in a recent release; trixie .deb package exists
- notesmd-cli GitHub README: supports `--vault` flag and headless operation; config via `~/.config/obsidian/obsidian.json`; install via Go build or AUR binary
- Obsidian CLI page (obsidian.md/cli): official CLI bundled with Obsidian 1.12+; requires GUI to be running; headless sync mode available with Obsidian Sync subscription
- Debian 13 trixie: released 2025-08-09; codename `trixie`; standard Debian package ecosystem
