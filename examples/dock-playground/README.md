# Workspace dock

The Keycaps shadcn/Base UI dock replaces the PWA workspace header and mobile terminal strip.
`GeneralWorkspaceDock` connects the reusable dock/overlay to saved boards, the global Hive launcher,
live shortcut help, active xterm input, clipboard/uploads, and session-scoped font controls.
This directory retains the local fixture used to develop and validate the component.

The preview reuses the existing `WindowCanvas`, `TerminalSessionFrame`, window manager and layout
helpers, Fira Code fonts, CRT background classes, and unmodified `src/app/globals.css`. Its empty-state copy and dashboard
wrappers follow `GeneralWorkspace.tsx` and the dashboard layout. The prototype adapter supplies
local board/window state; it does not load the production page or call live services.

## Run the playground

From the repository root, using the pinned package manager and lockfile:

```sh
pnpm install --frozen-lockfile
node examples/dock-playground/serve.mjs
```

The server listens on `0.0.0.0:4317`. Override `PORT` if needed. `--build-only` writes static assets to
`.artifacts/dock-playground` without starting a server. Restart the command after source changes.
The preview needs no environment variables, database, app login, or production services. Access
through Coder still requires the workspace owner's Coder sign-in.

## Try it

The screen starts with Hive's original **Your workspace** empty state and **Add window** button.
There is no marketing page, wallpaper, decorative Mac window, or new application theme.

The canvas fills the entire screen. A separate `WorkspaceDockOverlay` places the dock above
windows without reserving footer space, and keeps launcher/help dialogs above the dock. It starts
expanded and auto-minimises after 2.5 seconds away. Hover, keycap/grip focus, dragging, and an open
playground dialog suspend the timer. Manual expansion resumes auto-minimise; there is no pin mode.

Two 26px square badges with 4px corners match the count badge's dark background and subtle green
border; the selected-space remove button uses the same style. On top/bottom edges the controls
form a centred column to the right (Minimise above Move). On left/right edges they form a centred
row above the dock (Minimise left, Move right), without a draggable bar.
Minimise reduces the dock to one 48px expand button. The existing shell changes
width and height: controls fade out (120ms), the shell shrinks (340ms), and the expand icon arrives
as it settles. Expansion grows the shell (380ms), then the keycaps appear in a stagger (300ms per
cap, up to 240ms total stagger). The layout stays mounted so the selected view and modifiers survive.
Overlapping navigation/space mutations finish before a pending minimise. Reduced motion finishes
immediately. Hidden controls are inert and excluded from the accessibility tree.

Drag the Move badge, the dock's unused background, or the collapsed button. Release velocity predicts a resting point and feeds a single damped spring to an edge.
Gentle releases return to the nearby edge; strong flicks can carry the dock across the screen.
There is no separate coast/snap handoff. A new drag interrupts the motion. Reduced motion attaches
immediately. Switching between horizontal and vertical layouts rotates the frame through a quarter
turn while counter-transforming the keycaps to keep their labels upright. It uses a 12px/safe-area inset; centre drops cannot
leave it floating in the canvas. The edge and position along it are shared between both shapes,
including while changing views or resizing the visual viewport. Touch drags use the grip/button,
while native key-strip swipes remain available. Dragging the button never activates expansion.

Enter/Space activates Minimise/Expand; **Alt+Shift+D** toggles outside dialogs and focuses the
revealed controls or returns focus to Expand. On the grip or collapsed button, arrows move along
the current edge, Shift+Arrow chooses an edge, and Home/End move to corners. Escape cancels a
drag. The expanded form has no additional control underneath. Window geometry stays full-screen.

Left/right edges stack upright keycaps from top to bottom; top/bottom edges use a horizontal row.
Expanded spaces and keyboard controls follow that axis too. Side strips use vertical swipes, wheel
scrolling, Up/Down scroll controls, and Up/Down focus navigation. Back and + remain pinned outside
the scroll area. View transitions and numbered-space animations allocate height for a vertical dock
and width for a horizontal dock, then reveal the new controls.

Keycaps keep their solid shadow anchored at the bottom-left. On hover a key lifts up/right and its
shadow grows; pressing moves it down/left and collapses the shadow. The press is quick (65ms) and
release eases back (220ms). Mouse, touch, Space, and Enter get the same depressed-key feedback.
Hover lift is limited to fine pointers, and reduced-motion mode removes transitions and hover lift.
Toggled modifiers and the selected space keep the depressed position and collapsed shadow; they
do not lift on hover. Modifiers still reset after the next key.

View changes fade the old row out (160ms), ease the tray to its new width (560ms), and reveal the
next row during that resize. The slow lead-in accelerates into the resize before settling. Controls
are inert while moving, Escape can queue a return, and focus moves only after the animation ends.
Reduced-motion view changes are immediate.

