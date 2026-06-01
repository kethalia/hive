# S02 Mobile Terminal Keyboard Evidence

**Reader:** the S02 engineer or tester collecting real-device acceptance evidence for Hive's mobile terminal keyboard refit behavior.

**Post-read action:** fill this record after running the [Mobile Terminal Keyboard Diagnostics UAT](./mobile-terminal-keyboard-diagnostics-uat.md) on a real mobile browser or installed PWA, then decide whether the viewport, xterm/FitAddon, terminal proxy resize, and tmux dimension evidence satisfy S02.

This document is a fillable evidence contract. It may be committed with placeholders while operational evidence is still pending, but a completed S02 run must replace every `PENDING` value with redacted real-device observations.

## Evidence status

- **Run status:** `PENDING | PASS | FAIL | BLOCKED`
- **Tester:** `PENDING`
- **Run date and timezone:** `PENDING`
- **Related UAT run:** `PENDING`
- **Overall result:** `PENDING`

## Redaction boundary

Only record geometry, dimensions, timing, counters, and boolean visibility results from the debug overlay. Do not paste terminal buffer contents, command input, hidden input contents, session proof values, authentication material, cookies, upstream connection URLs, filesystem paths, or checkout-specific absolute paths. If a copied diagnostic snapshot contains any of those values, stop the run and file a diagnostics redaction bug instead of pasting the snapshot here.

When recording the route, use only the route and query shape. Replace workspace identifiers and session names with placeholders.

```text
/workspaces/<workspace-id>/terminal?session=<session-name>&debugViewport=1
```

## Device and environment

- **Device model:** `PENDING`
- **Physical device used:** `yes | no | PENDING`
- **Operating system and version:** `PENDING`
- **Browser or installed PWA mode:** `PENDING`
- **Browser version, if visible:** `PENDING`
- **Orientation:** `portrait | landscape | PENDING`
- **Viewport mode notes:** `PENDING`
- **Route/query shape used:** `/workspaces/<workspace-id>/terminal?session=<session-name>&debugViewport=1`

## Required acceptance observations

- **Terminal bottom visible before keyboard opens:** `yes | no | PENDING`
- **Terminal bottom remains visible while keyboard is open:** `yes | no | PENDING`
- **Terminal bottom visible after keyboard closes:** `yes | no | PENDING`
- **Keyboard inset becomes positive or visual viewport shrinks while keyboard is open:** `yes | no | PENDING`
- **xterm rows/cols change or are confirmed appropriate for the keyboard-open viewport:** `yes | no | PENDING`
- **Resize-sent rows/cols are observed after the keyboard-open refit:** `yes | no | PENDING`
- **tmux numeric dimensions match the propagated resize closely enough to accept:** `yes | no | PENDING`

## Snapshot A: keyboard closed before focus

Record the copied debug overlay JSON as a redacted attachment or issue comment, then summarize the fields below.

- **Sample timestamp:** `PENDING`
- **Layout viewport width x height:** `PENDING`
- **Visual viewport width x height:** `PENDING`
- **Visual viewport offset top/page top:** `PENDING`
- **Keyboard inset bottom:** `PENDING`
- **Terminal shell rect bottom and visible-viewport bottom:** `PENDING`
- **Helper rectangle present:** `yes | no | PENDING`
- **Active element tag/role/type only:** `PENDING`
- **xterm rows x cols:** `PENDING`
- **Latest fit rows x cols and count:** `PENDING`
- **Latest resize-request rows x cols and count:** `PENDING`
- **Latest resize-sent rows x cols and count:** `PENDING`
- **Terminal-bottom visibility result:** `visible | clipped | PENDING`

## Snapshot B: keyboard open

Wait for at least two overlay refreshes after the software keyboard opens before recording this snapshot.

- **Sample timestamp:** `PENDING`
- **Layout viewport width x height:** `PENDING`
- **Visual viewport width x height:** `PENDING`
- **Visual viewport offset top/page top:** `PENDING`
- **Keyboard inset bottom:** `PENDING`
- **Terminal shell rect bottom and visible-viewport bottom:** `PENDING`
- **Helper rectangle present:** `yes | no | PENDING`
- **Active element tag/role/type only:** `PENDING`
- **xterm rows x cols:** `PENDING`
- **Latest fit rows x cols and count:** `PENDING`
- **Latest resize-request rows x cols and count:** `PENDING`
- **Latest resize-sent rows x cols and count:** `PENDING`
- **Terminal-bottom visibility result:** `visible | clipped | PENDING`
- **Rows/cols propagated to terminal proxy:** `yes | no | PENDING`

## Snapshot C: keyboard closed after dismissal

Wait for at least two overlay refreshes after the software keyboard closes before recording this snapshot.

- **Sample timestamp:** `PENDING`
- **Layout viewport width x height:** `PENDING`
- **Visual viewport width x height:** `PENDING`
- **Visual viewport offset top/page top:** `PENDING`
- **Keyboard inset bottom:** `PENDING`
- **Terminal shell rect bottom and visible-viewport bottom:** `PENDING`
- **Helper rectangle present:** `yes | no | PENDING`
- **Active element tag/role/type only:** `PENDING`
- **xterm rows x cols:** `PENDING`
- **Latest fit rows x cols and count:** `PENDING`
- **Latest resize-request rows x cols and count:** `PENDING`
- **Latest resize-sent rows x cols and count:** `PENDING`
- **Terminal-bottom visibility result:** `visible | clipped | PENDING`

## tmux dimension observation

Use a safe dimension-only observation from the terminal multiplexer or PTY side. Record only numbers and the observation method; do not include shell output beyond dimensions.

- **Observation method:** `PENDING`
- **Rows observed:** `PENDING`
- **Columns observed:** `PENDING`
- **Observed after snapshot:** `A | B | C | PENDING`
- **Matches latest resize-sent rows/cols:** `yes | no | PENDING`
- **Mismatch notes:** `PENDING`

## Acceptance decision

- **Viewport refit accepted:** `yes | no | PENDING`
- **xterm/FitAddon refit accepted:** `yes | no | PENDING`
- **Terminal proxy resize propagation accepted:** `yes | no | PENDING`
- **tmux resize observation accepted:** `yes | no | PENDING`
- **S02 real-device evidence accepted:** `yes | no | PENDING`

## Failure notes

If the run fails, identify the first observed break in the chain.

- **Viewport changed but xterm rows/cols did not:** `yes | no | PENDING`
- **xterm rows/cols changed but resize-request did not:** `yes | no | PENDING`
- **resize-request changed but resize-sent did not:** `yes | no | PENDING`
- **resize-sent changed but tmux dimensions did not:** `yes | no | PENDING`
- **All dimensions changed but terminal bottom was clipped:** `yes | no | PENDING`
- **Notes:** `PENDING`

## Evidence attachments checklist

- **Redacted diagnostic JSON for Snapshot A attached:** `yes | no | PENDING`
- **Redacted diagnostic JSON for Snapshot B attached:** `yes | no | PENDING`
- **Redacted diagnostic JSON for Snapshot C attached:** `yes | no | PENDING`
- **Screenshots show bottom visibility without exposing private content:** `yes | no | PENDING`
- **No prohibited data categories are present in this record or attachments:** `yes | no | PENDING`
