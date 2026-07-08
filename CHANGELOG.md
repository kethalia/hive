# hive-orchestrator

## 2.5.13

### Patch Changes

- 5e09cee: Release the multi-session terminal focus fix so passive session reloads and recovery no longer move keyboard focus into hidden workspace panes.

## 2.5.12

### Patch Changes

- f3cd568: Stabilize the multi-session workspace close button so active boards can be closed reliably.

## 2.5.11

### Patch Changes

- a2d1527: Stabilize terminal websocket reconnects across browser lifecycle events.

## 2.5.10

### Patch Changes

- f728e8e: Restore terminal file paste when the browser Clipboard API does not expose copied files.

## 2.5.9

### Patch Changes

- f05d2f4: Prevent Ctrl+V image paste from dispatching through both the Clipboard API and native paste event paths.

## 2.5.8

### Patch Changes

- 88c7d90: Fix multi-session compose so commands send to the pane that opened compose.

## 2.5.7

### Patch Changes

- 42d00b0: Release the global dashboard keybinding and command palette fixes.

## 2.5.6

### Patch Changes

- dfda039: Add regression coverage for compose paste parity across regular terminal and multi-session workspace surfaces.

## 2.5.5

### Patch Changes

- 4ab327f: Make terminal clipboard paste reliable for text, images, and files by handling browser clipboard data before terminal apps can fall back to unavailable X11 clipboards, and stream pasted assets into Coder workspaces through the SSH stdio transport.

## 2.5.4

### Patch Changes

- 73e91a1: Scope xterm row selection to explicit selection mode so normal tmux mouse scrollback does not show browser selection artifacts.

## 2.5.3

### Patch Changes

- a320c32: Keep multi-session workspace panes warm while switching workspace boards so terminals stay mounted without reloading sessions.

## 2.5.2

### Patch Changes

- 18b7d67: Fix workspace terminal panes so single-session boards use the full available height.

## 2.5.1

### Patch Changes

- 8a2aba0: Fix terminal paste so Ctrl+V dispatches once and add the shared terminal context menu to multi-session workspace panes.

## 2.5.0

### Minor Changes

- ebfc79f: Unify terminal paste handling across desktop, mobile, tabbed, and multi-session terminals with compose staging for multiline text and workspace image paste uploads.

## 2.4.7

### Patch Changes

- 0598973: Fix the Coder template and hive-base Obsidian MCP seed configuration to use a published mcpvault package version so Codex, Claude Code, and pi can complete MCP startup.

## 2.4.6

### Patch Changes

- 508b542: Add in-place terminal connection recovery, Git pane proof refresh, sanitized proxy diagnostics, and workspace-board recovery status for terminal resilience.

## 2.4.5

### Patch Changes

- 67bfbf0: Tighten workspace board Git pane restoration metadata validation and avoid fallback key collisions for persisted Git panes.

## 2.4.4

### Patch Changes

- 8c0f1d6: Document terminal workspace updates and ignore generated agent evidence artifacts plus generated doc-contract tests.
- Updated dependencies [8c0f1d6]
  - @hive/auth@1.0.3
  - @hive/db@0.1.2

## 2.4.3

### Patch Changes

- 43f62fe: Add mobile terminal ergonomics, navigation favorites schema changes, terminal proxy resize coverage, and CI audit policy for the dev-only Vitest UI advisory.
- Updated dependencies [43f62fe]
  - @hive/db@0.1.1

## 2.4.2

### Patch Changes

- 179761f: Add Git clone discovery, home-root sidebar browsing, and session-bound persistent clone terminals with hardened proxy validation.
- Updated dependencies [179761f]
  - @hive/auth@1.0.2

## 2.4.1

### Patch Changes

- 630b81c: Migrate existing host-only session cookies to the configured domain scope and clear both cookie scopes on logout so the terminal WebSocket receives authentication on sibling subdomains.

## 2.4.0

### Minor Changes

- e0c0d38: Add the mobile-first agentic development experience.

## 2.3.2

### Patch Changes

- 5cdb610: Install Codex and maintained OpenGSD packages in Coder templates, wire Codex Playwright MCP/skills, and document workspace migration steps.

  Operator note: existing Coder workspaces created from the previous templates must be rebuilt or manually repaired so they stop resolving abandoned pre-OpenGSD packages and pick up the maintained `@opengsd` package shims, Codex CLI, Codex MCP config, and Codex skill wiring.

