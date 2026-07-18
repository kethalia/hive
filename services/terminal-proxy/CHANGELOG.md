# hive-terminal-proxy

## 2.0.12

### Patch Changes

- 42e2778: Load terminal runtime configuration before dashboard hydration and verify both browser and Coder WebSocket legs with acknowledged heartbeats so healthy sessions stay connected while half-open sessions recover automatically.

## 2.0.11

### Patch Changes

- 8a2aba0: Enable native tmux mouse scrollback for persistent web terminal sessions.

## 2.0.10

### Patch Changes

- 508b542: Add in-place terminal connection recovery, Git pane proof refresh, sanitized proxy diagnostics, and workspace-board recovery status for terminal resilience.

## 2.0.9

### Patch Changes

- 8c0f1d6: Document terminal workspace updates and ignore generated agent evidence artifacts plus generated doc-contract tests.
- Updated dependencies [8c0f1d6]
  - @hive/auth@1.0.3

## 2.0.8

### Patch Changes

- 43f62fe: Add mobile terminal ergonomics, navigation favorites schema changes, terminal proxy resize coverage, and CI audit policy for the dev-only Vitest UI advisory.

## 2.0.7

### Patch Changes

- 179761f: Add Git clone discovery, home-root sidebar browsing, and session-bound persistent clone terminals with hardened proxy validation.
- Updated dependencies [179761f]
  - @hive/auth@1.0.2

## 2.0.6

### Patch Changes

- c955598: Harden Helm rollout defaults and include the migrate image in deployment preflight coverage.

## 2.0.5

### Patch Changes

- Updated dependencies [2323c3d]
  - @hive/auth@1.0.1

## 2.0.4

### Patch Changes

- 9674e1c: fix(auth): default AUTH_SERVICE_URL to in-cluster Service, treat empty as unset

  The hive-web and hive-terminal charts previously shipped `AUTH_SERVICE_URL: ""`
  in their default ConfigMap. Combined with the `??` operator in the client code,
  this resulted in a literal empty `baseUrl`, so `fetch(\`${baseUrl}/login\`)`threw`Failed to parse URL from /login` rather than falling back to the local
  default.

  - Charts now default `AUTH_SERVICE_URL: "http://hive-auth"` (the in-cluster
    Service rendered by `hive-auth` when `Release.Name = hive-auth`). Operators
    deploying under a different release (e.g. an umbrella where the Service
    renders as `<umbrella-release>-hive-auth`) MUST override this value.
  - Client code in `src/lib/auth/service-client.ts` and
    `services/terminal-proxy/src/auth.ts` switched from `??` to `||` so an
    explicitly empty `AUTH_SERVICE_URL` env var also falls through to the
    local dev default (`http://localhost:4400`).

## 2.0.3

### Patch Changes

- eaca1db: fix(charts): writable /tmp emptyDir under readOnlyRootFilesystem, opt-out toggle

  All three chart Deployments now mount a writable `/tmp` emptyDir
  (`name: hive-tmp`) so pods with `securityContext.readOnlyRootFilesystem: true`
  can satisfy tsx transpile cache writes and any `os.tmpdir()` callers without
  EROFS. The volume is enabled by default and can be disabled with
  `tmpVolume.enabled: false` for consumers that need to mount their own `/tmp`
  (e.g. a sized tmpfs or PVC). The volume name is chart-scoped (`hive-tmp`) to
  avoid colliding with user-supplied entries in `.Values.volumes` /
  `.Values.volumeMounts`.

## 2.0.2

### Patch Changes

- 51039a3: ci: trigger fresh release through the gated Release workflow

  The v1.0.3 release (commit `e581794`) ran Release in parallel with Build
  images on the merge `push`, so the retag step looked for
  `:sha-e581794` before Build had pushed it and errored with
  `Source image ... does not exist in registry`. Result: `hive-web` and
  `hive-auth` never got `:v1.0.3` / `:latest` tags published on GHCR
  (only `:sha-e581794`). `hive-terminal` was recovered manually via
  workflow_dispatch.

  PR #64 fixed the underlying race by switching Release to
  `workflow_run: ["Build images"] completed`. Patch-bump the stack so a
  release flows end-to-end through the gated workflow and produces the
  missing version tags.

## 2.0.1

### Patch Changes

- 9f7f91c: ci: pin reusable workflows to @v1 and consolidate changeset check via ci-changeset-check reusable

## 2.0.0

### Major Changes

- e1a2d80: Rewire terminal proxy to use auth service for session-based cookie authentication instead of direct Coder token auth

## 1.0.0

### Major Changes

- 78c7ca4: Release pipeline: multi-stage Docker builds, CI validation, and GHCR publishing via changesets
