---
id: T02
parent: S04
milestone: M010
key_files:
  - public/sw.js
  - src/app/manifest.ts
  - src/components/service-worker-register.tsx
  - src/app/layout.tsx
  - src/__tests__/components/service-worker-register.test.tsx
key_decisions:
  - (none)
duration: 
verification_result: passed
completed_at: 2026-04-18T21:17:01.095Z
blocker_discovered: false
---

# T02: Create service worker with push/notificationclick handlers, web app manifest with display:standalone, and PWA registration component wired into root layout

**Create service worker with push/notificationclick handlers, web app manifest with display:standalone, and PWA registration component wired into root layout**

## What Happened

Created three PWA artifacts: (1) `public/sw.js` — a minimal service worker handling `push` events (parses JSON payload, calls showNotification with /login as the click target) and `notificationclick` events (closes notification, focuses existing tab and navigates to /login, or opens new window). No fetch handler — Hive requires a live Coder connection so offline caching is intentionally omitted. (2) `src/app/manifest.ts` — Next.js MetadataRoute.Manifest export with display:standalone, zinc-950 theme/background colors matching the dark theme, and favicon.ico icon. (3) `src/components/service-worker-register.tsx` — a 'use client' component that registers /sw.js in a useEffect on mount, with a guard for missing serviceWorker API. Added ServiceWorkerRegister to the root layout before TooltipProvider. Created tests verifying registration on mount and graceful handling when serviceWorker API is unavailable.

## Verification

All 6 must-haves verified: sw.js exists with showNotification and notificationclick handlers, manifest.ts exports standalone display mode, ServiceWorkerRegister present in layout.tsx, no fetch event handler in service worker. Test suite passes (2/2 tests).

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `test -f public/sw.js` | 0 | ✅ pass | 5ms |
| 2 | `test -f src/app/manifest.ts` | 0 | ✅ pass | 5ms |
| 3 | `grep -q 'showNotification' public/sw.js` | 0 | ✅ pass | 5ms |
| 4 | `grep -q 'notificationclick' public/sw.js` | 0 | ✅ pass | 5ms |
| 5 | `grep -q 'standalone' src/app/manifest.ts` | 0 | ✅ pass | 5ms |
| 6 | `grep -q 'ServiceWorkerRegister' src/app/layout.tsx` | 0 | ✅ pass | 5ms |
| 7 | `pnpm vitest run src/__tests__/components/service-worker-register.test.tsx` | 0 | ✅ pass (2/2 tests) | 535ms |

## Deviations

None

## Known Issues

None

## Files Created/Modified

- `public/sw.js`
- `src/app/manifest.ts`
- `src/components/service-worker-register.tsx`
- `src/app/layout.tsx`
- `src/__tests__/components/service-worker-register.test.tsx`
