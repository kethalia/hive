# Knowledge Base

## Docker-in-Docker Networking in Coder Workspaces

**Discovered:** 2026-03-19 during T01

Docker port forwarding (`-p 3000:3000`) does **not** expose ports to `localhost` on the Coder workspace host. This is because Docker runs in a nested container (DinD) where the Docker daemon's network namespace is separate from the host.

**Workarounds:**
- Run commands inside containers: `docker exec m001-app-1 <command>`
- Use container IPs directly: `docker inspect <container> --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'` (unreliable — sometimes firewalled)
- For drizzle-kit push: `docker exec m001-app-1 npx drizzle-kit push --force`
- For curl tests: `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000`

**Impact on testing:** Integration tests that need DB/Redis access should either run inside the app container or use a `--network` flag to join the Docker network.

## Next.js 15 Docker Binding

Next.js 15 `next dev` only listens on `localhost` by default. In Docker, you must use `next dev --hostname 0.0.0.0` for the server to be reachable from outside the container. The `HOSTNAME=0.0.0.0` env var alone is NOT sufficient.

## Vitest: Response Body Can Only Be Read Once

**Discovered:** 2026-03-19 during T02

When mocking `fetch` with `vi.fn().mockResolvedValue(new Response(...))`, the same Response object is returned on every call. But `Response.json()` / `Response.text()` consume the body stream — the second call throws "Body is unusable: Body has already been read". Use `mockImplementation(() => Promise.resolve(new Response(...)))` to return a fresh Response each time. This matters for polling tests where fetch is called multiple times.

## Slice Completion: Always Open a Separate PR

**Discovered:** 2026-03-19 after S01/S02 merge disaster

Each slice MUST get its own PR targeting `main`. Never point multiple slice branches at the same HEAD. The workflow:

1. Complete the slice on `milestone/M001` branch
2. Create a dedicated branch for the PR (e.g. `M001-S02`)
3. **Open the PR immediately** before starting the next slice
4. Wait for merge before rebasing the next slice on top

**What went wrong:** S01 and S02 branches both pointed to the same commit. When PR #7 (S01) was squash-merged, it included all S02 work too. S02 ended up with zero diff against main — no PR possible.

**Rule:** After every slice, stop, open a PR, get it merged, pull main, THEN start the next slice.

## GitHub Auth: Use gh CLI, Not .env

**Discovered:** 2026-03-19

Store GitHub PAT in `gh auth login --with-token`, NOT in `.env`. The `.env` file gets modified/overwritten during development. `gh` stores credentials in `~/.config/gh/hosts.yml` which persists across sessions. Classic PAT needs `repo` + `read:org` scopes for `gh pr create` to work.

## Turbopack CSS: "style" Export Condition Not Supported

**Discovered:** 2026-03-19

Turbopack (Next.js 16 default) cannot resolve CSS `@import` for packages that use the `"style"` export condition (e.g. `shadcn`, `tw-animate-css`). Workaround: vendor the CSS files locally (`src/styles/`) and import via relative paths.

## Tailwind v4 Requires @tailwindcss/postcss

**Discovered:** 2026-03-19

Tailwind CSS v4 with Next.js requires `@tailwindcss/postcss` as a devDependency AND a `postcss.config.mjs` that registers it. Without this, `@import "tailwindcss"` is silently ignored and no utility classes are generated.

## Base UI: render Prop Instead of asChild

**Discovered:** 2026-03-19

shadcn `base-nova` style uses Base UI, not Radix. Base UI components use `render={<Link href="..." />}` for polymorphism, NOT Radix's `asChild` pattern. Using `asChild` on Base UI components causes React DOM warnings.

## Vitest: Mock Module Boundaries, Not Just Libraries

**Discovered:** 2026-03-19 during T03

When a module validates env vars before constructing a library client (e.g., `getRedisConnection()` checks `REDIS_URL` then creates IORedis), mocking the library (`vi.mock("ioredis")`) is insufficient — the env var check runs first and throws. Instead, mock the entire wrapper module: `vi.mock("@/lib/queue/connection", () => ({ getRedisConnection: vi.fn(() => mockConnection) }))`. This is cleaner and avoids coupling tests to implementation details of the connection module.

## Blueprint Context Piping via Base64

**Discovered:** 2026-03-19 during S03/T03

When piping large context strings into a remote workspace via `coder ssh`, shell quoting/escaping breaks on special characters in code snippets and markdown. Use base64 encoding: `echo '<base64>' | base64 -d > /tmp/context.md` then reference the file in the Pi command. This avoids all shell interpolation issues. The pattern is in `src/lib/blueprint/steps/agent.ts`.

