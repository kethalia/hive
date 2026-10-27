# Mobile toolbar spacing and upload feedback

Validated on 2026-10-27 in the reused `creator-direction-upgrade` Browser Testing workspace. It remains running for another active task. Source changes and this evidence are preserved in the primary Hive repository; no workspace was created or deleted.

The workspace toolbar was displaying the same clipboard status as its progress toast in an extra row, retaining even completed messages. Its keyboard visibility prop was also missing, so the bottom home-indicator inset stayed reserved above the open keyboard. The toolbar now uses only the existing progress/success/error toasts and receives the same keyboard state as its shell. Bottom toasts follow the published visual viewport height and pan offset on phones and tablets.

`report.json` records 16 passing browser checks with no page errors. The two added scenarios use 390px and 840px touch viewports with a 34px bottom safe area, then simulate a 400px visual viewport and 35px page pan. The phone also shrinks `window.innerHeight`, covering installed iOS keyboard detection. Both toolbar heights change from 86px to 56px, leaving 8px between the buttons and the usable viewport edge. Upload progress, success, and failure leave that geometry unchanged; closing the keyboard restores the 34px safe area.

The tests drive the real upload picker, clipboard feedback hook, toolbar, toast renderer, and viewport shell. A delayed fixture upload response verifies that one progress toast is updated to completion, while a failed response produces an error toast and re-enables upload. The screenshots show progress and completion above the simulated keyboard boundary. Terminal clients and upload storage are fixtures; no live files were uploaded. Native iOS keyboard and accessory-bar rendering still require a physical device check.

All 37 focused tests across six suites pass, along with TypeScript and Biome. `targeted-tests.txt` preserves the test results; `source-hashes.json` records the production sources and fixture used for browser validation.

To reproduce, build with `node scripts/build-window-management-fixture.mjs .artifacts/mobile-toolbar/browser`, transfer the bundle and `e2e/mobile-workspace.browser.mjs` to Browser Testing, and run the script there with the existing Playwright module selected by `HIVE_PLAYWRIGHT_MODULE`.
