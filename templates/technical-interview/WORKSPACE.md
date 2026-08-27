# Technical Interview Workspace

This isolated workspace is prepared for the Proton.ai full-stack assessment at
`~/projects/prmsolutions/interview-template`.

## Quick start

- Read `~/INTERVIEW_READY.md` and run `interview-check` before the call.
- Use `interview-start`, `interview-status`, `interview-restart`, and `interview-stop` to manage only
  the `interview` tmux session.
- Open **Interview App** for the Vue frontend, **API Docs** for FastAPI, **Desktop** for Chrome, or
  **code-server** for editing.
- Open the owner-only **Interview Claude** application when the interviewer provides the temporary
  Anthropic key. It opens a second Coder agent in a separate container and PID namespace. Run
  `interview-claude` there; the helper masks input and retains the key only for that Claude process.
- From a trusted external Coder client, the equivalent connection is
  `coder ssh <workspace>.claude`. The main development terminal intentionally refuses key input.
- Codex, Playwright MCP, Bun, pnpm, Python, npm, Chrome, and the project dependencies are prepared
  before the readiness report is generated.

GitHub external authentication and Coder CLI login are intentionally disabled. The workspace clones
only the public assessment repository over anonymous HTTPS and never updates an existing checkout
automatically.
