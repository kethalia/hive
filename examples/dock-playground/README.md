# Workspace dock experiment

A standalone Keycaps-only shadcn/Base UI dock experiment inside Hive's actual main-screen layout.
The application has no imports of the experiment. Keep the tracking PR in draft until the larger
refactor is ready.

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
new positions (440ms). Mutations are coordinated so repeated actions cannot overlap; Back can
queue a return while they finish. Reduced-motion mutations finish immediately.

- **Apps / Add window:** opens Search Hive with Terminal, Files, VS Code, Desktop, built-in Hive tool
  previews, and window layout actions. Terminal uses the same xterm renderer, theme, and font as
  Hive. Files is a local file-list fixture, VS Code is an editable scratchpad, and remaining tools
  show their native pane frame with a disconnected-service placeholder.
- **Workspaces:** replaces the four home buttons with Back, +, and numbered workspaces. New
  workspaces become active and start empty, matching Hive. Boards preserve their panes and terminal
  buffers. The maximum is Hive's existing nine-board limit.
  Back and + stay fixed while the numbered spaces scroll. The selected space has a round × to
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

The visible page contains only the main workspace and dock. There is no floating Playground button,
settings panel, or visible interaction/status log. Action feedback remains available to screen readers.

## Component contract

`src/components/experimental/workspace-dock.tsx` uses the repository's existing shadcn `Button` and
`Tooltip` components. It imports only its own scoped CSS, pure key data/encoding, and UI primitives.
The playground owns app launcher and keybind dialogs using shadcn `Dialog`.

```tsx
import { WorkspaceDock } from "@/components/experimental/workspace-dock";

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
```

The component owns its current view and one-shot modifiers. Consumers own workspace data and all
effects. Optional `onWorkspaceRemove`, `density`, `canCreateWorkspace`, `disabledActions`, and `className` props control
presentation and capabilities. `onKeyPress` receives the base key, modifier snapshot, and encoded VT
sequence using Hive's existing encoder. `onAction` receives `copy`, `paste`, `upload`,
`font-decrease`, or `font-increase`. Wire those to real selected-terminal capabilities only during
the later integration. Workspaces are numbered by their array order and identified by stable IDs.

Tab and Shift+Tab follow normal button order. Left/Right, Home, and End move between enabled dock
buttons and reveal options inside the dock. Enter/Space activate buttons. Escape returns from an
expanded dock while focus is inside it; it does not capture terminal input globally. Expanding
focuses Back; returning focuses the opener. Reduced-motion preferences disable entrance and hover
animations. Dialog focus management comes from Base UI.

## Validate

```sh
pnpm exec biome check src/components/experimental examples/dock-playground
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

The browser script checks workspace session isolation, one-shot encoded modifiers, every mobile
control, clipboard/file/font interactions, launcher and keybind dialogs, keyboard focus, theme,
page reload/reset, real canvas Strip/Grid layouts and resizing,
320px/390px layouts with nine workspaces, and reduced motion. It saves screenshots and
`results.json`. It uses `@playwright/test` from the repository's pinned dependencies and installed
Chrome; it does not install a browser.

## Deferred integration

After the main refactor, decide on dock placement with the native mobile keyboard open, preserve
xterm focus/selection during terminal actions, wire the real app registry and workspace lifecycle,
use the real keybinding registry, and connect actual clipboard/upload capability and busy states.
The preview deliberately has no imports in application routes, layouts, providers, or navigation.
