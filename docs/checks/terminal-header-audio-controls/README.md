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
requires Codex running with its default F8 voice shortcut in the target terminal.

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

## Listen here

Background sound notifications offer **Go to pane** and **Listen here**. The first
selects the speaking pane. The second plays the live remainder of its current
reply while preserving the selected pane, keyboard focus, and microphone routing.
It does not replay audio produced before the click.

The relay provides PCM without reply boundaries, so two seconds without audible
samples ends temporary listening. Later replies use normal focus-only playback.
Pausing or stopping speakers, hiding the browser, freezing the page, ending the
call, or selecting the speaking pane also clears the temporary exception.

Validated in disposable Browser Testing workspace `hive-audio-listen`, using real
Chrome audio APIs and an emulated relay. Browser assertions check both buttons,
audible output from the background pane, unchanged focus and microphone routing,
silence timeout, and silent output for the next reply.

The notice rearms when its pane is selected, so leaving a still-speaking pane can
show it again immediately. The browser fixture waits for the microphone popover
to close and returns focus to its terminal before checking background playback.
It uses the application's theme-aware toaster, including the two-row action layout.

Repository format/lint checks and typechecking passed. Full application coverage
passed with 1,996 tests across 165 files, including nine temporary-playback
regressions.

All 54 Chrome audio cases passed across desktop, tablet, and mobile; see
[results](listen-browser-results.txt). After adding immediate notice rearming,
the six navigation/listening cases passed again across all three viewports;
see [follow-up results](listen-rearm-results.txt). Screenshots below reflect
this final run. Evidence was preserved before stopping and deleting the
task's disposable browser workspace.

| Viewport | Two-action sound notification |
| --- | --- |
| Desktop | [Toast](desktop-listen-toast.png) |
| Tablet | [Toast](tablet-listen-toast.png) |
| Mobile | [Toast](mobile-listen-toast.png) |

## Additional review corrections

Connect sends Codex's F8 voice function key instead of inserting `/voice` and
Enter, preserving unsent drafts. The binding was verified against the
[Codex 0.163 source](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/tui/src/keymap.rs).
Mobile audio controls select the pane without focusing xterm's hidden input.

Failed microphone reattachment releases both the stream and any partially
connected source while retaining healthy speakers. The microphone can be
connected again after the failure. Regression tests cover source creation and
connection failures, desktop voice dispatch, and mobile focus behavior.

Repository format/lint and typechecks passed again. The 192 targeted tests passed,
followed by full application coverage: 2,000 tests across 165 files, plus the
Cloudflare, template, and runtime checks.

## Audio observer performance

The audio bridge observes direct changes on its terminal's ancestor chain,
without watching descendant trees. Output rendering, popovers, toasts, and
other-pane mutations do not refresh audio state. Moving the terminal or an
ancestor rebinds observation to the new frame or parking container. Header
replacement still relocates the controls, and active/inert changes on the
current ancestors still update routing.

The 102 focused audio, bridge, and persistent-terminal tests passed, including
unrelated DOM churn, ancestor moves, header replacement, parking, and reattachment.
