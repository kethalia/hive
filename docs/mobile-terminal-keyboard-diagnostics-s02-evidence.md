# S02 Mobile Terminal Keyboard Evidence

**Reader:** the S02 engineer or tester collecting real-device acceptance evidence for Hive's mobile terminal keyboard refit behavior.

**Post-read action:** fill this record after running the [Mobile Terminal Keyboard Diagnostics UAT](./mobile-terminal-keyboard-diagnostics-uat.md) on a real mobile browser or installed PWA, then decide whether the viewport, xterm/FitAddon, terminal proxy resize, and tmux dimension evidence satisfy S02.

This document is a fillable evidence contract. It may be committed with blocked values while operational evidence is still unavailable, but an accepted S02 run must replace blocked values with redacted real-device observations.

## Evidence status

- **Run status:** `BLOCKED`
- **Tester:** `GSD auto-mode agent`
- **Run date and timezone:** `2026-06-01 UTC`
- **Related UAT run:** `not run in T65 - no physical mobile device, installed PWA, or real mobile browser runtime was available to this execution session`
- **Overall result:** `R024 is not validated by this T65 run; real-device keyboard and tmux proof remains blocked until a physical iOS PWA or real mobile browser run is collected`

## Blocker note

This T65 execution session had no attached physical iOS or Android device tooling, no simulator bridge, and no browser environment suitable for authoritative software-keyboard evidence. Browser emulation, jsdom, automated unit tests, source inspection, desktop simulation, autonomous-environment capability checks, and fabricated values are intentionally not accepted substitutes for this task, so the required viewport, xterm/FitAddon, resize-sent, terminal-proxy, and tmux numeric observations were not collected. The first blocked link is the real mobile visualViewport/software-keyboard capture precondition; without it, the viewport to FitAddon to WebSocket to proxy to tmux chain could not be exercised.

## Closeout retry note

The T65 S02 evidence collection retry on 2026-06-01 confirmed this artifact exists and remains the authoritative blocked-evidence record for the unavailable physical mobile keyboard run. Automated diagnostics and redaction guardrails can be verified from this record, but S02 operational acceptance still requires replacing the blocked fields with redacted observations from a physical iOS installed PWA or real mobile browser run.

## Redaction boundary

Only record geometry, dimensions, timing, counters, and boolean visibility results from the debug overlay. Do not paste shell screen contents, command input, hidden input contents, repository validation material, credential material, browser storage values, upstream connection endpoints, machine-specific locations, or checkout-specific absolute locations. If a copied diagnostic snapshot contains any of those values, stop the run and file a diagnostics redaction bug instead of pasting the snapshot here.

When recording the route, use only the route and query shape. Replace workspace identifiers and session names with placeholders.

```text
/workspaces/<workspace-id>/terminal?session=<session-name>&debugViewport=1
```

## Device and environment

- **Device model:** `not available in this execution session`
- **Physical device used:** `no`
- **Operating system and version:** `not observed - blocked before real-device run`
- **Browser or installed PWA mode:** `not observed - blocked before real-device run`
- **Browser version, if visible:** `not observed - blocked before real-device run`
- **Orientation:** `not observed - blocked before real-device run`
- **Viewport mode notes:** `No authoritative mobile visualViewport or software-keyboard behavior was observed in this T65 session.`
- **Route/query shape used:** `/workspaces/<workspace-id>/terminal?session=<session-name>&debugViewport=1`

## Required acceptance observations

- **Terminal bottom visible before keyboard opens:** `not observed - blocked before real-device capture`
- **Terminal bottom remains visible while keyboard is open:** `not observed - blocked before real-device capture`
- **Terminal bottom visible after keyboard closes:** `not observed - blocked before real-device capture`
- **Keyboard inset becomes positive or visual viewport shrinks while keyboard is open:** `not observed - blocked before real-device capture`
- **xterm rows/cols change or are confirmed appropriate for the keyboard-open viewport:** `not observed - blocked before real-device capture`
- **Resize-sent rows/cols are observed after the keyboard-open refit:** `not observed - blocked before real-device capture`
- **tmux numeric dimensions match the propagated resize closely enough to accept:** `not observed - blocked before real-device capture`

## Snapshot A: keyboard closed before focus

Record the copied debug overlay JSON as a redacted attachment or issue comment, then summarize the fields below.

- **Sample timestamp:** `not observed - blocked before real-device capture`
- **Layout viewport width x height:** `not observed - blocked before real-device capture`
- **Visual viewport width x height:** `not observed - blocked before real-device capture`
- **Visual viewport offset top/page top:** `not observed - blocked before real-device capture`
- **Keyboard inset bottom:** `not observed - blocked before real-device capture`
- **Terminal shell rect bottom and visible-viewport bottom:** `not observed - blocked before real-device capture`
- **Helper rectangle present:** `not observed - blocked before real-device capture`
- **Active element tag/role/type only:** `not observed - blocked before real-device capture`
- **xterm rows x cols:** `not observed - blocked before real-device capture`
- **Latest fit rows x cols and count:** `not observed - blocked before real-device capture`
- **Latest resize-request rows x cols and count:** `not observed - blocked before real-device capture`
- **Latest resize-sent rows x cols and count:** `not observed - blocked before real-device capture`
- **Terminal-bottom visibility result:** `not observed - blocked before real-device capture`

