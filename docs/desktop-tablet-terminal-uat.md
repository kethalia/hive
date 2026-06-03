# Desktop Tablet Terminal UAT Evidence

**Reader:** the engineer or tester validating the assembled S06 terminal and multi-session workspace flows across desktop, laptop, and tablet browser surfaces.

**Post-read action:** fill this record with redacted categorical observations, then decide which S06 claims are accepted, pending, blocked, or deferred without using automated browser emulation as a substitute for live tmux/runtime or physical/PWA evidence.

This document is the S06 evidence contract. It may start in a pre-UAT state. It must stay truthful: automated regression proof can support automated scope, desktop/laptop/tablet browser checks can support viewport and control reachability, and live tmux/runtime proof can support live runtime behavior only when a real runtime was observed. Desktop or tablet emulation must not be used to accept R024, R026, or live R028 behavior.

## Evidence status

- **Overall S06 evidence status:** `pre-UAT - browser, live-runtime, and operational evidence still need redacted observations`
- **Automated regression baseline status:** `pending - attach only command name, exit code, duration, and pass/fail result`
- **Browser viewport matrix status:** `pending - desktop, laptop, and tablet rows are not yet accepted`
- **Terminal route UAT status:** `pending - route controls and layout observations not yet recorded`
- **Multi-session workspace UAT status:** `pending - workspace route controls and layout observations not yet recorded`
- **Tablet touch and gesture-cancellation status:** `pending - tablet browser observations not yet recorded`
- **Live tmux/runtime status:** `blocked - no live tmux or terminal-proxy runtime has been evidenced in this record`
- **Blocked operational status:** `blocked - operational runtime proof remains unavailable until a live run is attached`
- **Redaction status:** `required - all evidence must stay categorical and must not expose sensitive runtime material`

## Scope and requirements

S06 validates assembled terminal flows across the terminal route and the multi-session workspace route. It hardens regressions discovered by integrated verification and records blockers truthfully.

Requirement coverage fields:

- **R027 viewport and layout coverage:** `pending - requires desktop, laptop, and tablet viewport rows with route, layout, and control observations`
- **R028 live terminal runtime coverage:** `blocked - requires live tmux/runtime connection evidence and cannot be inferred from emulated browser checks`
- **R029 multi-session workspace coverage:** `pending - requires workspace route observations for session switching, tab/control reachability, and layout persistence`
- **R030 tablet touch coverage:** `pending - requires tablet touch and gesture-cancellation observations without terminal-content capture`
- **R012 diagnostic and failure-surface coverage:** `pending - requires redacted connection, layout, and blocked-runtime status fields`
- **R013 persistence and continuity coverage:** `pending - requires redacted layout/session-continuity observations across route changes or reloads`
- **R024 mobile keyboard evidence:** `deferred - remains out of S06 acceptance unless true physical browser or installed-PWA evidence is later attached`
- **R026 physical/PWA terminal behavior evidence:** `deferred - remains out of S06 acceptance unless true physical browser or installed-PWA evidence is later attached`

## Automated regression baseline

Use this section only for automated carry-forward and guard proof. Automated proof may show that existing route, component, documentation, and typecheck coverage did not regress. It must not claim live tmux behavior, terminal command behavior, physical keyboard behavior, physical touch behavior, installed-PWA behavior, credential behavior, clone proof behavior, or upstream endpoint behavior.

Required fields:

- **Automated command name:** `pending - record the redacted command label only`
- **Automated command exit code:** `pending`
- **Automated command duration:** `pending`
- **Automated verdict:** `pending`
- **Automated scope accepted:** `pending - automated scope only, never live runtime or physical/PWA scope`
- **Automated limitations:** `desktop and tablet emulation cannot accept R024, R026, or live R028 behavior`

## Browser viewport matrix

Record one row for each viewport class. Use placeholder route shapes only. Do not record real workspace identifiers, session names, storage values, terminal text, endpoint values, local locations, or runtime IDs.

### Desktop viewport row

