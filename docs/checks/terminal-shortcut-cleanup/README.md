# Terminal controls and keyboard shortcut cleanup

Validated in Chrome on 2026-10-16 in the disposable `hive-shortcut-validation`
workspace (`browser-testing`). Implementation and this evidence are preserved in
the primary software workspace. The disposable browser workspace was stopped and
deleted after validation.

The browser fixture bundled the production workspace, terminal, dashboard keyboard
controller, help dialog, notification listener, and toast components. Server
actions, terminal tickets, upload storage, and terminal output used local fixtures.
The terminal fixture enabled bracketed paste and recorded terminal input to verify
that multiline paste adds no submission key.

`results.json` records these checks:

- The desktop dialog includes dashboard actions, native paste and Shift+Paste,
  numbered workspace shortcuts, all board-switching arrow alternatives, terminal
  creation, and tmux menu access. Browser fallback chords remain visible.
- The dialog opens at the top and fits a 390px viewport without horizontal overflow.
  Mac user-agent coverage verifies Command/Option formatting and alternatives.
- The former compose shortcut and mobile control are absent. Multiline text and
  uploaded file paths paste directly into the terminal without an appended Enter.
- File hover/drop feedback, workspace creation/removal fallback shortcuts, and
  notification session switching still work. No browser page errors occurred.

Screenshots show desktop and mobile help, Mac shortcut formatting, and the mobile
terminal after removing compose. Keyboard alternatives below the visible portion
of the list remain reachable by scrolling.

Unit coverage verifies live shortcut registry snapshots and subscriptions,
registration/removal updates in an open help dialog, platform alternatives, native
paste passthrough, clipboard/file uploads, workspace switching, and mobile layouts.
The desktop board integration checks explicitly use a desktop viewport to avoid
reading terminal nodes replaced by the mobile layout after hydration.

Validation: 1,957 Vitest tests across 163 files, focused help/provider tests,
`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm build` (including
standalone runtime verification) passed. The production build retains the existing
broad file-tracing warning in template tools.

These are fixture-level browser checks. Native macOS keyboard delivery, physical
mobile keyboards, and production terminal infrastructure were not exercised.
