# M005: Workspace Terminals

## Vision
Persistent tmux-backed interactive terminals in the Hive dashboard with workspace discovery, multi-tab support, and integrated access to external workspace tools (Filebrowser, KasmVNC, Coder dashboard).

## Slice Overview
| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | S01 | medium | — | ✅ | User opens /workspaces, sees all their Coder workspaces with live status badges, clicks into one and sees its tmux sessions listed |
| S02 | S02 | high | — | ✅ | User clicks 'new terminal' on a workspace, gets a full interactive shell — types commands, runs vim, closes the tab, reopens it, reattaches to the same tmux session with scrollback intact |
| S03 | S03 | medium | — | ✅ | User has multiple terminal tabs open simultaneously across workspaces, creates sessions auto-named from cwd, renames them, kills unused ones |
| S04 | S04 | low | — | ⬜ | Workspace detail page shows embedded Filebrowser and KasmVNC in iframe panels with popup-out buttons, plus link-out to Coder dashboard. Falls back to links if iframe blocked. |
