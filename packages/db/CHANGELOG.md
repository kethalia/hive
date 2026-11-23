# @hive/db

## 0.4.0

### Minor Changes

- d7bd8b1: Support the existing Hive application on Cloudflare, including repository terminals, workspace file tools, clipboard uploads, audio, notifications, template jobs and durable background processing. Add the compatibility schema and preserve existing Node deployment behavior during migration.
- a8ea438: Serve Hive previews from the existing Cloudflare Worker with request-scoped Neon database access, in-process authentication, portable workspace/settings reads and ordinary terminal transport.
- 37c5529: Use Better Auth for browser sign-in through the configured Coder OAuth application. Preserve Hive user identities, encrypt provider credentials, serialize rotating refreshes, and support local sign-out and Coder disconnect. Propagate OAuth bearer credentials through workspace APIs, commands, terminals, audio, and template publication.

  Apply the additive Coder OAuth migration and scoped runtime grants, then configure the Coder OAuth client secret before enabling this release. Existing users complete a one-time Coder consent flow.

  Open Coder consent in a separate browser window. Serve a self-contained HTML callback and keep the window open until Hive verifies its browser session. Recover through serialized same-origin session checks when popup notifications are lost or the user closes the window after consent. Preserve typed browser-navigation responses for existing callback flows.

  Keep a visible workspace-loading state after successful popup sign-in until navigation completes, with a disabled button and accessible progress feedback.

  Fade command-palette results beneath the directional scroll arrows and preserve keyboard selection when scrolling moves rows under a stationary pointer. Mouse movement and clicks retain selection support.

  Resolve current OAuth credentials through the auth service for every Node terminal keepalive, including rotating tokens and revoked-session handling. Bind the refresh to the authenticated terminal session and configured Coder host.

## 0.3.0

### Minor Changes

- 7efebce: Add mobile and desktop PWA push alerts for Codex and Claude Code questions, approvals, and ready reports, with Claude failure, template result, and token-expiry alerts. Add per-device preferences, CRT sound previews, workspace hook setup and revocation, secure callback delivery, notification badges, and terminal deep links.

## 0.2.1

### Patch Changes

- 7b0f8fe: Update the web, authentication, terminal, and migration runtime dependency chains to patched
  Next.js, Prisma, Undici, and WebSocket releases. Keep the UI scaffolding CLI out of production
  dependencies and make CI enforce the root application typecheck.

## 0.2.0

### Minor Changes

- f34c01f: Retire the asynchronous Tasks workflow and task-specific Coder template in favor of interactive,
  profile-driven workspaces. Add authenticated start, stop, and exact-name-confirmed delete controls,
  plus the database migration that removes legacy task records and task-owned workspace metadata.

## 0.1.2

### Patch Changes

- 8c0f1d6: Document terminal workspace updates and ignore generated agent evidence artifacts plus generated doc-contract tests.

## 0.1.1

### Patch Changes

- 43f62fe: Add mobile terminal ergonomics, navigation favorites schema changes, terminal proxy resize coverage, and CI audit policy for the dev-only Vitest UI advisory.
