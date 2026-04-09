# M003: Shared Base Image & Obsidian Second Brain

**Gathered:** 2026-04-09
**Status:** Ready for planning

## Project Description

Hive orchestrator — automated task-to-PR pipeline with multi-agent council review. Three active Coder workspace templates (hive-worker, hive-verifier, hive-council) plus ai-dev, all currently sharing 131-line identical Dockerfiles based on ubuntu:24.04 with massive duplication.

## Why This Milestone

Every template has an identical base Dockerfile — identical 131-line layer defining the same ubuntu:24.04, Docker CE, Node.js, git, zsh stack. Keeping them in sync manually is fragile and getting worse as templates multiply. The user wants a single published base image to DRY this up, migrate all templates to extend it, and add the Obsidian "second brain" so Claude in any workspace can read/write a shared knowledge vault.

The second brain is the primary new capability: Obsidian runs in every workspace's KasmVNC desktop session (autostarts), connected to a git-backed vault. Claude uses the vault to carry context across sessions and workspaces — understanding what the user needs without re-explaining it each time.

## Codebase Brief

### Technology Stack
- Templates: Terraform (coder provider ~2.15, docker provider ~3.6) + Docker
- Dockerfiles: All from ubuntu:24.04; all ~131 lines with identical base layers
- Current WM in KasmVNC: fluxbox (in hive-council Dockerfile)
- Claude CLI: already installed in hive-council (claude-install.sh)
- KasmVNC: v1.4.0 installed via .deb from GitHub releases

### Key Modules
- `templates/hive-worker/` — worker blueprint template (no KasmVNC today)
- `templates/hive-verifier/` — verifier template (no KasmVNC today)
- `templates/hive-council/` — council template, has Chrome + KasmVNC + fluxbox
- `templates/ai-dev/` — manual dev template

### Patterns in Use
- Terraform `coder_agent` + `coder_script` for initialization
- `docker_image` resource with local build context (`context = "."`)
- anthropic_api_key variable with conditional injection via Terraform merge() pattern (D011)
- `coder_app` for browser-accessible services (KasmVNC app already in hive-council)
- Scripts: `init.sh`, `claude-install.sh`, `tools-shell.sh`, `tools-node.sh`, etc. — copied verbatim across templates

## User-Visible Outcome

### When this milestone is complete, the user can:
- Run `docker pull ghcr.io/<org>/hive-base:latest` and get the fully-equipped base image
- Open any Hive workspace in their browser via KasmVNC → Obsidian already running with their vault loaded
- Right-click on the KasmVNC desktop → app launcher menu with Obsidian, terminal
- Have Claude CLI in any workspace invoke `notesmd-cli search ~/vault <query>` to read the second brain
- Modify notes in Obsidian in one workspace → git sync pushes → another workspace sees the update

### Entry point / environment
- Entry point: Coder workspace launch (template provisioning)
- Environment: KasmVNC browser desktop inside Coder workspace container
- Live dependencies: GHCR (for base image pull), GitHub (for vault repo sync)

## Completion Class

- Contract complete means: `docker build` succeeds, `terraform validate` passes, `notesmd-cli` and `obsidian` binaries exist in image
- Integration complete means: Workspace starts, Obsidian autostarts in KasmVNC, vault clones from configured repo, right-click menu shows app items
- Operational complete means: git cron runs every 30min and commits+pushes vault changes

## Architectural Decisions

### Switch from fluxbox to Openbox as KasmVNC window manager

**Decision:** Use Openbox (not fluxbox) as the WM inside KasmVNC sessions.

**Rationale:** The user wants "easy way to launch apps from the KasmVNC session without having to SSH." Openbox has a native XML menu system (`~/.config/openbox/menu.xml` or `/etc/xdg/openbox/menu.xml`) that provides a right-click desktop launcher — exactly this capability. Fluxbox has a menu system too but it's less well-documented for containerized use. The LinuxServer KasmVNC baseimage community uses Openbox for exactly this pattern.

**Evidence:** LinuxServer docker-baseimage-kasmvnc docs show the `menu.xml` pattern with `<action name="Execute"><command>/usr/bin/app</command></action>` items. Openbox autostart mechanism launches apps on WM init.

**Alternatives Considered:**
- fluxbox (current) — has menu system but requires different config format, less community documentation for containerized KasmVNC use
- XFCE — full DE, much heavier, overkill for this use case

---

### Base image on Debian 13 trixie, not Ubuntu 24.04

**Decision:** New `hive-base` image uses `debian:trixie` (Debian 13).

