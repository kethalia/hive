# Mobile Terminal Reference Decisions

**Reader:** an engineer changing Hive's mobile terminal layout, resize, or input behavior.

**Post-read action:** implement S02 keyboard-resize diagnostics and fixes without changing the terminal engine, copying upstream code, or leaking terminal/session data.

## Coder Terminal and Tmux Resize Observations

- **Source context:** D023 records that a user observed Coder's terminal working correctly in an iOS PWA and asked Hive to study that behavior before another speculative mobile terminal fix.
- **Public reference status:** a public, task-local reference for Coder's exact tmux terminal URL implementation was not available during this task. Treat the Coder evidence as an operator-observed product reference, not as an implementation recipe.
- **Useful behavior to emulate:** when the soft keyboard changes available viewport space, the terminal should refit to the visible area and the PTY/tmux side should receive an updated rows/cols size rather than leaving the prompt hidden below the keyboard.
- **Hive constraint:** do not copy Coder source or assume Coder's tmux module maps one-to-one to Hive. Use it only as a proof that a mobile web terminal can stay usable in an iOS PWA when viewport and PTY resize propagation are correct.
- **Unresolved evidence:** the exact Coder resize event path, tmux command path, and browser APIs involved remain unresolved for S02. Conservative Hive diagnostics should expose enough geometry and resize evidence to compare behavior without depending on Coder internals.

## Blink Mobile Terminal Affordances

- **Source context:** D026 considered multi-touch navigation as a candidate interaction; accessible controls must win when gestures conflict with scrollback, selection, pinch zoom, long-press menus, or OS gestures.
- **Public references:** Blink Shell's public app listing describes Smart Keys on the software keyboard for touch navigation, multiple windows/tabs, and hardware-keyboard support. A public Lifehacker overview describes Blink as gesture-heavy and notes that users may need help/configuration to discover those gestures.
- **What Hive can learn:** mobile terminal ergonomics benefit from visible modifier/navigation affordances near the keyboard, plus later gesture enhancements when they can be proven not to fight terminal scrolling or selection.
- **What Hive should not infer:** Blink is a native iOS terminal; its selection, keyboard, and gesture stack is not the same as Hive's browser/xterm stack. Native-like selection and gesture parity are proof items, not assumptions.

## Hive Decisions

- **Keep xterm and FitAddon for now.** D030 is treated as the conservative engine boundary for this slice: Hive continues using xterm/FitAddon unless S01/S02 evidence proves the engine is the root blocker.
- **Diagnose before changing layout.** S02 should first collect viewport, terminal frame, xterm rows/cols, fit timing, and resize-send evidence from Hive's own route before changing keyboard behavior.
- **Visible accessible controls are the baseline.** Navigation, favorites, terminal switching, and future smart-key actions should ship as discoverable controls before any hidden gesture becomes required.
- **Multi-touch navigation is rejected.** It was unreliable across iPhone, iPad, terminal, and embedded-tool surfaces. Workspace tabs, terminal controls, keyboard shortcuts, and one-finger sidebar gestures remain the supported navigation paths.
- **Redaction is part of the feature.** Diagnostics must never sample terminal buffer text, helper textarea values, command input, clone proof material, tokens, secrets, or local filesystem paths.
- **Conflicts become S02 questions.** If a Coder or Blink reference conflicts with keeping xterm/FitAddon, S02 should record a revisitable question and continue diagnostics rather than swapping engines in this slice.

## Non-goals

- Replacing xterm, FitAddon, tmux, the terminal proxy, or the WebSocket protocol.
- Copying Coder, Blink, or any upstream implementation code.
- Claiming real-device iOS keyboard behavior is fixed before S02 produces evidence.
- Sampling terminal contents, command text, helper textarea values, clone proofs, tokens, secrets, or local filesystem paths.
- Making hidden gestures mandatory for navigation or selection.
- Providing native-iOS selection/copy/paste parity in this slice.

## S02 Diagnostic Expectations

S02 should expose a debug-only, user-copyable diagnostics snapshot behind `debugViewport=1` that includes only non-secret geometry and state:

- layout viewport and visual viewport dimensions, scale, and offsets;
- CSS viewport custom properties used by the mobile shell;
- terminal shell, helper, and xterm element rectangles;
- active-element metadata such as tag name, role, type, and stable class hints, but not values;
- xterm rows and columns from the active terminal instance;
- last fit timestamp and last resize request timestamp;
- resize request and sent counts, including the last sent rows/cols;
- enough timestamps to compare keyboard-open, fit, and WebSocket resize propagation order.

The snapshot should remain opt-in, read-only, and safe to copy into issue comments. It must not alter auth, session selection, clone proof validation, or terminal input behavior.

## Revisitable Questions for S02

- Which exact viewport event sequence does the Coder terminal use when the iOS keyboard opens?
- Does Hive's current failure come from CSS viewport sizing, FitAddon timing, WebSocket resize propagation, tmux/PTY resize handling, or a combination?
- Are Blink-inspired smart keys enough to cover common mobile navigation before gesture work begins?
- What real-device evidence would justify revisiting the xterm/FitAddon engine decision?
