---
id: S03
parent: M004
milestone: M004
provides:
  - (none)
requires:
  []
affects:
  []
key_files:
  - ["src/app/templates/page.tsx", "src/app/templates/actions.ts", "src/components/templates/TemplatesClient.tsx", "src/components/templates/TerminalPanel.tsx", "src/app/api/templates/status/route.ts", "src/components/app-sidebar.tsx", "src/app/templates/layout.tsx"]
key_decisions:
  - ["Used KNOWN_TEMPLATES (2 templates: hive, ai-dev) rather than plan's 4 — matched actual codebase", "writeRef + lineHistory pattern decouples SSE data arrival from xterm mount timing — no output lost", "xterm CSS imported via local copy in layout.tsx to work around Turbopack style export condition bug"]
patterns_established:
  - ["SSE → xterm.js streaming pattern: POST starts job, EventSource streams output, terminal.write() renders ANSI, status event closes stream", "writeRef + lineHistory replay pattern for decoupling async data arrival from component mount timing"]
observability_surfaces:
  - none
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-13T23:22:15.939Z
blocker_discovered: false
---

# S03: Templates Dashboard Page with xterm.js

**Delivered the /templates dashboard page with stale/current badges, push buttons, and inline xterm.js terminal panels streaming live push output via SSE.**

## What Happened

S03 assembled the user-facing Templates dashboard page at `/templates`, wiring together the staleness engine (S01) and push worker/SSE streaming (S02) into a complete UI.

**T01 — Server action and data fetching:** Created `src/app/templates/actions.ts` with `getTemplateStatuses()` (calls `compareTemplates()` for all entries in `KNOWN_TEMPLATES`) and `revalidateTemplates()` (calls `revalidatePath("/templates")` for cache busting after push). The GET `/api/templates/status` route already existed from S02 work. Added 3 tests covering success, error, and template name pass-through. Note: the plan referenced "4 known templates" but `KNOWN_TEMPLATES` contains 2 (`hive`, `ai-dev`) — implementation matches codebase reality.

**T02 — Templates page UI with xterm.js terminal panel:** Three components deliver the full experience:
- `src/app/templates/page.tsx` — Server component fetching initial statuses with error fallback, renders `<TemplatesClient>`.
- `src/components/templates/TemplatesClient.tsx` — Client component with table (Name, Last Pushed, Status, Action columns), green/amber status badges (Current/Stale/Unknown/Pushing), per-row Push button (disabled with spinner while in progress), 30s polling via `/api/templates/status`. Push flow: POST to start → SSE EventSource for streaming → status event handling → badge refresh on success. Uses a writeRef + lineHistory pattern to decouple SSE data arrival from xterm mount timing with replay on terminal ready.
- `src/components/templates/TerminalPanel.tsx` — xterm.js wrapper with dynamic import (SSR disabled), Dracula-style dark theme, JetBrains Mono font, FitAddon for responsive sizing, close button, 5000-line scrollback. xterm CSS imported via `src/app/templates/layout.tsx` using a local copy to work around Turbopack's inability to resolve the `style` export condition from `@xterm/xterm`.

**T03 — Nav link and regression check:** The Templates link was already present in `src/components/app-sidebar.tsx` (added during T02 implementation) at `/templates` with the LayoutTemplate icon. Full vitest suite confirmed 315 tests passing across 42 files with zero regressions.

All three tasks found that most implementation was already in place from prior session work (S01/S02). The slice primarily verified completeness and added the missing server action layer.

## Verification

**Full test suite:** `npx vitest run` — 315 tests passed across 42 test files (2.19s), exceeding the 263+ threshold. Zero failures, zero regressions.

**Targeted tests:** `npx vitest run src/__tests__/app/api/templates/status.test.ts` — 3 tests passed covering getTemplateStatuses success, error handling, and template name pass-through.

**Structural checks:** Templates nav link confirmed at `src/components/app-sidebar.tsx:22`. xterm packages (`@xterm/xterm`, `@xterm/addon-fit`) confirmed in package.json dependencies. xterm CSS import chain verified via `src/app/templates/layout.tsx`.

**Browser e2e not performed:** Full push flow (click Push → xterm streams coder output → badge flips) requires live infrastructure (coder CLI, Redis, BullMQ worker) not available in this environment. Documented as known limitation.

## Requirements Advanced

None.

## Requirements Validated

None.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

Plan referenced 4 known templates but KNOWN_TEMPLATES contains 2 (hive, ai-dev). The GET /api/templates/status route and all three UI components already existed from prior session work — tasks primarily verified completeness. Browser e2e verification skipped due to lack of live infrastructure (coder CLI, Redis, BullMQ worker).

## Known Limitations

Browser end-to-end flow (push button → xterm streaming → badge flip) not verified — requires running coder CLI, Redis, and BullMQ worker infrastructure. SSE connection drop handling not tested under real network conditions.

## Follow-ups

None.

## Files Created/Modified

- `src/app/templates/actions.ts` — Server actions: getTemplateStatuses() and revalidateTemplates()
- `src/__tests__/app/api/templates/status.test.ts` — 3 tests for GET /api/templates/status route
- `src/app/templates/page.tsx` — Server component fetching initial template statuses
- `src/components/templates/TemplatesClient.tsx` — Client component with table, badges, push flow, SSE streaming
- `src/components/templates/TerminalPanel.tsx` — xterm.js terminal wrapper with FitAddon and dark theme
- `src/components/app-sidebar.tsx` — Added Templates nav link at /templates
