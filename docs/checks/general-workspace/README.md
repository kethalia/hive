# Shared Workspace canvas validation

Validated on 2026-10-25 in the reused `creator-direction-upgrade` Browser Testing workspace. It remains running because it serves another active task. Implementation and evidence are preserved in the primary Hive checkout.

The browser fixture bundles the real GeneralWorkspace, pane, picker, sidebar, board/window layout, session action menu, mobile controls, and application styles. Only server actions, Next navigation, the agent-tools dialog, and terminal runtime are replaced with fixtures. The embedded app pages use separate test origins. This validates UI behavior, not live Coder login, VS Code, File Browser, Kasm, or PTY connectivity. Existing server-action authorization tests and terminal-runtime tests cover those application contracts.

At both 1440 × 900 and 390 × 900, Chrome verified:

- Sidebar Files and Desktop open inside Hive with no popup; VS Code uses the same canvas.
- Files from software, Desktop from Browser Testing, and identically named terminals from both workspaces coexist.
- Board switching preserves iframe DOM and terminal mount counts; reopening an app focuses its existing pane.
- Reload restores all windows with fresh app-action calls. Saved state contains pane identities, not app URLs, authentication redirects, agent IDs, or clone proofs.
- Closing an app preserves the other panes. Per-session font changes affect only the selected terminal.
- A stopped workspace can be started through Add window before creating its terminal.
- No page errors or horizontal document overflow.

`report.json` records the checks. `*-mixed-canvas.png` and `*-restored-canvas.png` show desktop tiling and mobile pane navigation.

Automated regression coverage also checks stale connection responses after rebuilds, CSP reload requirements, stopped-workspace gating, fresh repository identity resolution, saved-state validation, legacy layout imports, and template capability restrictions.

The existing per-workspace URLs remain available for old deep links. The first shared-canvas visit imports supported legacy pane descriptors without deleting the original local layouts. Layouts remain local to the browser and signed-in user. Coder app origins, authentication, and iframe sandbox policies retain their existing boundaries.

## Header control follow-up

The sidebar toggle, Agents, and search controls share an icon-only ghost button style in both the shared canvas and the existing terminal workspace. They measure 40 × 40 px on desktop and 44 × 44 px on mobile; coarse-pointer devices also use the larger size. Header controls use the existing shadcn tooltip component, now styled with Hive's popover surface, phosphor border/text, monospace font, and matching arrow.

Chrome at 1440 × 900 and 390 × 900 verified equal square dimensions, no visible button labels, working sidebar/search actions, and no horizontal overflow or page errors. Desktop checks also cover each tooltip on hover, keyboard focus, Escape dismissal, and Enter activation. See `header-report.json`, `header-1-tooltip.png`, and `*-square-header.png`. The relevant terminal workspace and sidebar suites pass all 122 tests; TypeScript and Biome checks also pass.
