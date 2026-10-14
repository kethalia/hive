# PR 314 selection hover review

Thread `PRRT_kwDORpHjSM6sRdRd` reports link menus opening when a held touch
selection pauses over a URL or path. Returning from the capture listener leaves
the generated mousemove available to xterm's linkifier and bubbling listeners.

Link hover callbacks and pending-path feedback now ignore marked selection
moves. Those events still propagate to xterm and the remote application's mouse
protocol. Ordinary desktop hover and short-touch link probes retain their behavior.

Five unit regressions cover plain paths, web URLs, OSC URLs, OSC file links, and
deferred path validation, including continued mousemove delivery. The real
tmux/Chrome checks pause for 650 ms before releasing over a URL or delayed path,
check that no menu opens, and verify the copied text. The URL regression fails
against `2ba839d` with a visible link menu; `baseline-validation.txt` records that
expected failure. The serial suite skips the following path case after that
failure. Both focused cases pass with the fix.

Validation: 291 targeted unit/integration tests, 54 real tmux/Chrome cases across
desktop/tablet/phone settings, and 19 existing mobile link/path regressions.
TypeScript, Biome, and diff checks pass. The fixture and physical iOS limitations
in the parent README still apply.

Browser validation used the task's new disposable `browser-testing` workspace,
recorded in `workspace.json`. Source and evidence are preserved in the primary
software workspace; its temporary CLI key was revoked before cleanup.
