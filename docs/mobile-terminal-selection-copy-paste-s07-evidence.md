# S07 Mobile Terminal Selection Copy Paste Evidence

**Reader:** the S07 engineer or tester validating Hive mobile terminal selection, copy, and paste behavior.

**Post-read action:** use this record to decide whether S07 shipped discoverable Clipboard controls with a safe selection-mode fallback, whether automated evidence is accepted, and whether any physical phone browser or installed-PWA evidence is still blocked.

This document is an evidence contract for S07. It may be committed with blocked operational evidence when no physical mobile runtime is available, but acceptance of real-device behavior requires replacing the blocked fields with redacted categorical observations from a physical phone browser or installed PWA. Do not use this record to accept physical runtime behavior until that replacement evidence exists.

## Evidence status

- **Clipboard controls shipped:** `yes - mobile terminal controls include a Clipboard page with Select, Copy, and Paste actions`
- **Selection-mode fallback shipped:** `yes - mobile selection mode can be toggled when mobile terminal controls are available`
- **Copy contract shipped:** `yes - copy uses the active terminal selection and emits categorical status without exposing selected text`
- **Paste/fallback contract shipped:** `yes - paste reads from platform clipboard when available and exposes fallback guidance when clipboard APIs are blocked`
- **User-visible status shipped:** `yes - clipboard and selection outcomes are announced through an aria-live status message`
- **Payload redaction status:** `yes - automated evidence is limited to labels, categorical action outcomes, fallback reason categories, runtime availability, and pass/fail results`
- **Real-device evidence status:** `blocked - no physical phone, mobile-browser, or installed PWA runtime was available in the agent environment`

## Shipped Clipboard controls

S07 ships a visible Clipboard page in the mobile terminal controls carousel. The page contains three discoverable actions:

- **Select:** toggles terminal selection mode for mobile selection fallback.
- **Copy:** copies the active terminal selection when selection exists.
- **Paste:** sends platform clipboard text to the active terminal sender when platform access succeeds, or leaves the user in a browser/native fallback path when platform access is blocked.

The control surface is intentionally visible, button-based, and screen-reader reachable. The safe inspection surface is limited to control labels, ARIA labels, enabled or disabled reasons, aria-live status text, categorical callback status, fallback reason category, and automated pass or fail outcomes. S07 evidence does not require terminal output, selected text, helper text, command input, browser storage, endpoint data, clone material, opaque identifiers, or checkout information.

## Selection-mode behavior

Selection mode is an explicit mobile fallback for environments where native-like terminal selection or Clipboard APIs are constrained. When enabled, terminal gesture suppression is relaxed for the mobile terminal surface so browser selection can be attempted without creating a hidden required gesture. When disabled, the terminal returns to the normal mobile interaction path.

Selection mode is not accepted as physical native parity in this record. It is accepted only as an automated, discoverable fallback path with redacted status text. Physical browser and installed-PWA acceptance remains blocked until a real device run records categorical observations for selection enablement, copy outcome, paste outcome, and fallback reason category.

## Copy contract

The copy path reads the active terminal selection from the terminal object and attempts to write it through platform clipboard APIs. If platform clipboard writing is unavailable or denied, the path attempts a browser copy fallback and reports a categorical outcome. If no terminal selection exists, the path reports a pass-through outcome so terminal shortcut behavior can continue.

Safe copy evidence may state only these categories: `copied`, `failed`, `passthrough`, `clipboard-api`, `exec-command`, `clipboard-api-unavailable`, `clipboard-api-denied`, and `clipboard-api-failed`. Safe evidence must not include the selected text, terminal buffer text, helper textarea value, command input, command output, proof material, real route identifiers, browser storage values, endpoints, or local locations.

## Paste and fallback contract

The paste path reads from platform clipboard APIs when available and sends the result to the active terminal sender only inside the running application. If platform clipboard reading is unavailable, the user remains in the native browser fallback path. If platform clipboard reading fails, the path attempts the browser paste command fallback and reports whether the fallback was attempted or succeeded categorically.

