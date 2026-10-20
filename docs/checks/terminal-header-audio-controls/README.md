# Terminal header audio controls

Validated in the primary software workspace and disposable Browser Testing
workspace `hive-audio-header`. The browser workspace was created for this task;
its evidence was copied here before cleanup.

## Behavior checked

- Microphone and speaker icons render in the real draggable pane header.
- Menus connect native voice without typing a command, pause/resume independently,
  stop devices independently, and reconnect a stopped device.
- Speaker-only connections never request microphone access.
- A 500 ms mouse hold or touch hold toggles pause without opening the menu.
- Microphone and audible speaker routing follow the selected pane.
- Non-silent speaker frames in another connected pane produce a bottom-right
  navigation toast and a streaming indicator, while its audio output stays silent.
- The toast action selects the requested pane and restores audible playback.
- Permission denial, pending grants, stale frames, cross-device ownership,
  parked terminals, context recovery, and page freeze/resume retain their coverage.
- Header and action-menu removals retain board selection, tool opening, drag
  layout, and close behavior. Touch headers retain their close button.

## Checks

- `pnpm typecheck` passed.
- Biome checks passed for all changed TypeScript/TSX and JavaScript files.
- 288 targeted Vitest tests passed across browser audio, AudioWorklet,
  pane frames, multi-session workspaces, persistent terminals, interactive terminal
  integration, and board regression tests.
- 51 Playwright cases passed in desktop, tablet, and mobile Chrome using real
  browser microphone/AudioWorklet APIs, synthetic input, and an emulated relay.
  See [browser-results.txt](browser-results.txt).
- Nine dark-theme visual checks passed, including real touch holds on tablet and
  mobile. See [visual-results.txt](visual-results.txt).

Browser command:

```sh
pnpm exec playwright test e2e/terminal-audio.spec.mjs \
  --project desktop-chromium --project tablet-chromium \
  --project mobile-chromium --workers=1
```

Screenshots:

| Viewport | Device menu | Background sound toast |
| --- | --- | --- |
| Desktop | [Menu](desktop-menu.png) | [Toast](desktop-background-toast.png) |
| Tablet | [Menu](tablet-menu.png) | [Toast](tablet-background-toast.png) |
| Mobile | [Menu](mobile-menu.png) | [Toast](mobile-background-toast.png) |

These fixtures do not exercise a live Codex account or physical microphone
acoustics. Safari/iOS and production deployment were not tested. Menu connection
requires Codex running at an empty prompt in the target terminal.

## CI follow-up

Updated the microphone consent component tests to open the new header popover,
query its portal, and verify that stopping the microphone retains speakers.
Standalone terminal tests now supply the app-router mock used by the notification
navigation callback. Formatted the browser spec with the repository formatter.

Validation after these corrections:

- `pnpm format:check` and `pnpm lint` passed across the repository.
- `pnpm typecheck` and recursive package typechecks passed.
- `pnpm test:coverage` passed: 1,978 application tests across 165 files, plus the
  Cloudflare, template, and runtime checks.
- Recursive package coverage passed: 141 auth-service tests and 235
  terminal-proxy tests.

## Review follow-up

Speaker-only connections work when microphone capture APIs are unavailable.
Unplugging or revoking an active microphone releases input and reports its error
while preserving a connected speaker; if speakers were already stopped, the relay
is released. Reconnecting the microphone continues using the same speaker worklet.

Keyboard users can move the focused pane with **Ctrl/Cmd+Alt+Shift+Arrow**.
These bindings appear in shortcut help and persist the same tiled layout changes
as dragging. The header tooltip documents them. Normal text fields retain their
keyboard behavior, and the removed Move menu entries stay removed.

Regression tests cover missing microphone APIs, microphone track termination with
speakers connected or stopped, all four keyboard move directions, saved layout,
focus retention, and text-field boundaries.

After the review fixes, repository format/lint checks, typechecking, and full
application coverage passed again: 1,987 tests across 165 files.
