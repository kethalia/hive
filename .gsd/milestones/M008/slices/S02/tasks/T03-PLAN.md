---
estimated_steps: 35
estimated_files: 3
skills_used: []
---

# T03: Restructure compose files: rename local, create prod, update build contexts

## Description

Per decision D035, the compose files should be:
- `docker-compose.yml` — prod (references GHCR published images, no build directives)
- `docker-compose.local.yml` — builds from source (current docker-compose.yml content with updated build contexts)
- `docker-compose.dev.yml` — unchanged (postgres + redis only)

This task renames the existing docker-compose.yml to docker-compose.local.yml, updates it to use correct build contexts (terminal-proxy needs repo root context now), and creates a new prod docker-compose.yml.

## Steps

1. Rename `docker-compose.yml` to `docker-compose.local.yml` (use `git mv`)
2. In `docker-compose.local.yml`, update the terminal-proxy build section:
   - Change `context: ./services/terminal-proxy` to `context: .`
   - Change `dockerfile: Dockerfile` to `dockerfile: services/terminal-proxy/Dockerfile`
   - Keep all other settings (ports, environment) identical
3. Create new `docker-compose.yml` (prod):
   - `app` service: `image: ghcr.io/kethalia/hive:latest` (per D033), same ports/depends_on/environment as local but NO build directive
   - `terminal-proxy` service: `image: ghcr.io/kethalia/hive-terminal-proxy:latest` (per D033), same ports/environment but NO build directive
   - Same postgres and redis services with healthchecks and volumes
   - Add `restart: unless-stopped` to app and terminal-proxy services
4. Verify `docker compose config` validates (prod)
5. Verify `docker compose -f docker-compose.local.yml config` validates (local)
6. Verify `docker compose -f docker-compose.dev.yml config` validates (dev, unchanged)

## Must-Haves

- [x] docker-compose.local.yml has build directives and correct contexts
- [x] docker-compose.yml (prod) uses GHCR images per D033, no build directives
- [x] docker-compose.dev.yml is untouched
- [x] All three compose files validate with `docker compose config`
- [x] Prod compose has `restart: unless-stopped` on app services

## Verification

- `test -f docker-compose.local.yml` exits 0
- `grep -q 'ghcr.io/kethalia/hive:latest' docker-compose.yml` exits 0
- `grep -q 'ghcr.io/kethalia/hive-terminal-proxy:latest' docker-compose.yml` exits 0
- `! grep -q 'build:' docker-compose.yml` exits 0 (no build directives in prod)
- `grep -q 'build:' docker-compose.local.yml` exits 0 (has build directives)
- `docker compose config -q` exits 0
- `docker compose -f docker-compose.local.yml config -q` exits 0
- `docker compose -f docker-compose.dev.yml config -q` exits 0

## Inputs

- ``docker-compose.yml` — current build-from-source compose (to be renamed)`
- ``docker-compose.dev.yml` — postgres+redis only (unchanged)`
- ``Dockerfile` — updated root Dockerfile from T01`
- ``services/terminal-proxy/Dockerfile` — updated terminal-proxy Dockerfile from T02`

## Expected Output

- ``docker-compose.local.yml` — renamed from docker-compose.yml with updated terminal-proxy build context`
- ``docker-compose.yml` — new prod compose with GHCR images, restart policy, no build directives`

## Verification

test -f docker-compose.local.yml && grep -q 'ghcr.io/kethalia/hive:latest' docker-compose.yml && grep -q 'ghcr.io/kethalia/hive-terminal-proxy:latest' docker-compose.yml && docker compose config -q && docker compose -f docker-compose.local.yml config -q && docker compose -f docker-compose.dev.yml config -q
