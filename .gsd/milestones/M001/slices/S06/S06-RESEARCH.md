# S06: Live Agent Streaming & Dashboard Results — Research

**Date:** 2026-03-20
**Depth:** Targeted — known tech (Next.js SSE, React) but new integration (Pi RPC over `coder ssh`, pi-web-ui Lit components in React).

## Summary

S06 connects the dashboard to live agent activity inside workspaces and completes the task detail view with PR links, CI status, and verification reports. There are two main deliverables:

1. **Live agent streaming** — Pi supports `--mode rpc` which emits AgentEvent JSON lines (message_update, tool_execution_start/end, agent_start/end) on stdout. The orchestrator needs to relay these events from the workspace (via `coder ssh`) to the browser (via SSE). pi-web-ui provides Lit web components for rendering agent chat, but integrating Lit in Next.js SSR requires dynamic imports with `ssr: false`. A simpler MVP approach: build lightweight React components that consume the SSE stream directly and render agent events (text deltas, tool calls, progress) — skip pi-web-ui for now, add it later if the custom components are insufficient.

2. **Dashboard results** — The task detail page (S02 placeholder at `app/tasks/[id]/task-detail.tsx`) needs to show PR link, CI status badge, and verification report (strategy, outcome, logs, duration). The data is already in the DB (`task.prUrl`, `task.verificationReport`) and fetched by `getTask()` — this is pure UI wiring.

## Recommendation

**Split into 3 tasks:**

1. **T01: SSE streaming endpoint + stream primitive** — Create a Next.js Route Handler (`app/api/tasks/[id]/stream/route.ts`) that connects to the workspace and relays agent output as SSE. Create `streamFromWorkspace()` using `child_process.spawn` (not `execFile`) for streaming stdout. This is the riskiest piece — prove it works first.

2. **T02: Live streaming UI component** — Build a React client component (`AgentStreamPanel`) that connects to the SSE endpoint and renders: text deltas (streaming markdown), tool call indicators (name + args summary), agent lifecycle (started/ended). Replace the "Live Agent Activity" placeholder card in `task-detail.tsx`. Only shows when task status is `running`.

3. **T03: Dashboard results display** — Enhance `task-detail.tsx` to show: PR link with GitHub icon (already partially done — extend with CI status), verification report card (strategy badge, outcome badge with pass/fail/inconclusive coloring, duration, expandable logs). Add `verificationReport` to `TaskWithRelations` type. Unit tests for the results components.

## Implementation Landscape

### Key Files

- `src/app/tasks/[id]/task-detail.tsx` — Main task detail client component. Has S06 placeholder card ("Live Agent Activity"). Needs streaming panel integration and results display. PR link already partially present, verification report missing.
- `src/lib/api/tasks.ts` — `getTask()` already includes full task with `verificationReport` field via Prisma include. `getVerificationReport()` exists as a separate function.
- `src/lib/workspace/exec.ts` — `execInWorkspace()` uses `execFile("coder", ["ssh", ...])`. For streaming, we need `spawn` instead of `execFile` to get a readable stdout stream. New function needed: `streamFromWorkspace()`.
- `src/lib/types/tasks.ts` — `TaskWithRelations` needs `verificationReport` field added (currently not in the type but is in the Prisma schema as `Json?`).
- `prisma/schema.prisma` — Task model already has `verificationReport Json?` — no schema changes needed.
- `src/lib/verification/report.ts` — `VerificationReport` type with strategy, outcome, logs, durationMs, timestamp. Used for rendering.
- `src/lib/queue/task-queue.ts` — Worker pipeline. The key design question: how does the streaming endpoint observe the running agent? Options below.
- `src/lib/helpers/format.ts` — Status badge variant mapping. May need verification outcome→variant mapping.

### New Files

- `src/app/api/tasks/[id]/stream/route.ts` — SSE Route Handler. Connects to workspace and relays agent output as SSE events. Uses `ReadableStream` for Next.js streaming response.
- `src/lib/workspace/stream.ts` — `streamFromWorkspace(workspaceName, command)` — spawns `coder ssh` with `spawn` (not `execFile`), returns a readable stream of lines. Handles JSONL buffer splitting.
- `src/app/tasks/[id]/agent-stream-panel.tsx` — Client component consuming SSE, rendering streaming text + tool calls.
- `src/app/tasks/[id]/verification-report-card.tsx` — Client component rendering the structured verification report.

### Streaming Architecture Decision

The agent step currently runs Pi in `--print` mode (one-shot, text stdout). For structured streaming, there are three approaches:

**Option A: Modify agent step to use `--mode rpc` and tee stdout to a log file.** The worker blueprint runs `pi --mode rpc --no-session` instead of `pi --print`. The worker sends the prompt via stdin JSON, and Pi emits JSONL events on stdout. The worker captures stdout and writes events to a log file (`/tmp/hive-agent-events.jsonl`). The SSE endpoint connects via `coder ssh workspace -- tail -f /tmp/hive-agent-events.jsonl` and relays. **Recommended** — gives structured events, minimal changes to worker flow, and the SSE endpoint is a simple tail.

