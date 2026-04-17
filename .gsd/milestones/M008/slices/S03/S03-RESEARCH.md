# S03: CI & Release Workflows — Research

## Summary

This slice creates two GitHub Actions workflows: a **CI workflow** that builds both Docker images on PRs (no push), and a **release workflow** that uses `changesets/action@v1` to create version PRs and conditionally build+push Docker images for bumped packages only. The pattern is well-established — lsp-indexer's `release.yml` is the direct reference implementation, adapted for two independent images instead of one.

**Depth: Light research.** All patterns exist in the lsp-indexer reference repo at `/home/coder/lsp-indexer/.github/workflows/`. GitHub Actions, changesets/action, and GHCR are known technologies already used in this org. The only complexity is conditional builds for two independent packages instead of one.

## Requirements Owned

- **R073** — PR CI builds both Docker images (primary)
- **R074** — Merging changesets opens version PR (primary)
- **R075** — Merging version PR triggers Docker build+push (primary)
- **R080** — Images published to ghcr.io/kethalia/ (primary)
- **R081** — Only changed packages trigger Docker builds (primary)

## Recommendation

Create two workflow files:

1. **`.github/workflows/ci.yml`** — Triggers on PRs to main. Builds both Docker images with `push: false, load: true` (same pattern as `build-base-image.yml`). Single `ci-pass` gate job for branch protection. Include changeset validation check.

2. **`.github/workflows/release.yml`** — Triggers on push to main. Uses `changesets/action@v1` to either create a version PR or detect published packages. Two conditional Docker jobs gate on extracted package versions from `publishedPackages` output. Tags: `v{version}`, `sha-{sha}`, `latest`.

No npm publish step needed (D034). The `publish` command for changesets/action just runs `changeset version` since there's nothing to publish — the action detects the version bump and reports packages as "published" via its outputs.

## Implementation Landscape

### Existing Infrastructure

| Asset | Location | Role |
|-------|----------|------|
| Base image workflow | `.github/workflows/build-base-image.yml` | Reference for GHCR login, Docker build-push-action, tagging |
| Root Dockerfile | `Dockerfile` | 3-stage pnpm build, standalone Next.js (from S02) |
| Terminal-proxy Dockerfile | `services/terminal-proxy/Dockerfile` | 3-stage pnpm deploy build (from S02), context=repo root |
| Changeset config | `.changeset/config.json` | Independent versioning, private packages, no npm publish (from S01) |
| Prod compose | `docker-compose.yml` | References `ghcr.io/kethalia/hive:latest` and `ghcr.io/kethalia/hive-terminal-proxy:latest` |
| lsp-indexer release.yml | `/home/coder/lsp-indexer/.github/workflows/release.yml` | Direct reference: changesets/action → conditional Docker build |
| lsp-indexer ci.yml | `/home/coder/lsp-indexer/.github/workflows/ci.yml` | Reference for CI gate pattern |

### Key Patterns from lsp-indexer Reference

**Release workflow** (`/home/coder/lsp-indexer/.github/workflows/release.yml`):
- `changesets/action@v1` with `publish: pnpm ci:publish` and `version: pnpm changeset version`
- Outputs: `published`, `publishedPackages` (JSON array of `{name, version}`)
- Conditional Docker job: `if: needs.release.outputs.indexerVersion != ''`
- Version extraction: `jq -r '.[] | select(.name == "@chillwhales/indexer") | .version'`
- Tags: `{sha}`, `v{version}`, `latest` — computed in a meta step
- OCI labels on images for traceability

**CI workflow** (`/home/coder/lsp-indexer/.github/workflows/ci.yml`):
- Uses shared `chillwhales/.github` workflows — Hive should NOT use these (different project structure)
- Changeset check: `changeset-check: ${{ github.base_ref == 'main' }}`
- Single `ci-pass` gate job with `if: always()` and explicit result checks

### Adaptation for Hive (Two Independent Images)

The key difference from lsp-indexer: Hive has **two independently versioned packages** that each produce a Docker image.

**Release job outputs need two version extractions:**
```
orchestratorVersion: jq select(.name == "hive-orchestrator") | .version
terminalProxyVersion: jq select(.name == "hive-terminal-proxy") | .version
```

**Two conditional Docker jobs:**
- `docker-app`: `if: needs.release.outputs.orchestratorVersion != ''`
  - Image: `ghcr.io/kethalia/hive`
  - Dockerfile: `Dockerfile` (context: `.`)
