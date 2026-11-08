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


## Scope and architecture discipline

- Use the accepted single-Worker Cloudflare deployment and its connected repository
  builds as the default. Inspect existing code, configuration and provider capabilities
  before designing deployment infrastructure.
- A failed operation in a newly proposed architecture is not automatically a blocker
  for the accepted roadmap. Identify the unmet user requirement and demonstrate why
  the existing path cannot satisfy it first.
- Before implementing an additional publisher, controller runtime, deployment pipeline
  or new platform dependency, record the concrete gap, smallest alternative and cost;
  obtain owner agreement for that architecture change. Routine work within the accepted
  design remains autonomous.
- Request credentials only for an approved, necessary operation. State the exact API,
  existing authorization failure, minimum scope and runtime that needs it. First check
  whether the connected integration already performs the required operation.
- Use the human-readable Coder inventory or filter JSON to an explicit identity,
  lifecycle and health allowlist before printing it. Raw workspace, resource and agent
  metadata can contain credentials in environment variables and commands; never dump
  those responses into tool output, reports or subagent handoffs.
- Give subagents bounded implementation goals, acceptance criteria and stopping
  conditions. The manager checks proposed architecture against accepted requirements
  before authorizing implementation; successful local tests do not establish that a
  component was needed.
- Report completion by user-visible roadmap outcomes. Keep implementation, test
  evidence, enabled configuration and production acceptance distinct.
