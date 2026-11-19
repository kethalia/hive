# Agent Instructions

## Git And PR Workflow

- Never push to `main`; `main` is updated by the user through GitHub merges.
- Never merge branches locally, including merge commits, squash merges, or rebases, unless the user explicitly asks.
- Prefer normal pushes that preserve PR commit history.
- Do not force-push unless the user explicitly asks for history rewriting.
- Use Conventional Commits for commit titles, for example `feat(terminal): add shared session frame`.
- Use Conventional Commits format for PR titles.
- Open PRs as drafts only while work is still in progress. Once the work is complete and ready for
  the user to check, open the PR as ready for review or mark an existing draft ready for review.
- After a completed PR slice, verify the PR exists and leave `main` clean.

## Interface feedback

- Use the dashboard toast for brief confirmations of user actions, including clipboard copies,
  cancellation and disconnect. Keep one confirmation per action and keep credentials out of toasts.
- Show durable connection state, pending approvals and recovery actions in the active panel.
  Preserve the last confirmed identity during a refresh and use one loading indicator per operation.
- Reuse the workspace list and connection-state components across provider windows. Show the
  credential scope and the actions supported by that provider.

### Loading states

- Use `LoadingStatus` from `@/components/ui/loading-status` for initial loads. It provides one
  accessible status, a decorative spinner, reduced-motion support, and shared typography.
- Center a blocking workspace restore with `placement="workspace"`. Keep window titles and
  sidebars visible during panel loads. Use the inline placement inside padded content and
  `placement="window"` for a fallback directly inside an unpadded frame.
- Name the operation and preserve product capitalization, for example “Checking GitHub connection…”.
  Use the same label and placement while a connection panel loads its code and checks the account.
  Show sign-in instructions, empty states, counts, and actions once the initial check completes.
- During refresh, keep confirmed content, selection, and search visible. Put progress on the
  action that initiated it. Clear stale content immediately when authorization or identity fails.
- Check slow initial loads, background refresh, and error recovery when changing a window.
  Compare equivalent provider panels side by side for matching placement and a single indicator.
