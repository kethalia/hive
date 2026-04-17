# M008: Release Workflow

**Gathered:** 2026-04-17
**Status:** Ready for planning

## Project Description

Set up a complete release pipeline for Hive's Docker images using changesets for version management, GitHub Actions for CI/CD, and restructured compose files for production vs local development.

## Why This Milestone

There is no release pipeline today. Docker images aren't published, there's no version tracking, and there's no CI check that Docker images even build. Hive can only be deployed by building from source. This milestone makes releases reproducible, versioned, and deployable from published images.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Run `pnpm changeset` to create a changeset, merge a PR with it, see a version PR auto-created, merge that, and find tagged Docker images in GHCR
- Run `docker compose up` to start Hive from published GHCR images (production)
- Run `docker compose -f docker-compose.local.yml up` to build and run from source (local development)
- See PR CI fail if a Docker image doesn't build

### Entry point / environment

- Entry point: GitHub Actions workflows triggered by PR and push events
- Environment: GitHub Actions runners, GHCR registry
- Live dependencies involved: GitHub API (changesets/action), GHCR (image push/pull)

## Completion Class

- Contract complete means: workflows exist, changeset config is correct, compose files reference correct images
- Integration complete means: a real changeset merged to main triggers the full pipeline end-to-end
- Operational complete means: published images start correctly with `docker compose up`

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- A changeset merged to main creates a version PR, and merging that PR pushes correctly tagged images to GHCR
- PR CI builds both Docker images and fails if either build breaks
- `docker compose up` pulls published images and starts the full stack
- `docker compose -f docker-compose.local.yml up` builds from source and starts the full stack
- `docker compose -f docker-compose.dev.yml up` still works unchanged

## Architectural Decisions

### Independent versioning (not fixed)

**Decision:** Use independent changeset versioning — each package versions independently.

**Rationale:** hive-orchestrator and hive-terminal-proxy are separate services with separate Dockerfiles. A change to terminal-proxy shouldn't bump the main app version.

**Alternatives Considered:**
- Fixed versioning (lsp-indexer pattern) — rejected because lsp-indexer's packages are a published SDK where consumers expect aligned versions. Hive's services are independently deployed.

### No npm publish

**Decision:** Skip npm publish entirely. Changesets used only for version tracking and Docker image tagging.

**Rationale:** Both packages are `private: true` with no npm consumers. The deliverable is Docker images, not npm packages.

**Alternatives Considered:**
- Publishing to npm alongside Docker — rejected as unnecessary complexity with no consumers.

### Conditional Docker builds in release workflow

**Decision:** Check changesets/action `publishedPackages` output to determine which images to build, rather than building all images on every release.

**Rationale:** Independent versioning means only changed packages should trigger builds. Building both images every time defeats the purpose of independent versioning.

**Alternatives Considered:**
- Always build both — simpler but wasteful, and conflates version semantics.

### Dockerfile upgrades to multi-stage pnpm builds

**Decision:** Upgrade both Dockerfiles from single-stage npm to multi-stage pnpm with non-root user.

**Rationale:** Current Dockerfiles use `npm install` despite the monorepo using pnpm. They're single-stage (dev deps in production image) and run as root. Multi-stage builds produce smaller, more secure images.

**Alternatives Considered:**
- Keep current Dockerfiles — rejected because npm/pnpm mismatch causes lockfile drift and the images are larger than necessary.

## Error Handling Strategy

- **Docker build failures on PR:** CI fails the PR check, blocking merge. Standard GitHub branch protection.
- **Release workflow failures:** If image push fails after version bump, the version is already committed. Re-running the workflow retries the push. No rollback of version bumps needed.
- **Registry auth failures:** Use `GITHUB_TOKEN` with `packages:write` scope. Standard GHCR pattern, no additional secrets.
- **Partial releases (independent versioning):** If one image builds and the other fails, the successful one still pushes. The failed one can be retried by re-running the workflow.

## Risks and Unknowns

- Minimal risk — this is established patterns (changesets, GHCR, multi-stage Docker builds) applied to a well-understood monorepo
- The main complexity is conditional image building in the release workflow (only build images for packages that were actually bumped)

## Existing Codebase / Prior Art

