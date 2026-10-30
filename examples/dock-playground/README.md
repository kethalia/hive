# Workspace dock experiment

A standalone shadcn/Base UI dock experiment inside Hive's actual main-screen layout. The application
has no imports of the experiment. Keep the tracking PR in draft until the larger refactor is ready.

The preview reuses the existing `WindowCanvas`, `TerminalSessionFrame`, `WorkspaceBoardBar`,
`WorkspaceSearchButton`, `WindowLayoutControls`, window manager and layout helpers, Fira Code fonts,
CRT background classes, and unmodified `src/app/globals.css`. Its empty-state copy and dashboard
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

Use the style buttons below the canvas to switch instantly, or **Compare** to see all five side by
side. The active style is stored in the URL (`?dock=phosphor`, `?dock=outline`, `?dock=keycaps`,
`?dock=console`, or `?dock=glass`), so links can be shared and refreshed. Switching styles preserves
the dock's expanded view, workspace state, and terminal sessions.

| Style | Treatment |
| --- | --- |
| Phosphor (default) | Flat panel, muted labels, app colors and borders. |
| Outline | Separate square buttons, fine outlines, transparent tray. |
| Keycaps | Raised keyboard keys with monospace legends. |
| Console | A slim text-first command bar. |
| Glass | The original colorful macOS-style treatment. |

The four native variants use Hive's CSS tokens in both dark and light themes. All variants support
the same workspace/keyboard expansions, focus behavior, and compact size. Comparison samples are
inert illustrations; **Try** applies a style to the real playground controls.

- **Apps / Add window:** opens Search Hive with Terminal, Files, VS Code, Desktop, built-in Hive tool
  previews, and window layout actions. Terminal uses the same xterm renderer, theme, and font as
  Hive. Files is a local file-list fixture, VS Code is an editable scratchpad, and remaining tools
  show their native pane frame with a disconnected-service placeholder.
- **Workspaces:** replaces the four home buttons with Back, +, and numbered workspaces. New
  workspaces become active and start empty, matching Hive. Boards preserve their panes and terminal
  buffers. The maximum is Hive's existing nine-board limit.
- **Extra keyboard:** replaces home buttons with Back and every current mobile terminal control:
  Ctrl, Alt, Shift, Enter, Tab, Esc, Backspace, Up, Down, Left, Right, Space, Copy, Paste, Upload,
  Decrease font size, and Increase font size. Focus a terminal to use terminal actions. Scroll
  horizontally on narrow screens; Back stays outside the scrolling options.
- **Keybinds:** opens prototype keyboard help and working layout action buttons.
- **Playground:** a small utility button below the canvas opens controls for comparing the dock
  with the **actual current Hive navbar**, switching the native dark/light theme, changing dock
  density, adding a terminal, and resetting the preview. It does not cover pane-header controls.

Drag pane title bars and resize their divider grips using Hive's real canvas. Use the pane actions
menu or Search Hive to switch Strip/Grid, cycle width, maximize, float, or equalize windows. Close
buttons remove panes. The native navbar comparison includes the original search, layout, numbered
workspace buttons, and workspace deletion behavior.

The terminal shell is local. Type `help`, `ls`, `pwd`, `whoami`, `echo <text>`, or `clear`. Cursor
arrows, history arrows, Backspace, Tab, Enter, Escape, Ctrl+C, and Ctrl+L work. Other modifier
combinations appear in the status line. Dock modifiers reset after the next key. Copy/Paste use a
preview-only clipboard. Upload opens a native file picker and displays filenames; contents are not
read or sent anywhere. Refresh resets all local state. No shell command runs on Coder.

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
  onAppsOpen={() => setPanel("apps")}
  onKeybindsOpen={() => setPanel("keybinds")}
  onKeyPress={({ sequence }) => sendToFocusedTerminal(sequence)}
  onAction={handleTerminalAction}
/>
```

The component owns its current view and one-shot modifiers. Consumers own workspace data and all
effects. Optional `variant`, `density`, `canCreateWorkspace`, `disabledActions`, and `className` props control
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

Run `validate-variants.browser.mjs` with the same environment to check all five styles in every dock
view at desktop, 390px, and 320px widths, plus light/compact styles, URL reload, style switching
without resetting the view, and comparison selection/focus. It also saves the comparison image.

The browser script checks workspace session isolation, one-shot encoded modifiers, every mobile
control, clipboard/file/font interactions, launcher and keybind dialogs, keyboard focus, theme,
density, reset, native navbar comparison, real canvas Strip/Grid layouts and resizing,
320px/390px layouts with nine workspaces, and reduced motion. It saves screenshots and
`results.json`. It uses `@playwright/test` from the repository's pinned dependencies and installed
Chrome; it does not install a browser.

## Deferred integration

After the main refactor, decide on dock placement with the native mobile keyboard open, preserve
xterm focus/selection during terminal actions, wire the real app registry and workspace lifecycle,
use the real keybinding registry, and connect actual clipboard/upload capability and busy states.
The preview deliberately has no imports in application routes, layouts, providers, or navigation.
