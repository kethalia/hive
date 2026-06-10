# Agent Instructions

## Git And PR Workflow

- Never push to `main`; `main` is updated by the user through GitHub merges.
- Never merge branches locally, including merge commits, squash merges, or rebases, unless the user explicitly asks.
- Prefer normal pushes that preserve PR commit history.
- Do not force-push unless the user explicitly asks for history rewriting.
- Use Conventional Commits for commit titles, for example `feat(terminal): add shared session frame`.
- Use Conventional Commits format for PR titles.
- After a completed PR slice, verify the PR exists and leave `main` clean.
