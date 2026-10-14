# Mobile tmux selection validation

Implementation remains in the primary software checkout. Browser checks ran in
the disposable Browser Testing workspace recorded in `workspace.json`; evidence
was copied here before cleanup. Its newly issued owner CLI key was revoked after
checking ownership, creation time, and distinction from the primary credential.

- 262 targeted Vitest tests pass across the gesture, clipboard, terminal
  component, existing selection/paste, and sidebar boundaries.
- 30 Chrome cases pass: ten each with desktop, tablet, and phone device settings.
  The fixture uses the production browser integration and touch selection code,
  real xterm, real isolated tmux servers, PTYs, WebSockets, and the OS clipboard.
- Another 19 mobile Chrome path-validation and workspace-link regressions pass.
- TypeScript, Biome lint/format, and diff checks pass.

CDP supplies trusted held touch gestures. Tests observe tmux's active selection,
then compare successful browser clipboard writes with tmux's actual copy buffer.
Cases cover single-line/multiline selection, desktop drag copying, cancelled
touches, pane isolation, held drags over URLs, browser-denied writes with a working
Copy fallback, short swipes/stationary holds, and an already focused input.
The screenshots show tmux highlights while the native DOM selection is collapsed.
An unsolicited OSC 52 request produces no successful write until Copy is clicked.

The clipboard wrapper records text only after the real browser write succeeds;
the API is not mocked except in the explicit denial case. The denial test keeps
the real writeText API for its Copy action. Each tmux server uses its own temporary
socket and `/dev/null` configuration, so no user tmux state or plugins are loaded.

The browser fixture isolates the selection/clipboard boundary; it does not run
the deployed Hive authentication or terminal proxy. The React integration test
checks the production component's gesture wiring, focus, and scroll arbitration.
Physical iOS Safari and mobile soft-keyboard behavior remain unverified. WebKit
download succeeded in Browser Testing, but launch prerequisites are missing and
the workspace disallows privilege elevation. No privileged host changes were made.

Automatic copying grants intent for one workspace-supplied response after release.
It does not authenticate that response's contents. No Security Cloud finding was
closed. Deploy the web client and refresh terminal views before live verification.
