# S02: Template Migration — Research

**Date:** 2026-04-09

## Summary

S02 is straightforward: replace 4 identical 131-line ubuntu:24.04 Dockerfiles with thin ~5-line files that just `FROM ghcr.io/kethalia/hive-base:latest`. The base image (built in S01) already contains everything those Dockerfiles install, so the migration is mostly deletion. The main non-obvious work is: (1) fixing `browser-serve.sh` in 3 templates to launch `openbox` instead of `fluxbox` (fluxbox is not in the base image), and (2) adding a `browser-serve.sh` + `coder_app` to `hive-council`, which never had KasmVNC wired up in Terraform.

`terraform validate` already passes for hive-worker, hive-council, and hive-verifier (providers cached in `.terraform/`). `ai-dev` has un-initialized modules (`code-server`, `filebrowser`) — `terraform init` is needed there before validate will pass. The 263 vitest tests are orchestrator-level tests with no dependency on template Dockerfiles; they will continue to pass unchanged.

Vault/Obsidian integration (`vault_repo` variable, init.sh vault clone, Openbox autostart, menu.xml, cron) is **S03 scope** — not S02. S02 success = `docker build` succeeds for all 4 + `terraform validate` passes for all 4 + 263 vitest tests still pass.

## Recommendation

Replace each template Dockerfile with a minimal FROM-only file. Fix `browser-serve.sh` in the 3 templates that have it (swap `fluxbox` → `openbox`). Add `browser-serve.sh` + `coder_app` to `hive-council` (copy from hive-worker pattern). Run `terraform init` in `ai-dev` before validate. Run vitest once to confirm 263 still pass.

## Implementation Landscape

### Key Files

**Dockerfiles (all need replacement):**
- `templates/hive-worker/Dockerfile` — 131 lines, ubuntu:24.04; replace with `FROM ghcr.io/kethalia/hive-base:latest` (no template-specific layers needed)
- `templates/hive-verifier/Dockerfile` — identical to hive-worker; same treatment
- `templates/hive-council/Dockerfile` — 131 lines, ubuntu:24.04, nearly identical to hive-worker (only minor `userdel` guard differences); replace same way
- `templates/ai-dev/Dockerfile` — identical to hive-worker; replace same way

**browser-serve.sh (fluxbox → openbox fix):**
- `templates/hive-worker/scripts/browser-serve.sh` — line 63-64: `if command -v fluxbox &>/dev/null; then nohup fluxbox …` → change to `openbox`
- `templates/hive-verifier/scripts/browser-serve.sh` — same fix needed
- `templates/ai-dev/scripts/browser-serve.sh` — same fix needed
- `templates/hive-council/scripts/` — **no browser-serve.sh exists**; must create it (copy from hive-worker pattern, replace fluxbox with openbox)

**main.tf KasmVNC wiring (hive-council only):**
- `templates/hive-council/main.tf` — has no `coder_script` for browser-serve or `coder_app` for KasmVNC; add both (pattern from hive-worker lines ~267-294 and ~283-291 respectively)
- `templates/hive-worker/main.tf`, `templates/hive-verifier/main.tf`, `templates/ai-dev/main.tf` — already have `coder_script.browser_serve` and `coder_app.browser_vision` wired; no changes needed

**docker_image resource (all templates):**
- All 4 currently use `build { context = "." }` — this stays unchanged; the slim Dockerfile builds trivially fast (just `docker pull` of base + optional tiny additions)
- Trigger hash covers only `Dockerfile` in hive-worker/verifier/council; ai-dev covers `Dockerfile + scripts/*`

**terraform init (ai-dev only):**
- `templates/ai-dev/` — no `.terraform/` directory; `terraform init` must run before `terraform validate` works. Has un-initialized modules: `code-server`, `filebrowser`, `github-upload-public-key`, `git-commit-signing`, `git-config`

### Build Order

1. **Replace all 4 Dockerfiles first** — pure deletion, each becomes ~5 lines. Low risk, establishes the core deliverable.
2. **Fix browser-serve.sh in 3 templates** (fluxbox → openbox) — without this, the KasmVNC desktop starts but has no window manager running (cosmetic failure at runtime, not a build/validate failure, but correct to fix in S02).
3. **Add browser-serve.sh + coder_app to hive-council** — hive-council has KasmVNC in the image (via base) but no Terraform wiring to start it; add the script and coder_app resource following hive-worker's exact pattern.
4. **Run `terraform init` in ai-dev** — needed only for `terraform validate` to pass.
5. **Verify**: `docker build` for all 4 (local build), `terraform validate` for all 4, `npm run test` for 263 vitest tests.

### Verification Approach

```bash
# Build all 4 templates
docker build -t test-hive-worker templates/hive-worker/
docker build -t test-hive-verifier templates/hive-verifier/
docker build -t test-hive-council templates/hive-council/
docker build -t test-ai-dev templates/ai-dev/

# Terraform validate (hive-worker, hive-council, hive-verifier already have .terraform/)
cd templates/hive-worker && terraform validate
cd templates/hive-council && terraform validate
cd templates/hive-verifier && terraform validate
# ai-dev needs init first
cd templates/ai-dev && terraform init && terraform validate

# Vitest
npm run test  # expected: 37 test files, 263 tests passed
```

## Constraints

- `docker build` requires the base image to exist: `ghcr.io/kethalia/hive-base:latest`. If not yet pushed to GHCR (S01 CI may not have run), building locally requires the base to be present locally or pulled first. A `docker pull ghcr.io/kethalia/hive-base:latest` step before build, or the CI workflow must have run. In a local-only environment without the image, builds will fail with "manifest unknown". This is the key external dependency.
- `terraform validate` for ai-dev requires `terraform init` — modules are not cached. This needs network access to registry.coder.com.
- `terraform validate` for hive-worker, hive-council, hive-verifier works already (providers cached in `.terraform/` directories present in the repo).
- The new slim Dockerfiles should use `FROM ghcr.io/kethalia/hive-base:latest` — no extra layers needed for S02. Template-specific layers (Obsidian autostart, vault setup) come in S03.

## Common Pitfalls

- **fluxbox still in browser-serve.sh** — base image has openbox, not fluxbox. The `if command -v fluxbox` check will silently no-op, leaving the VNC session windowmanager-less. Change to `openbox` in all 3 affected scripts.
- **hive-council missing browser-serve.sh** — hive-council Dockerfile previously had KasmVNC installed but no Terraform script resource or coder_app to start/expose it. After migrating to base image (which has KasmVNC), the wiring must be added or the app won't be accessible.
- **docker build cache from old ubuntu layers** — if Docker build cache is warm for the old ubuntu:24.04 layers, it may still use them for the old trigger hash. After Dockerfile replacement the trigger sha1 changes, forcing a fresh build that actually pulls from GHCR.
- **ai-dev terraform init network** — if registry.coder.com is unreachable, `terraform init` fails and validate can't run. The CI environment needs outbound internet access.
- **`docker build` fails if GHCR image not yet public/pulled** — the base image must be accessible. In CI, add a `docker pull ghcr.io/kethalia/hive-base:latest` step or configure GHCR auth before running template builds.

## Open Risks

- If `ghcr.io/kethalia/hive-base:latest` hasn't been pushed to GHCR yet (first CI run not done), local `docker build` of templates will fail. Mitigation: build base image locally first (`docker build -t ghcr.io/kethalia/hive-base:latest docker/hive-base/`), or tag a local build.
- ai-dev has additional modules beyond hive-council (code-server, filebrowser) that require registry.coder.com network access during `terraform init`. If those modules have breaking changes or version mismatches, init may fail.
