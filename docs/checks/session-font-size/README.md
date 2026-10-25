# Session font-size controls

Validation reused `creator-direction-upgrade` (Browser Testing). The fixture used
the real TerminalSessionFrame, WorkspacePaneActionSheet, font controls, scoped
font hook, styles, and fonts with two sample terminal readouts. It did not connect
to live terminal sessions or change Coder resources.

Chrome at 1440px and 390px verified:

- Font size label and compact stepper share one row; the value uses 14px text.
- Mobile increment/decrement targets are at least 44px square.
- Increasing the first session leaves the second unchanged. Opening the second
  session's menu shows its own size, and decreasing it leaves the first unchanged.
- Reload restores the independent sizes (14px and 12px).
- The legacy global preference is not written; there is no horizontal page overflow
  or browser exception.
- Desktop keyboard navigation reaches the increment button and Enter adjusts only
  the selected terminal.

The seven relevant test suites passed 248 tests in total. They cover the live
InteractiveTerminal runtime (with mocked xterm), scoped refitting and remount,
workspace/session isolation, cross-tab storage events, legacy fallback, session
switching, blocked storage, and existing pane/mobile behavior. Typecheck and
Biome also passed.

Screenshots and measurements are preserved here. The browser and fixture server
closed after the check; the reused workspace remains running for its other task.
