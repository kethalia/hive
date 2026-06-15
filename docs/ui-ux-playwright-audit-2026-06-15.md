# Hive UI/UX Playwright Audit - 2026-06-15

## Scope

Thorough UI/UX investigation of the live Hive app at `hive.local.kethalia.com` using Playwright MCP, authenticated against the supplied Coder instance. No product fixes were made.

Primary emphasis:

- Ease of use for developer workflows.
- Desktop, tablet, and mobile responsive behavior.
- Normal and edge cases across tasks, templates, workspaces, terminal diagnostics, missing resources, and stale terminal routes.
- Common improvement goals after grouping findings.

## Evidence

- Authenticated session: successful; `hive-session` cookie was `httpOnly`, `secure`, `SameSite=Lax`.
- Tested viewports:
  - Desktop: `1440x900`
  - Tablet: `820x1180`
  - Mobile: `390x844`
- Routes exercised:
  - `/tasks`
  - `/tasks/new`
  - `/templates`
  - `/templates/hive`
  - `/templates/ai-dev`
  - `/workspaces`
  - `/terminal/status`
  - `/tasks/not-a-real-task`
  - `/workspaces/not-a-real-workspace/terminal`
- Interaction probes:
  - Login.
  - Empty task list and new-task entry points.
  - New task empty submit, invalid repository URL, council-size underflow/overflow, long prompt.
  - Mobile sidebar open.
  - Notification prompt recurrence.
  - Template push button click probe without completing a push.
  - Workspace add modal open without creating infrastructure.
  - Coder Dashboard external link inspection.
- Screenshots:
  - `.artifacts/browser/2026-06-15-ux-audit/ux-audit-desktop-tasks.png`
  - `.artifacts/browser/2026-06-15-ux-audit/ux-audit-desktop-create-task-sidebar-intercept.png`
  - `.artifacts/browser/2026-06-15-ux-audit/ux-audit-desktop-add-workspace-modal.png`
  - `.artifacts/browser/2026-06-15-ux-audit/ux-audit-desktop-missing-task-error.png`
  - `.artifacts/browser/2026-06-15-ux-audit/ux-audit-mobile-templates.png`
  - `.artifacts/browser/2026-06-15-ux-audit/ux-audit-mobile-template-detail-edge-button.png`
  - `.artifacts/browser/2026-06-15-ux-audit/ux-audit-mobile-new-task-focused.png`
  - `.artifacts/browser/2026-06-15-ux-audit/ux-audit-mobile-stale-terminal.png`
- Console evidence:
  - `.playwright-mcp/console-2026-06-15T07-37-38-328Z.log`

## Executive Findings

### P0/P1 Workflow Blockers

1. **Desktop sidebar intercepts primary content clicks.**
   - Evidence: on `/tasks/new`, Playwright could not click `Create Task`; hit-testing at the button center returned the sidebar content container.
   - The same pattern appeared on `/templates/hive`; the visible `Push` button was also intercepted by sidebar/panel UI.
   - User impact: primary developer actions can appear available but fail for pointer users. This is the highest-impact ease-of-use issue found.

2. **Missing task IDs render a raw production error page.**
   - Evidence: `/tasks/not-a-real-task` returned "This page couldn't load", `Reload`, and an opaque error digest.
   - User impact: a stale task link or deleted task becomes a dead-end instead of explaining what happened or offering recovery paths.

### High-Value UX Issues

3. **The notification prompt dominates every tested viewport until dismissed.**
   - Evidence: "Stay notified" appeared on desktop, tablet, and mobile across tasks, templates, workspaces, terminal diagnostics, stale-terminal, and missing-route flows.
   - On mobile it occupies the lower-right area and competes with primary task/template controls.
   - Dismiss behavior was hard to complete while the mobile sidebar sheet was open, and the prompt reappeared on later navigations in testing.

4. **React hydration errors occur repeatedly during responsive route testing.**
   - Evidence: console showed repeated minified React error `#418` on `/tasks`, `/templates`, `/templates/hive`, `/tasks/new`, and `/terminal/status`.
   - User impact: hydration mismatches are often experienced as flicker, duplicate content, stale event handlers, or unreliable first interactions.

5. **Template detail action placement is poor on narrow viewports.**
   - Evidence: mobile `/templates/hive` placed `Push` at the extreme left edge; desktop hit-testing also showed action click interception.
   - User impact: the primary action feels detached from the template details and is easy to miss or mistrust.

6. **New-task validation relies mostly on browser-native validation bubbles.**
   - Evidence: empty submit focuses the invalid field only if pointer click can reach the button; invalid URL reports native "Please enter a URL"; council size reports native min/max messages.
   - User impact: errors are not summarized in-app, long prompts have no visible length/quality guidance, and server/action failures are separate from native validation behavior.