**Option B: Worker writes events to Redis pub/sub.** The worker captures agent stdout events and publishes them to a Redis channel keyed by task ID. The SSE endpoint subscribes to the Redis channel. Avoids browser→Coder SSH entirely. More complex but avoids proxy routing risk.

**Option C: Stream raw `--print` mode stdout as plain text.** Keep the agent step as-is. The SSE endpoint tails the raw stdout output. Less structured (no tool call events, just text) but zero changes to the worker. Simplest MVP.

**Recommendation: Option A** — gives us structured AgentEvent JSONL with minimal architecture changes. The agent step switches from `--print` to `--mode rpc`, the worker tees events to a file, and the SSE endpoint tails that file.

### Build Order

1. **T01 first** (SSE endpoint + stream primitive) — riskiest integration point. Must prove: (a) `streamFromWorkspace()` with `spawn` works, (b) JSONL parsing is correct, (c) Next.js SSE Route Handler streams properly, (d) cleanup on disconnect.
2. **T03 second** (results display) — straightforward React UI using existing data. Unblocks visual completeness.
3. **T02 last** (streaming UI) — depends on T01's SSE endpoint. Can be developed against a mock SSE stream.

### Verification Approach

- **T01**: Unit test the JSONL-to-SSE relay logic with mock child process. Test stream cleanup on abort signal.
- **T02**: Component renders mock SSE events (text deltas, tool calls, agent lifecycle).
- **T03**: Component renders verification report data (strategy, outcome, logs). Task detail shows PR link.
- **Full slice**: Submit a task, watch live streaming in dashboard, see PR link and verification report after completion.

## Constraints

- `execInWorkspace()` uses `execFile` which buffers stdout — streaming requires `spawn`. New `streamFromWorkspace()` function needed alongside the existing one.
- Pi's RPC mode uses JSONL on stdout with `\n` as record delimiter. Node's `readline` is NOT protocol-compliant (splits on U+2028/U+2029 per Pi docs). Use manual buffer+newline parsing as shown in Pi's RPC documentation.
- Next.js SSE requires a Route Handler returning `new Response(readableStream, { headers: { 'Content-Type': 'text/event-stream' } })`. Cannot use Server Actions for streaming.
- pi-web-ui (`@mariozechner/pi-web-ui`) is a Lit web component library. Lit components need `ssr: false` dynamic imports in Next.js. **Decision: skip pi-web-ui for MVP**, build custom React components that consume the SSE stream directly. Add pi-web-ui later if needed. This retires the "pi-web-ui + Next.js integration" risk by consciously deferring it.
- The SSE endpoint must handle workspace lookup — given a task ID, find the associated running workspace to connect to. Use Prisma query: workspace with `taskId` and `status: running` and `templateType: worker`.

## Common Pitfalls

- **JSONL buffer splitting** — Network chunks don't align with JSON line boundaries. Must accumulate a buffer and split on `\n`, only parsing complete lines. Pi RPC docs show the correct pattern using StringDecoder + buffer.
- **SSE client disconnect cleanup** — When the browser navigates away, the SSE connection closes. The spawned `coder ssh` process must be killed (SIGTERM) to avoid orphaned processes. Use `request.signal` (AbortSignal) in the Route Handler.
- **Workspace not yet running** — Task status is `running` but workspace build might still be in progress or Pi hasn't started yet. The SSE endpoint should return a "waiting" status event until the log file appears.
- **EventSource reconnection** — The browser's `EventSource` API auto-reconnects on connection drop. The SSE endpoint must handle reconnection gracefully (e.g., replay recent events or indicate where the client left off via `Last-Event-ID`).

## Open Risks

- **Coder SSH streaming reliability** — `coder ssh workspace -- tail -f /tmp/file.jsonl` through the Coder proxy is unproven. If the SSH connection drops or buffers excessively, streaming will be unreliable. Fallback: Option B (Redis pub/sub).
- **Agent step modification** — Changing from `--print` to `--mode rpc` in the agent step is a behavioral change that needs careful testing. The `--mode rpc` Pi process doesn't exit on completion like `--print` — it waits for more commands. The worker must send `{"type": "prompt", "message": "..."}` and then detect `agent_end` to know when to proceed.
- **File-based event relay race condition** — The SSE endpoint starts `tail -f` which may miss events written before the tail starts. Mitigate by using `tail -f -n +1` to read from the beginning of the file.

## Skills Discovered

No additional skills needed. The work is Next.js Route Handlers (known), React components (known), and child_process spawn (known). The pi-web-ui integration is explicitly deferred.
