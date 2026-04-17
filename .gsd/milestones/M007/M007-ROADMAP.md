# M007: Sidebar Navigation Overhaul

## Vision
Restructure the Hive dashboard from a flat sidebar + dedicated pages model into a directory-tree sidebar with collapsible workspace/template sections. Remove header and breadcrumbs from all pages. Terminal pages become full-viewport xterm with exclusive keystroke capture. Sidebar supports floating (offcanvas) and docked (pinned) modes with a toggle.

## Slice Overview
| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | S01 | high | — | ✅ | Sidebar shows collapsible Workspaces and Templates sections with live data from Coder API. Header removed from all pages. Floating sidebar trigger visible. Last-refreshed timestamp and refresh button at sidebar bottom. Fetch failures show inline error with retry. |
| S02 | S02 | medium | — | ✅ | Terminal sessions listed under each workspace in sidebar. Clicking a session navigates to full-page terminal. All keystrokes captured by xterm. Session create/kill/switch from sidebar. Stale entry clicks trigger error + sidebar refresh. |
| S03 | S03 | low | — | ⬜ | Clicking a template in sidebar opens detail page with info and push button. Sidebar mode toggle (pin/unpin) with localStorage persistence. Mobile responsive sidebar. Old workspaces page removed. |