Creating a space first expands the tray (280ms), then fades/scales the new cap into its allocated
slot (260ms). Overflow controls retain their settled state until the layout finishes, avoiding
temporary scroll arrows while the tray makes room. At the viewport limit, real overflow controls
update after the mutation. Removing a space
first fades/scales its cap out (180ms), then resizes the tray and slides surviving caps into their
new positions together (440ms, with the same easing). All final cap positions are measured before
resize playback starts, including removal of scroll arrows when the remaining row fits. This
keeps caps anchored to the centered tray and prevents a second snap after playback.
Mutations are coordinated so repeated actions cannot overlap; Back can
queue a return while they finish. Reduced-motion mutations finish immediately.

- **Apps / Add window:** opens Search Hive with Terminal, Files, VS Code, Desktop, built-in Hive tool
  previews, and window layout actions. Terminal uses the same xterm renderer, theme, and font as
  Hive. Files is a local file-list fixture, VS Code is an editable scratchpad, and remaining tools
  show their native pane frame with a disconnected-service placeholder.
- **Workspaces:** replaces the four home buttons with Back, +, and numbered workspaces. New
  workspaces become active and start empty, matching Hive. Boards preserve their panes and terminal
  buffers. The maximum is Hive's existing nine-board limit.
  Back and + stay fixed while the numbered spaces scroll. The selected space has a square badge × to
  remove it; after removal the remaining selection receives focus. The last space cannot be removed.
- **Extra keyboard:** replaces home buttons with Back and every current mobile terminal control:
  Ctrl, Alt, Shift, Enter, Tab, Esc, Backspace, Up, Down, Left, Right, Space, Copy, Paste, Upload,
  Decrease font size, and Increase font size. Focus a terminal to use terminal actions. Scroll
  using the side arrows, mouse wheel, trackpad, or touch swipe; Back stays outside the scrolling
  options. Edge fades show overflow, and the native scrollbar is hidden. Active spaces reveal
  themselves automatically when selected or when the viewport resizes.
- **Keybinds:** opens prototype keyboard help and working layout action buttons.

Drag pane title bars and resize their divider grips using Hive's real canvas. Use the pane actions
menu or Search Hive to switch Strip/Grid, cycle width, maximize, float, or equalize windows. Close
buttons remove panes. The dock remains isolated from the real application navigation.

The terminal shell is local. Type `help`, `ls`, `pwd`, `whoami`, `echo <text>`, or `clear`. Cursor
arrows, history arrows, Backspace, Tab, Enter, Escape, Ctrl+C, and Ctrl+L work. Other modifier
combinations are encoded by the dock; unsupported combinations are ignored by the local shell.
Dock modifiers reset after the next key. Copy/Paste use a preview-only clipboard. Upload opens a native file picker and displays filenames; contents are not
read or sent anywhere. Refresh resets all local state. No shell command runs on Coder.

The visible page contains only the main workspace and dock (or its single expand button). There is no floating Playground button,
settings panel, or visible interaction/status log. Action feedback remains available to screen readers.

## Component contract

`src/components/workspaces/dock/workspace-dock.tsx` uses the repository's existing shadcn `Button` and
`Tooltip` components. It imports only its own scoped CSS, pure key data/encoding, and UI primitives.
The playground owns app launcher and keybind dialogs using shadcn `Dialog`.

```tsx
import { WorkspaceDock } from "@/components/workspaces/dock/workspace-dock";
import { WorkspaceDockOverlay } from "@/components/workspaces/dock/workspace-dock-overlay";

<WorkspaceDockOverlay blocked={dialogOpen}>
  <WorkspaceDock
    workspaces={workspaces}
    activeWorkspaceId={activeWorkspaceId}
    onWorkspaceSelect={setActiveWorkspaceId}
    onWorkspaceCreate={createWorkspace}
    onWorkspaceRemove={removeWorkspace}
    onAppsOpen={() => setPanel("apps")}
    onKeybindsOpen={() => setPanel("keybinds")}
    onKeyPress={({ sequence }) => sendToFocusedTerminal(sequence)}
    onAction={handleTerminalAction}
  />
</WorkspaceDockOverlay>
```

The component owns its current view and one-shot modifiers. Consumers own workspace data and all
effects. Optional `onWorkspaceRemove`, `density`, `canCreateWorkspace`, `disabledActions`, and `className` props control
presentation and capabilities. `onKeyPress` receives the base key, modifier snapshot, and encoded VT
sequence using Hive's existing encoder. `onAction` receives `copy`, `paste`, `upload`,
`font-decrease`, or `font-increase`. Wire those to real selected-terminal capabilities only during
the later integration. Workspaces are numbered by their array order and identified by stable IDs.
Controlled `modifiers`/`onModifiersChange` share xterm’s one-shot modifier store in the PWA;
`keysDisabled`, `preserveTerminalFocus`, and `busyActions` control terminal capabilities and feedback.
The optional overlay owns visibility and placement; `blocked` suspends its timer while a consuming
dialog or picker is open. The base dock can still be rendered without the overlay.