**Rationale:** User explicitly requested Debian 13. Trixie released August 2025, LTS through 2030 — longer lifecycle than Ubuntu 24.04 LTS (through 2029). Kernel 6.12 LTS. Stable, well-supported package set.

**Alternatives Considered:**
- ubuntu:24.04 (current) — already working, but user explicitly wants Debian 13

---

### KasmVNC in the base image (not per-template)

**Decision:** KasmVNC is installed in the base image so all templates inherit it.

**Rationale:** User confirmed: "In the base image." DRY principle — no need to add it per-template. KasmVNC doesn't consume resources when not in use; `vncserver` only runs when started by a `coder_app`.

---

### Obsidian autostarts in all templates; Chrome does NOT autostart

**Decision:** Obsidian autostarts via Openbox `autostart` in all templates (worker, verifier, council, ai-dev). Chrome does not autostart.

**Rationale:** User note: "obsidian does tho since it needs to be used by claude to understand what i need him to do + share context across multiple agents." Chrome is on-demand only.

---

### vault_repo as required per-template variable

**Decision:** Each template has a `vault_repo` string variable (required, no default). Users configure it when creating a workspace.

**Rationale:** Coder does not support deployment-level or organization-level template variables. Per-template required variable is the only mechanism. Workspace presets can pre-fill it to avoid repetition.

**Evidence:** User confirmed: "i don't see a way to add global vars; i think we will have to do it per template required var"

---

### Both official Obsidian CLI + notesmd-cli installed

**Decision:** Install both. Official CLI for full feature set when Obsidian GUI is running. notesmd-cli for headless fallback and scripting.

**Rationale:** User note: "i think the cli has some functions that are not available to notesmd-cli." Coexistence is simple (both are binaries). Official CLI requires Obsidian running — since Obsidian autostarts, it's always available in KasmVNC sessions. notesmd-cli provides safety net.

## Interface Contracts

- **S01 → S02:** `ghcr.io/<org>/hive-base:latest` image published; contains claude, obsidian, notesmd-cli, act, KasmVNC, Openbox, Google Chrome, Node.js 24, Docker CE, all common tools
- **S02 → S03:** All 4 templates rebuilt from base; `docker_image` resources reference new image; Openbox + KasmVNC infrastructure available in all templates
- **S03:** `vault_repo` Terraform variable → init script → `~/vault` git clone → Openbox autostart Obsidian pointing to `~/vault`; `/etc/cron.d/vault-sync` or user crontab every 30min

## Error Handling Strategy

- **Obsidian no-sandbox:** Electron apps in Docker require `--no-sandbox --disable-gpu-sandbox`. These flags in the autostart command, not assumed.
- **Vault clone failure:** init script treats vault clone as best-effort. If `vault_repo` is empty or clone fails, log warning and continue. Workspace starts regardless.
- **Vault sync conflicts:** cron uses `git pull --rebase` before push. Conflicts logged to `/var/log/vault-sync.log`.
- **Image pull failure in templates:** `docker_image` resource fails workspace creation. GHCR must be public or auth configured.
- **Obsidian version URL changes:** Pin version explicitly in Dockerfile; update deliberately.

## Final Integrated Acceptance

To call this milestone complete:
- `docker run --rm ghcr.io/<org>/hive-base:latest claude --version` exits 0
- `docker run --rm ghcr.io/<org>/hive-base:latest notesmd-cli --version` exits 0
- All 4 templates: `docker build` succeeds, `terraform validate` passes
- All 263 existing vitest tests pass (no orchestrator regressions)
- Manual: open any workspace → KasmVNC → Obsidian running with vault → right-click shows apps

## Testing Requirements

- S01: `docker run` smoke tests in GitHub Actions CI for each installed tool
- S02: `terraform validate` for all 4 templates in CI; existing vitest suite as regression check
- S03: Manual UAT for KasmVNC + Obsidian autostart; `pgrep obsidian` as automated proxy; vault sync tested manually

## Acceptance Criteria

### S01 — Base Image & CI
- `docker build` in `docker/hive-base/` succeeds
- `claude --version`, `notesmd-cli --version`, `act --version` all exit 0 in the image
- GitHub Actions workflow at `.github/workflows/build-base-image.yml` exists, triggers on push to main
- Image pushed to `ghcr.io/<owner>/hive-base:latest`

