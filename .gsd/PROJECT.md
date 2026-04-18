# Hive

## What This Is

An automated development system inspired by Stripe's Minions. Accepts task descriptions via a web dashboard, spins up isolated Coder workspaces, runs GSD agents to implement the work using a blueprint pattern (deterministic steps interleaved with agent loops), auto-verifies output through proof-by-consumption in a separate verifier workspace, and produces PRs ready for human review.

The system uses Pi/GSD as the agent harness (leveraging Pi's SDK, RPC, and pi-web-ui web components), Coder for workspace isolation and lifecycle management, and a Next.js + Tailwind dashboard backed by Postgres and Redis.

## Core Value

Unattended task-to-PR automation with behavioral verification — the system doesn't just write code, it proves the output works by consuming it in a fresh environment.

## Current State

**M001 complete.** All 7 slices delivered and verified. The full task-to-PR automation pipeline is built: dashboard submission -> BullMQ dispatch -> worker workspace creation -> 8-step blueprint execution (hydrate -> rules -> tools -> agent -> lint -> commit-push -> CI -> PR) -> verifier workspace with adaptive strategy detection -> structured verification report -> live SSE streaming -> dashboard results display. 148 tests across 25 files, all passing. All 22 M001 requirements validated.

**M002 in progress — 3 of 4 slices complete.**
- S01 (Terraform + Schema + Queue Setup): complete — council template, schema columns, BullMQ queues configured
- S02 (Council Reviewer Blueprint): complete — 5-step blueprint (clone -> diff -> review -> emit) with Claude integration via base64-safe prompt passing, and JSON validation gate
- S03 (Aggregation & PR Comment): complete — aggregation logic groups findings by file+line with >=2 consensus, markdown formatting with severity sections, PR comment posting via gh CLI, step 13 integrated into task pipeline
- S04 (Council Dashboard): remaining — UI to display CouncilResultCard with severity badge counts and consensus highlighting; task submission form with councilSize field

**M004 complete — all 3 slices delivered and verified.**
- S01 (Coder Template API Client & Staleness Engine): complete
- S02 (Push Job Worker & SSE Streaming Route): complete
- S03 (Templates Dashboard Page with xterm.js): complete — 315 total tests pass across 42 files.

**M005 complete — all 4 slices delivered and verified.** Persistent tmux-backed interactive terminals in the Hive dashboard with workspace discovery, multi-tab support, session lifecycle management, and integrated access to external workspace tools. 76 new tests, 407 total passing across 51 files.
- S01 (Workspace Discovery & Listing): complete — /workspaces page with live Coder workspace listing, status badges, lazy-loaded tmux sessions, external tool links, sidebar navigation. 16 tests.
- S02 (Bidirectional Terminal via PTY WebSocket): complete — Custom server.ts wrapping Next.js with WebSocket upgrade proxy to Coder PTY endpoint. InteractiveTerminal with xterm.js, auto-reconnect with exponential backoff, tmux session persistence. 44 tests.
- S03 (Multi-Tab Terminal & Session Management): complete — TerminalTabManager with multiple simultaneous terminal tabs, inline rename, kill, session picker. 22 tests.
- S04 (External Tool Integration): complete — Workspace detail page at /workspaces/[id] with iframe-embedded Filebrowser/KasmVNC panels, tab toggle, popup-out buttons, Coder Dashboard link-out, error fallback. 10 tests.

**M006 complete — all 5 slices delivered and verified.** Persistent terminal sessions: server-side workspace keep-alive, infinite reconnection, Postgres-backed scrollback with virtual scrolling. 504 frontend tests, 88 proxy tests.
- S01 (Workspace Keep-Alive Service): complete
- S02 (Infinite Reconnection & Session Continuity): complete
- S03 (Scrollback Persistence Backend): complete
- S04 (Virtual Scrolling & Hydration UI): complete
- S05 (End-to-End Integration & Regression): complete

**M007 complete — all 3 slices delivered and verified.** Sidebar navigation overhaul: directory-tree sidebar with collapsible workspace/template sections, full-viewport terminal pages, floating sidebar toggle, template detail page with push flow, sidebar pin/unpin mode toggle. 462 tests passing. All 14 M007 requirements validated.
- S01 (Sidebar Tree Structure & Layout Overhaul): complete — Replaced flat nav with collapsible Workspaces/Templates tree sections with live Coder API data and 30s polling. Removed header/breadcrumbs globally, added floating SidebarTrigger. Footer with last-refreshed timestamp and refresh button. Inline error states with retry per section. 8 new tests.
- S02 (Terminal Integration & Session Management): complete — Terminal sessions nested under each workspace in sidebar with lazy-fetched agent info, session CRUD (create/kill), external-link buttons, 30s polling per expanded workspace. Full-viewport terminal page with keystroke exclusivity (stopPropagation + auto-focus). Stale entry recovery via hive:sidebar-refresh CustomEvent bridge. 10 new tests (7 sidebar + 3 keystroke integration).
- S03 (Template Detail Page & Sidebar Polish): complete — Template detail page at /templates/[name] with SSE push flow, sidebar pin/unpin mode toggle with localStorage persistence, old workspaces listing page removed, breadcrumbs updated to /tasks. 23 new tests (12 template detail + 11 sidebar mode).

**M008 complete — all 3 slices delivered and verified.** Complete release pipeline: changesets for independent versioning, multi-stage Dockerfiles, CI Docker builds on PRs, release workflow with version PRs and conditional tagged image publishing to GHCR. 10 M008 requirements (R072-R081).
- S01 (Changesets Setup): complete — @changesets/cli installed, independent versioning configured for both private packages, convenience scripts in root package.json
- S02 (Dockerfile Upgrades & Compose Restructure): complete — Multi-stage pnpm Dockerfiles for both services (standalone Next.js + pnpm deploy for terminal-proxy), non-root users, restructured compose files (prod with GHCR images, local builds from source, dev unchanged). All 3 compose files validate.
- S03 (CI & Release Workflows): complete — PR CI builds both Docker images without pushing (ci.yml), release workflow creates version PRs via changesets/action and conditionally pushes tagged images to GHCR per-package (release.yml). ci:release script added to package.json.

**M009 complete — 1 slice delivered and verified.** Multi-target vault sync: sync-vault.sh copies skills, CLAUDE.md, and AGENTS.md to three independent directories (~/.claude/, ~/.agents/, ~/.pi/agent/) with no symlinks and per-directory manifest cleanup. 16 tests. All 6 M009 requirements (R082-R087) validated.
- S01 (Multi-target vault sync): complete — Replaced 2-target sync (claude + gsd) with 3-target sync (claude + agents + pi). Deleted link_gsd_skills() symlink logic entirely. Per-directory .vault-managed manifests for independent stale cleanup. Both template copies byte-identical.

**M010 in progress — 2 of 4 slices complete.** Multi-user Coder authentication replacing static env vars with per-user, per-deployment credentials. 537 tests across 67 files.
- S01 (Auth Foundation — Login, Schema, Sessions): complete — Prisma schema (User/CoderToken/Session), AES-256-GCM encryption, CoderClient auth methods, session CRUD with cookie management, login flow orchestration with API key fallback (3 retries), server actions via next-safe-action (login/logout/getSession), edge-safe middleware route protection, sliding-window rate limiter (5/min per IP), login page UI with error display, (dashboard) route group restructuring with sidebar session indicator and logout. 59 tests.
- S02 (Per-User Token Rewiring): complete — getCoderClientForUser factory resolves per-user credentials from DB. All workspace actions, BullMQ workers, template operations, and workspace proxy use per-user credentials. Task model has userId FK. CODER_URL/CODER_SESSION_TOKEN removed from .env.example, ENCRYPTION_KEY added. 537 tests pass.
- S03 (Token Lifecycle & Resilience): remaining — auto-rotation, expiry handling, encryption key change resilience
- S04 (PWA & Push Notifications): remaining — PWA install, push notifications for token expiry

**Operational notes:** M001 cleanup scheduler not wired to entrypoint. M002 council can run in isolation or as part of full pipeline; initial testing with 3-reviewer council works correctly with mock data. Real GitHub integration tested via mocked gh CLI; live GitHub token handling depends on environment setup during deployment. M005 dev workflow now uses `tsx watch server.ts` instead of `next dev` to support WebSocket upgrade. M010 requires TOKEN_ENCRYPTION_KEY env var (64-char hex = 32 bytes) for credential encryption.

Repository: https://github.com/kethalia/hive

## Architecture / Key Patterns

- **Orchestrator:** Next.js 15 app (docker-composed with Postgres + Redis) manages task lifecycle
- **Workspace isolation:** Coder API creates/destroys workspaces per task. Two templates: worker (with Pi/GSD) and verifier (with Chrome, no AI tools)
- **Agent harness:** GSD (built on Pi) runs inside workspaces in `--print --no-session` mode. Blueprint execution pattern from Stripe — deterministic steps (lint, push, PR) interleave with agent loops (implement, fix CI failures)
- **Stripe Minions patterns:** Context hydration before agent launch, scoped rule injection, shift-left linting (5s timeout), 2-round CI cap, curated MCP tool subsets, workspace pre-warming
- **Verification:** Proof-by-consumption — verifier workspace pulls the PR branch and actually uses the output (test-suite execution for tested repos, dev server + screenshot for web apps, inconclusive for unknown types)
- **Dashboard:** Next.js + Tailwind v4, with live agent streaming via SSE (custom React components, not pi-web-ui Lit — D009)
- **Template Management:** Staleness engine compares local template files against Coder's active version via deterministic sha256 hashing of sorted file paths + contents. Push worker spawns coder CLI as child process with log-file-based SSE streaming. Dashboard page at /templates with xterm.js terminal panels for live push output. Detail page at /templates/[name] with template info and push flow.
- **Workspace Terminals:** Custom server.ts wraps Next.js with WebSocket upgrade support. Browser connects via xterm.js -> WebSocket proxy -> Coder PTY endpoint. All sessions tmux-backed for persistence. Infinite reconnection with exponential backoff capped at 60s. Multi-tab support via TerminalTabManager — inactive tabs hidden with display:none to preserve xterm.js instances. ResizeObserver-based re-fit on tab visibility changes. Session lifecycle (create/rename/kill) managed through server actions with SAFE_IDENTIFIER_RE validation. Session picker for reconnecting to existing tmux sessions. ReconnectId auto-regeneration after 3 consecutive failures to rejoin tmux sessions.
- **Scrollback Persistence:** Two-zone scroll architecture (D025): TerminalHistoryPanel (virtual scroll via @tanstack/react-virtual) renders unbounded older scrollback above xterm; xterm handles live terminal + recent hydrated history. Scrollback persisted to Postgres as chunked writes (S03). On reconnect, useScrollbackHydration fetches recent chunks and writes to xterm with live-data gating to prevent race conditions. Paginated API (cursor/limit) serves JSON for virtual scroll, binary for hydration (D026). ANSI escape sequences rendered via ansi-to-html with streaming mode for cross-chunk state.
- **Workspace Keep-Alive:** KeepAliveManager in terminal-proxy pings Coder extend API every 55s for each workspace with active WebSocket connections. ConnectionRegistry tracks workspaceId->connectionId mappings. /keepalive/status endpoint exposes per-workspace health. Frontend useKeepAliveStatus hook polls every 30s; KeepAliveWarning banner appears at 3+ consecutive failures.
- **External Tool Integration:** Workspace detail page at /workspaces/[id] embeds Filebrowser and KasmVNC in iframe panels with tab toggle and popup-out buttons. Coder Dashboard accessed via link-out. Cross-origin iframe error detection with automatic fallback to direct links. Disabled state for non-running workspaces.
- **Sidebar Navigation:** Directory-tree sidebar with collapsible Workspaces and Templates sections using shadcn Collapsible/SidebarMenuSub primitives. Per-section independent data fetching with 30s polling via setInterval. Floating SidebarTrigger replaces removed header/breadcrumbs. Footer shows last-refreshed timestamp, manual refresh button, and pin/unpin mode toggle. Inline Alert with retry button per section on fetch failure. Workspaces are nested Collapsibles with terminal sessions, external-link buttons (Filebrowser/KasmVNC/Code Server), and session CRUD. Agent info lazy-fetched and cached per workspace. Per-workspace 30s session polling for expanded workspaces. hive:sidebar-refresh CustomEvent bridge for stale entry recovery across component trees. Sidebar supports offcanvas (floating) and icon (pinned) modes persisted in localStorage via useSidebarMode hook. Mobile viewports render sidebar as Sheet overlay via shadcn's useIsMobile().
- **Terminal Keystroke Exclusivity:** Terminal page uses negative margin cancellation (-m-6 -mt-14) for full-viewport rendering. stopPropagation on keydown prevents keystroke bubbling. Auto-focus on mount via term.focus(), click-to-refocus on container interaction.
- **Versioning:** @changesets/cli configured for independent versioning across both private packages. No npm publish — changesets used for version tracking and Docker image tagging only. Built-in changelog generator (no GitHub token needed).
- **Docker Images:** Multi-stage pnpm Dockerfiles for both services. Root app uses 3-stage build (deps/builder/runner) with standalone Next.js output and non-root nextjs user. Terminal-proxy uses 3-stage build with `pnpm deploy --filter` for workspace-correct dependency isolation, tini as PID 1, and non-root appuser. Both use corepack with pnpm@10.32.1 on node:20-alpine.
- **Compose Files:** Three-file convention — docker-compose.prod.yml (prod, GHCR images, restart: unless-stopped), docker-compose.local.yml (build from source with correct contexts), docker-compose.dev.yml (postgres + redis only for local dev).
- **Vault Sync:** sync-vault.sh copies skills, CLAUDE.md, and AGENTS.md to three independent directories (~/.claude/, ~/.agents/, ~/.pi/agent/). No symlinks — all targets get direct copies. Per-directory .vault-managed manifests track vault-managed skills for independent stale cleanup. skill_targets array loop makes adding new target directories trivial.
- **Authentication:** Multi-user Coder auth via direct login API. Per-user encrypted API keys in Postgres. Dynamic Coder URL per user. Browser sessions database-backed. Workers use submitting user's stored credentials.
- **Deployment:** Docker-compose: Next.js + Postgres + Redis. PWA-capable with push notifications

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [x] M001: Minimum Viable Hive — Task-to-PR pipeline with worker + verifier + dashboard (22 requirements validated)
- [ ] M002: Council Review — N independent Claude reviewer agents analyse the PR diff in parallel, aggregate findings by consensus, post a single combined review comment
- [x] M004: Template Management Dashboard — Web UI for viewing template staleness and pushing updates (3 slices, 315 tests)
- [x] M005: Workspace Terminals — Persistent tmux-backed interactive terminals in the dashboard with workspace discovery and external tool integration (4 slices, 407 tests, 7 requirements validated)
- [x] M006: Persistent Terminal Sessions — Fix critical session persistence: server-side workspace keep-alive, infinite reconnection, Postgres-backed scrollback with virtual scrolling (5 slices, 504 frontend + 88 proxy tests)
- [x] M007: Sidebar Navigation Overhaul — Directory-tree sidebar with collapsible workspace/template sections, full-viewport terminal pages, floating sidebar toggle, template detail page, sidebar pin/unpin mode (3 slices, 462 tests, 14 requirements validated)
- [x] M008: Release Workflow — Changesets for independent versioning, CI Docker image builds on PRs, release workflow pushing tagged images to GHCR, compose file restructure (prod/local/dev) (3 slices, 5 requirements validated)
- [x] M009: Multi-Target Vault Sync — sync-vault.sh copies skills and context files to ~/.claude/, ~/.agents/, ~/.pi/agent/ with direct copies, no symlinks (1 slice, 16 tests, 6 requirements validated)
- [ ] M010: Multi-User Coder Authentication — Replace static CODER_URL/CODER_SESSION_TOKEN with per-user auth via Coder's direct login API, encrypted token storage, PWA with push notifications
