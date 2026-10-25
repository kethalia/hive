# Terminal controls and shortcut tooltips

Validated on 2026-10-25 in the reused `creator-direction-upgrade` Browser Testing workspace. It remains running for another active task. Changes and evidence are preserved in the primary Hive checkout.

The disconnected microphone uses a microphone with an X at its upper-right. Mic, speaker, Actions, and Close use the same 32 × 32 px buttons and 16 px icons on desktop; all four use 44 × 44 px touch targets on mobile. Shadcn tooltips show the current action/status and a platform-formatted keyboard shortcut using Hive's tooltip theme.

| Control | Windows/Linux | Mac |
| --- | --- | --- |
| Sidebar | Ctrl+B | ⌘B |
| Agents | Ctrl+Alt+A | ⌘⌥A |
| Search / add window | Ctrl+Alt+F | ⌘⌥F |
| Microphone controls | Ctrl+Alt+M | ⌘⌥M |
| Speaker controls | Ctrl+Alt+S | ⌘⌥S |
| Pane actions | Ctrl+Alt+P | ⌘⌥P |
| Close focused pane | Ctrl+Alt+X | ⌘⌥X |
| Manage Coder workspaces | Ctrl+Alt+G | ⌘⌥G |

Existing global Ctrl/⌘+K command-palette and Ctrl/⌘+Shift+N shortcuts remain available. Pane shortcuts require focus in Hive or its terminal. Key events inside cross-origin embedded apps remain owned by those apps. The audio shortcuts open their control popovers; connecting a microphone remains a separate explicit action.

The browser fixture bundles the real shared canvas, terminal frames, audio controls, keybinding provider, dashboard keyboard controller, and tooltip components/styles. Server actions, the PTY, device connections, and the Agent Tools dialog body are fixture implementations. This is UI/keyboard validation, not a live microphone capture or live Coder session test.

Chrome checked 1440 × 900 with both Ctrl and Mac-style ⌘ profiles, plus a 390 × 900 touch viewport:

- All four pane buttons have equal square geometry, and the disconnected microphone has an X rather than an unplug badge.
- Pane and workspace-header tooltips display the same key combinations registered by their handlers, formatted for the selected platform.
- Mic, speaker, Actions, Agents, search, and sidebar shortcuts activate the corresponding UI; opening mic/speaker controls does not connect a device.
- Pane actions target the focused visible pane. Dialogs/menus block actions on the pane underneath, and a held Close shortcut closes only one pane.
- Closing a pane selects the remaining pane without reactivating the removed pane through a bubbled click.
- No page errors or horizontal overflow.

`controls-report.json` contains the assertions and dimensions; PNGs show desktop tooltip and mobile sizing. All 2,013 Vitest tests, TypeScript, Biome, production Next build, and standalone runtime verification pass.