- **Viewport class:** `desktop`
- **Viewport size:** `pending - record width by height category only`
- **Device scale factor:** `pending`
- **Browser mode:** `pending - browser family or installed-PWA category only`
- **Route shape checked:** `/workspaces/<workspace-id>/terminal`
- **Workspace route shape checked:** `/workspaces/<workspace-id>/terminal/workspace`
- **Terminal route status:** `pending`
- **Multi-session workspace status:** `pending`
- **Controls checked:** `pending - record categorical reachability only`
- **Acceptance status:** `pending`

### Laptop viewport row

- **Viewport class:** `laptop`
- **Viewport size:** `pending - record width by height category only`
- **Device scale factor:** `pending`
- **Browser mode:** `pending - browser family or installed-PWA category only`
- **Route shape checked:** `/workspaces/<workspace-id>/terminal`
- **Workspace route shape checked:** `/workspaces/<workspace-id>/terminal/workspace`
- **Terminal route status:** `pending`
- **Multi-session workspace status:** `pending`
- **Controls checked:** `pending - record categorical reachability only`
- **Acceptance status:** `pending`

### Tablet viewport row

- **Viewport class:** `tablet`
- **Viewport size:** `pending - record width by height category only`
- **Device scale factor:** `pending`
- **Browser mode:** `pending - browser family or installed-PWA category only`
- **Route shape checked:** `/workspaces/<workspace-id>/terminal`
- **Workspace route shape checked:** `/workspaces/<workspace-id>/terminal/workspace`
- **Terminal route status:** `pending`
- **Multi-session workspace status:** `pending`
- **Controls checked:** `pending - record categorical reachability only`
- **Acceptance status:** `pending`

## Terminal route UAT

Use the terminal route placeholder shape `/workspaces/<workspace-id>/terminal`. Evidence may describe visible page regions, control availability, layout category, connection-state category, and pass/fail result. Evidence must not include terminal buffers, command input, command output, route identifiers shaped like real opaque values, clone material, credentials, browser storage values, local filesystem paths, or upstream endpoints.

Required fields:

- **Terminal route shape:** `/workspaces/<workspace-id>/terminal`
- **Terminal route load status:** `pending`
- **Terminal connection-state diagnostic:** `pending - categorical status only`
- **Terminal control reachability:** `pending - categorical status only`
- **Terminal layout persistence observation:** `pending - categorical status only`
- **Terminal route regression result:** `pending`

## Multi-session workspace UAT

Use the workspace route placeholder shape `/workspaces/<workspace-id>/terminal/workspace`. Evidence may describe session-list visibility, active-session control reachability, tab or panel state, layout persistence category, and pass/fail result. Do not record session names, opaque identifiers, terminal text, command text, storage values, endpoint values, clone proof material, or local locations.

Required fields:

- **Workspace route shape:** `/workspaces/<workspace-id>/terminal/workspace`
- **Workspace route load status:** `pending`
- **Session switching status:** `pending - categorical status only`
- **Workspace control reachability:** `pending - categorical status only`
- **Workspace layout persistence observation:** `pending - categorical status only`
- **Workspace route regression result:** `pending`

## Tablet touch and gesture-cancellation evidence

Tablet evidence must use categorical observations. It may describe whether controls remain reachable, whether touch gestures cancel safely, whether terminal scroll or drag behavior stays bounded, and whether route controls remain usable. It must not include terminal content, clipboard values, command text, storage values, endpoint values, clone proof material, or real runtime identifiers.

Required fields:

- **Tablet touch runtime:** `pending - physical tablet browser, installed PWA, or emulated tablet category`
- **Touch target reachability:** `pending`
- **Gesture-cancellation status:** `pending`
- **Terminal scroll or drag cancellation status:** `pending`
- **Route-control cancellation status:** `pending`
- **Tablet evidence limitation:** `R024 and R026 remain deferred unless true physical browser or installed-PWA evidence is later attached`

## Live tmux/runtime evidence

Live runtime evidence is required before accepting R028. A browser viewport pass is not live runtime evidence. Live runtime evidence may record only connection-state categories, attach/create categories, tmux availability category, resize propagation category, and pass/fail result. It must not expose terminal buffers, command input, command output, session names, storage values, local filesystem paths, credentials, clone proof material, or upstream HTTP, WebSocket, or SSH endpoint values.

Required fields:

