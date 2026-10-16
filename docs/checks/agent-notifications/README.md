# Agent notification validation

Date: 2026-10-16.

Browser workspace: `daniel/creator-direction-upgrade` (`browser-testing`), reused. No workspace was created, stopped, or deleted. This persistent workspace serves another task and is retained running. The isolated test fixture is at `/tmp/hive-notification-validation`; authoritative implementation and preserved evidence are in the primary `daniel/ai-dev-01` checkout at `/home/coder/projects/kethalia/hive` on `feat/pwa-agent-notifications`.

Chrome validation used desktop (1280 × 1000) and mobile-width (390 × 844) viewports. Both passed device setup, question/ready audio synthesis, preference saving, workspace setup, native service-worker notification creation, and foreground toast delivery, with no page errors or horizontal overflow. See [results.json](results.json), [desktop.png](desktop.png), and [mobile.png](mobile.png).

The fixture uses the actual components, styles, and service worker with mocked server actions and subscriptions. Synthetic pushes exercise native Chrome notification APIs. This does not establish vendor push transport delivery, physical phone behavior, lock-screen sounds, or Safari/iOS compatibility. Those require enabling and testing a subscription on the real device after deployment. Audio generation completed without browser errors; subjective sound quality was not assessed by listening.

Unit coverage exercises callback authorization and recipient isolation, bounded bodies and rate limiting, retry deduplication, revoked sources, transient versus stale push failures, device preferences, account reassociation, service-worker navigation and foreground audio routing, existing-subscription restoration, and persistent device opt-out. Python checks cover lifecycle classification, metadata-only transmission and retry, idempotent installation preserving user configuration, and rejection of malformed configuration.

Production build output was moved to `/tmp/hive-notification-build/next` because the home volume was full. Its temporary `.next` symlink is removed before handoff; unrelated user files were retained. The normal Next production build and standalone-runtime check passed using that output.

Final checks: all 1,909 Vitest tests across 163 files passed; all four Python hook tests passed; TypeScript, Prisma schema validation, Biome checks on changed code, production build, and standalone runtime validation passed. The initial full Vitest run exposed two explicit icon mocks missing the new Bell export; those mocks were updated and the full suite then passed.