## Web Streams API for SSE in Next.js Route Handlers

**Discovered:** 2026-03-20 during S06/T01

Next.js Route Handlers work natively with Web `Response` objects, so use the Web Streams API (`ReadableStream`) rather than Node.js streams for SSE. Pattern: create a `ReadableStream` with `start(controller)` that enqueues `TextEncoder.encode()` data, return `new Response(stream, { headers: { 'Content-Type': 'text/event-stream', ... } })`. Add a `cancel()` method on the ReadableStream for cleanup when the consumer disconnects.

## EventSource Mock Pattern for Component Testing

**Discovered:** 2026-03-20 during S06/T03

To test components that use `EventSource`, create a `MockEventSource` class with helper methods (`_emitMessage`, `_emitStatus`, `_emitError`) and a static `instances` array. Assign it to `global.EventSource` before tests. Helpers call `onmessage`, `addEventListener` callbacks with synthetic `MessageEvent` objects. Track `close()` calls to verify cleanup. Pattern is in `src/__tests__/app/tasks/agent-stream-panel.test.ts`.

## Workspace Name Sync Between Coder Client and SSE Route

**Discovered:** 2026-03-20 during S06/T01

The SSE streaming route constructs workspace names using `hive-worker-${taskId.slice(0,8)}`. This MUST match the naming convention in `src/lib/coder/client.ts`. If either side changes, streaming silently fails (returns "waiting" forever with no error). There is no shared constant — this is a cross-module contract enforced only by convention.

## Coder Prebuilds: Container Name Stability is Critical

**Discovered:** 2026-03-20 during S07/T01

When using Coder prebuilt workspaces, the `docker_container` resource **must** have `lifecycle { ignore_changes = [name] }`. Without this, when a prebuild is claimed and ownership transfers, the container name changes (it includes the owner name), causing Terraform to destroy and recreate the container — completely defeating the purpose of prebuilds. The prebuild would "work" but take just as long as a cold start.

## Coder Workspace Preset Parameters Must Match Variable Names

**Discovered:** 2026-03-20 during S07/T01

The `coder_workspace_preset` `parameters` map keys must exactly match `variable` block names in the Terraform template. There is no compile-time validation — mismatches silently break prebuild creation. If template variables are refactored (renamed, removed), the preset parameters must be updated in sync.

## Composite Step Pattern for Multi-Phase Operations

**Discovered:** 2026-03-20 during M001 closeout

When a blueprint step needs to orchestrate sub-steps (e.g., CI feedback: poll → extract logs → retry agent → re-push → poll again), inject the sub-step factories as constructor parameters instead of importing them directly. This avoids circular imports and makes each sub-step independently testable. Pattern is in `src/lib/blueprint/steps/ci.ts` — `createCIStep(agentFactory, lintFactory, commitPushFactory)`.

## Dual-Workspace Lifecycle: Track Both, Clean Both

**Discovered:** 2026-03-20 during M001 closeout

A single task may spawn two workspaces (worker + verifier). Both must be independently tracked in the database and both must be cleaned up in the `finally` block regardless of success/failure. The verifier workspace ID is stored separately and cleaned up alongside the worker workspace. Never assume a task maps to exactly one workspace.

## SSE Streaming Architecture Trade-offs

**Discovered:** 2026-03-20 during M001 closeout

Three approaches were considered for live agent streaming: (1) Pi RPC over WebSocket, (2) Redis pub/sub, (3) agent tee-to-logfile + coder ssh tail. Option 3 was chosen because it requires zero changes to the agent harness (just append `| tee /tmp/log`) and avoids Redis pub/sub complexity. The trade-off: text-only streaming with no structured event types. The logfile also serves as a post-mortem artifact inside the workspace. If structured events are needed later, upgrade to Pi RPC mode.

## BullMQ + IORedis Dual-Install Type Mismatch

**Discovered:** 2026-04-09 during M002/S01/T01

BullMQ v5 bundles its own copy of ioredis under `node_modules/bullmq/node_modules/ioredis`. When `connection.ts` imports `IORedis` from the top-level `ioredis` package and returns it as a `ConnectionOptions`, TypeScript sees two structurally incompatible `Redis` types (same JS runtime, different declaration files). This causes `TS2322` errors on every queue/worker instantiation. This is a **pre-existing project-wide issue** (affects `task-queue.ts` too) — not a bug in new queue files. The fix is to deduplicate ioredis by aliasing bullmq's import or to add `"ioredis": "..."` to bullmq's peerDependencies. Until then, these errors are expected and new queue files that follow the same pattern are correct.

