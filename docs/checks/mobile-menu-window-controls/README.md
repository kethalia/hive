# Mobile menu scrolling and window controls

Validated on 2026-10-28 using the existing `creator-direction-upgrade` Browser Testing workspace. Implementation and evidence remain in the primary Hive checkout. The reused workspace remains available for its other active task; no workspace was created or deleted.

Touch title dragging now uses the existing Grid, Strip, and floating-window drag behavior, including live previews and cancellation. Headers opt out of window swipes and two-finger search. A drop focuses the moved window. The final unpinned Strip column has a left grip; dragging left grows it while its right edge stays visible. Adjacent resize targets stay inside their own columns on desktop and touch screens.

The command list explicitly allows vertical touch scrolling, can shrink within the drawer, and contains overscroll. It keeps touch sequences away from document gesture handlers while leaving native scrolling uncanceled. Mobile commands disable hover selection, retaining taps and keyboard navigation. Two-finger search claims early movement even when one finger lags, tolerates diagonal drift, and cancels the release's compatibility click through a non-passive listener.

Validation:

- `tests.txt` and `keyboard-tests.txt`: 217 tests across 12 suites, including gesture ownership, layout geometry, command selection, terminal focus, tool windows, and terminal integration.
- `browser-report.json`: 16 new checks at 390, 744, and 1194px plus 70 existing desktop/mobile checks. Touch scenarios cover growing the last column, menu scrolling in both directions to its final option, Grid/Strip rearrangement, floating movement/cancellation, persistence, and unchanged terminal instances. A real xterm fixture verifies staggered two-finger search stays open and the resulting menu scrolls.
- TypeScript, Biome, production build, and standalone runtime verification passed. Existing non-null assertion, test-mock `finalFocus`, and dynamic template-path build warnings remain.

Chrome receives native touch events through CDP; viewport/keyboard cases use simulated geometry. The reported menu stall did not reproduce in Chrome before the change. Menu hardening is covered by touch and component checks, but physical iPad Safari/PWA confirmation remains necessary. Real xterm is used for its DOM and document gesture handlers; terminal transport and backend actions remain fixtures.

Reproduce by building `node scripts/build-window-management-fixture.mjs .artifacts/mobile-menu-window-controls/browser` in the primary workspace, transferring that directory to Browser Testing, and running these scripts sequentially with its installed Playwright module selected through `HIVE_PLAYWRIGHT_MODULE`:

1. `e2e/mobile-window-controls.browser.mjs`
2. `e2e/mobile-workspace.browser.mjs`
3. `e2e/mobile-interaction-recovery.browser.mjs`
4. `e2e/window-management.browser.mjs`

Pass the transferred browser directory as each script's first argument. `source-hashes.json` records the source and built fixture used for this validation.
