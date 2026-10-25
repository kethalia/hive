# Hive feature catalog

This is the product inventory for the general Hive workspace. Update this document and the
corresponding regression coverage whenever a feature changes or moves. Historical screenshots in
`docs/checks/` are evidence for their recorded versions, not the current product specification.

## Workspace and windows

| Feature | Current behavior | Implementation / coverage |
| --- | --- | --- |
| General workspace | `/workspaces` is the only working canvas. Windows can come from any authorized Coder workspace. | `GeneralWorkspace`; general-workspace tests |
| Boards | Up to nine saved arrangements, labeled workspaces in search/help; not Coder environments. Move windows to previous/next workspaces, create, select, and close. Closing releases clients, not tmux sessions; the last workspace resets to empty. | `WorkspaceBoardBar`; window-management browser checks |
| Windows | Up to 32 terminal/app/tool windows across boards. Window identity remains stable when moving between boards. | `general-workspace`; `WindowCanvas` |
| Grid | Binary splits with saved proportions and adjustable dividers. Overflow scrolls when minimum pane sizes cannot fit. | `workspace-window-layout`; window-manager tests |
| Strip | Horizontal columns retain their widths; focus reveals the selected column. Two-finger horizontal scrolling and Shift+wheel navigate without a bottom slider. | `window-manager`; browser checks |
| Resizing | Pointer capture, keyboard-adjustable separators, minimum sizes, reset by double-click, and persisted dimensions. Floating windows have width/height edge handles. | `WindowResizeHandle`; browser checks |
| Drag rearrangement | A destination border and live neighboring-pane preview appear before drop. Escape/cancel restores the original layout. | `WindowCanvas`; browser checks |
| Stacks and tabs | Strip columns can stack windows vertically or display one tab at a time. Hidden tabs remain mounted. | window-manager tests; browser checks |
| Pinning | One column on each side can remain stationary while other strip columns scroll. | window-manager tests |
| Floating | Toggle a pane out of tiling, move its title area, resize its edges, then return it to tiling. | window-manager tests |
| Window shortcuts | Directional focus/movement, sizing, grouping, pinning, floating, numbered windows, and board actions. All are searchable with Cmd/Ctrl+K. Cmd/Ctrl+? opens keyboard help and the current board’s shortcut setting. | `window-actions`; `useWindowManagerCommands`; `HelpOverlay` |
| Persistence | Browser-local, user-scoped pane descriptors and layout preferences. No app authentication URLs, agent IDs, or clone proofs are stored. | general-workspace tests |
| Session continuity | Mode changes, resizing, tabbing, pinning and board moves keep the same terminal/iframe instances. Explicit reconnect and Coder rebuilds request fresh authorization. | pane tests; browser continuity checks |
| Mobile | One focused window at a time, horizontally scrollable pane selectors, touch terminal controls, keyboard viewport accommodation, safe areas. Desktop geometry remains saved. | `GeneralWorkspaceMobileControls`; mobile browser checks |
| Motion | Geometry transitions and animated drop previews; collapsibles use Base UI's measured height. Reduced-motion preferences disable transitions. | `WorkspaceWindow`; `Collapsible`; browser checks |

See [window management](window-management.md) for controls, shortcuts, limits and migration details.

## Navigation and discovery

| Feature | Current behavior | Implementation / coverage |
| --- | --- | --- |
| One search | Cmd/Ctrl+K opens a Spotlight-style launcher with Terminals, Projects, Files, VS Code, Desktops, Hive tools, and commands. The header search button and mobile swipe open the same launcher. | `CommandPalette`; general-workspace-commands tests |
| Repository search | Literal query matching excludes unrelated repositories; repository terminals resolve current clone identity before connecting. | literal-repository-search checks; git-clones action tests |
| Creation | New session heads Terminals and asks for a name and running Coder workspace. New project heads Projects and asks for a GitHub owner, repository, and running workspace before cloning and opening its terminal. | create-window-dialog; clone-project tests |
| Native tools | Agents, Settings, Diagnostics, Logs, Templates, and Manage Coder workspaces open as movable, resizable canvas windows. Opening an existing target focuses its window across boards. | general-workspace-windows tests; browser checks |
| Workspace apps | Files, VS Code and Desktop open inside the canvas when supported by the template. | general-workspace-pane tests; workspace-app-isolation browser suite |
| Cached discovery | Shared, user-scoped workspace/agent/repository/session data, deduplicated requests and background refresh. Cached content remains usable during refresh. | discovery tests; workspace-discovery-cache checks |
| Loading/error feedback | Initial discovery, app connection and lazy tool windows have local loading states. Errors and explicit retry do not blank the whole canvas. | general-workspace-windows tests; terminal-workspace-feedback checks |
| Tooltips | Fixed width, wrapping description above a separate right-aligned shortcut footer. | `ShortcutTooltip`; unified-workspace-search checks |

