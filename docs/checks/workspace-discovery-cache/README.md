# Workspace discovery cache

## Investigation

Reopening search cleared terminal/repository results and reran SSH discovery for every running workspace. Reopening Agents reran CLI inventory (including plugin commands); expanding workspace apps refetched agents. The sidebar and workspace canvas polled independently. The sidebar also downloaded and hashed five template archives every 30 seconds while Templates was collapsed. Client Server Action reads shared a serialized request queue with interactive work.

Measurements from the persistent software workspace on 2026-10-25 (two samples each, not production HTTP latency):

| Operation | Duration |
| --- | --- |
| tmux listing directly | 4–5 ms |
| tmux listing through Coder SSH | 268–320 ms |
| Repository scan directly, 74 repositories | 1,401–1,411 ms |
| Repository scan through Coder SSH | 1,548–1,644 ms |
| Agent inspection directly | 6,638–6,923 ms |

A separate agent-command profile showed `codex plugin list --json` consuming its five-second timeout. `baseline-timings.json` preserves the operation timing data without command output or credentials.

## Change

An authenticated dashboard owns one React Query client, keyed by a hash of the login session. Discovery is memory-only in the browser, shared across consumers, deduplicated in flight, and discarded five minutes after its last observer detaches. Reopening a panel uses its current results while stale data refreshes. Logout clears queries; a new login session replaces the provider. New builds receive distinct workspace query keys. Transient failures preserve results; authentication/authorization, missing-workspace and stopped-workspace responses hide old data.

| Resource | Browser freshness | Refresh while visible | Server cache |
| --- | --- | --- | --- |
| Workspace list | 5 seconds | One dashboard poll every 15 seconds | None |
| Agent connection metadata | 5 seconds | On use/focus/reconnect | None |
| tmux sessions | 5 seconds | Every 5 seconds while search is open | None; SSH timeout 8 seconds |
| Repositories | 1 minute | Every minute while search is open | 1 minute, keyed by Coder origin/user/workspace/build/root |
| Agent inspection | 5 seconds | Every 5 seconds while Agents is open | Inventory only, 5 minutes; session state read every time |
| Template statuses | 5 minutes | Only when Templates is used | Archive hash by authorized immutable version/file, 24 hours |
| Launch template options | 1 minute | Only when launch dialog is used | None |

Read-only GET endpoints retain existing session and Coder authorization and send `Cache-Control: private, no-store`. Browser HTTP caches, service workers, and shared proxies must not cache these responses. Mutations remain Server Actions. Lifecycle and terminal events invalidate shared queries. Configuring agent tools invalidates inventory; explicit Refresh bypasses the cache. Repository terminal proofs and workspace app credentials remain fresh authorized operations. Connected terminal windows stay mounted during background refreshes.

The server cache uses the existing `REDIS_URL` with a separate ioredis connection: 200 ms connection/command limits, no offline queue or indefinite retries, and a 30-second reconnect backoff. It falls back to at most 256 entries / 8 MiB of process memory, with at most 1 MiB per value. Failures and missing repository roots are not cached. Generation keys prevent older scans from overwriting a refreshed generation across pods. All Redis entries expire; hashes and cache keys exclude credentials.

## Infrastructure and limits

`k8s-cluster/apps/kethalia/hive/values-prod.yaml` already enables Valkey with `hive-valkey-secret`, 2 GiB persistence and a 512 MiB memory limit. The Hive chart supplies `REDIS_URL`. No new Redis deployment or k8s PR is required. This shares the existing no-eviction queue service; discovery entries are expendable and fall back locally if Redis refuses writes.

The software workspace could resolve the Valkey service but TCP access was refused, as were other Hive services. This does not establish whether the production service is healthy. The implementation is verified with cache/transport tests and browser fixtures, not a live production cache hit measurement. Redis-outage invalidation is immediate within the handling process; another process can retain its existing snapshot until its bounded TTL expires. Cold reads still require Coder/SSH. The browser cache does not persist between reloads. Terminal scrollback/runtime persistence remains owned by the existing terminal provider.

## Validation

Validation results and browser evidence are recorded alongside this file. Browser validation reuses `creator-direction-upgrade` (Browser Testing), with real Hive components and controlled discovery HTTP responses. Terminal transports and app credentials are fixtures. The helper serves other work and is retained running; only this task's temporary fixture directory is removed after preserving evidence.

Validated results:

- Production Next.js build and standalone runtime verification passed.
- TypeScript, Biome lint and formatting checks passed.
- All 2,089 Vitest tests across 176 files passed. Template, runtime and service-worker tests also passed.
- Desktop (1440×900) and mobile (390×900) Chrome fixtures passed. Search reopened in 308/306 ms and Agents in 67/49 ms, including interaction/animation time, with no new reads on warm reopen. These are fixture measurements, not production latency promises.
- Cached search results remained visible during HTTP 503 responses. The existing terminal mounted exactly once throughout search, Agents, workspace management and refresh/outage checks. Collapsed Templates produced no status/archive reads.
- Browser evidence and scripts are preserved here; `/tmp/hive-discovery-cache` was removed from the reused helper. The helper remains running for unrelated work.
