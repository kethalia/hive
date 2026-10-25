# Workspace search and layout validation

Validated on 2026-10-25 in the reused Browser Testing workspace
`creator-direction-upgrade`. It remains running for its other active task.
Implementation and this evidence are preserved in the primary software workspace.

Chromium exercised the real GeneralWorkspace, DashboardKeyboardController,
CommandPalette, workspace cards, terminal frame, audio controls, and theme at
1440×900, 1100×900, and 390×900. The fixture mocked Coder server actions and the
terminal transport; it did not create, stop, or delete production workspaces.

- Arrowed through the full desktop command list and verified every selected item
  stayed inside the visible scroll area. Both scroll indicators occupy separate
  rows outside that area, including when the last action is selected.
- Created `test-runner` from global search in the selected software workspace and
  `named-picker` from Add window in the browser workspace.
- Opened the Hive repository with its clone key and relative path. Persisted
  layout contains no returned clone proof.
- Verified three workspace cards, no table, no nested page navigation, and no
  horizontal overflow in the management dialog at all three sizes.
- Compared computed desktop styles: mic, sound, and Actions have identical hover
  backgrounds and corner radii. Close changes to solid red with a contrasting icon.
- No browser page errors were reported.

The JSON report records browser geometry and computed colors. Keyboard visibility
is null for the phone fixture, which uses the mobile search sidebar rather than
cmdk's desktop keyboard list.

Screenshots:

- `1440-palette-bottom.png`: final keyboard-selected action remains readable.
- `1440-workspace-cards.png`: workspace management as a responsive card grid.
- `390-workspace-cards.png`: the same dialog on a phone.
- `1440-hover-actions.png` and `1440-hover-close.png`: matched and destructive hover states.

## Tooltip footer follow-up

All shortcut tooltips now place the description at the top left and the shortcut
in a separate footer aligned to the right. Chromium verified the geometry of all
eight controls (sidebar, Agents, search, management, microphone, sound, Actions,
and Close) with both Ctrl and macOS shortcut labels: 16 checks passed with no
page errors. `ctrl-actions-tooltip.png` and `mac-sidebar-tooltip.png` show the
updated layout. The 27 focused component tests, Biome check, and TypeScript check
also pass.
