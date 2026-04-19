---
estimated_steps: 38
estimated_files: 5
skills_used: []
---

# T02: Create service worker, web app manifest, and PWA registration component

## Description

Makes the app installable as a PWA (R103) and sets up the notification click handler that opens /login (R109). Creates three artifacts: a static service worker file handling push and notificationclick events, a Next.js route-based manifest export, and a client component that registers the service worker on mount.

The service worker is intentionally minimal — no fetch caching (Hive requires a live Coder connection). It handles two events: `push` (show notification) and `notificationclick` (focus existing tab or open /login).

## Steps

1. Create `public/sw.js` with:
   - `push` event listener: parse event.data.json() for {title, body, tag, icon}, call self.registration.showNotification(title, {body, tag, icon, data: {url: '/login'}})
   - `notificationclick` event listener: event.notification.close(), then clients.matchAll({type: 'window', includeUncontrolled: true}), if existing tab found focus it and navigate to /login, else clients.openWindow('/login')
   - No fetch event handler (no offline caching)
2. Create `src/app/manifest.ts` using Next.js MetadataRoute.Manifest export:
   - name: 'Hive Orchestrator', short_name: 'Hive', start_url: '/', display: 'standalone'
   - background_color: '#09090b' (zinc-950, matches dark theme), theme_color: '#09090b'
   - icons: [{src: '/favicon.ico', sizes: 'any', type: 'image/x-icon'}]
3. Create `src/components/service-worker-register.tsx` — a 'use client' component that calls `navigator.serviceWorker.register('/sw.js')` in a useEffect on mount. No UI output (returns null). Checks for serviceWorker support before registering.
4. Add `<ServiceWorkerRegister />` to `src/app/layout.tsx` inside the body, before TooltipProvider.
5. Create `src/__tests__/components/service-worker-register.test.tsx` testing: registers sw.js on mount, handles missing serviceWorker API gracefully.

## Must-Haves

- [ ] public/sw.js handles push event with showNotification
- [ ] public/sw.js handles notificationclick with tab focus/open logic targeting /login
- [ ] src/app/manifest.ts exports valid manifest with display:standalone
- [ ] ServiceWorkerRegister component registers /sw.js on mount
- [ ] ServiceWorkerRegister added to root layout
- [ ] No fetch event handler in service worker (no offline caching)

## Verification

- `test -f public/sw.js`
- `test -f src/app/manifest.ts`
- `grep -q 'showNotification' public/sw.js`
- `grep -q 'notificationclick' public/sw.js`
- `grep -q 'standalone' src/app/manifest.ts`
- `grep -q 'ServiceWorkerRegister' src/app/layout.tsx`
- `pnpm vitest run src/__tests__/components/service-worker-register.test.tsx`

## Inputs

- `src/app/layout.tsx` — root layout to add ServiceWorkerRegister component

## Expected Output

- `public/sw.js` — service worker with push and notificationclick handlers
- `src/app/manifest.ts` — Next.js route-based web app manifest
- `src/components/service-worker-register.tsx` — client component for SW registration
- `src/app/layout.tsx` — updated with ServiceWorkerRegister
- `src/__tests__/components/service-worker-register.test.tsx` — registration tests

## Inputs

- ``src/app/layout.tsx` — root layout to wire ServiceWorkerRegister into`

## Expected Output

- ``public/sw.js` — service worker with push and notificationclick handlers`
- ``src/app/manifest.ts` — Next.js MetadataRoute.Manifest export with display:standalone`
- ``src/components/service-worker-register.tsx` — client component that registers /sw.js on mount`
- ``src/app/layout.tsx` — updated with ServiceWorkerRegister component`
- ``src/__tests__/components/service-worker-register.test.tsx` — SW registration tests`

## Verification

test -f public/sw.js && test -f src/app/manifest.ts && grep -q 'ServiceWorkerRegister' src/app/layout.tsx && pnpm vitest run src/__tests__/components/service-worker-register.test.tsx
