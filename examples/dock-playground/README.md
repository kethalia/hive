# Workspace dock experiment

A standalone shadcn/Base UI component experiment for a future main-page navigation refactor. The
application does not import it. Keep the tracking PR in draft until the larger refactor is ready.

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

- **Apps:** opens a launcher for Terminal, Files, Browser, and Editor previews.
- **Workspaces:** replaces the four home buttons with Back, +, and numbered workspaces. New
  workspaces become active. Each workspace retains its simulated terminal input and output.
- **Extra keyboard:** replaces the home buttons with Back and all current mobile terminal controls:
  Ctrl, Alt, Shift, Enter, Tab, Esc, Backspace, Up, Down, Left, Right, Space, Copy, Paste, Upload,
  Decrease font size, and Increase font size. Scroll horizontally on narrow screens. Back stays
  outside the scrolling options.
- **Keybinds:** opens instructions for the prototype's actual keyboard controls.
- Toggle theme, desktop/mobile preview, backdrop, and dock density. Reset restores the initial
  workspaces, terminal sessions, selected app, font size, and local clipboard.

The terminal is a local simulation. Type `help`, `ls`, `pwd`, `whoami`, `echo <text>`, or `clear`.
Ctrl/Alt combinations and Up/Down are demonstrated in the interaction log. Modifier toggles apply
to the next dock key, then reset. Copy/Paste use a playground-only clipboard. Upload opens a native
file picker and displays filenames; file contents are not read or sent anywhere. Files and Browser
are visual previews; Editor is an editable scratchpad. Refresh resets all playground state.

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
effects. Optional `density`, `canCreateWorkspace`, `disabledActions`, and `className` props control
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

The browser script checks workspace session isolation, one-shot encoded modifiers, every mobile
control, clipboard/file/font interactions, launcher and keybind dialogs, keyboard focus, theme,
density, reset, 320px/390px layouts with 15 workspaces, and reduced motion. It saves screenshots and
`results.json`. It uses `@playwright/test` from the repository's pinned dependencies and installed
Chrome; it does not install a browser.

## Deferred integration

After the main refactor, decide on dock placement with the native mobile keyboard open, preserve
xterm focus/selection during terminal actions, wire the real app registry and workspace lifecycle,
use the real keybinding registry, and connect actual clipboard/upload capability and busy states.
The preview deliberately has no imports in application routes, layouts, providers, or navigation.
