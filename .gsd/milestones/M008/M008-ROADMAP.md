# M008: Release Workflow

## Vision
A complete release pipeline for Hive's Docker images. Changesets drive independent versioning for hive-orchestrator and hive-terminal-proxy. PR CI builds Docker images to catch failures before merge. A release workflow creates version PRs and pushes tagged images to GHCR on merge. Compose files restructured: prod pulls published images, local builds from source, dev stays as-is.

## Slice Overview
| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | S01 | low | — | ✅ | pnpm changeset creates a changeset file; pnpm changeset version bumps the correct package.json independently |
| S02 | S02 | medium | — | ✅ | docker compose -f docker-compose.local.yml build succeeds with multi-stage pnpm builds; docker compose config validates prod compose; dev compose unchanged |
| S03 | S03 | medium | — | ✅ | PR CI builds both Docker images without pushing; merging a changeset to main opens a version PR; merging the version PR pushes tagged images to GHCR |