- **Live tmux runtime status:** `blocked - no live tmux runtime evidence attached`
- **Terminal proxy connection status:** `blocked - no live terminal-proxy connection evidence attached`
- **Session create or attach status:** `blocked - no redacted live session evidence attached`
- **Resize propagation status:** `blocked - no live resize evidence attached`
- **Runtime route shape:** `/workspaces/<workspace-id>/terminal`
- **R028 live-runtime acceptance:** `blocked - requires live tmux/runtime evidence before this field can move out of blocked state`

## Blocked operational evidence

Use this section when the agent cannot reach the runtime needed for live proof. Blocked evidence is acceptable only when it states what was unavailable, which claim remains blocked, and what replacement evidence is required. Blocked evidence must not be reworded as accepted live behavior.

Required fields:

- **First blocked link:** `live tmux/runtime unavailable in this evidence record`
- **Blocked proof type:** `live terminal runtime, terminal-proxy connection, and physical/PWA runtime proof`
- **Unavailable runtime:** `live tmux, live terminal proxy, physical browser or installed PWA as applicable`
- **Replacement evidence required:** `redacted live runtime observations and, for R024/R026, true physical browser or installed-PWA observations`
- **Can automated evidence substitute:** `no - automated checks can support regression scope only`

## Redaction boundary

Do not paste terminal buffers, terminal screen contents, selected text, clipboard contents, helper textarea contents, command input, command output, clone proof material, proof tokens, credential material, private keys, browser storage values, upstream HTTP endpoints, upstream WebSocket endpoints, upstream SSH endpoints, shell prompt snippets, route or session identifiers shaped like real opaque values, repository local locations, checkout-specific absolute paths, operating-system absolute paths, or implementation-specific runtime IDs into this evidence record.

Safe evidence is limited to route placeholder shapes, viewport categories, visible control labels, accessibility categories, connection-state categories, layout categories, gesture-cancellation categories, runtime availability categories, blocked-link categories, exit codes, durations, and pass/fail verdicts.

If a copied diagnostic snapshot contains prohibited material, stop the run and record a redaction blocker instead of pasting the snapshot here.

## Acceptance decision

- **Automated regression baseline acceptance:** `pending - accept only after automated evidence rows are attached`
- **Desktop viewport acceptance:** `pending - requires redacted desktop route and workspace observations`
- **Laptop viewport acceptance:** `pending - requires redacted laptop route and workspace observations`
- **Tablet viewport acceptance:** `pending - requires redacted tablet route, workspace, touch, and gesture-cancellation observations`
- **Terminal route acceptance:** `pending - requires redacted route-control, connection-state, and layout observations`
- **Multi-session workspace acceptance:** `pending - requires redacted workspace route, switching, control, and layout observations`
- **R028 live-runtime acceptance:** `blocked - requires live tmux/runtime evidence before this field can move out of blocked state`
- **R024 physical/PWA acceptance:** `deferred - desktop or tablet emulation is not replacement evidence`
- **R026 physical/PWA acceptance:** `deferred - desktop or tablet emulation is not replacement evidence`
- **Overall S06 acceptance:** `pending - browser UAT, live-runtime blockers, and redacted evidence attachments are not complete in this starter record`

## Evidence attachments checklist

- [ ] Automated carry-forward regression command row with exit code, duration, and verdict.
- [ ] Documentation guard command row with exit code, duration, and verdict.
- [ ] Desktop terminal route observation with redacted control and layout status.
- [ ] Desktop multi-session workspace observation with redacted switching and layout status.
- [ ] Laptop terminal route observation with redacted control and layout status.
- [ ] Laptop multi-session workspace observation with redacted switching and layout status.
- [ ] Tablet terminal route observation with redacted touch and gesture-cancellation status.
- [ ] Tablet multi-session workspace observation with redacted touch and gesture-cancellation status.
- [ ] Live tmux/runtime observation, or a blocked operational row explaining why it remains unavailable.
- [ ] Physical browser or installed-PWA attachment for R024/R026 only if that runtime was truly exercised.
- [ ] Redaction review confirming no prohibited buffers, commands, clone material, credentials, storage values, endpoints, opaque identifiers, or local paths were recorded.
