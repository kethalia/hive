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