Safe paste evidence may state only these categories: `pasted`, `empty`, `fallback`, `clipboard-api`, `native-browser`, `exec-command`, `clipboard-api-unavailable`, `clipboard-api-denied`, and `clipboard-api-failed`. The evidence record must never include clipboard contents, pasted text, command text, terminal text, helper textarea contents, endpoint values, storage values, credentials, opaque runtime identifiers, or filesystem locations.

## Non-regression coverage

Automated S07 coverage accepts the shipped browser-testable scope only:

- Clipboard controls are discoverable in the mobile controls carousel.
- Select, Copy, and Paste expose accessible names and aria-live status wiring.
- Copy and paste action helpers emit typed categorical status callbacks.
- Mobile selection mode is forwarded only through the mobile terminal route path.
- Desktop terminal behavior remains unchanged by the mobile selection-mode toggle.
- Existing mobile Windows, Compose, Font size, and smart-key controls remain present.
- Documentation redaction and blocked-device language are guarded by an executable documentation test.

This record does not claim physical phone selection fidelity, installed-PWA copy/paste fidelity, long-press menu behavior, operating-system permission behavior, or hardware keyboard behavior.

## Device and environment

- **Physical device used:** `blocked - unavailable in this execution environment`
- **Device model:** `blocked - unavailable until a physical phone run is collected`
- **Operating system and version:** `blocked - unavailable until a physical phone run is collected`
- **Browser or installed PWA mode:** `blocked - unavailable until a physical phone browser or installed PWA run is collected`
- **Runtime used for automated evidence:** `jsdom unit, component, integration, documentation, and static typecheck tests`
- **First blocked link:** `lack of physical phone, mobile-browser, or installed PWA runtime`

## Redaction boundary

Do not paste terminal buffer or screen contents, selected text, pasted text, helper textarea contents, command input, command output, clone proof material, proof tokens, credential material, private keys, browser storage values, upstream connection endpoints, shell prompt snippets, route or session identifiers shaped like real opaque values, repository local locations, checkout-specific absolute paths, operating-system absolute paths, or implementation-specific runtime IDs into this evidence record.

Safe evidence is limited to visible Clipboard control labels, page labels, ARIA labels, aria-live status strings, enabled or disabled state categories, fallback reason categories, runtime availability, and pass/fail results from automated tests.

If a copied diagnostic snapshot contains prohibited material, stop the run and file a redaction bug instead of pasting the snapshot here.

## Acceptance decision

- **S07 automated Clipboard controls acceptance:** `accepted - visible controls, accessibility wiring, categorical copy/paste statuses, mobile-only selection forwarding, and non-regression scope are covered by automated tests`
- **S07 copy contract acceptance:** `accepted - automated proof covers categorical copy outcomes without selected-text evidence`
- **S07 paste/fallback contract acceptance:** `accepted - automated proof covers categorical paste and fallback outcomes without clipboard-value evidence`
- **S07 real-device/PWA acceptance:** `blocked - requires a physical phone browser or installed PWA run with redacted categorical observations`
- **S07 native-like selection parity acceptance:** `blocked - requires physical mobile runtime evidence and must not be inferred from jsdom tests`
- **Follow-up required:** `collect redacted real-device/PWA evidence when device access is available; keep blocked fields blocked until that evidence replaces them`

## Evidence attachments checklist

- [x] Automated terminal action tests for copy and paste categorical status outcomes.
- [x] Automated mobile controls component coverage for Clipboard controls and aria-live status wiring.
- [x] Automated terminal route integration coverage for mobile-only selection-mode forwarding and desktop non-regression.
- [x] Documentation guard test for S07 evidence sections, blocked physical-device status, accepted automated scope, no-claim language, and redaction boundary.
- [x] Static typecheck.
- [ ] Physical phone browser or installed PWA capture.
