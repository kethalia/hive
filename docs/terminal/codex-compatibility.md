# Codex terminal compatibility

Hive uses Codex's native fullscreen UI, input handling, question dialogs, and
keymap. It does not select a Codex TUI mode or change user configuration.

## Paste

Text (including multiple lines and multiple uploaded file paths) goes directly
through xterm's paste API. Hive no longer automatically opens Compose, and paste
never appends Enter. Codex enables bracketed paste, so newline characters remain
part of the draft. Escape characters are removed from pasted text so they cannot
terminate a bracketed paste early. Compose remains available as an explicit tool.

## Links and copy

The maintained xterm web-links add-on recognizes plain HTTP(S) URLs; xterm's OSC 8
handler handles named hyperlinks. Clicking a detected link opens it in the local
browser, without forwarding the click to the remote application's browser launcher.
Shift-drag remains available for terminal selection. Touch taps use the same link
providers; touch scrolling and selection mode do not open links.

The xterm clipboard add-on handles OSC 52 from Codex and tmux. Clipboard reads
return empty data, never local clipboard contents. Nonempty writes up to 1 MiB go
to the browser clipboard. If the browser requires a fresh gesture, a Copy action
lets the user complete the write. Native mobile browser selections inside the
active terminal are also recognized by Hive's Copy button. Failed copies retain
selection for retry.

On each new PTY attachment, the dedicated `web` tmux server enables application
clipboard writes and negotiated extended keys. The client advertises clipboard,
hyperlinks, RGB, and extended-key support. Existing sessions benefit on a fresh
attachment; no workspace image rebuild or tmux server restart is needed. Browser
refresh alone may resume an existing Coder PTY; open a new terminal connection if
the original attachment predates this change.

## Touch controls

- Codex: Queue (Tab), Steer/send (Enter), Transcript (Ctrl+T), Copy reply (Ctrl+O).
- Questions: option up/down, Space to toggle, Enter to confirm, Tab/Shift+Tab and
  left/right navigation. Free text still uses the device keyboard.
- All keys: an expandable keyboard for letters, digits, punctuation, Enter,
  Escape, Tab, navigation, editing, and F1–F12, with Ctrl/Alt/Shift combinations.
  Modifiers reset after each key. This supports custom bindings as well as default
  bindings without maintaining a competing copy of Codex's complete keymap.
  Ctrl+V uses Hive's existing clipboard/file paste path, and Ctrl+C copies a local
  selection when one exists. Otherwise shortcuts go directly to the active pane.
- Existing terminal quick keys, clipboard tools, Compose, and font controls remain.

Use Codex's `/keymap` to inspect the active bindings. For example, Ctrl+J enters a
newline, Ctrl+G opens the external prompt editor, and Shift+Tab can be sent from All
keys. F12 retains Hive's existing tmux menu binding. Modified key encodings still
require support from the active terminal application.

## Evidence

Baseline: `b9236e2`, Codex installed version `0.158.0`, tmux `3.5a`.
The official changelog retrieved during this work documented fullscreen-by-default
in 0.157.0 and stopped at 0.157.1; no claim is made about unpublished 0.158 changes.

- `pnpm exec vitest run`: 134 files, 1,308 tests passed.
- `pnpm --filter hive-terminal test`: 9 files, 173 tests passed.
- `pnpm exec tsc --noEmit`: passed.
- `pnpm check`: passed.
- `pnpm build`: passed, including standalone runtime verification.
- Isolated real tmux PTY probe: OSC 52 forwarded; complete bracketed multiline
  paste preserved; modified Enter forwarded as an extended key.

Sources:
- [Codex changelog](https://learn.chatgpt.com/docs/changelog)
- [CLI commands and shortcuts](https://learn.chatgpt.com/docs/developer-commands)
- [Codex keymap configuration](https://learn.chatgpt.com/docs/config-file/config-sample)
- [tmux clipboard protocol](https://github.com/tmux/tmux/wiki/Clipboard)

## Browser validation handoff

Workspace handoff required
- Target template: `browser-testing`
- Reason: Chrome, Playwright, and visual desktop/mobile validation belong to that profile.
- Repository/path: `kethalia/hive`, branch `fix/terminal-codex-compatibility`, based on
  `b9236e2`, primary checkout `/home/coder/projects/kethalia/hive` in `ai-dev-01`.
- Current state: implementation and automated checks completed in the primary
  checkout; browser/device checks below are pending. No production deployment.
- Next action: open this branch's terminal preview in Browser Testing, reconnect
  the PTY, launch Codex, and run the checklist. Keep corrections in Hive's live TUI.

- [ ] Paste a multiline prompt with a trailing newline: no Compose, no turn until Enter.
- [ ] Paste from Ctrl+V, Ctrl+Shift+V, native context menu, and touch Paste; each occurs once.
- [ ] Paste images and multiple files into Codex.
- [ ] Click a plain URL and an OSC 8 named link: local tab, no remote browser error.
- [ ] Tap links on touch; drag to scroll/select without opening a link.
- [ ] Copy Codex's fullscreen selection and use Ctrl+O / Copy reply.
- [ ] Copy a Hive Shift-drag selection and a mobile native selection.
- [ ] Deny clipboard write permission and retry using the local Copy action.
- [ ] Answer single-choice, multi-choice, and free-text questions using touch controls.
- [ ] Exercise Ctrl+J, Ctrl+G, Shift+Tab, Enter, Tab, and custom keymap bindings.
- [ ] Switch active panes and verify shortcuts, copy, and paste target the selected pane.
- [ ] Test physical iOS/iPadOS and Android keyboards and clipboard permissions.
