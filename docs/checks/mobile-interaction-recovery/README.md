# Mobile resizing, foreground recovery, and search gestures

Validated on 2026-10-27 in the reused `creator-direction-upgrade` Browser Testing workspace. It remains running for another active task. Implementation and evidence are preserved in the primary Hive checkout; no workspace was created or deleted.

Mobile layout dividers had remained disabled after mobile adopted the shared desktop canvas. Grid, Strip, and floating windows now expose visible grips with 44px touch targets. Grip gestures are excluded from window swipes and launcher gestures. Touch resizing preserves terminal input focus; desktop dividers retain their full draggable edge and keyboard controls. The header now aligns search, destination-view toggle, workspace numbers, and plus on the left.

The viewport publisher and keyboard hook now share one set of viewport and app lifecycle listeners. Returning via `visibilitychange`, `pageshow`, or window focus immediately rereads measurements, then makes bounded rereads over one second to catch delayed browser geometry. A keyboard that remains open keeps its reduced viewport. The listeners and pending timers are removed when the last consumer unmounts.

Two-finger upward search claims parallel movement before native scrolling begins and stops the event reaching terminal/nested scroll handlers. It retains control while the fingers lift separately, tolerates unequal upward travel, and opens only after both fingers lift. Single-finger scrolling, existing text selection, and unclaimed pinch gestures remain available.

The new browser scenarios use native Chrome touch events on 390px and 840px viewports. They resize Grid, Strip, and floating panes; check unchanged selection and terminal lifetime; verify left-aligned controls; restore full height and pan offset without viewport resize events; exercise delayed restoration and a keyboard that stays open; and prove two-finger search leaves a scrollable surface unchanged while a one-finger swipe still scrolls it. The screenshots show the resize grips and restored viewport. Terminal clients and backend requests are fixtures, while workspace, gesture, and viewport components are production code. Keyboard and foreground lifecycle geometry are simulated; native iOS rendering still requires a physical-device check.

Validation records:

- `targeted-tests.txt`: 48 viewport, gesture, and window navigation tests.
- `integration-regressions.txt`: 124 terminal, keyboard, command palette, and tool-window tests.
- `interaction-report.json`: six native touch/foreground checks.
- `mobile-report.json`: 18 existing mobile checks, including safe areas, clipboard toasts, and swipe navigation.
- `window-report.json`: 46 existing window-management checks.
- TypeScript, Biome, production build, and standalone runtime verification pass. The existing two canvas non-null assertion warnings and template-push build warnings remain.

`source-hashes.json` records the source and browser fixture used for the touch scenarios. Reproduce with `node scripts/build-window-management-fixture.mjs .artifacts/mobile-interaction-recovery/browser`, then transfer the bundle and run `e2e/mobile-interaction-recovery.browser.mjs`, `e2e/mobile-workspace.browser.mjs`, and `e2e/window-management.browser.mjs` sequentially in Browser Testing. Select its installed Playwright module with `HIVE_PLAYWRIGHT_MODULE`.
