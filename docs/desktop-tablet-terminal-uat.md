# Desktop Tablet Terminal UAT Evidence

**Reader:** the engineer or tester validating the assembled S06 terminal and multi-session workspace flows across desktop, laptop, and tablet browser surfaces.

**Post-read action:** fill this record with redacted categorical observations, then decide which S06 claims are accepted, pending, blocked, or deferred without using automated browser emulation as a substitute for live tmux/runtime or physical/PWA evidence.

This document is the S06 evidence contract. It may start in a pre-UAT state. It must stay truthful: automated regression proof can support automated scope, desktop/laptop/tablet browser checks can support viewport and control reachability, and live tmux/runtime proof can support live runtime behavior only when a real runtime was observed. Desktop or tablet emulation must not be used to accept R024, R026, or live R028 behavior.

## Evidence status

- **Overall S06 evidence status:** `blocked - local app shell was reachable, but no signed-in app session was available for terminal or workspace route UAT`
- **Automated regression baseline status:** `passed - T04 planned workspace, layout, documentation, and integration regression command exited 0`
- **Browser viewport matrix status:** `blocked - desktop, laptop, and tablet browser navigations reached the auth gate before terminal or workspace route mount`
- **Terminal route UAT status:** `blocked - auth gate prevented terminal route control and layout observations`
- **Multi-session workspace UAT status:** `blocked - T04 desktop, laptop, and tablet workspace route attempts reached auth gate before session switching or layout controls mounted`
- **Tablet touch and gesture-cancellation status:** `blocked - auth gate prevented tablet terminal and workspace touch observations`
- **Live tmux/runtime status:** `blocked - signed-in app session was unavailable before live tmux or route WebSocket evidence could be collected`
- **Blocked operational status:** `blocked - first unavailable link was signed-in app session; workspace runtime and live tmux were not reached`
- **Redaction status:** `reviewed - categorical blocked evidence only; no sensitive runtime material recorded`

## Scope and requirements

S06 validates assembled terminal flows across the terminal route and the multi-session workspace route. It hardens regressions discovered by integrated verification and records blockers truthfully.

Requirement coverage fields:

- **R027 viewport and layout coverage:** `blocked - desktop, laptop, and tablet route attempts reached auth gate before terminal or workspace layout could mount`
- **R028 live terminal runtime coverage:** `blocked - requires live tmux/runtime connection evidence and cannot be inferred from auth-gated browser checks`
- **R029 multi-session workspace coverage:** `blocked - T04 workspace route UAT reached auth gate before session switching or layout persistence could be observed`
- **R030 tablet touch coverage:** `blocked - tablet route attempts reached auth gate before touch or gesture-cancellation behavior could be observed`
- **R012 diagnostic and failure-surface coverage:** `partial - redacted app shell, terminal proxy health, auth gate, and blocked-runtime categories recorded`
- **R013 persistence and continuity coverage:** `blocked - route continuity and layout persistence were not reached because signed-in app session was unavailable`
- **R024 mobile keyboard evidence:** `deferred - remains out of S06 acceptance unless true physical browser or installed-PWA evidence is later attached`
- **R026 physical/PWA terminal behavior evidence:** `deferred - remains out of S06 acceptance unless true physical browser or installed-PWA evidence is later attached`

## Automated regression baseline

Use this section only for automated carry-forward and guard proof. Automated proof may show that existing route, component, documentation, and typecheck coverage did not regress. It must not claim live tmux behavior, terminal command behavior, physical keyboard behavior, physical touch behavior, installed-PWA behavior, credential behavior, clone proof behavior, or upstream endpoint behavior.

Required fields:

- **Automated command name:** `pnpm vitest run S06 T04 documentation, workspace component, layout library, and integration regression set`
- **Automated command exit code:** `0`
- **Automated command duration:** `3223 ms pre-edit baseline; final duration recorded in T04 task summary`
- **Automated verdict:** `passed - automated regression scope only`
- **Automated scope accepted:** `automated documentation guard, workspace component behavior, metadata-only layout persistence, and integration regression scope only; never live runtime or physical/PWA scope`
- **Automated limitations:** `desktop and tablet emulation cannot accept R024, R026, or live R028 behavior`

## Browser viewport matrix

Record one row for each viewport class. Use placeholder route shapes only. Do not record real workspace identifiers, session names, storage values, terminal text, endpoint values, local locations, or runtime IDs.

### Desktop viewport row