### S02 — Template Migration
- All 4 template Dockerfiles start with `FROM ghcr.io/<owner>/hive-base:latest`
- `docker build` succeeds for hive-worker, hive-verifier, hive-council, ai-dev
- `terraform validate` passes for all 4 templates
- 263 existing vitest tests still pass

### S03 — Obsidian & Vault Integration
- All 4 templates have `vault_repo` Terraform variable
- init.sh clones `$vault_repo` to `~/vault` on first start, `git pull` on reconnect
- Openbox autostart launches Obsidian pointing to `~/vault` on KasmVNC session start
- `menu.xml` has items for Obsidian + terminal
- Cron entry runs `git -C ~/vault add -A && git commit -m 'sync' && git push` every 30min
- `notesmd-cli search --vault ~/vault test` works from terminal

## Risks and Unknowns

- KasmVNC .deb for Debian trixie: need to verify which release package works (bookworm vs trixie); the noble .deb used in hive-council is Ubuntu-specific
- Obsidian Electron in Docker: `--no-sandbox` usually required; verify exact flags needed
- notesmd-cli headless mode: verify `--vault` flag path resolution; set `NOTESMD_DEFAULT_VAULT` env var to `~/vault`
- GHCR visibility: image must be public OR docker pull must be authenticated in each Coder workspace

## Existing Codebase / Prior Art

- `templates/hive-council/Dockerfile` — most complete existing Dockerfile; base image starts from this and generalizes it to Debian 13
- `templates/hive-council/scripts/claude-install.sh` — Claude CLI install; this logic moves into base image Dockerfile
- `templates/hive-council/main.tf` — `vault_repo` pattern follows same structure as `anthropic_api_key` conditional injection (D011)
- `.github/` — may not exist yet; create for GitHub Actions workflow

## Relevant Requirements

- R035 — Shared base image published to GHCR
- R036 — KasmVNC + Openbox in all templates with right-click launcher
- R037 — Obsidian autostarts with vault; official CLI available
- R038 — vault_repo variable, clone on init, git cron sync
- R039 — notesmd-cli for headless vault access
- R040 — GitHub Actions builds and pushes hive-base on main merge

## Scope

### In Scope
- New `docker/hive-base/Dockerfile` on Debian 13
- GitHub Actions workflow to build and push to GHCR
- Migration of hive-worker, hive-verifier, hive-council, ai-dev Dockerfiles to FROM base
- Switch from fluxbox to Openbox in KasmVNC
- Openbox menu.xml with Obsidian + terminal items
- Openbox autostart launching Obsidian on desktop session start
- vault_repo required variable in all 4 templates
- init.sh vault clone + pull logic
- git cron for vault sync every 30min
- notesmd-cli installed in base image
- Official Obsidian CLI (comes with Obsidian .deb)

### Out of Scope / Non-Goals
- Multi-vault support
- Obsidian plugin management
- Chrome autostart
- Versioned GHCR tags / semver (latest only)
- Coder prebuild pools (R031)
- Dashboard changes

## Technical Constraints

- KasmVNC .deb must match the Debian version — verify bookworm compatibility on trixie
- Obsidian must run with `--no-sandbox` in Docker
- GHCR image should be public for simplicity; no secrets in base image itself
- `vault_repo` empty string → init script skips vault setup gracefully, workspace still starts

## Integration Points

- GHCR — image pushed by GitHub Actions, pulled by each template's `docker_image` resource
- GitHub — vault_repo is a GitHub repo; uses existing GitHub external auth in Coder for private repos
- Openbox — menu.xml and autostart baked into base image

## Ecosystem Notes

- Debian 13 (trixie): released August 2025, kernel 6.12 LTS, support through 2030. Docker packages: `https://download.docker.com/linux/debian`
- KasmVNC releases: https://github.com/kasmtech/KasmVNC/releases — check for `bookworm` .deb (Debian 12 package likely works on Debian 13)
- Openbox menu.xml: `~/.config/openbox/menu.xml` (user) or `/etc/xdg/openbox/menu.xml` (system); XML `<action name="Execute">` items for app launching
- notesmd-cli: https://github.com/Yakitrak/notesmd-cli — Go binary; `notesmd-cli --vault /path <cmd>` for headless use; set `NOTESMD_DEFAULT_VAULT` env var
- Official Obsidian CLI: bundled with Obsidian 1.12+; `obsidian <cmd>` connects to running instance; available at `~/.local/bin/obsidian` after Obsidian install

## Open Questions

- KasmVNC .deb compatibility: use bookworm package on trixie — verify during S01 implementation
- GHCR visibility: recommend public; validate no secrets are baked into base image
