# Window management

Hive has one general workspace at `/workspaces`. A **board** is a saved arrangement within it.
A **Coder workspace** supplies the running environments behind the windows.

New boards use Strip; existing saved arrangements retain Grid. Switch with the Grid/Strip header
buttons. Both modes keep the same mounted panes, connections, unsaved app state and terminal font
preferences. Layout changes do not refetch repositories, agents or sessions.
There is no sidebar. Cmd/Ctrl+K or the header search button opens one launcher inspired by
[PowerToys Command Palette](https://learn.microsoft.com/en-us/windows/powertoys/command-palette/overview)’s
nested pages and inline prompts:

- **Terminal**: opens a searchable session list with **Create terminal** first. Create terminal
  opens a name prompt in the same command input; type a name and press Enter. Existing sessions
  open directly as windows.
- **Projects**: opens a searchable project list with **New project** first. New project asks for
  a GitHub organization/owner, then a repository name, inside the command palette. It uses that
  workspace's GitHub authentication to clone into `~/projects/<owner>/<repo>`
  and opens a terminal there. Existing folders are never overwritten. Existing projects open directly.
- **Files, VS Code, Desktops**: each supported Coder workspace supplies an app window.
- **Hive**: Agents, Settings, Diagnostics, Logs, Templates, and Manage Coder workspaces are native
  canvas windows. Agent conversations are shown first; setup details stay collapsed until expanded.
- **Commands**: layout, focus, movement, and workspace actions remain searchable.

The blank home screen shows categories and Hive tools; typing still searches across all targets.
Every nested screen has a Back button. Forward navigation slides right to left, and Back reverses
it while restoring the parent’s query. Escape goes back one level (dismisses at home); Backspace
also goes back when the input is empty. Reduced-motion preferences disable these transitions.

Creation defaults to the focused running Coder workspace, then the development workspace or first
running workspace. The **Workspace** item opens a searchable destination picker and restores the
name you typed when returning. Enter submits the name; progress and errors remain inline. During
creation, duplicate submits and dismissal are blocked. Closing and reopening returns to home.

Search ranks exact names before prefixes, phrases, aliases, categories, and descriptive context.
Each group is ordered by its strongest match, so a matching Hive tool can appear above terminals or
apps. All search words must match; `editor ai-dev` narrows VS Code to that workspace. Common aliases
include `preferences`, `vscode`, `new terminal`, and `clone repository`. Single-letter typos in names
and aliases are low-priority fallbacks, not scattered-letter matches across descriptions.
App aliases also find stopped workspaces that support those apps, so search can start them.
Background metadata refreshes preserve the selected result while it still matches; if it disappears,
selection moves to the first available match. Projects stay literal name/path matches, including queries such as `projects hive`. Clearing search
restores categories at home, or the creation-first order inside Terminal and Projects.

Existing targets are focused across all boards instead of duplicated. Tool windows resize, move,
float, close, and restore like terminal/app windows. Their loading/error states stay within the pane;
opening them preserves existing terminal and app instances. Settings contains Open Coder and sign-out.
Closing the focused window selects its previous neighbor in the current layout, or the next window
when there is no previous one. Closing a background window keeps the current selection.
On mobile the same search opens in a bottom sheet; a deliberate leftward swipe also opens it.

## Resize and arrange

Resize edges have a short, muted grip that highlights on hover, drag, or keyboard focus. The whole
edge remains draggable, including the transparent area above or beside the grip.

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
Search and keyboard help call boards **workspaces**, matching the numbered workspace tabs.
Moving a window to the previous/next workspace wraps at either end. With just one workspace,
either action creates a second one. Closing the last workspace leaves a fresh empty workspace.

## Shortcuts

Open **Cmd/Ctrl+?** (Shift+/) for keyboard help, including the active board’s layout shortcuts and
enable/disable setting. Cmd/Ctrl+/ also opens the same help panel. There is no separate Arrange windows screen.

The layout modifier **M** is Command+Option on macOS and Control+Alt on Windows/Linux.
Shortcuts never combine Command and Control. Keyboard help can turn layout shortcuts off;
existing saved modifier presets migrate to the platform-appropriate keys without changing layouts.
Existing system/browser shortcuts may take precedence; all actions are also in Cmd/Ctrl+K.

| Keys | Action |
| --- | --- |
| Cmd/Ctrl + arrows, or M + H/J/K/L | Focus left/down/up/right (when layout shortcuts are enabled) |
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
| M + N / Shift+N | Move the window to the next/previous Hive workspace |
| M + Q | Disable layout shortcuts; re-enable through search or keyboard help |
| Ctrl/Cmd + 1–9 | Select board (browser tab bindings may take precedence) |
| M + Left/Right, or M + PageUp/PageDown | Previous/next numbered workspace |
| Ctrl/Cmd + Alt + Enter | Create board |
| Cmd/Ctrl + W, or Cmd/Ctrl + Alt + Backspace | Close current workspace, preserving underlying sessions |
| Cmd/Ctrl + K | Unified search |
| Cmd/Ctrl + ? (Shift+/), or Cmd/Ctrl + / | Keyboard help and layout shortcut settings |
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
Cmd/Ctrl+W is handled when the browser delivers it to Hive. Browsers that reserve it for closing
their tab/window require Cmd/Ctrl+Alt+Backspace or **Close current workspace** in Cmd/Ctrl+K.
Embedded apps keep their own keyboard focus; focus a Hive pane header to use these commands.

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
