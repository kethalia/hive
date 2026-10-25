# Stable file targets and mobile header safe area

Validated on 2026-10-25 in the reused `creator-direction-upgrade` Browser Testing workspace. The workspace remains running for another active task. Implementation and evidence are preserved in the primary checkout.

File actions resolve relative paths against the source terminal before creating a Files window. The saved descriptor contains the resolved absolute path, and restores/reconnects continue to obtain fresh authorized URLs. Unit tests cover directory changes, fresh reconnect authorization, rejected paths, and responses arriving after the source pane closes.

The browser fixture uses real canvas, pane, layout storage, viewport publisher, header, and styles, with mock Coder actions and terminal runtime. Chrome at 390 × 844 verifies:

- Setting the top safe-area inset to 44px increases the header height from 61px to 105px. All four header controls begin at 52px and retain 44 × 44px targets.
- With a simulated 500px visual viewport and 40px pan offset, the header controls remain below the safe area and the mobile shell follows the viewport.
- Opening `README.md` stores `/home/coder/projects/hive/README.md`. Reloading after the simulated terminal changes to another directory opens that same path with fresh authorization.
- Authorization URLs are not saved in the layout, and no browser errors occur.

`report.json` and screenshots record the browser checks. This is simulated Chrome viewport validation, not an iOS hardware test or a live Coder authorization test. Focused component/state tests, TypeScript, and Biome pass.
