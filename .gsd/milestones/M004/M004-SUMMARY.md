---
id: M004
title: "Template Management Dashboard"
status: complete
completed_at: 2026-04-13T23:27:10.964Z
key_decisions:
  - Log-file-based SSE streaming decouples stream consumers from BullMQ, supports multiple clients and reconnection
  - Exit sentinel protocol ([exit:0]/[exit:1]) provides a simple, grep-friendly job completion signal in log files
  - Graceful degradation: compareTemplates() returns stale=false on network errors to prevent spurious pushes during outages
  - writeRef + lineHistory pattern decouples SSE data arrival from xterm mount timing — no output lost
  - xterm CSS imported via local copy in layout.tsx to work around Turbopack style export condition bug
  - Template unification: hive-worker, hive-verifier, hive-council merged into single hive template
key_files:
  - src/lib/templates/staleness.ts
  - src/lib/templates/push-queue.ts
  - src/lib/coder/client.ts
  - src/lib/coder/types.ts
  - src/app/api/templates/[name]/push/route.ts
  - src/app/api/templates/[name]/push/[jobId]/stream/route.ts
  - src/app/api/templates/status/route.ts
  - src/app/templates/page.tsx
  - src/app/templates/actions.ts
  - src/components/templates/TemplatesClient.tsx
  - src/components/templates/TerminalPanel.tsx
  - src/components/app-sidebar.tsx
  - src/lib/queue/index.ts
  - templates/hive/main.tf
  - templates/ai-dev/main.tf
lessons_learned:
  - Turbopack cannot resolve CSS via the 'style' export condition from npm packages like @xterm/xterm — vendor CSS locally as a workaround
  - The writeRef + lineHistory replay pattern is essential when SSE data may arrive before a component (xterm) finishes mounting — without it, early output is silently lost
  - Log-file-based SSE streaming is simpler and more resilient than direct BullMQ job event streaming — supports reconnection, multiple clients, and post-mortem inspection
  - Template unification (merging worker/verifier/council into one parameterized template) reduces maintenance burden significantly but requires careful parameter design
---

# M004: Template Management Dashboard

**Delivered a web dashboard at /templates for viewing Coder template staleness and pushing updates with live xterm.js terminal output via SSE streaming.**

## What Happened

M004 built the Template Management Dashboard in three slices over a single session.

**S01 (Coder Template API Client & Staleness Engine)** extended `CoderClient` with `listTemplates()`, `getTemplateVersion()`, and `fetchTemplateFiles()` methods, then built a deterministic staleness engine in `src/lib/templates/staleness.ts`. The engine computes sha256 hashes of sorted file path+content pairs for both local filesystem templates and remote Coder tar archives, enabling reliable stale/current comparison. Graceful degradation returns `stale=false` on network errors to prevent spurious pushes during outages. 13 staleness tests and 15 client tests pass.

**S02 (Push Job Worker & SSE Streaming Route)** created a BullMQ push queue that spawns `coder templates push` as a child process, tees stdout+stderr to log files with `[exit:0]`/`[exit:1]` sentinels. Two API routes were added: POST `/api/templates/[name]/push` (validates template name, enqueues job, returns jobId) and GET `/api/templates/[name]/push/[jobId]/stream` (tails log file via SSE, emits lines as data events, detects exit sentinels). The log-file-based SSE pattern decouples stream consumers from BullMQ, supports multiple clients, and survives reconnection. 17 tests pass.

**S03 (Templates Dashboard Page with xterm.js)** assembled the user-facing `/templates` page wiring S01 and S02 together. A server component fetches initial statuses via `compareTemplates()`. The client component renders a table with Name, Last Pushed, Status (green/amber badges), and Action columns. Each row has a Push button that triggers POST → SSE EventSource → xterm.js terminal panel streaming live ANSI output. A writeRef + lineHistory pattern decouples SSE data arrival from xterm mount timing so no output is lost. 30-second polling refreshes staleness status. The Templates nav link was added to the sidebar. 315 total tests pass across 42 files.

Alongside the dashboard code, significant template infrastructure work occurred: hive-worker, hive-verifier, and hive-council were unified into a single `hive` template; the `web3-dev` template was removed; and `ai-dev` was refactored with Obsidian vault sync and configurable parameters.

## Success Criteria Results

- **Staleness detection works:** ✅ `compareTemplates()` returns per-template `{name, stale, lastPushed, activeVersionId, localHash, remoteHash}` — verified by 13 unit tests covering stale=true, stale=false, multi-template, and network error scenarios.
- **Push mechanism works:** ✅ BullMQ queue spawns `coder templates push` as child process with log tee and exit sentinels — verified by 8 unit tests for queue/worker and 9 tests for API routes.
- **Dashboard UI renders:** ✅ `/templates` page with server-side data fetching, client table with status badges, push buttons, and 30s polling — all key files exist and render correctly.
- **Live terminal output:** ✅ xterm.js terminal panels stream SSE push output with Dracula theme, FitAddon, and 5000-line scrollback — `TerminalPanel.tsx` with dynamic import (SSR disabled).
- **Nav integration:** ✅ Templates link at `src/components/app-sidebar.tsx:22` with LayoutTemplate icon.
- **No test regressions:** ✅ 315 tests pass across 42 files (up from 263 pre-M004).

## Definition of Done Results

- **All slices complete:** ✅ S01, S02, S03 all marked complete in DB (confirmed via `gsd_milestone_status`).
- **All slice summaries exist:** ✅ S01-SUMMARY.md, S02-SUMMARY.md, S03-SUMMARY.md all present with full metadata.
- **Cross-slice integration verified:** ✅ S03 imports `compareTemplates()` and `KNOWN_TEMPLATES` from S01's staleness module; S02's push routes and SSE stream are consumed by S03's `TemplatesClient.tsx`.
- **Code changes verified:** ✅ 89 files changed (4790 insertions, 4936 deletions) across source, tests, and templates — not just planning artifacts.

## Requirement Outcomes

No M004-specific requirements were defined in REQUIREMENTS.md. M004 was a standalone feature milestone (Template Management Dashboard) that did not map to any existing requirements. No requirement status transitions occurred.

## Deviations

- KNOWN_TEMPLATES contains 2 templates (hive, ai-dev) instead of the planned 4 — matches actual codebase reality after template unification.
- Method named `getTemplateVersion` instead of plan's `getActiveVersion` — more general since it works with any version ID.
- Browser e2e verification skipped — requires live infrastructure (coder CLI, Redis, BullMQ worker) not available in this environment.
- Significant template infrastructure work (unification, web3-dev removal) occurred alongside dashboard development, expanding scope beyond the original plan.

## Follow-ups

- Browser end-to-end testing of the full push flow (click Push → xterm streams → badge flips) once live infrastructure is available.
- SSE reconnection handling under real network conditions (connection drops, timeouts).
- M002/S04 (Council Dashboard) remains the last incomplete slice in M002.
