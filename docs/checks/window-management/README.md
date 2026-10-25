# General workspace window management verification

Validated on 2026-10-25 in the reused Browser Testing workspace `creator-direction-upgrade`.
It also serves another task and was retained running. Implementation and these artifacts are
preserved in the primary Hive repository.

## Browser evidence

`report.json` records 24 passing checks with no page errors. The fixture bundles the production
GeneralWorkspace, WindowCanvas, GeneralWorkspacePane, keybinding provider, command palette and
Base UI collapsible. It uses stub terminal clients with mount/destroy counters and a real
cross-origin app frame with an unsaved draft.

- `grid.png`: initial Grid arrangement.
- `drag-preview.png`: destination border and neighboring pane movement before drop.
- `strip.png`: Strip columns, a pinned tab group and persistent app frame.
- `mobile.png`: one visible pane and no horizontal document overflow at 390 px.
- `app-isolation.txt`: four Chrome tests migrated to GeneralWorkspacePane; app authentication,
  microphone permissions, cookie/DOM/API isolation and the inert retired proxy all pass.

The browser checks cover pointer/keyboard resizing, stacked divider reset, successful/cancelled
drag, focus and layout shortcuts, modal isolation, terminal/iframe continuity, moving between
boards, notification reuse/new-board creation, reload persistence, reduced motion, mobile layout,
and the restored measured-height expand/collapse animation. Review regressions also cover revealing
new/reopened Strip apps, keeping manual scrolling available, and preserving clicked/keyboard tab
selection after leaving the column and reloading. Grid checks cover transferring maximization
when opening new/existing apps; model tests also cover adjacent-divider resizing and spatial
navigation after leaving Strip tabs. Regression tests failed before their corresponding fixes.

`verification.json` separates the original full validation from the review-fix validation and
records the current browser bundle and source hashes.

## Reproduce

In the software workspace, run `node scripts/build-window-management-fixture.mjs`. Transfer its
output and `e2e/window-management.browser.mjs` to Browser Testing, then run the script there with
its bundle directory as the argument and `HIVE_PLAYWRIGHT_MODULE` pointing to the installed
Playwright module. It uses the existing Chrome executable; no browser installer is required.

For app isolation, build with `node scripts/build-workspace-isolation-fixture.mjs <output>` and
run `e2e/workspace-app-isolation.spec.mjs` in Browser Testing with `HIVE_ISOLATION_BUNDLE_DIR`
pointing to those assets. The test runner is pinned to the repository's Playwright version.

## Limits

This is browser fixture validation, not a production deployment or a live Coder/PTY login test.
Mount continuity proves that layout changes preserve clients, not that a network service cannot
fail. Existing authorization, terminal runtime, notification server, and integration tests remain
part of validation. Cross-origin apps retain their own keyboard events; Hive shortcuts require
focus in Hive or its terminal. Old database favorites are left as inert data for rollback safety;
their server actions and navigation UI are removed. Saved local descriptors have a read-only
importer; old URL handlers are redirects only.