Tab and Shift+Tab follow normal button order. Left/Right, Home, and End move between enabled dock
buttons and reveal options inside the dock. Enter/Space activate buttons. Escape returns from an
expanded dock while focus is inside it; it does not capture terminal input globally. Expanding
focuses Back; returning focuses the opener. Completed animations preserve focus if a dialog has
opened in the meantime. Reduced-motion preferences disable entrance and hover
animations. Dialog focus management comes from Base UI.

## Validate

```sh
pnpm exec biome check src/components/workspaces/dock examples/dock-playground
pnpm exec tsc --project examples/dock-playground/tsconfig.json --noEmit
node examples/dock-playground/serve.mjs --build-only
```

Run browser checks in the **Browser Testing** workspace with installed Chrome, per `AGENTS.md`:

```sh
DOCK_PREVIEW_URL=http://127.0.0.1:4317 \
DOCK_EVIDENCE_DIR=/tmp/dock-evidence \
node examples/dock-playground/validate.browser.mjs
```

Run `validate-keycaps.browser.mjs` with the same environment for the resting shadow, hover lift,
mouse press/release, latched state, Space/Enter activation, touch press/release, and reduced motion.
It saves close-up screenshots of the cap states.

Run `validate-navigation.browser.mjs` for the staged transitions, persistent depressed selections,
wheel/arrow scrolling, pinned Back/+ at 320px, selected-space removal and focus, rapid Escape, and
reduced motion. It records frame-by-frame tray widths and saves screenshots of the new controls.

Run `validate-spaces.browser.mjs` for cap entry/exit, surviving-cap movement, tray resizing, focus,
mobile overflow, queued Back, and reduced-motion mutations. It observes DOM insertions to catch
transient scroll arrows and verifies that the tray finishes expanding before a new cap appears.
It records per-frame cap opacity, position, tray width, and scroll-control presence.
Removal checks cover first/middle/last caps, shared resize/movement progress, and the overflow
boundary, including frames after playback to catch any final position snap.

Run `validate-visibility.browser.mjs` for shell morph frame samples, staged cap appearance,
square control placement in a right column or top row, absence of a title bar, collapsed-only accessibility, keyboard toggling/focus, auto-minimise,
dialog holds, dragging both forms to every edge, centre-drop snapping, keyboard placement, Escape
cancellation, real touch dragging, viewport resizing, full-height canvas geometry, and reduced motion.

Run `validate-axis.browser.mjs` for vertical home/spaces/keys layouts, control placement on each axis,
vertical creation/removal/reveal and scrolling, latched modifiers across morphs, full-height strip
edge selection, sampled spring motion, gentle returns versus strong flicks from the same position,
interrupting motion, upright labels and viewport bounds during rotation, and immediate reduced-motion drops.

The browser script checks workspace session isolation, one-shot encoded modifiers, every mobile
control, clipboard/file/font interactions, launcher and keybind dialogs, keyboard focus, theme,
page reload/reset, real canvas Strip/Grid layouts and resizing,
320px/390px layouts with nine workspaces, and reduced motion. It saves screenshots and
`results.json`. It uses `@playwright/test` from the repository's pinned dependencies and installed
Chrome; it does not install a browser.

## PWA integration

`GeneralWorkspace` owns board persistence and session teardown as before. Its header and duplicate
mobile-only key strip are replaced with `GeneralWorkspaceDock`. The dock overlays the full canvas;
it reserves no footer height. Each window contributes a shared 2px inset and the canvas adds another
2px around its edges, matching the 4px gap between adjacent window borders even at full width or
when maximized. Mobile safe areas and the installed iOS status-bar clearance remain in effect.

The adapter shares the existing per-terminal modifier store with native xterm input, preserves terminal
focus for pointer-operated keys (including opening/closing Keys), disables actions without the active
terminal/capability, and uses the existing selection, clipboard, upload, feedback, and font APIs.
Switching terminals clears latched modifiers. Clipboard/file operations and any open modal hold the
dock open. Touch interaction suspends auto-hide and restarts the timer at release. The strip is marked
as scrollable inside `MobileTerminalShell` so its global page-scroll lock does not swallow dock gestures.

Append `?integration=1` to the local fixture URL to exercise the production adapter, real shortcut help,
shared modifiers, and PWA mobile shell. Its xterm transport remains the local shell; no command runs on
Coder. Browser clipboard actions are real in this mode; asset upload requires the actual PWA endpoint.
The default fixture retains its preview-only clipboard and local file-picker behavior.

Run `validate-integration.browser.mjs` in Browser Testing for matching outer/inter-window gaps,
full-width/maximized padding, native xterm focus and modifier reset, font settings, scrolling under
the mobile page lock, modal holds, and board creation/removal. The component tests also cover saved
board persistence, stale-terminal guards, clipboard/upload routing, capability checks, and the live
help event. Live backend login and physical iOS keyboard behavior need the configured application
environment; the browser fixture supplies no authentication bypass.