7. **Notification prompt accessible naming interferes with form-field queries.**
   - Evidence: a broad `getByLabel(/prompt/i)` matched both "Dismiss notification prompt" and the actual Prompt textarea.
   - User impact: screen-reader search and automation can encounter ambiguous matches around "prompt"; this also signals avoidable accessible-name noise.

8. **Empty states are understandable but underpowered for developer workflow recovery.**
   - Evidence: `/tasks` says "No tasks yet" with a clear create link. `/workspaces` says "No workspaces found" and suggests refreshing after creating one in Coder.
   - Opportunity: workspace empty state should offer a direct primary path to create a Hive workspace and a secondary Coder dashboard handoff.

## Normal-Path Notes

- Login worked with the supplied Coder URL, email, and password.
- `/tasks` empty state is clear and has a `New Task` action plus "Create your first task".
- `/workspaces` `Add workspace` opened a modal with workspace name, template choices, Cancel, Create workspace, and Close.
- The Coder `Dashboard` link uses `_blank` with `noopener noreferrer`, which is appropriate for external handoff.
- `/terminal/status` uses clear redaction language and exposes useful aggregate counts without terminal content.
- Mobile sidebar opens as a sheet and includes Tasks, New Task, Dashboard, templates, settings, and user account controls.

## Edge-Case Notes

- `/workspaces/not-a-real-workspace/terminal` shows a plain stale-entry message and "Back to home". This is better than the raw task error, but could still offer "Workspaces" and "Terminal diagnostics" recovery actions.
- Template list on mobile switches from table to card-like content, which is usable, but hidden duplicate `Push` buttons were present in the DOM for the responsive table/card variants.
- Tablet and mobile keep top actions reachable, but the notification prompt overlaps the visual priority of most pages.
- The deprecated PWA meta warning appeared repeatedly: `<meta name="apple-mobile-web-app-capable" content="yes"> is deprecated. Please include <meta name="mobile-web-app-capable" content="yes">`.

## Common Improvement Goals

1. **Fix global layering and pointer-event safety.**
   - Ensure sidebar, sheets, notification prompts, and panels never intercept clicks outside their visible bounds.
   - Add Playwright coverage for hit-testing primary buttons on desktop/tablet/mobile.

2. **Make recovery states first-class.**
   - Replace raw server errors for missing tasks with a friendly task-not-found page.
   - Add recovery actions: Tasks, New Task, Workspaces, Terminal diagnostics, and Coder Dashboard where relevant.

3. **Reduce persistent prompt friction.**
   - Make the notification prompt less intrusive, persist dismiss state reliably, and avoid showing it on error/stale states.
   - Consider a settings/banner pattern instead of a floating prompt that competes with primary controls.

4. **Stabilize hydration across responsive surfaces.**
   - Investigate React error `#418` under mobile/tablet route transitions.
   - Prioritize components that render differently server/client: viewport-dependent layout, sidebar state, pull-to-refresh, notification prompt, and timestamped terminal status.

5. **Strengthen developer workflow forms.**
   - Add in-app validation summaries for New Task and Add Workspace.
   - Keep native validation, but pair it with visible field-level messages and recovery guidance.
   - Add prompt quality affordances: length, attachment expectations, repo URL examples, and optional advanced settings grouping.

6. **Clarify high-risk actions.**
   - Template `Push` should have reliable placement, a clear confirmation/review step, and status feedback.
   - On narrow viewports, primary actions should remain visually attached to the object they affect.

7. **Improve mobile information architecture.**
   - Keep the mobile sidebar, but consider a compact bottom or top-level nav for the highest-frequency developer routes: Tasks, New Task, Workspaces, Terminal status.
   - Avoid requiring the sidebar for common recovery paths.

8. **Add Playwright UX regression checks.**
   - Coverage candidates:
     - Login and authenticated redirect.
     - Hit-test primary actions on all core pages.
     - Mobile sidebar open/close.
     - Notification prompt dismiss persistence.
     - Missing task and stale workspace recovery pages.
     - New Task validation and Add Workspace modal validation.

## Suggested Next Slices

1. **P1: Layout hit-test fix.**
   - Reproduce with Playwright `elementFromPoint` on `Create Task` and template `Push`.
   - Fix sidebar/panel layering.
   - Add regression tests for desktop and tablet.

2. **P1: Error and stale-state recovery.**
   - Implement friendly task-not-found handling.
   - Upgrade stale workspace terminal page with richer recovery actions.

3. **P2: Notification prompt redesign.**
   - Persist dismiss state.
   - Move to a less intrusive placement.
   - Remove ambiguous accessible naming.

4. **P2: Hydration investigation.**
   - Reproduce React `#418` in a local production build.
   - Identify server/client mismatch sources and add focused tests.

5. **P2: Form UX hardening.**
   - Improve New Task and Add Workspace validation, inline errors, and workflow guidance.

