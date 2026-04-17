---
id: T03
parent: S02
milestone: M008
key_files:
  - docker-compose.yml
  - docker-compose.local.yml
key_decisions:
  - Prod compose uses GHCR images per D033 with restart: unless-stopped; local compose updated terminal-proxy build context to repo root for pnpm workspace deploy compatibility
duration: 
verification_result: passed
completed_at: 2026-04-17T12:41:39.044Z
blocker_discovered: false
---

# T03: Restructure compose files: prod uses GHCR images, local builds from source with updated contexts, dev unchanged

**Restructure compose files: prod uses GHCR images, local builds from source with updated contexts, dev unchanged**

## What Happened

Renamed `docker-compose.yml` to `docker-compose.local.yml` via `git mv`, then updated the terminal-proxy build context from `./services/terminal-proxy` to repo root (`.`) with explicit `dockerfile: services/terminal-proxy/Dockerfile` — required because T02's multi-stage Dockerfile now uses pnpm workspace deploy from the repo root. Created a new prod `docker-compose.yml` referencing GHCR images (`ghcr.io/kethalia/hive:latest` and `ghcr.io/kethalia/hive-terminal-proxy:latest`) per D033, with `restart: unless-stopped` on app services and no build directives. The dev compose file was left completely untouched. All three compose files validate cleanly with `docker compose config -q`.

## Verification

Ran 8 verification checks: file existence, GHCR image references in prod, absence of build directives in prod, presence of build directives in local, restart policy in prod, and config validation for all three compose files (prod, local, dev). Also verified dev compose is byte-identical to HEAD via diff.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `test -f docker-compose.local.yml` | 0 | pass | 5ms |
| 2 | `grep -q 'ghcr.io/kethalia/hive:latest' docker-compose.yml` | 0 | pass | 5ms |
| 3 | `grep -q 'ghcr.io/kethalia/hive-terminal-proxy:latest' docker-compose.yml` | 0 | pass | 5ms |
| 4 | `! grep -q 'build:' docker-compose.yml` | 0 | pass | 5ms |
| 5 | `grep -q 'build:' docker-compose.local.yml` | 0 | pass | 5ms |
| 6 | `docker compose config -q` | 0 | pass | 800ms |
| 7 | `docker compose -f docker-compose.local.yml config -q` | 0 | pass | 800ms |
| 8 | `docker compose -f docker-compose.dev.yml config -q` | 0 | pass | 800ms |

## Deviations

None

## Known Issues

None

## Files Created/Modified

- `docker-compose.yml`
- `docker-compose.local.yml`
