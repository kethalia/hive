# Agent notifications

Open **Notifications** in Hive's sidebar. Enable push on each device, connect your running workspaces, restart Codex and Claude Code, and review/trust Hive's hooks in Codex `/hooks`. Use **Send test push** to check delivery and the preview buttons to hear the three CRT motifs. Event preferences and disabling push apply to the current browser/PWA device; workspace connections apply to your account.

On iPhone and iPad, install Hive with **Share → Add to Home Screen**, open that app, and enable notifications there (iOS/iPadOS 16.4+). Use HTTPS. Focus modes, OS permissions, and browser policies can suppress delivery or sound. CRT audio plays in a visible Hive page after interaction; background web push uses the OS notification sound. The Web Notifications API does not expose custom background sounds.

Questions and approvals use a rising CRT chirp, ready reports use a resolved ascending arpeggio, and warnings use lower pulses. Only one visible tab receives audio/toasts for each push. An existing OS notification with the same delivery tag prevents duplicate foreground audio during queue retries. Clicking an alert opens its workspace and tmux session when available. Token warnings open login; template results open the template. Badges reflect notifications still held in the OS notification center, where supported.

## Events and privacy

| Agent / source | Events |
| --- | --- |
| Codex | `PreToolUse` for `request_user_input` / `request_user_input_async`, `PermissionRequest`, `Stop` |
| Claude Code | `PreToolUse` for `AskUserQuestion` / `ExitPlanMode`, `PermissionRequest`, elicitation/input `Notification`, `Stop`, `StopFailure` |
| Hive | Template push success/failure and Coder token expiry |

Ready means an agent emitted a turn-stop event, rather than a guarantee that a broader objective is complete. Lifecycle hooks cannot determine whether another independent Stop hook will request continuation. Claude idle reminders and ordinary command output do not produce alerts. Codex currently lacks the Claude `StopFailure` hook, so its arbitrary API failures are not automatically classified as failures. Natural-language questions outside structured question tools are not inferred from terminal output.

The workspace sender transmits only event kind, agent name, random event ID, and tmux session name. Hive supplies the owner and workspace from the scoped callback token; request bodies cannot choose a different recipient. Prompts, answers, tool arguments, and transcripts are not uploaded. A 60-events-per-minute limit bounds noisy callbacks. Callback retries are deduplicated in BullMQ for up to 24 hours (bounded retained jobs); delivery has four exponential retries, a one-hour push TTL, and a ten-second per-device request timeout. Permanent 404/410 subscriptions are removed.

Connecting installs a Python sender and a mode-0600 credential file under `~/.local/share/hive/notifications/`, and appends hooks to `${CODEX_HOME:-~/.codex}/hooks.json` and `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`. Existing hooks and settings are preserved, including symlink targets. Reconnecting stages a recoverable callback credential before changing the workspace. Active and pending credentials are accepted during installation; confirmation revokes the previous credential. Database failures leave a retryable pending setup, and versioned remote installation prevents late requests from overwriting newer credentials. Only credential hashes are stored; pending tokens are recovered using the existing server `COOKIE_SECRET`. Disconnecting revokes it and drops queued deliveries from that source; the inert hook definitions remain on disk. A browser endpoint can belong to only one Hive account at a time.

## Deployment

Deploy the Prisma migrations `20261016000000_add_agent_notifications` and `20261016010000_stage_notification_credentials` with the web release. It adds device event preferences and workspace callback sources, and consolidates duplicate browser endpoints before enforcing single-account ownership. No schema changes are applied by the settings UI.

The existing database-backed VAPID keys and Redis instance are reused. The new `agent-notifications` BullMQ worker starts from Next instrumentation unless `HIVE_DISABLE_BACKGROUND_WORKERS=true`; at least one worker-enabled instance is required. Set `HIVE_PUBLIC_ORIGIN` to Hive's externally reachable HTTPS origin behind a reverse proxy. Workspaces must be able to reach that origin, and the web service must retain its existing Coder SSH capability. The standalone output includes the two Python installer/sender assets.

No workspace-template rollout is needed: **Connect** installs hooks into the selected workspace's persistent home. Codex's one-time hook trust review is intentional and is not bypassed.

## Validation

Run `pnpm exec vitest run src/__tests__/push src/__tests__/components/push-permission-prompt.test.tsx`, `python3 scripts/notifications/test_hooks.py`, `pnpm typecheck`, and `pnpm build`. Browser checks belong in `browser-testing`; generate a fixture with `node scripts/notifications/build-preview.mjs /tmp/hive-notification-preview`, transfer it there, and run its `validate.mjs` with `HIVE_PLAYWRIGHT_MODULE` pointing to the installed Playwright module.

Browser evidence and limitations are in [checks/agent-notifications/README.md](checks/agent-notifications/README.md).

References: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Web Notifications options](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification), [WebKit Home Screen Web Push](https://webkit.org/blog/13878/).
