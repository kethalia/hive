---
verdict: needs-attention
remediation_round: 0
---

# Milestone Validation: M006

## Success Criteria Checklist
- [x] **Workspace stays alive with no browser connected** — KeepAliveManager pings PUT /api/v2/workspaces/{id}/extend every 55s, independent of browser state. 12 integration tests with real HTTP mock server. (S01)
- [x] **Keep-alive failure shows warning banner** — KeepAliveWarning renders destructive Alert at 3+ consecutive failures. 7 component tests. (S01)
- [x] **WebSocket disconnect recovers with infinite retries** — MAX_RECONNECT_ATTEMPTS removed, backoff capped at 60s. Tests at attempt counts 50 and 100. (S02)
- [x] **Reconnecting banner visible during recovery** — shadcn Alert with spinning RefreshCw icon showing live attempt count. (S02)
- [x] **Tab switching preserves scrollback** — ResizeObserver-based re-fit across display:none/block transitions. 4 component tests. (S02)
- [x] **Expired reconnectId regenerates for same tmux session** — After 3 consecutive close-without-open, reconnectId auto-regenerates with fresh UUID. 7 localStorage lifecycle tests. (S02)
- [x] **Terminal output written to Postgres in chunks** — ScrollbackWriter with 5s/100KB batched INSERTs, monotonic seqNum. (S03)
- [x] **Scrollback survives proxy restart** — Data in Postgres before proxy restarts; integration test exists (skipped without live DB). (S03)
- [x] **Reconnect hydrates history from Postgres** — GET /api/terminal/scrollback API returns ordered binary chunks consumed by S04 hydration hook. (S03/S04)
- [x] **Virtual scrolling for 10K+ lines** — @tanstack/react-virtual windowed rendering with cursor-based backward pagination. (S04)
- [x] **Jump-to-bottom button** — Floating JumpToBottom with CSS opacity fade. 3 component tests. (S04)
- [x] **Full lifecycle: close browser → reopen → scrollback intact** — Cross-slice integration tests prove hydration gating, format round-trip, reconnectId lifecycle. (S05)
- [x] **All previous terminal features still work** — 8 TerminalTabManager regression tests, 504 frontend + 88 proxy tests pass with zero regressions. (S05)

## Slice Delivery Audit
All 5 slices have SUMMARY.md files with `verification_result: passed`:

| Slice | SUMMARY | Assessment | Status |
|-------|---------|------------|--------|
| S01 — Workspace Keep-Alive | ✅ Present | ✅ passed | Delivered: 75 tests (68 proxy + 7 component) |
| S02 — Infinite Reconnection | ✅ Present | ✅ passed | Delivered: 21 tests (10 backoff + 7 reconnectId + 4 ResizeObserver) |
| S03 — Scrollback Persistence Backend | ✅ Present | ✅ passed | Delivered: 88 proxy tests (9 ring-buffer, writer, protocol, keepalive, proxy, route) |
| S04 — Virtual Scrolling & Hydration UI | ✅ Present | ✅ passed | Delivered: 39 tests (20 paginated-API + 9 hydration + 7 history panel + 3 JumpToBottom) |
| S05 — End-to-End Integration | ✅ Present | ✅ passed | Delivered: 30 cross-slice integration tests, full suite regression (504 frontend + 88 proxy) |

**Notable:** S03 "Files Created/Modified" section reads "None" (template artifact) but the body and verification thoroughly detail all files. Not a delivery gap.

## Cross-Slice Integration
| Boundary | Producer | Consumer | Status |
|---|---|---|---|
| S01 → S02: ConnectionRegistry/KeepAliveManager singletons | S01 confirms singletons in index.ts | S02 correctly scoped to client-side — no server-side consumption needed | **PASS** |
| S01 → S02: workspaceId WebSocket query param | S01 added optional param in proxy.ts | S02 operates via existing URL params, no re-addition needed | **PASS** |
| S03 → S04: scrollback_chunks table + GET /api/terminal/scrollback | S03 confirms Prisma model and API route | S04 explicitly requires S03, extended route with pagination, built hydration/pagination hooks | **PASS** |
| S03 → proxy: ScrollbackWriter real-time persistence | S03 confirms writer.append() before browserWs.send() | Proxy wiring verified in source | **PASS** |
| S05 → All: End-to-end integration | All slices verification_result: passed | S05 proves 30 cross-slice integration tests covering hydration↔WebSocket gating, binary format round-trip, reconnectId lifecycle chain | **PASS** |

