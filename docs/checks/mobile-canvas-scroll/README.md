# Mobile canvas scrolling

Validated on 2026-10-25 in the reused `creator-direction-upgrade` Browser Testing workspace. It remains running for another active task. The fixture uses the real GeneralWorkspace, picker, management dialog, mobile terminal shell, styles, and sidebar; Coder/server actions and the terminal runtime use fixture data.

At a 390 × 844 touch viewport, Chrome verified:

- Open windows tabs accept touch and wheel events, and a native touch swipe scrolls horizontally.
- A picker containing 40 sessions accepts touch swipes and wheel scrolling. The last session is reached and opened.
- The workspace-management dialog accepts touch swipes and wheel scrolling with 21 Coder workspaces, reaching the final workspace.
- The document still blocks background touch/wheel scrolling while the mobile shell is mounted.
- No browser page errors.

`report.json` contains scroll measurements, and the screenshots show scrolled content. The 11 existing mobile shell/layout tests, TypeScript, and Biome checks pass. No live Coder resource was changed.
