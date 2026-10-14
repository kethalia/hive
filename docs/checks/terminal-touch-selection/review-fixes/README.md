# PR 314 review regressions

The four review threads are addressed:

1. `PRRT_kwDORpHjSM6sPweL`: the explicit mobile native fallback retains its native
   marker and removes the normal touch-selection marker. React integration checks
   verify the flags; real Chrome checks retain native Copy text across xterm redraw.
2. `PRRT_kwDORpHjSM6sPweZ`: automatic grants require a primary-button selection
   starting within the screen grid. Scrollbar chrome and visible helper inputs
   cannot qualify, and modified drags revoke access. Chrome's transparent input
   proxy remains part of the grid for touch hit testing near the cursor.
3. `PRRT_kwDORpHjSM6sPwej`: ancestor observers cancel pending access when a pane
   becomes inert, detaches, or parks. Queued transitions are checked before a
   response is accepted, so even an inactive/active round trip in one DOM batch
   permanently revokes the old grant. Observers follow new ancestors after moves
   and disconnect on disposal; ordinary output redraws do not cancel gestures.
4. `PRRT_kwDORpHjSM6sRQWT`: the explicit native fallback keeps the browser's
   context menu while stopping xterm from cancelling it. Four component cases
   cover default/fallback modes with and without sourceCapabilities; the fallback
   also works when its React capture handler prevents touch-event tracking.

Validation: 286 targeted unit/integration tests, 51 real tmux/Chrome checks across
desktop/tablet/phone settings, and 19 existing mobile link/path regressions pass.
TypeScript, Biome lint/format, and diff checks pass. The browser fixture and physical
iOS limitations described in the parent README still apply.

The scrollbar and two delayed-response cases fail against `8de96ec` with real
successful clipboard writes; `baseline-validation.txt` records those expected
failures and their clipboard observations. The fixed version offers Copy, makes
no automatic write, and accepts a fresh explicit action. No deployed services or
Security Cloud findings were changed.

Browser validation used a newly created disposable workspace, recorded in
`workspace.json`. Source and evidence remain in the primary software checkout.
