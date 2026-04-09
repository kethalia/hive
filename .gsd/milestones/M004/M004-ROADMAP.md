# M004: Template Management Dashboard

## Vision
A Templates page in the dashboard shows all Coder templates with live staleness detection (local directory hash vs remote tar hash), a Push button per template, and an xterm.js terminal panel that streams coder templates push output in real time via SSE — eliminating manual CLI pushes entirely.

## Slice Overview
| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | Coder Template API Client & Staleness Engine | low | — | ⬜ | compareTemplates() returns [{name, stale, lastPushed, activeVersionId}] for all 4 templates. |
| S02 | Push Job Worker & SSE Streaming Route | medium | S01 | ⬜ | curl POST starts a push job; curl SSE endpoint streams coder output in real time; template version updates in Coder. |
| S03 | Templates Dashboard Page with xterm.js | medium | S01, S02 | ⬜ | Open /templates, see stale badge on ai-dev, click Push, watch coder output stream in xterm.js terminal, badge flips to current. |
