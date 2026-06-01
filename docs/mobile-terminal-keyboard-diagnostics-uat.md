# Mobile Terminal Keyboard Diagnostics UAT

**Reader:** the S02 engineer or tester collecting real-device evidence for Hive's mobile terminal keyboard behavior.

**Post-read action:** open the terminal route on a real phone, focus the terminal, open the software keyboard, copy the debug diagnostics JSON, and decide whether viewport, xterm size, fit, and WebSocket resize evidence moved in the expected order.

This runbook is an evidence-collection guide. Completing it on a real device is S02 evidence; it is not an S01 pass claim and does not prove the keyboard bug is fixed.

## What the debug overlay is allowed to contain

The `debugViewport=1` overlay is a geometry-only surface. It may show viewport sizes, visual viewport offsets, CSS viewport variables, terminal shell/helper rectangles, active-element metadata, xterm rows and columns, latest fit or resize-request timing, and WebSocket resize-sent counts.

It must not contain terminal text, helper textarea values, command input, clone proof material, tokens, secrets, or local filesystem paths. Stop and file a bug if copied JSON includes any of those values.

## Device setup

1. Use a real iPhone or Android phone. Browser device emulation is useful for layout checks, but it does not produce authoritative software-keyboard evidence.
2. Sign in to Hive and choose a workspace that has a terminal session available.
3. If possible, install or open Hive in the same mode where the keyboard issue occurs, such as iOS Safari or the installed PWA.
4. Keep a notes document ready for timestamps and the copied JSON payload.

## Open the diagnostic route

1. Open the terminal route with debug mode enabled:

   ```text
   /workspaces/<id>/terminal?session=<name>&debugViewport=1
   ```

2. Replace `<id>` with the workspace id and `<name>` with the terminal session name.
3. Confirm the amber **Mobile viewport diagnostics** overlay is visible.
4. Confirm the overlay says geometry only and that terminal text and input values are excluded.

If the overlay is not visible, confirm the URL contains `debugViewport=1` exactly. Without that query value, the overlay should stay hidden and should not sample diagnostics.

## Collect baseline evidence before opening the keyboard

1. Tap the terminal surface once so the terminal can receive focus.
2. Before opening the software keyboard, read the overlay rows:
   - **Layout** and **Visual** viewport dimensions.
   - **Keyboard inset**.
   - **Shell** and **Helper textarea** geometry.
   - **Active element**.
   - **Xterm size**.
   - **Latest resize**.
   - **WS resize sent**.
3. Tap **Copy JSON** and paste the JSON into your notes under `before keyboard`.
4. Check that the copied JSON contains geometry and resize fields only.

## Collect keyboard-open evidence

1. Tap inside the terminal until the software keyboard opens.
2. Wait at least two overlay refreshes, about two seconds total. The overlay samples once per second.
3. Copy the JSON again and paste it into your notes under `after keyboard open`.
4. Record what changed:
   - Did the visual viewport height shrink or offset change?
   - Did the keyboard inset become positive?
   - Did the terminal shell rectangle stay inside the visible viewport?
   - Did xterm rows or columns change after the viewport changed?
   - Did **Latest resize** show a fit or resize request after keyboard open?
   - Did **WS resize sent** increment and show the same rows and columns as the latest xterm size?

## Collect keyboard-close evidence

1. Dismiss the keyboard using the platform gesture or control.
2. Wait at least two overlay refreshes.
3. Copy the JSON again and paste it into your notes under `after keyboard close`.
4. Record whether viewport dimensions, xterm rows/cols, latest resize timing, and WebSocket resize-sent count moved back toward the baseline values.

## How to interpret the evidence

Use the copied JSON to identify where the resize chain breaks:

- **Viewport changed, xterm size did not:** investigate FitAddon timing, terminal container measurement, or layout signal propagation.
- **Xterm size changed, resize request did not:** investigate the terminal resize event handler.
- **Resize request changed, WebSocket resize sent did not:** investigate the terminal WebSocket resize-send path.
- **WebSocket resize sent changed, prompt still hidden:** investigate tmux/PTY resize handling or terminal scroll anchoring.
- **No viewport change on keyboard open:** investigate browser/PWA viewport APIs and CSS viewport variables for that device mode.

A useful S02 report includes the three JSON payloads, device model, OS version, browser or PWA mode, orientation, route used, and a short note about whether the prompt remained visible while typing.

## Failure handling

- If **Copy JSON** fails, keep the visible `Copy failed` status in the screenshot or notes and manually transcribe the rows shown in the overlay.
- If a row shows `missing`, keep it in the evidence. Missing xterm or resize evidence is a diagnostic result, not a reason to discard the run.
- If debug mode is disabled, do not treat missing overlay data as a failure. Reopen the route with `debugViewport=1` and retry.
