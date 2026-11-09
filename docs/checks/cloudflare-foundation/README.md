# P01 Cloudflare foundation acceptance

Validated on 9 November 2026 against the isolated branch Preview. This is the
first extracted increment of the autonomous-delivery epic. The owner accepts and
merges each increment through GitHub.

[PR449](https://github.com/kethalia/hive/pull/449) contains the implementation and
current check status. [The migration plan](https://github.com/kethalia/hive/blob/codex/delivery-system-design/docs/autonomous-delivery-pr-migration.md)
records P01–P11 and the later feature boundaries.

## Scope and environment

- Preview is `https://codex-cloudflare-foundation-hive.b00ste.workers.dev` under the
  existing `hive` Worker.
- The connected repository builds with `pnpm build:cloudflare` and publishes with
  `node deploy/cloudflare/native/deploy.mjs preview`. The branch-specific existing
  Workers Builds trigger retains its configured provider credential.
- Neon database `hive_foundation_preview` uses the existing Free project's compute.
  The application connects as `hive_foundation_runtime`. The migration owner
  applies main's seven migrations. `database.json` records inspected privileges
  and the completed migration count.
- Credential login, workspace/settings reads, ordinary terminals and bounded
  terminal-session inventory comprise this acceptance. Coder OAuth follows in
  P02. Signed workspace helpers, managed tasks and production activation follow
  their respective increments.
- Required secret values stay in private setup storage and Cloudflare settings.
  New Preview requests hold until the enrolled database and runtime role are set.

## Validation

The full application suite passed 1,987 tests across 170 files before the final
review corrections. Narrow regression suites then validated those corrections,
including native client-IP forwarding, four streamed auth cleanup paths and
129/200/201-character terminal-name boundaries. Both auth-package typechecks and
root TypeScript passed. A subsequent Codex review found that direct internal auth
calls could outlive the client deadline. The binding now races cancellation,
retains late domain cleanup and propagates aborts through response streaming. Six
composed regressions passed, including delayed domain work, late success/failure,
pre-dispatch cancellation and response-body cancellation. Independent review
cleared the correction. Cloudflare TypeScript and the final OpenNext build passed.
The Node build and standalone verification passed. Repository formatting reported
six existing warnings and zero errors.

`pnpm test:cloudflare` passed the deployment guards, build-integrity regression and
seven database adapter/request-scope tests. Review found and corrected a missing
shared terminal-protocol build input. A real Coder probe exposed text framing on
inventory acknowledgments. Binary frames corrected it, and regression tests and
actual Coder inventory passed. Separate reviewers checked other authors' changes.

The first connected build inherited an epic-only command condition and reported
success while skipping P01. The branch-specific trigger now runs the actual build
and deploy commands. A subsequent branch push automatically built and deployed
revision `9af9f32671753b3a490e5ce1dfb34e55c3b0e613` through build
`834fb0db-0fcd-49ee-ab63-29ae0438e69a`, which completed successfully. The Preview
retained its isolated secrets across that source deployment.

Browser Testing uses the installed Chrome in the reused browser workspace.
`browser.json` records real credential sign-in, authenticated reload and reads,
Settings rendering, UI terminal creation, output, mobile-sized reconnection to the
same shell, normal exit and refreshed inventory. An additional browser WebSocket
check exercises the hosted ticket route and relay, verifies a 100×35 shell resize,
reconnects to the same PID and exits with code 1000. The local Workerd transport
check also passed exact resize and reconnect against real Coder.

## Limits and operations

OpenNext warns that Node.js middleware support is experimental. Keep its observed
runtime behavior in regression acceptance as the subsequent increments progress.
The narrow-viewport check exercises Chromium viewport sizing and reconnection.
Physical iOS Safari and its on-screen keyboard remain an owner acceptance check.
The inherited window layout can retain windows wider than the mobile viewport.

Harness assertions were corrected during validation. Normal terminal closure
uses the existing “Terminal connection ended because the terminal session closed”
message. Window geometry does not guarantee fewer than 80 columns when resizing
the viewport. Exact resize validation uses the hosted terminal protocol and checks
the shell-reported dimensions. A later run needed a short viewport transition wait
before keyboard input. One fixture from an earlier timed-out run was removed
through Coder SSH after matching its exact session and pane PID. The final
inventory was empty. The cleanup follow-up also verified logout, a Settings
redirect to login and JSON 401 from workspace discovery.

The retained software test workspace has a historical managed-runtime startup
hold. Its connected agent and ordinary PTY work for P01. Managed execution belongs
to P05 and was outside this acceptance. No model session was started for P01.

`workspaces.json` preserves the primary's inspected identities for the reused
browser and software workspaces. Test tmux sessions are exited. The primary stops
these reused resources after preserving results and retains their persistent
storage. The Preview and its database remain available for owner validation.

## Owner checklist

1. Open the Preview and sign in using the baseline Coder credential flow.
2. Open Settings through the launcher and inspect workspaces and terminal discovery.
3. Create a uniquely named terminal, run a command, resize, reload and reconnect.
4. Exit the shell and verify the normal-close message and refreshed inventory.
5. Inspect the PR checks and connected Cloudflare build, then merge through GitHub
   after acceptance. P02 supplies the configured-host OAuth flow next.