## Prisma Migrate Requires Live DB Even for --create-only

**Discovered:** 2026-04-09 during M002/S01/T01

`npx prisma migrate dev --create-only` still attempts to connect to the database (P1001) before generating the SQL file. In environments without a live Postgres connection, write the migration SQL manually and run `npx prisma generate` (which only reads `schema.prisma`) to regenerate the client. The manually-written SQL file is valid as a migration artifact for when the DB is available.

## Empty Diff Graceful Handling in Multi-Step Blueprints

**Discovered:** 2026-04-09 during M002/S02/T01-T02

When a multi-step blueprint processes source diffs (council-diff → council-review), empty diffs must be treated as **success**, not failure. The pattern: (1) diff-capture step returns empty string on no changes (ctx.councilDiff = ""), (2) review step checks for empty diff early and skips expensive operations (Claude invocation), returning success with empty findings ({ findings: [] }), (3) emit step validates the empty findings and passes through. This prevents spurious failures when no code changes are present. The contract is enforced by storing empty string (not undefined or null) to allow safe falsy checks in downstream steps.

## UI Expansion Pattern Consistency: 3-Item Threshold

**Discovered:** 2026-04-09 during M002/S04/T01

When rendering collapsible lists in cards (e.g., VerificationReportCard logs, CouncilResultCard consensus items), use a consistent expansion threshold to improve discoverability and familiarity. Established threshold: show first 3 items, render "Show more" button if total > 3, toggle state to show all. This pattern should be applied across future cards to establish UI consistency. Affects: task detail page card component library.

## Staleness Engine: Graceful Degradation on Network Errors

**Discovered:** 2026-04-13 during M004/S01/T02

The `compareTemplates()` function in `src/lib/templates/staleness.ts` returns `stale=false` (not an error) when the Coder API is unreachable or an individual template fetch fails. This prevents spurious template pushes during outages. The trade-off: a genuinely stale template won't be detected until connectivity is restored. Downstream consumers (push jobs, dashboard) should treat `stale=false` as "current OR unknown" — not as a positive guarantee of freshness.

## Tar Hashing: Deterministic Sort is Critical

**Discovered:** 2026-04-13 during M004/S01/T02

When computing a content hash over tar entries, entries must be sorted deterministically by path before hashing. Tar archives don't guarantee entry order, so the same directory contents can produce different tar archives with different native hashes. The staleness engine sorts entries by path for both local (filesystem) and remote (tar buffer) hashing to ensure comparison is reliable. The `tar-stream` package is used for parsing.

## Log-File SSE Streaming: Decouple Producers from Consumers

**Discovered:** 2026-04-13 during M004/S02

When streaming output from a background job (e.g., BullMQ worker) to the browser via SSE, writing to an intermediate log file and having the SSE route tail that file is more resilient than direct job-event-to-SSE coupling. Benefits: multiple clients can connect to the same stream, reconnection replays from disk, the log persists for post-mortem inspection, and the producer (worker) doesn't need to know about consumers. Use byte-offset reads for efficient incremental tailing and exit sentinels (`[exit:0]`/`[exit:1]`) for completion signaling.

## writeRef Pattern: Decouple Async Data from Component Mount

**Discovered:** 2026-04-13 during M004/S03/T02

When SSE data arrives before a component finishes mounting (e.g., xterm.js terminal loaded via dynamic import), use a `writeRef` + `lineHistory` pattern: store incoming lines in a history array and set a ref to write directly once the component mounts. On mount, replay the buffered history then switch to direct writes. Without this, early SSE messages are silently lost. Pattern is in `src/components/templates/TemplatesClient.tsx`.

## Next.js 16 Turbopack: No `ssr: false` Dynamic Import in Server Components

**Discovered:** 2026-04-14 during M005/S02/T03

Next.js 16 with Turbopack rejects `dynamic(() => import(...), { ssr: false })` when used in a Server Component. The workaround is to split into a server component (page.tsx) that fetches data and a client component wrapper that performs the `ssr: false` dynamic import. Pattern: `page.tsx` (server) → `terminal-client.tsx` ('use client' + dynamic import with ssr: false) → actual component. This applies to any component that accesses browser APIs on import (xterm.js, canvas libraries, etc.).

## Custom server.ts for WebSocket Upgrade in Next.js App Router

**Discovered:** 2026-04-14 during M005/S02/T02

