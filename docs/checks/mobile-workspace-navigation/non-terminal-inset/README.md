# Non-terminal mobile bottom inset

Validated on 2026-10-27 in the reused `creator-direction-upgrade` Browser Testing workspace. It remains running for another active task. Implementation and evidence are preserved in the primary Hive repository; no workspace was created or deleted.

The terminal toolbar was the only component reserving the bottom home-indicator inset. Selecting Settings or an embedded app removed that toolbar, leaving the window flush with the bottom of the visible viewport. The mobile workspace now reserves `max(8px, safe-area-inset-bottom)` when the terminal toolbar is absent. With the keyboard open it reserves only 8px. Terminal controls continue to own their inset, and desktop layout does not add this padding.

The phone (390px) and tablet (840px) scenarios use production Settings, app panes, canvas, viewport tracking, and mobile controls. With a simulated 34px safe area, both non-terminal frames end 36px above the bottom edge, including the canvas's existing 2px gutter. Settings can scroll to its last content. An embedded app retains its unsaved text as the visual viewport shrinks to 400px and pans down 35px; its frame then ends 10px above the keyboard boundary. Switching to a terminal removes the workspace inset, and closing the keyboard restores the toolbar's safe area without doubling it.

The screenshots show Settings at its scroll end and an embedded app at both widths. Terminal runtime, settings data, and app contents are fixture implementations. Keyboard geometry and safe-area insets are simulated in Chrome; this does not validate native iOS rendering.

All 18 mobile browser checks pass without page errors (`report.json`). All 36 focused tests across four suites pass, along with TypeScript and Biome. `targeted-tests.txt` preserves those results and `source-hashes.json` records the validated source and bundle.

To reproduce, build with `node scripts/build-window-management-fixture.mjs .artifacts/mobile-pane-inset/browser`, transfer the bundle and `e2e/mobile-workspace.browser.mjs` to Browser Testing, and run the script with the existing Playwright module selected by `HIVE_PLAYWRIGHT_MODULE`.
