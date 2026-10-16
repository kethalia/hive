# PR #324 review fixes

Validated on 2026-10-16 in the primary `daniel/ai-dev-01` checkout.

- Credential rotation (`PRRT_kwDORpHjSM6tFl1J`): stage a pending hash before SSH installation while accepting the active hash. Concurrent callers reuse the same recoverable candidate. Conditional confirmation cannot replace a newer credential. The remote installer locks writes and ignores older generations; failed confirmation leaves the installed candidate valid for retry. The additive `20261016010000_stage_notification_credentials` migration supplies staging fields.
- Notification controls (`PRRT_kwDORpHjSM6tFl1L`): one device-state event updates the permission prompt and settings card after setup/disable, with a shared in-flight subscription promise and revision guards for asynchronous preference loads.

All 1,917 Vitest tests across 163 files passed. Five Python hook tests passed, including out-of-order remote installation. Regression cases cover database failure before and after installation, SSH failure, retry recovery, concurrent reconnects, both UI enable paths, and persistent device disable. TypeScript, repository-wide lint and format checks, Prisma validation, production build, and standalone-runtime validation passed.

Browser checks reused `daniel/creator-direction-upgrade` (`browser-testing`) in `/tmp/hive-pr324-review-validation`. No workspace was created or stopped; this persistent workspace remains running for another task. Results and screenshots are preserved here: [results.json](results.json), [desktop.png](desktop.png), [mobile.png](mobile.png). Desktop setup uses the global prompt; mobile-width setup uses the settings card. Both verify the prompt disappears, event switches become available, and native notification/toast delivery still works without page errors or horizontal overflow.

The fixture mocks native consent and server actions while the Chrome context grants actual notification access. This validates control synchronization rather than the OS consent dialog or vendor push transport. Production build output uses `/tmp/hive-notification-build/next` due limited home-volume storage; the temporary `.next` symlink is removed before handoff.