## Terminal, files and agent workflows

| Feature | Current behavior | Documentation / coverage |
| --- | --- | --- |
| Persistent tmux | Terminal views attach to Coder workspace tmux sessions. Closing a Hive window does not kill its tmux session. | [tmux sessions](terminal/tmux-sessions.md) |
| Reconnection | Connection banners, recovery and explicit reconnect; fresh authorization after workspace builds. | InteractiveTerminal integration tests; pane tests |
| Session controls | Open tmux's menu with Cmd/Ctrl+Shift+M. CLI/tmux owns terminal session operations. | KeybindingProvider tests |
| Fonts | Font size is scoped to a workspace/session, available in its pane actions and mobile controls. | session-font-size checks; terminal-font tests |
| Clipboard and uploads | Native copy/paste, file drops, upload progress/error feedback, workspace-scoped paste assets. | InteractiveTerminal integration; clipboard tests |
| File links | Open files in Hive, open in a new board, or download. Relative targets resolve against the originating terminal. | general-workspace-pane tests; file-targets-safe-area checks |
| Session logs | Pane actions open sanitized session event logs; Diagnostics provides broader connection status. | `TerminalSessionEventLog`; terminal-status tests |
| Audio and microphone | Per-pane controls, microphone consent, active-pane ownership and “Go to pane” audio notifications. | [browser voice](terminal/codex-browser-voice.md); audio/consent checks |
| Touch selection | Native selection and terminal input controls cooperate without hijacking page scrolling. | [touch selection](terminal/touch-selection.md) |
| Agent tools | Resume recent conversations, switch Coder workspaces, and expand setup/integration details when needed. | [agent tools](agent-tools.md) |
| Multiple CLIs/models | Workspace tooling supports Codex, Claude and configured open-model clients. Hive does not merge their conversation state. | [workspace agents](workspace-agents.md) |
| Agent notifications | Questions, approvals, completion and failure alerts; click focuses an existing window across all boards, or opens the missing target on a new/unused board. | notification-window tests; push tests |
| Notification preferences | Settings, push subscriptions, foreground audio, background OS alerts and notification history. | [notifications](agent-notifications.md) |

## Administration and boundaries

- Coder workspace launch, start, stop, delete, health and template management remain in the management
  and Templates windows. Those operations affect Coder environments; closing a Hive board does not.
- Template capabilities determine which apps/tools are offered. Software, browser, infrastructure,
  game and electronics profiles remain distinct. See [template profiles](workspace-template-profiles.md).
- Disposable helper lifecycle, idle stop and completed-task cleanup follow the documented template
  contract; persistent workspaces remain persistent.
- Authentication, per-user Coder authorization, app origin isolation, terminal proofs and API access
  remain enforced. Layout operations are local UI changes and do not relax these boundaries.
- Settings, Diagnostics, app-update handling, installation/PWA behavior and notification history
  are available in canvas windows through search. Settings also contains account sign-out and Open Coder. See [deployment](deployment.md).

## Migration audit

| Previous behavior | Disposition |
| --- | --- |
| Drag landing border and neighboring-pane movement | Restored in the general canvas. |
| Pane focus and movement shortcuts | Restored through the central layout action definitions. |
| Numbered board navigation and creation/closing | Restored; browser-safe alternatives documented. |
| Key repeat suppression | Fixed: the registration hook now preserves `allowRepeat`. |
| Sidebar and its shortcuts | Removed. Cmd/Ctrl+K provides navigation and launches windows. |
| Pane session logs / Desktop action | Available from the general terminal pane. |
| Notifications and audio “Go to pane” | Migrated to existing-window focus or new-board creation. |
| Per-workspace terminal pages and clients | Removed, including old tab manager, multi-session renderer, navigation hooks and unused layout engines. |
| Repository/session sidebar sections, second search and all-workspaces page | Intentionally retired; use the grouped launcher and management window. |
| Old saved local layouts | Only a bounded read-only import remains for users without a general layout. It imports safe descriptors, never old runtime code or credentials. |
| Old URLs | Redirect-only compatibility for bookmarks/delivered notifications; no legacy pages or clients remain behind them. |

Cross-origin apps own their keyboard events. Hive cannot intercept their internal keystrokes without
an app-specific integration. Focus the Hive pane header or use its controls/search; do not describe
the layout preset as an operating-system-wide shortcut manager. This remains an explicit limitation,
not an invisible or promised feature.
