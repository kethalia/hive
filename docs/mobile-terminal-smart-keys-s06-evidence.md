# S06 Mobile Terminal Smart Keys Evidence

**Reader:** the S06 engineer or tester validating Hive mobile terminal smart-key behavior.

**Post-read action:** use this record to decide whether S06 shipped visible smart keys with the expected terminal control sequences, whether focus and existing mobile controls stayed intact, and whether any real-device or installed-PWA evidence is still blocked.

This document is an evidence contract for S06. It may be committed with blocked operational evidence when no physical mobile runtime is available, but acceptance of real-device behavior requires replacing the blocked fields with redacted observations from a physical phone browser or installed PWA.

## Evidence status

- **Visible smart-key controls shipped:** `yes - mobile terminal controls include Keys, Control, Navigation, and Position smart-key pages`
- **Fixed sequence catalog shipped:** `yes - each visible smart key maps to a fixed terminal control sequence`
- **Existing window controls retained:** `yes - the Windows, Compose, and Font size pages remain present after the smart-key pages`
- **Focus-preserving handlers retained:** `yes - smart keys, page dots, and window controls prevent pointer and mouse focus transfer before click handling`
- **No modifier latch shipped:** `yes - S06 sends fixed complete sequences only; it does not introduce sticky modifier state`
- **No new smart-key gesture shipped:** `yes - no hidden gesture is required for the S06 smart-key path`
- **Real-device evidence status:** `blocked - no physical phone, mobile-browser, or installed PWA runtime was available in the agent environment`

## Shipped smart-key catalog

S06 ships visible, Blink-inspired controls as carousel pages near the mobile terminal input surface. The shipped smart-key pages are:

- **Keys:** Enter, Tab, Esc, Backspace.
- **Control:** Ctrl+C, Ctrl+D, Ctrl+L, Ctrl+R.
- **Navigation:** Up, Down, Left, Right.
- **Position:** Home, End, PgUp, PgDn.

The user-visible inspection surface is limited to labels, page labels, ARIA labels, page-dot labels, haptic callback invocation in tests, and automated pass or fail outcomes. S06 does not require terminal output, helper text, command input, clone material, browser storage, endpoint data, or local checkout information to validate the smart-key catalog.

## Exact key sequence contract

The smart-key sequence contract is fixed and byte-oriented. Escaped values below describe what is sent to the active terminal sender; they are not copied from terminal output.

| Page | Key | Sequence name | Escaped sequence |
|---|---|---|---|
| Keys | Enter | carriage return | `\r` |
| Keys | Tab | horizontal tab | `\t` |
| Keys | Esc | escape | `\x1b` |
| Keys | Backspace | delete | `\x7f` |
| Control | Ctrl+C | interrupt | `\x03` |
| Control | Ctrl+D | end of transmission | `\x04` |
| Control | Ctrl+L | form feed clear-screen | `\x0c` |
| Control | Ctrl+R | reverse search | `\x12` |
| Navigation | Up | cursor up | `\x1b[A` |
| Navigation | Down | cursor down | `\x1b[B` |
| Navigation | Left | cursor left | `\x1b[D` |
| Navigation | Right | cursor right | `\x1b[C` |
| Position | Home | cursor home | `\x1b[H` |
| Position | End | cursor end | `\x1b[F` |
| Position | PgUp | page up | `\x1b[5~` |
| Position | PgDn | page down | `\x1b[6~` |

Automated unit and component tests are the acceptance source for this table. If the shipped catalog or control component changes, this document and its guard test must be updated together.

## No modifier latch or new gesture decision

S06 follows the reference decision that visible accessible controls are the baseline and gestures are additive proof items. Smart keys are visible buttons that send complete fixed sequences through the active terminal sender; they do not introduce a modifier latch, sticky Control state, hidden chord grammar, two-finger swipe, long-press replacement, or required gesture path.

This decision keeps the shipped path discoverable, keyboard and screen-reader reachable, and testable in the existing automated environment. Gesture or native-like selection work remains future proof work and must not replace these accessible controls.

## Focus, typing, and scrollback non-regression

S06 keeps the existing mobile terminal controls seam instead of introducing an overlay that floats over scrollback. The control bar remains in the mobile terminal layout flow, close to the keyboard when the keyboard-visible state is active, and adjacent to the pre-existing Windows, Compose, and Font size pages.

Automated component proof covers that smart keys call the active terminal sender with the fixed sequence, haptic callbacks still fire for smart-key and page-dot actions, optional missing active senders do not throw, and pointer or mouse down on controls prevents focus transfer before click handling. This preserves the intended direct-typing path by avoiding button focus capture that could close the mobile keyboard.

S06 does not claim native selection, clipboard, or hardware-keyboard acceptance. It also does not claim R024 keyboard acceptance or S07 clipboard and selection acceptance.

## Device and environment

- **Physical device used:** `blocked - unavailable in this execution environment`
- **Device model:** `blocked - unavailable until a physical phone run is collected`
- **Operating system and version:** `blocked - unavailable until a physical phone run is collected`
- **Browser or installed PWA mode:** `blocked - unavailable until a physical phone browser or installed PWA run is collected`
- **Runtime used for automated evidence:** `jsdom unit, component, integration, hook, documentation, and static typecheck tests`
- **First blocked link:** `lack of physical phone, mobile-browser, or installed PWA runtime`

## Redaction boundary

Do not paste terminal buffer or screen contents, helper textarea contents, command input, clone proof material, proof tokens, credential material, private keys, browser storage values, upstream connection endpoints, shell prompt snippets, route or session identifiers shaped like real opaque values, repository local locations, checkout-specific absolute paths, or operating-system absolute paths into this evidence record.

Safe evidence is limited to visible smart-key labels, page labels, ARIA labels, page-dot labels, haptic callback counts in tests, generic blocked or available runtime fields, and pass/fail results from automated tests.

If a copied diagnostic snapshot contains prohibited material, stop the run and file a redaction bug instead of pasting the snapshot here.

## Acceptance decision

- **S06 automated smart-key acceptance:** `accepted - fixed catalog, sequence sending, focus preservation, and existing mobile control non-regression are covered by automated tests`
- **S06 real-device/PWA acceptance:** `blocked - requires a physical phone browser or installed PWA run`
- **S06 modifier latch acceptance:** `not shipped - fixed complete sequences only`
- **S06 gesture acceptance:** `not shipped - visible controls remain the accepted baseline`
- **Follow-up required:** `collect redacted real-device/PWA evidence when device access is available; keep S07 clipboard and selection acceptance separate from this S06 evidence`

## Evidence attachments checklist

- [x] Automated smart-key catalog test for page grouping and exact sequence values.
- [x] Automated mobile controls component test for visible pages, smart-key sending, haptics, optional sender absence, focus preservation, and retained S05 window controls.
- [x] Automated interactive terminal integration non-regression test.
- [x] Automated terminal keystroke exclusivity non-regression test.
- [x] Automated pinch zoom hook non-regression test.
- [x] Documentation guard test for S06 evidence sections, blocked device status, and redaction boundary.
- [x] Static typecheck.
- [ ] Physical phone browser or installed PWA capture.
