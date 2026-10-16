# Terminal feedback, workspace shortcuts, and loading

Validated in Chrome on 2026-10-16 using the disposable `hive-terminal-browser`
workspace (`browser-testing`). The primary software workspace owns implementation.
The disposable workspace was stopped and deleted after preserving this evidence.

The temporary browser fixture bundled the production workspace, terminal,
keybinding, notification listener, and toast components. Server actions, terminal
tickets, upload storage, and terminal output used local fixtures. No production
credentials or push delivery were needed.

Checks in `results.json` cover file hover/drop feedback, upload toast placement,
numbered workspace creation/removal, notification focus without terminal teardown
or another session-discovery request, and a 390px mobile viewport without
horizontal overflow. The two terminal WebSockets stay connected while switching
focus; the total socket count also includes terminal audio. Screenshots record
the desktop drop target, bottom-right upload toast, notification focus, and mobile
drop target.

Unit regressions additionally cover fresh session-bound proofs for several Git
panes from one scan, authorization failures, saved notification destinations,
client navigation acknowledgement and full-navigation fallback, repeated
notification focus, shortcut modifiers, and preservation of terminal sessions
when closing a numbered workspace.

Ctrl/Cmd+T and Ctrl/Cmd+W work when the host delivers those keys to the app.
Browsers may reserve them; Ctrl/Cmd+Alt+T and Ctrl/Cmd+Alt+W are the browser
fallbacks. Native macOS and physical-device keyboard behavior was not tested.

These checks verify avoided work and retained connections, not production
end-to-end latency. Live connection time still depends on the network, Coder
agent, and SSH/terminal proxy startup.

Validation: 1,973 Vitest tests across 167 files, `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, and `pnpm build` (including standalone runtime verification)
passed. The build retains existing broad file-tracing warnings in template tools.
