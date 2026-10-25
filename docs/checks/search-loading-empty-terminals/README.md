# Search loading and empty terminal discovery

The search palette only exposed discovery progress through its empty-results text.
Apps and terminal-creation actions made that text invisible. Loading now has its own
status row below the input, outside desktop results and inside the mobile sticky
header. Existing results remain usable while other workspaces finish loading.

Read-only inspection of the healthy reused Browser Testing workspace
`creator-direction-upgrade` reproduced the false retry condition:

```text
tmux -L web list-sessions -F '#{session_name}:#{session_created}:#{session_windows}'
error connecting to /tmp/tmux-1000/web (No such file or directory)
exit code: 1
```

No Hive tmux server had created that socket. Session discovery now treats this
specific missing-socket diagnostic and exit code as an empty list. Permission,
connection, missing-tool, and SSH failures remain errors with retry available.

All 138 focused action, workspace-command, command-palette, and dashboard-controller
tests pass, along with typecheck and Biome. Coverage includes stdout/stderr missing
sockets, genuine failures, progress alongside partial results, and the three palette
layouts (desktop, mobile sidebar, mobile sheet).

Chromium checks at 1440px and 390px used the real workspace and palette with manually
delayed mocked Coder actions. Loading stayed visible after partial results arrived
and while scrolling. An empty helper showed no retry action; a genuine failure kept
successful results and retry, which showed progress without closing search. No
browser runtime errors occurred. The screenshots and `report.json` preserve results.

The specialist workspace was reused and remains running for another active task.
Only this validation's temporary files were removed after evidence was copied here.