- `.github/workflows/build-base-image.yml` — existing base image workflow, publishes to `ghcr.io/kethalia/hive-base`. Stays unchanged.
- `Dockerfile` — current main app Dockerfile, single-stage npm, needs upgrade
- `services/terminal-proxy/Dockerfile` — current proxy Dockerfile, single-stage npm, needs upgrade
- `docker-compose.yml` — current compose that builds from source, will be renamed to `docker-compose.local.yml`
- `docker-compose.dev.yml` — postgres + redis only, stays as-is
- `pnpm-workspace.yaml` — already configured with `"."` and `"services/*"`
- `package.json` (root) — `hive-orchestrator`, version `0.1.0`, private
- `services/terminal-proxy/package.json` — `hive-terminal-proxy`, version `0.1.0`, private

### Reference: chillwhales/lsp-indexer release pattern

The lsp-indexer repo is the reference implementation:
- `.changeset/config.json` — `@changesets/changelog-github`, `privatePackages: { version: true, tag: true }`
- `release.yml` — `changesets/action@v1` creates version PRs, `publish: pnpm ci:publish` triggers on merge, `docker` job conditional on `indexerVersion != ''`
- `ci.yml` — shared workflow from `chillwhales/.github`, includes changeset check on PRs to main
- `docker.yml` — manual dispatch workflow for ad-hoc builds
- Tags: `{sha}`, `v{version}`, `latest`

Key adaptation for Hive: no npm publish (lsp-indexer publishes to npm), independent versioning (lsp-indexer uses fixed), two images instead of one, custom CI instead of shared workflows.

## Relevant Requirements

- R072 — Changesets configured for independent versioning
- R073 — PR CI builds both Docker images
- R074 — Merging changesets opens version PR
- R075 — Merging version PR triggers Docker build+push
- R076 — Production compose pulls published images
- R077 — Local compose builds from source
- R078 — Dev compose unchanged
- R079 — Dockerfiles upgraded to multi-stage pnpm
- R080 — Images published to ghcr.io/kethalia/
- R081 — Only changed packages trigger Docker builds

## Scope

### In Scope

- Changeset CLI and config for the monorepo
- CI workflow building Docker images on PRs
- Release workflow with changesets/action → version PR → Docker build+push
- Multi-stage Dockerfile upgrades for both services
- Compose file restructure (prod/local/dev)
- Image tagging: v{version}, sha-{sha}, latest

### Out of Scope / Non-Goals

- npm publishing (no consumers)
- Base image workflow changes (stays as-is)
- Manual dispatch Docker workflow (can add later if needed)
- Preview/canary builds from feature branches
- Docker image scanning or security checks (can add later)

## Technical Constraints

- Both packages are `private: true` — changesets must handle private packages
- pnpm monorepo — Dockerfiles must use pnpm, not npm
- Main app requires `prisma generate` during build
- Terminal-proxy is a standalone service in `services/terminal-proxy/`
- GHCR auth via `GITHUB_TOKEN` — no additional secrets needed
- `typescript.ignoreBuildErrors: true` in next.config.ts (D003) — Docker builds must work with this

## Integration Points

- GitHub Actions — CI and release workflows
- GHCR (ghcr.io/kethalia/) — image registry
- changesets/action@v1 — version PR creation and publish detection
- Coder — production compose may need CODER_URL etc. env vars passed through

## Testing Requirements

- CI workflow: verify both images build on PR (no push)
- Release workflow: verify conditional build based on publishedPackages output
- Compose files: verify `docker compose config` validates for all three compose files
- Dockerfiles: verify multi-stage builds produce working images

## Acceptance Criteria

### S01 (Changesets Setup)
- `pnpm changeset` creates a changeset file
- `pnpm changeset version` bumps the correct package.json independently
- Changeset config uses independent versioning, no npm publish

### S02 (Dockerfile Upgrades & Compose Restructure)
- Both Dockerfiles use multi-stage builds with pnpm
- `docker compose -f docker-compose.local.yml build` succeeds
- `docker compose -f docker-compose.local.yml up` starts the full stack
- `docker compose config` validates the prod compose
- `docker compose -f docker-compose.dev.yml up` works unchanged

### S03 (CI & Release Workflows)
- PR CI builds both Docker images without pushing
- Release workflow creates version PR on changeset merge
- Release workflow conditionally builds+pushes images for bumped packages only
- Images tagged with v{version}, sha-{sha}, latest

## Open Questions

- None — scope is well-defined and follows established patterns from lsp-indexer