All 5 cross-slice boundaries are honored with producer artifacts confirmed delivered and consumer artifacts confirmed consuming them.

## Requirement Coverage
| Requirement | Status | Evidence |
|---|---|---|
| R043 — KeepAliveManager pings every 55s with integration tests | **COVERED** | keepalive.ts PING_INTERVAL_MS=55000, 12 integration tests with real HTTP mock server. S01 validated. |
| R044 — Infinite retries, 60s backoff cap, reconnecting banner, no retry exhaustion | **COVERED** | MAX_DELAY_MS=60000, MAX_RECONNECT_ATTEMPTS absent, banner with attempt count + Reconnect Now button. S02 validated. |
| R045 — ScrollbackWriter real-time chunks to Postgres, survives browser close/refresh/restart | **COVERED** | scrollback-writer.ts append()/flush(), wired in proxy.ts before browserWs.send(), SIGTERM handler. S03 validated. |
| R047 — GET /api/terminal/scrollback returns ordered binary chunks | **COVERED** | route.ts implements GET with UUID validation, binary hydration + JSON pagination. S03/S04 validated. |
| R048 — reconnectId auto-regenerates after 3 consecutive failures | **COVERED** | consecutiveFailuresRef at threshold 3, onReconnectIdExpired callback, 7 lifecycle tests. S02 validated. |
| R050 — KeepAliveWarning at 3+ failures, nothing below | **COVERED** | FAILURE_THRESHOLD=3, returns null below, destructive Alert above. 7 component tests. S01 validated. |
| R051 — BoundedRingBuffer 1000-chunk capacity, 1s-30s backoff | **PARTIAL** | Ring buffer and backoff 1s→30s confirmed. However, ScrollbackWriter defaults to capacity 256 (opts.ringBufferCapacity ?? 256), and proxy.ts passes no override. Production capacity is 256, not the 1000 specified in the requirement. |
| R052 — ResizeObserver fit() on hidden→visible transition | **COVERED** | ResizeObserver in InteractiveTerminal.tsx guards non-zero dimensions before fit(). 4 tests. S02 validated. |

**Gap:** R051 specifies 1000-chunk ring buffer capacity but production wiring uses default 256. Either the requirement should be updated to 256 or proxy.ts should pass `ringBufferCapacity: 1000`.

## Verification Class Compliance
| Class | Planned Check | Evidence | Verdict |
|---|---|---|---|
| **Contract** | Unit tests for scrollback CRUD, reconnection logic, keep-alive scheduler, virtual scroll chunk resolver | S01: 21 unit + 12 integration tests for ConnectionRegistry/KeepAliveManager. S02: 10 backoff, 7 reconnectId, 4 ResizeObserver tests. S03: 9 ring-buffer, ScrollbackWriter unit tests. S04: 20 paginated-API, 9 hydration, 7 history panel, 3 JumpToBottom tests. 100+ unit tests total. | **PASS** |
| **Integration** | Terminal-proxy → Postgres write path; hydration path (Postgres → xterm.js); keep-alive → Coder API mock | S01: 12 integration tests with real HTTP mock servers. S03: write-path wired in proxy.ts; scrollback-integration.test.ts exists (skipped without live DB). S04/S05: 12 cross-slice data-flow tests prove hydration gating and binary format round-trip. 504 frontend + 88 proxy tests pass. | **PASS** (caveat: Postgres write-path integration test skipped without live DB) |
| **Operational** | Workspace stays alive 24h+; scrollback survives proxy restart; reconnection after real network interruption | UAT scripts document manual procedures (S01-UAT TC2, S03-UAT TC5, S02-UAT TC1) but no execution logs or recorded outcomes exist. | **NEEDS-ATTENTION** |
| **UAT** | Open two sessions, run long process, close browser, wait 1h+, reopen — verify process running, scrollback intact, both tabs functional | All 5 slices have UAT scripts with preconditions and expected outcomes. No execution evidence for the 1h+ live scenario. S05-UAT focuses on automated test-suite validation. | **NEEDS-ATTENTION** |


## Verdict Rationale
Two of three reviewers flagged issues. (1) R051 ring buffer capacity: requirement specifies 1000 chunks but production code defaults to 256 — a minor config gap, not a structural issue. (2) Operational and UAT verification classes have documented manual test scripts but no recorded execution evidence — the 24h+ keep-alive test, proxy restart with real Postgres, and 1h+ browser-close scenario remain unverified in a live environment. Contract and Integration classes have strong automated coverage (500+ tests). Cross-slice integration is fully proven. These are attention items, not blockers requiring remediation slices.