- **Viewport class:** `desktop`
- **Viewport size:** `desktop 1440 by 900 category`
- **Device scale factor:** `default browser scale category`
- **Browser mode:** `Chromium browser automation category`
- **Route shape checked:** `/workspaces/<workspace-id>/terminal`
- **Workspace route shape checked:** `/workspaces/<workspace-id>/terminal/workspace`
- **Terminal route status:** `blocked - auth gate reached before terminal shell mounted`
- **Multi-session workspace status:** `blocked - auth gate reached before workspace shell mounted`
- **Controls checked:** `blocked - auth form controls visible; terminal and workspace controls not mounted`
- **Acceptance status:** `blocked - signed-in app session required before desktop route acceptance`

### Laptop viewport row

- **Viewport class:** `laptop`
- **Viewport size:** `laptop 1280 by 800 category`
- **Device scale factor:** `default browser scale category`
- **Browser mode:** `Chromium browser automation category`
- **Route shape checked:** `/workspaces/<workspace-id>/terminal`
- **Workspace route shape checked:** `/workspaces/<workspace-id>/terminal/workspace`
- **Terminal route status:** `blocked - auth gate reached before terminal shell mounted`
- **Multi-session workspace status:** `blocked - auth gate reached before workspace shell mounted`
- **Controls checked:** `blocked - auth form controls visible; terminal and workspace controls not mounted`
- **Acceptance status:** `blocked - signed-in app session required before laptop route acceptance`

### Tablet viewport row

- **Viewport class:** `tablet`
- **Viewport size:** `tablet 820 by 1180 category`
- **Device scale factor:** `default browser scale category`
- **Browser mode:** `Chromium browser automation category`
- **Route shape checked:** `/workspaces/<workspace-id>/terminal`
- **Workspace route shape checked:** `/workspaces/<workspace-id>/terminal/workspace`
- **Terminal route status:** `blocked - auth gate reached before terminal shell mounted`
- **Multi-session workspace status:** `blocked - auth gate reached before workspace shell mounted`
- **Controls checked:** `blocked - auth form controls visible; terminal and workspace controls not mounted`
- **Acceptance status:** `blocked - signed-in app session required before tablet route acceptance`

## Terminal route UAT

Use the terminal route placeholder shape `/workspaces/<workspace-id>/terminal`. Evidence may describe visible page regions, control availability, layout category, connection-state category, and pass/fail result. Evidence must not include terminal buffers, command input, command output, route identifiers shaped like real opaque values, clone material, credentials, browser storage values, local filesystem paths, or upstream endpoints.

Required fields:

- **Terminal route shape:** `/workspaces/<workspace-id>/terminal`
- **Terminal route load status:** `blocked - route attempt redirected to auth gate before terminal client mounted`
- **Terminal connection-state diagnostic:** `blocked - terminal connection state not reached`
- **Terminal control reachability:** `blocked - terminal controls not mounted`
- **Terminal layout persistence observation:** `blocked - terminal layout persistence not reached`
- **Terminal route regression result:** `blocked - requires signed-in app session to exercise route behavior`

## Multi-session workspace UAT

Use the workspace route placeholder shape `/workspaces/<workspace-id>/terminal/workspace`. Evidence may describe session-list visibility, active-session control reachability, tab or panel state, layout persistence category, and pass/fail result. Do not record session names, opaque identifiers, terminal text, command text, storage values, endpoint values, clone proof material, or local locations.

Required fields:

- **Workspace route shape:** `/workspaces/<workspace-id>/terminal/workspace`
- **Workspace route load status:** `blocked - T04 desktop, laptop, and tablet route attempts redirected to auth gate before workspace client mounted`
- **Session switching status:** `blocked - session list and switching controls not mounted`
- **Workspace control reachability:** `blocked - workspace controls not mounted; auth form controls were visible instead`
- **Workspace layout persistence observation:** `blocked - workspace layout persistence not reached; automated guard covers metadata-only persistence shape only`
- **Workspace route regression result:** `blocked - requires signed-in app session to exercise workspace behavior`

## Tablet touch and gesture-cancellation evidence

Tablet evidence must use categorical observations. It may describe whether controls remain reachable, whether touch gestures cancel safely, whether terminal scroll or drag behavior stays bounded, and whether route controls remain usable. It must not include terminal content, clipboard values, command text, storage values, endpoint values, clone proof material, or real runtime identifiers.

Required fields:

- **Tablet touch runtime:** `blocked - emulated tablet browser reached auth gate before terminal route mounted`
- **Touch target reachability:** `blocked - only auth form controls were reachable; terminal targets not mounted`
- **Gesture-cancellation status:** `blocked - terminal gesture layer not mounted`
- **Terminal scroll or drag cancellation status:** `blocked - terminal scroll and drag surfaces not mounted`
- **Route-control cancellation status:** `blocked - terminal route controls not mounted`
- **Tablet evidence limitation:** `R024 and R026 remain deferred unless true physical browser or installed-PWA evidence is later attached`

## Live tmux/runtime evidence

