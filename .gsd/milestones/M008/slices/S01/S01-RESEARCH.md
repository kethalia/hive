# S01 Research: Changesets Setup

## Current State

- **No `.changeset/` directory exists** — fresh setup needed.
- **Workspace config** (`pnpm-workspace.yaml`): includes `"."` (root) and `"services/*"`.
- Two private packages:
  - `hive-orchestrator` (root) — `version: "0.1.0"`, `private: true`
  - `hive-terminal-proxy` (`services/terminal-proxy`) — `version: "0.1.0"`, `private: true`
- No existing changeset scripts in root `package.json`.
- lsp-indexer reference repo not accessible at `~/vault` or `skills/vault`.

## What Needs to Happen

### 1. Install `@changesets/cli` as a root devDependency

```bash
pnpm add -Dw @changesets/cli
```

### 2. Initialize changesets

```bash
pnpm changeset init
```

This creates `.changeset/config.json` and a `README.md` inside `.changeset/`.

### 3. Configure `.changeset/config.json`

Target config (adapted from lsp-indexer reference pattern for independent, no-publish):

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.1.1/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "restricted",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": [],
  "privatePackages": {
    "version": true,
    "tag": true
  }
}
```

Key decisions reflected:
- **No `@changesets/changelog-github`** dependency needed — use built-in `@changesets/cli/changelog` to keep it simple (no GitHub token required). Can upgrade later if desired.
- **`"access": "restricted"`** — prevents any accidental publish (both packages are private anyway).
- **`privatePackages: { version: true, tag: true }`** — ensures changesets bumps versions and creates git tags for private packages. This is critical since both packages are private.
- **No `fixed` groups** — D032 specifies independent versioning, so each package version bumps independently.

### 4. Add convenience scripts to root `package.json`

```json
"changeset": "changeset",
"changeset:version": "changeset version"
```

### 5. Optionally install `@changesets/changelog-github`

Not required for S01. The built-in changelog generator works fine. Can be added in a future slice if GitHub-linked changelogs are desired (requires `GITHUB_TOKEN`).

## Constraints and Notes

- Both packages are `private: true` — `changeset publish` would be a no-op, which aligns with D034 (no npm publish).
- `privatePackages.tag: true` means `changeset version` will not create tags itself — tags are created by `changeset tag` (a separate command) or by CI. This is relevant for Docker image tagging in later slices.
- The `baseBranch` must be `"main"` to match the repo's primary branch.
- No `@changesets/changelog-github` avoids needing a GitHub token for local dev; the simpler built-in changelog is sufficient for version-tracking-only use.

## Acceptance Criteria Mapping

| Criterion | How Satisfied |
|---|---|
| `pnpm changeset` creates a changeset file | Install CLI + init config |
| `pnpm changeset version` bumps correct package.json independently | Independent mode + `privatePackages.version: true` |
| Config uses independent versioning, no npm publish | No `fixed`, `access: "restricted"`, both packages private |

## Estimated Effort

~15 minutes implementation. Install one dependency, create config, add two scripts, verify with a test changeset.