## Snapshot B: keyboard open

Wait for at least two overlay refreshes after the software keyboard opens before recording this snapshot.

- **Sample timestamp:** `not observed - blocked before real-device capture`
- **Layout viewport width x height:** `not observed - blocked before real-device capture`
- **Visual viewport width x height:** `not observed - blocked before real-device capture`
- **Visual viewport offset top/page top:** `not observed - blocked before real-device capture`
- **Keyboard inset bottom:** `not observed - blocked before real-device capture`
- **Terminal shell rect bottom and visible-viewport bottom:** `not observed - blocked before real-device capture`
- **Helper rectangle present:** `not observed - blocked before real-device capture`
- **Active element tag/role/type only:** `not observed - blocked before real-device capture`
- **xterm rows x cols:** `not observed - blocked before real-device capture`
- **Latest fit rows x cols and count:** `not observed - blocked before real-device capture`
- **Latest resize-request rows x cols and count:** `not observed - blocked before real-device capture`
- **Latest resize-sent rows x cols and count:** `not observed - blocked before real-device capture`
- **Terminal-bottom visibility result:** `not observed - blocked before real-device capture`
- **Rows/cols propagated to terminal proxy:** `not observed - blocked before real-device capture`

## Snapshot C: keyboard closed after dismissal

Wait for at least two overlay refreshes after the software keyboard closes before recording this snapshot.

- **Sample timestamp:** `not observed - blocked before real-device capture`
- **Layout viewport width x height:** `not observed - blocked before real-device capture`
- **Visual viewport width x height:** `not observed - blocked before real-device capture`
- **Visual viewport offset top/page top:** `not observed - blocked before real-device capture`
- **Keyboard inset bottom:** `not observed - blocked before real-device capture`
- **Terminal shell rect bottom and visible-viewport bottom:** `not observed - blocked before real-device capture`
- **Helper rectangle present:** `not observed - blocked before real-device capture`
- **Active element tag/role/type only:** `not observed - blocked before real-device capture`
- **xterm rows x cols:** `not observed - blocked before real-device capture`
- **Latest fit rows x cols and count:** `not observed - blocked before real-device capture`
- **Latest resize-request rows x cols and count:** `not observed - blocked before real-device capture`
- **Latest resize-sent rows x cols and count:** `not observed - blocked before real-device capture`
- **Terminal-bottom visibility result:** `not observed - blocked before real-device capture`

## tmux dimension observation

Use a safe dimension-only observation from the terminal multiplexer or PTY side. Record only numbers and the observation method; do not include shell output beyond dimensions.

- **Observation method:** `not observed - blocked before real-device capture`
- **Rows observed:** `not observed - blocked before real-device capture`
- **Columns observed:** `not observed - blocked before real-device capture`
- **Observed after snapshot:** `not observed - blocked before real-device capture`
- **Matches latest resize-sent rows/cols:** `not observed - blocked before real-device capture`
- **Mismatch notes:** `not observed - blocked before real-device capture`

## Acceptance decision

- **Viewport refit accepted:** `no - no real-device viewport evidence was collected`
- **xterm/FitAddon refit accepted:** `no - no real-device xterm/FitAddon evidence was collected`
- **Terminal proxy resize propagation accepted:** `no - no real-device resize-sent evidence was collected`
- **tmux resize observation accepted:** `no - no real-device tmux dimension evidence was collected`
- **S02 real-device evidence accepted:** `no - blocked until a physical iOS PWA or real mobile browser run is collected`

## Failure notes

If the run fails, identify the first observed break in the chain.

- **Viewport changed but xterm rows/cols did not:** `not observed - blocked before real-device capture`
- **xterm rows/cols changed but resize-request did not:** `not observed - blocked before real-device capture`
- **resize-request changed but resize-sent did not:** `not observed - blocked before real-device capture`
- **resize-sent changed but tmux dimensions did not:** `not observed - blocked before real-device capture`
- **All dimensions changed but terminal bottom was clipped:** `not observed - blocked before real-device capture`
- **Notes:** `Blocked before the diagnostic chain could be exercised because no accepted physical mobile device, installed PWA, or real mobile browser runtime was available in this T65 execution session. First blocked link: no real mobile visualViewport/software-keyboard capture, so xterm/FitAddon, resize-sent, proxy, and tmux observations could not be accepted.`

## Evidence attachments checklist

- **Redacted diagnostic JSON for Snapshot A attached:** `no - blocked before real-device capture`
- **Redacted diagnostic JSON for Snapshot B attached:** `no - blocked before real-device capture`
- **Redacted diagnostic JSON for Snapshot C attached:** `no - blocked before real-device capture`
- **Screenshots show bottom visibility without exposing private content:** `no - blocked before real-device capture`
- **No prohibited data categories are present in this record or attachments:** `yes`
