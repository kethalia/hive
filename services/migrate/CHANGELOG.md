# hive-migrate

## 0.1.11

### Patch Changes

- 8dcbc43: Add separate native Codex and Claude account windows for workspace connections through a versioned, signed Hive bridge. Bind account operations to the selected workspace build and preserve credential locks, provider flow state and reconnect behavior.

  Package the independent bridge, pinned Codex runtime installer and native workspace identity helper across workspace profiles. Configure matching deployment issuer keys, package pins and workspace bridge parameters for activation.

  Match the Creative Studio connection experience with expiry, copy and disconnect controls, and expose native Codex usage and version-protected runtime defaults inside Accounts.

  Reset command palette scrolling when the search changes and explain when the selected workspace needs enrollment or the Accounts bridge.

  Add a sidebar to Codex and Settings, a focused device-code sign-in, and expandable Hive build details. Manage workspace Codex skills and plugins and browse session history and MCP integrations in Hive.

  Extend the Settings and Codex sidebar dividers to the bottom of each pane and add a title-bar toggle. Give each shared Strip gutter one resize divider that moves both adjoining edges together. Keep the outer grip clear of the window border.

  Animate sidebar toggles with reduced-motion support and load larger Codex plugin and integration inventories within dedicated limits.

  Remember separate Codex and Claude workspace selections on this browser, and start a stopped workspace directly from either account window.

  List workspaces and their status in the first tab of each account window, where users can switch workspaces or start the selected one.

- Updated dependencies [d7bd8b1]
- Updated dependencies [a8ea438]
- Updated dependencies [37c5529]
  - @hive/db@0.4.0

## 0.1.10

### Patch Changes

- d0b49aa: Release all four application images with the Node.js 22.23.4 security update.
  The web image also includes the patched Next.js 16.4.1 runtime.

## 0.1.9

### Patch Changes

- Updated dependencies [7efebce]
  - @hive/db@0.3.0

## 0.1.8

### Patch Changes

- 069ef2f: Check existing PostgreSQL schemas for a completed baseline before deploying migrations. Preserve legacy schema/history and provide an explicit baseline-adoption runbook when reconciliation is required.

## 0.1.7

### Patch Changes

- 7b0f8fe: Update the web, authentication, terminal, and migration runtime dependency chains to patched
  Next.js, Prisma, Undici, and WebSocket releases. Keep the UI scaffolding CLI out of production
  dependencies and make CI enforce the root application typecheck.
- Updated dependencies [7b0f8fe]
  - @hive/db@0.2.1

## 0.1.6

### Patch Changes

- f34c01f: Retire the asynchronous Tasks workflow and task-specific Coder template in favor of interactive,
  profile-driven workspaces. Add authenticated start, stop, and exact-name-confirmed delete controls,
  plus the database migration that removes legacy task records and task-owned workspace metadata.
- Updated dependencies [f34c01f]
  - @hive/db@0.2.0

## 0.1.5

### Patch Changes

- 8c0f1d6: Document terminal workspace updates and ignore generated agent evidence artifacts plus generated doc-contract tests.
- Updated dependencies [8c0f1d6]
  - @hive/db@0.1.2

## 0.1.4

### Patch Changes

- Updated dependencies [43f62fe]
  - @hive/db@0.1.1

## 0.1.3

### Patch Changes

- c955598: Harden Helm rollout defaults and include the migrate image in deployment preflight coverage.

## 0.1.2

### Patch Changes

- 1c3e7ac: Chart: switch `hive-migrate` Job from Helm hooks (`post-install,pre-upgrade`, which ArgoCD treats as PreSync) to ArgoCD-native sync hooks with `argocd.argoproj.io/sync-wave: "-5"`, and annotate the CNPG `Cluster` CR with sync-wave `-10`. Prevents the chicken-and-egg deadlock where the migrate Job's `wait-for-postgres` init container looped on a not-yet-created `hive-pg-rw` Service on fresh preview namespaces.

## 0.1.1

### Patch Changes

- 033670c: Extract `@hive/db` workspace package owning the Prisma schema, migrations, and `PrismaClient` singleton. Web, auth, and migrate now import from `@hive/db` directly; the old `src/lib/db/index.ts` and `services/auth/src/db.ts` barrels are removed. New dedicated `hive-migrate` image runs `prisma migrate deploy` as a Helm hook.
