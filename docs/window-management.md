# Window management

Hive has one general workspace at `/workspaces`. A **board** is a saved arrangement within it.
A **Coder workspace** supplies the running environments behind the windows.

New boards use Strip; existing saved arrangements retain Grid. Switch with the Grid/Strip header
buttons. Both modes keep the same mounted panes, connections, unsaved app state and terminal font
preferences. Layout changes do not refetch repositories, agents or sessions.
The sidebar overlays the workspace; opening or closing it never changes pane dimensions.
Dismiss it with its toggle, Cmd/Ctrl+B, Escape, or a click outside.

## Resize and arrange

- Grid: drag the divider between panes. Dividers are focusable; arrows resize in 5% increments,
  Home/End reach the allowed limits, and double-click resets the split. Minimum tile size is
  280 × 160 px. Crowded grids scroll rather than compressing panes indefinitely.
- Strip: resize a column at its edge; resize stacked panes at their horizontal divider. Widths are
  proportional to the available viewport, with a minimum readable size. Focus automatically reveals
  the target. Two-finger horizontal trackpad gestures and Shift+wheel navigate the strip without
  a bottom slider. Vertical terminal scrolling and pinch-to-zoom retain their normal behavior.
  Embedded apps own gestures inside their iframe; scroll across their pane header to move the strip.
- Drag a title area to rearrange. The destination outline and neighboring windows preview the drop.
  Escape cancels. Strip dragging reorders columns, or panes within the same stack.
- Stack a pane into an adjacent column, detach it again, or toggle a column between stack and tabs.
  Tab contents stay mounted while hidden.
- Pin a column left/right to keep it stationary. Each side holds one column, bounded to 30% of the
  viewport. Pinning another column to that side replaces the previous pin.
- Floating panes move by title drag and resize at their right/bottom edges. Toggle floating again
  to return to the tiled layout. Floating geometry is relative to the viewport.
- Grid full-width mode temporarily maximizes the active window. Strip full-width mode expands its
  column. The action is reversible.

Saved geometry is coalesced during interaction. Moving to a board that already contains the same
target focuses its existing window and retains the source window, preserving both clients.
Explicit close releases that pane's client but keeps
its tmux session running. Limits are nine boards and 32 windows; notifications never evict existing
work to make room. On mobile, one pane is visible at a time and desktop geometry remains stored.

## Shortcuts

Open **Cmd/Ctrl+?** (Shift+/) for keyboard help, including the active board’s layout shortcuts and
enable/disable setting. Cmd/Ctrl+/ also opens the same help panel. There is no separate Arrange windows screen.

The layout modifier **M** is Command+Option on macOS and Control+Alt on Windows/Linux.
Shortcuts never combine Command and Control. Keyboard help can turn layout shortcuts off;
existing saved modifier presets migrate to the platform-appropriate keys without changing layouts.
Existing system/browser shortcuts may take precedence; all actions are also in Cmd/Ctrl+K.

| Keys | Action |
| --- | --- |
| M + arrows or H/J/K/L | Focus left/down/up/right |
| Cmd/Ctrl + Left/Right | Focus the window to the left/right (when layout shortcuts are enabled) |
| M + Shift + arrows or H/J/K/L | Move left/down/up/right |
| M + Home/End | Focus first/last column |
| M + Shift + Home/End | Move first/last column in Strip |
| M + 1–9 | Focus numbered window |
| M + R | Cycle Strip width presets; adjust a Grid split |
| M + F | Toggle full width |
| M + C | Center the active Strip column |
| M + Equals/Minus | Increase/decrease width |
| M + Shift + Equals/Minus | Increase/decrease height |
| M + 0 | Equalize stack heights / reset Grid proportions |
| M + P / Shift+P | Toggle left/right pin in Strip |
| M + Right bracket / Left bracket | Join left/right Strip column |
| M + Shift + Right bracket / Left bracket | Detach right/left |
| M + Shift + T | Toggle stack/tabs |
| M + T | Toggle floating |
| M + N | Move the pane to the next Hive board, creating a second board when needed |
| M + Q | Disable layout shortcuts; re-enable through search or keyboard help |
| Ctrl/Cmd + 1–9 | Select board (browser tab bindings may take precedence) |
| Ctrl/Cmd + Alt + PageUp/PageDown | Previous/next board |
| Ctrl/Cmd + Alt + Enter | Create board |
| Ctrl/Cmd + Alt + Backspace | Close board, preserving underlying sessions |
| Cmd/Ctrl + K | Unified search |
| Cmd/Ctrl + ? (Shift+/), or Cmd/Ctrl + / | Keyboard help and layout shortcut settings |
| Cmd/Ctrl + B | Sidebar |
| Cmd/Ctrl + Alt + A | Agents |
| Cmd/Ctrl + Alt + G | Manage Coder workspaces |
| Cmd/Ctrl + Alt + M / S | Microphone / speaker controls |
| Cmd/Ctrl + Alt + Period | Pane actions |
| Cmd/Ctrl + Alt + X | Close focused window |
| Cmd/Ctrl + Shift + M | tmux menu |
| Cmd/Ctrl + Enter | Fullscreen |
| Cmd/Ctrl + Shift + 1 / 2 / 3 | Workspace / Templates / Diagnostics |

The executable source is `src/lib/workspaces/window-actions.ts`; registrations, command search and
keyboard help use that source. Repeating focus/resize keys is supported; toggles and destructive
actions do not repeat. Modals and ordinary text fields suppress layout shortcuts. AltGr remains
character input. Symbol keys are normalized for Option-modified keyboard events.

This adapts [ChainYourMac's interactions](https://chainyourmac.com/) to browser panes. Moving to
a physical display and quitting a native window manager have no direct browser equivalent. Hive's
N/Q actions mean move to another board / disable shortcuts, never stop a Coder workspace or CLI.

## Notification routing and compatibility

New notification links use `/workspaces?workspace=<id>&session=<name>`. The canvas first looks across
all boards for the matching workspace/session or resolved repository identity. Existing windows are
focused and revealed; a missing target opens on a new board (or an unused empty board). Repository
notifications resolve current authorized identity on the server; URLs and storage never carry proofs.

Foreground notification clicks and audio “Go to pane” dispatch the same canvas event. The service
worker asks an existing Hive page to handle navigation before falling back to navigation/openWindow.
Cancelled or superseded repository resolution cannot open a late result. At capacity, an actionable
message asks the user to close an unused window/board.

The old per-workspace route files, terminal client, multi-session renderer, tab manager and obsolete
layout/navigation helpers are removed. Old URLs are redirect-only compatibility. A small read-only
import module protects existing local pane descriptors during first migration; no legacy renderer
or mutation code is retained.

## Verification contract

Every future layout or workspace-navigation change must check:

1. Pointer and keyboard resizing, minimum dimensions and persistence after reload.
2. Drag destination border, live neighbor preview, successful drop and cancel rollback.
3. Terminal instance/connection and iframe DOM identity across mode, grouping and board changes.
4. Notification focus across inactive boards and creation for missing targets, including repository
   authorization failures, stopped workspaces and capacity limits.
5. Keyboard repeat, text-field/modal isolation, modifier conflicts and displayed shortcut accuracy.
6. Reduced motion, narrow/mobile viewports, and no document overflow.

UI fixtures do not prove live Coder/PTY authentication. Keep action authorization, terminal runtime
and app-origin isolation tests alongside browser evidence. See the [feature catalog](features.md)
for the complete inventory and migration dispositions.
