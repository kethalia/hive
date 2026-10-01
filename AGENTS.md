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