Live runtime evidence is required before accepting R028. A browser viewport pass is not live runtime evidence. Live runtime evidence may record only connection-state categories, attach/create categories, tmux availability category, resize propagation category, and pass/fail result. It must not expose terminal buffers, command input, command output, session names, storage values, local filesystem paths, credentials, clone proof material, or upstream HTTP, WebSocket, or SSH endpoint values.

Required fields:

- **Live tmux runtime status:** `blocked - signed-in app session unavailable before live tmux runtime evidence could be collected`
- **Terminal proxy connection status:** `blocked - local proxy health was reachable but no signed-in route WebSocket evidence was collected`
- **Session create or attach status:** `blocked - workspace runtime was not reached`
- **Resize propagation status:** `blocked - terminal pane did not mount, so live resize evidence was not collected`
- **Runtime route shape:** `/workspaces/<workspace-id>/terminal`
- **R028 live-runtime acceptance:** `blocked - requires live tmux/runtime evidence before this field can move out of blocked state`

## Blocked operational evidence

Use this section when the agent cannot reach the runtime needed for live proof. Blocked evidence is acceptable only when it states what was unavailable, which claim remains blocked, and what replacement evidence is required. Blocked evidence must not be reworded as accepted live behavior.

Required fields:

- **First blocked link:** `signed-in app session unavailable for browser route UAT`
- **Blocked proof type:** `terminal route UAT, workspace route UAT, live terminal runtime, route WebSocket connection, and physical/PWA runtime proof`
- **Unavailable runtime:** `signed-in app session, workspace runtime, live tmux, route WebSocket connection, physical browser or installed PWA as applicable`
- **Replacement evidence required:** `redacted signed-in browser route observations, live runtime observations, and for R024/R026 true physical browser or installed-PWA observations`
- **Can automated evidence substitute:** `no - automated checks can support regression scope only`

## Redaction boundary

Do not paste terminal buffers, terminal screen contents, selected text, clipboard contents, helper textarea contents, command input, command output, clone proof material, proof tokens, credential material, private keys, browser storage values, upstream HTTP endpoints, upstream WebSocket endpoints, upstream SSH endpoints, shell prompt snippets, route or session identifiers shaped like real opaque values, repository local locations, checkout-specific absolute paths, operating-system absolute paths, or implementation-specific runtime IDs into this evidence record.

Safe evidence is limited to route placeholder shapes, viewport categories, visible control labels, accessibility categories, connection-state categories, layout categories, gesture-cancellation categories, runtime availability categories, blocked-link categories, exit codes, durations, and pass/fail verdicts.

If a copied diagnostic snapshot contains prohibited material, stop the run and record a redaction blocker instead of pasting the snapshot here.

## Acceptance decision

- **Automated regression baseline acceptance:** `pending - final task verification records command result outside this blocked browser record`
- **Desktop viewport acceptance:** `blocked - signed-in route UAT required before acceptance`
- **Laptop viewport acceptance:** `blocked - signed-in route UAT required before acceptance`
- **Tablet viewport acceptance:** `blocked - signed-in route UAT required before acceptance`
- **Terminal route acceptance:** `blocked - signed-in route UAT required before acceptance`
- **Multi-session workspace acceptance:** `blocked - signed-in workspace route UAT required before acceptance`
- **R028 live-runtime acceptance:** `blocked - requires live tmux/runtime evidence before this field can move out of blocked state`
- **R024 physical/PWA acceptance:** `deferred - desktop or tablet emulation is not replacement evidence`
- **R026 physical/PWA acceptance:** `deferred - desktop or tablet emulation is not replacement evidence`
- **Overall S06 acceptance:** `blocked - browser UAT could not proceed past auth gate; live-runtime and physical/PWA acceptance remain blocked or deferred`

## Evidence attachments checklist

- [x] Automated carry-forward regression command row with exit code, duration, and verdict.
- [x] Documentation guard command row with exit code, duration, and verdict.
- [x] Desktop terminal route observation with redacted control and layout status.
- [x] Desktop multi-session workspace observation with redacted switching and layout status.
- [x] Laptop terminal route observation with redacted control and layout status.
- [x] Laptop multi-session workspace observation with redacted switching and layout status.
- [x] Tablet terminal route observation with redacted touch and gesture-cancellation status.
- [x] Tablet multi-session workspace observation with redacted touch and gesture-cancellation status.
- [x] Live tmux/runtime observation, or a blocked operational row explaining why it remains unavailable.
- [ ] Physical browser or installed-PWA attachment for R024/R026 only if that runtime was truly exercised.
- [x] Redaction review confirming no prohibited buffers, commands, clone material, credentials, storage values, endpoints, opaque identifiers, or local paths were recorded.
