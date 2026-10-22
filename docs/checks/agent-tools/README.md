# Agent tools validation

Validated on 2026-10-21 from `codex/agent-tools-and-session-recovery`.

## Browser evidence

The disposable `daniel/hive-agent-tools-check` workspace used the
`browser-testing` template (workspace ID `234281e0-9785-4075-bd37-ef832ef74219`).
It was created for this bounded validation; unrelated workspaces were retained.
Changes and evidence were preserved in the primary Hive checkout before cleanup.

Playwright 1.61.1 used the workspace's image-provided Chrome. The fixture rendered
the real `AgentToolsDialog` with controlled server-action responses at desktop
1440 × 1000 and mobile 390 × 844 viewports. Search, open/resume callbacks, tracking
controls, error/refresh presentation, and horizontal overflow checks passed with
no page errors. Screenshots were visually inspected.

- [Machine-readable results](browser-report.json)
- [Desktop setup](1440-setup.png) and [conversation recovery](1440-sessions.png)
- [Mobile setup](390-setup.png) and [conversation recovery](390-sessions.png)

## Workspace boundary checks

The actual helper was also executed over Coder SSH in the disposable workspace.
Its result passed the application's Zod schema, reported the `browser` profile,
detected Codex 0.163.0 and Claude Code 2.1.306, and correctly withheld Coder
orchestration setup outside the software profile. No agent settings or live
conversations were changed by this read-only smoke check.

Python tests cover configuration preservation, metadata filtering, process
identity, fixed native resume arguments, duplicate prevention, missing folders,
and the Coder allowlist. Server tests cover owner authorization and credential
redaction; component tests cover opt-in changes and stale recovery responses.

This evidence does not constitute an authenticated native-agent inference or
OAuth test. Hook trust, live MCP connectivity, and project LSP activation remain
visible through the agents' native interfaces as described in
[the feature documentation](../../agent-tools.md).