Next.js App Router route handlers return `Response` objects and cannot access the raw HTTP socket needed for WebSocket upgrade. For bidirectional WebSocket support, wrap Next.js in a custom `server.ts` using `http.createServer` + `server.on('upgrade', ...)`. Use `app.getUpgradeHandler()` to delegate non-intercepted upgrades (HMR) back to Next.js. The `ws` package in `noServer` mode receives the raw socket from the HTTP server, avoiding port conflicts. Dev script becomes `tsx watch server.ts` instead of `next dev`.

## React Strict Mode: stateRef + Cancelled Flag for Async Effects

**Discovered:** 2026-04-15 during M006/S04/T02

React strict mode double-fires effects in development. When an effect triggers a fetch (e.g., scrollback hydration), the cleanup of the first invocation aborts the in-flight request if using `AbortController`. The second invocation then re-fetches, but the first abort may trigger error state if not handled. The cleaner pattern: use a `stateRef` (reset to idle in cleanup) plus a closure `cancelled` boolean flag. The cleanup resets stateRef so the second effect invocation sees idle and proceeds. The first invocation's cancelled flag prevents stale state writes. This avoids the abort-then-retry noise while still preventing race conditions. Pattern is in `src/hooks/useScrollbackHydration.ts`.

## Two-Zone Scroll Architecture for Terminal History

**Discovered:** 2026-04-15 during M006/S04

When terminal history exceeds xterm.js's built-in scrollback buffer, don't try to extend xterm's buffer — instead render a separate history panel above xterm. xterm handles live terminal output + recent hydrated history; a virtual-scrolled panel (e.g., @tanstack/react-virtual) renders unbounded older scrollback with cursor-based backward pagination. This separates concerns cleanly: xterm stays focused on terminal emulation while the history panel handles arbitrary-length browsing with lazy loading. The two zones communicate via scroll position callbacks to show/hide the history panel.

## Live-Data Gating During Async Hydration

**Discovered:** 2026-04-15 during M006/S04

When restoring terminal history from a database on reconnect, WebSocket messages may arrive before the async hydration fetch completes. Without gating, live data appears before historical data, creating a scrambled timeline. Solution: buffer incoming WebSocket data in an array during hydration (`isGatingLiveData` flag), then flush the buffer in order when hydration completes (success or error). This pattern applies to any component that must merge async historical data with a live streaming source.

## ResizeObserver for Container Dimension Changes Over Window Resize

**Discovered:** 2026-04-15 during M006/S02

For UI components that need to resize when their container changes (not just the window), use `ResizeObserver` instead of `window.addEventListener('resize')`. ResizeObserver fires on CSS visibility changes (display:none→block), parent resize, and window resize — a single mechanism covering all dimension change scenarios. Guard the callback against zero-dimension observations (hidden containers) to prevent corrupted state. This is particularly useful for tabbed interfaces where inactive tabs use display:none.

## vi.hoisted() for Shared Mock State in Vitest

**Discovered:** 2026-04-15 during M006/S05

When test files need per-test control over mocked hook return values, use `vi.hoisted()` to create shared mutable state that's accessible from both `vi.mock()` factory functions and test bodies. The factory reads from the hoisted ref; each test mutates it before rendering. This avoids module reimport overhead and enables fine-grained mock control for complex component integration tests. Pattern proven across 30 M006 integration tests.

## Cross-Origin Iframe Error Detection in jsdom/Vitest

**Discovered:** 2026-04-14 during M005/S04/T03

The `<iframe>` element's `onError` event does not fire for cross-origin blocks — only for network-level failures. To detect iframe embedding failures (X-Frame-Options, CSP), use a `setTimeout` after mount and attempt to access `iframe.contentWindow.document`. If this throws a `DOMException` (cross-origin), the iframe is blocked. In tests (jsdom), use `Object.defineProperty(iframeElement, 'contentWindow', { get() { throw new DOMException(...) } })` to simulate this — mocking `document.createElement` doesn't work because React creates elements internally.

## CustomEvent Bridge for Cross-Component-Tree Communication

**Discovered:** 2026-04-17 during M007/S02/T03

When two components live in different React component trees (e.g., a page component and a sidebar in a layout), React context and props can't bridge between them. Use `window.dispatchEvent(new CustomEvent('event-name'))` on the sender side and `window.addEventListener('event-name', handler)` in a `useEffect` on the receiver side. Clean up the listener on unmount. This avoids coupling via global state libraries for simple one-directional signals. Pattern used for `hive:sidebar-refresh` — terminal pages dispatch when detecting stale data, sidebar listens and re-fetches. For testing, use `window.dispatchEvent(new CustomEvent('event-name'))` in test code and assert the handler side-effects.
