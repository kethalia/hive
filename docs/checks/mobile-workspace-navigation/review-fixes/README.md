# Review fixes for PR #386

Validated on 2026-10-27 in the reused `creator-direction-upgrade` Browser Testing workspace. It remains running for another active task. Source changes and this evidence are preserved in the primary repository; no workspace was created or deleted for this review.

Two unresolved review findings are addressed:

- [Vertical Strip reveal](https://github.com/kethalia/hive/pull/386#discussion_r4393449364): vertical canvas scrolling now reveals the focused pane in both layouts and responds when the keyboard reduces the canvas height. The vertical effect is independent of horizontal Strip panning, so manual vertical scrolling is preserved while panning sideways.
- [Pinned-column swipe order](https://github.com/kethalia/hive/pull/386#discussion_r4393449373): swipe navigation follows left-pinned, unpinned, then right-pinned columns, matching the visible-order convention already used when closing windows.

The new component suite fails four regressions against the original PR head (`51a7ced`) and passes all five cases after the fixes. It covers forward/backward navigation through a five-window stack, keyboard resizing, manual scrolling, and both pin directions. `before-fix.txt` and `targeted-tests.txt` preserve the failures and the passing 72-test focused run.

`report.json` records all 14 mobile browser checks with no page errors. The three new cases use native Chrome touch events on production canvas/pane components with fixture terminal clients. The screenshots show the last stack window visible and both pin arrangements after forward navigation. All three scenarios also navigate backward without remounting terminals. Browser validation does not use live Coder sessions or physical iOS hardware.

The existing window-management browser suite also passes all 46 checks without page errors (`window-regressions.json`). TypeScript and Biome pass; the two existing non-null assertion warnings in the canvas remain.

Reproduce with `node scripts/build-window-management-fixture.mjs .artifacts/mobile-workspace-review/browser` in the software workspace, then run `e2e/mobile-workspace.browser.mjs` in Browser Testing against the transferred bundle. Use the existing installed Playwright module through `HIVE_PLAYWRIGHT_MODULE`; no browser installation is needed.