## 2.3.1

### Patch Changes

- c955598: Harden Helm rollout defaults and include the migrate image in deployment preflight coverage.

## 2.3.0

### Minor Changes

- 107a03d: Add terminal interaction layer: keybinding registry, clipboard copy/paste, session shortcuts, command palette, context menu, floating action button with virtual keys, and help overlay

## 2.2.0

### Minor Changes

- 5bcfc22: Add per-preview wildcard Certificate template for cookie-isolated preview environments. The chart now stamps a cert-manager Certificate covering both the preview host apex and `*.<host>` when `preview.enabled` is true.

## 2.1.11

### Patch Changes

- 3012717: Inject `NEXT_PUBLIC_TERMINAL_WS_URL` at runtime via `window.__HIVE_CONFIG__` so a single Docker image can be promoted across environments without rebuilding. Also document previously-undocumented env vars (login allowlist, Coder template IDs, pi provider defaults, tuning knobs, service bind config) in `.env.example`.

  Add `COOKIE_DOMAIN` env to the session cookie. When set (e.g. `.local.kethalia.com`), the cookie is sent to sibling subdomains, fixing the terminal-proxy `no_cookie → 401` rejection when the web UI and terminal-proxy live under different subdomains.

## 2.1.10

### Patch Changes

- a20ae21: Transpile `@hive/db` workspace package so Next/Turbopack resolves the generated Prisma client's `.js`-extension ESM imports during the production build.

## 2.1.9

### Patch Changes

- 033670c: Extract `@hive/db` workspace package owning the Prisma schema, migrations, and `PrismaClient` singleton. Web, auth, and migrate now import from `@hive/db` directly; the old `src/lib/db/index.ts` and `services/auth/src/db.ts` barrels are removed. New dedicated `hive-migrate` image runs `prisma migrate deploy` as a Helm hook.

## 2.1.8

### Patch Changes

- Updated dependencies [2323c3d]
  - @hive/auth@1.0.1

## 2.1.7

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

## 2.1.6

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

## 2.1.5

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

## 2.1.4

### Patch Changes

- 9f7f91c: ci: pin reusable workflows to @v1 and consolidate changeset check via ci-changeset-check reusable

## 2.1.3

### Patch Changes

- a6a3aeb: Seed pi MCP config from `~/.claude/mcp.json` into `~/.mcp.json` (and the cloned project's `.gsd/mcp.json` in Hive workers) so pi picks up playwright/obsidian MCP servers from first boot. Pi only reads project-rooted MCP config, so without seeding it has no MCP tools when launched from `~` or any project without its own config. Also align playwright `DISPLAY` to `:1` (matching the KasmVNC display) across `claude-mcp.json`, both `tools-shell.sh` chrome aliases, and the ai-dev README.

## 2.1.2

### Patch Changes

- 672e7d6: Normalize HCL formatting in ai-dev template and refine VS Code color theme defaults so the template gets pushed to Coder.

## 2.1.1

### Patch Changes

- c1b4d7d: Fix PATH duplication on workspace rebuild by using binary path checks instead of command -v

## 2.1.0

### Minor Changes

- e1a2d80: Add auth service integration with session-based authentication, token lifecycle management, and auth middleware

## 2.0.1

### Patch Changes

- 085623a: Fix PR review findings: VAPID race condition, rate-limit memory leak, task auth scoping, PWA manifest path

## 2.0.0

### Major Changes

- ac09e67: Multi-user Coder authentication: replaced static CODER_URL/CODER_SESSION_TOKEN env vars with per-user, per-deployment credentials stored encrypted in Postgres. Added login/logout flow, session management, token auto-rotation, PWA support with push notifications for token expiry.

## 1.0.1

### Patch Changes

- 81bff95: Multi-target vault sync: copy skills and context files to ~/.claude/, ~/.agents/, ~/.pi/agent/ with independent per-directory manifest cleanup

## 1.0.0

### Major Changes

- 78c7ca4: Release pipeline: multi-stage Docker builds, CI validation, and GHCR publishing via changesets