- `docker-terminal-proxy`: `if: needs.release.outputs.terminalProxyVersion != ''`
  - Image: `ghcr.io/kethalia/hive-terminal-proxy`
  - Dockerfile: `services/terminal-proxy/Dockerfile` (context: `.` — repo root, matching docker-compose.local.yml)

**Tagging per image:**
- `ghcr.io/kethalia/hive:v{version}`, `ghcr.io/kethalia/hive:sha-{sha}`, `ghcr.io/kethalia/hive:latest`
- `ghcr.io/kethalia/hive-terminal-proxy:v{version}`, `ghcr.io/kethalia/hive-terminal-proxy:sha-{sha}`, `ghcr.io/kethalia/hive-terminal-proxy:latest`

### CI Workflow: Docker Build Verification

For PR CI, build both images without pushing (verifies Dockerfiles aren't broken):
- Use `docker/build-push-action@v6` with `push: false, load: true` (same as base image workflow)
- Build both images in parallel jobs
- No need for GHCR login on PRs (no push)
- Include changeset check: verify PR includes a changeset when targeting main

### The "publish" Command for Private Packages

Since both packages are `private: true` with `access: restricted`, there's nothing to publish to npm. The `publish` command for changesets/action should just be a script that:
1. Runs `changeset version` (already done by `version` param — but the `publish` param is what triggers the "published" output)
2. Actually: `changesets/action` uses `publish` to detect what was released. For private packages with `privatePackages: { version: true, tag: true }`, the action creates git tags and reports them as published.

Looking at lsp-indexer: `publish: pnpm ci:publish` — this runs actual npm publish. For Hive, we need a script that just signals completion. The simplest approach: `publish: pnpm changeset tag` — this creates git tags for versioned packages without publishing to npm. The action then reads the tags to populate `publishedPackages`.

**Important nuance:** `changesets/action@v1` populates `publishedPackages` based on what the `publish` command does. For tag-only (no npm), use `changeset tag` as the publish command. This creates git tags and the action reports the packages.

### Permissions

```yaml
permissions:
  contents: write      # For version commits and tags
  pull-requests: write # For creating version PRs
  packages: write      # For GHCR push
```

### Actions Versions (Pin to Latest Stable)

- `actions/checkout@v4`
- `pnpm/action-setup@v4`
- `actions/setup-node@v4`
- `docker/setup-buildx-action@v3`
- `docker/login-action@v3`
- `docker/build-push-action@v6`
- `changesets/action@v1`

### Concurrency

- CI: `cancel-in-progress: true` (supersede old PR checks)
- Release: `cancel-in-progress: false` (never cancel a release in progress)

## Constraints

1. **No Docker daemon in Coder workspace** — workflows can only be verified by syntax/structure checks locally. Actual build verification happens when CI runs on GitHub.
2. **No shared workflows** — lsp-indexer uses `chillwhales/.github` shared workflows. Hive is in `kethalia` org and should have self-contained workflows.
3. **Terminal-proxy Dockerfile context is repo root** — the build context must be `.` not `./services/terminal-proxy` (S02 established this for pnpm workspace deploy compatibility).
4. **`changeset tag` for private packages** — need to add a `ci:release` script that runs `changeset tag` as the publish command for changesets/action.

## Task Decomposition Guidance

Natural seams for the planner:

1. **CI workflow** (`.github/workflows/ci.yml`) — PR Docker builds + changeset check + gate job. Independent file, can be built first.
2. **Release workflow** (`.github/workflows/release.yml`) — changesets/action + two conditional Docker jobs. Depends on understanding CI patterns but is an independent file.
3. **Package.json scripts** — Add `ci:release` script (e.g., `changeset tag`) for the release workflow's publish command.

Tasks 1 and 2 are independent files. Task 3 is a one-line addition to package.json. All three can be verified with `actionlint` (if available) or basic yaml parsing + grep checks.

## Verification Strategy

- YAML validity: `node -e "require('js-yaml').load(fs.readFileSync(...))"` or similar
- Structure checks: grep for required action versions, permissions, conditional gates
- Changeset integration: verify `ci:release` script exists in package.json
- Docker build contexts match what S02 established (`.` for both)
- Image names match D033 (`ghcr.io/kethalia/hive`, `ghcr.io/kethalia/hive-terminal-proxy`)
- No push on PR builds (`push: false`)
- Conditional Docker jobs gate on correct package names

## Skill Discovery

No additional skills needed. GitHub Actions, Docker, and changesets are all well-established patterns with sufficient reference material in the lsp-indexer repo.
