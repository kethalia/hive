# S05 Mobile Terminal Window Navigation Evidence

**Reader:** the S05 engineer or tester validating Hive mobile terminal-window navigation.

**Post-read action:** use this record to decide whether S05 shipped explicit accessible terminal-window controls, whether a two-finger swipe gesture is justified, and whether any real-device or installed-PWA evidence is still blocked.

This document is an evidence contract for S05. It may be committed with blocked operational evidence when no physical mobile runtime is available, but acceptance of real-device behavior requires replacing the blocked fields with redacted observations from a physical phone browser or installed PWA.

## Evidence status

- **Explicit controls shipped:** `yes - mobile terminal controls include a Windows page with Previous, Windows, Next, and Reload or Retry actions`
- **Route-authoritative switching shipped:** `yes - mobile controls and the route-level picker call the terminal route session-selection path`
- **One mounted terminal retained:** `yes - route integration tests assert one InteractiveTerminal instance for the selected route session`
- **Two-finger swipe status:** `deferred - no new two-finger swipe or hidden window-switch gesture shipped in S05`
- **Real-device evidence status:** `blocked - no physical phone browser or installed PWA runtime was available in the agent environment`

## Shipped accessible controls

The shipped mobile affordance is explicit control navigation, not a hidden gesture. The mobile terminal controls expose a Windows page with:

- **Previous:** switches to the previous generic terminal session when one exists.
- **Windows:** opens the existing Command Palette as a session picker.
- **Next:** switches to the next generic terminal session when one exists.
- **Reload or Retry:** refreshes the session list or retries after a list error.

The user-visible state may include generic session display names already visible in the route or sidebar, generic session counts, loading state, error state, disabled reasons, debug flag status, and device/runtime availability.

## Route switching evidence

- **Route shape used:** `/workspaces/<workspace-id>/terminal?session=<session-name>&debugViewport=1`
- **Selection encoding:** `verified by automated route tests for names with spaces and slash characters`
- **debugViewport=1 preservation:** `verified by automated route tests during previous, next, and picker selection`
- **Clone parameter stripping on generic selection:** `verified by automated route tests that switch from an active clone URL to a generic session URL without clone parameters`
- **Current session missing from fetched list:** `handled as disabled relative navigation while the picker can show the fetched generic sessions or an empty state`
- **Session-list server error:** `the current terminal route remains mounted and controls expose an error/retry state`

## Two-finger swipe comparison

S05 compared explicit controls against a two-finger swipe candidate and chose explicit controls for shipment.

- **Explicit controls:** shipped because they are discoverable, keyboard/screen-reader reachable, testable in jsdom, and do not compete with terminal scrollback, selection, pinch zoom, long-press menus, or operating-system gestures.
- **Two-finger swipe:** deferred because no conflict-proof evidence exists for Hive's browser/xterm gesture stack. It must remain an additive future experiment, not a required path for window switching.
- **No new gesture introduced:** S05 does not add a two-finger swipe, does not alter pinch zoom, and does not change long-press or scrollback handlers.

## Device and environment

- **Physical device used:** `blocked - unavailable in this execution environment`
- **Device model:** `blocked - unavailable until a physical phone run is collected`
- **Operating system and version:** `blocked - unavailable until a physical phone run is collected`
- **Browser or installed PWA mode:** `blocked - unavailable until a physical phone browser or installed PWA run is collected`
- **Runtime used for automated evidence:** `jsdom route and documentation tests`
- **debugViewport flag observed:** `automated tests preserve debugViewport=1 in generated route URLs`

## Redaction boundary

Do not paste terminal buffer or screen contents, helper textarea contents, command input, clone proof material, credential material, repository local locations, checkout-specific absolute paths, browser storage values, or upstream connection endpoints into this evidence record.

Safe evidence is limited to generic session display names already exposed in route/sidebar UI, generic session counts, disabled reasons, viewport or debug flag status, device/runtime availability, and pass/fail results from automated tests.

If a copied diagnostic snapshot contains prohibited material, stop the run and file a redaction bug instead of pasting the snapshot here.

## Acceptance decision

- **S05 explicit mobile window controls accepted:** `yes - automated integration tests cover controls and picker routing`
- **S05 two-finger swipe accepted:** `no - deferred until conflict proof exists`
- **S05 real-device/PWA acceptance:** `blocked - requires a physical phone browser or installed PWA run`
- **Follow-up required:** `collect redacted real-device/PWA evidence when device access is available; revisit two-finger swipe only with concrete conflict testing`

## Evidence attachments checklist

- [x] Automated route integration test for mobile controls receiving navigation state.
- [x] Automated route integration test for previous and next switching with encoded route URLs.
- [x] Automated route integration test for Command Palette picker selection without route-level session creation.
- [x] Automated route integration test for clone parameter stripping and debug flag preservation.
- [x] Automated route integration test for desktop one-terminal behavior remaining unchanged.
- [x] Documentation guard test for S05 evidence sections and redaction boundary.
- [ ] Physical phone browser or installed PWA capture.
