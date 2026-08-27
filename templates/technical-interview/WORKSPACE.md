# Technical Interview Workspace

This isolated workspace is prepared for the Proton.ai full-stack assessment at
`~/projects/prmsolutions/interview-template`.

## Quick start

- Read `~/INTERVIEW_READY.md` and run `interview-check` before the call. If a pinned tool download
  was interrupted, rerun `interview-setup`; it safely retries tools and dependencies.
- Use `interview-start`, `interview-status`, `interview-restart`, and `interview-stop` to manage only
  the `interview` tmux session.
- Open **Interview App** for the Vue frontend, **API Docs** for FastAPI, **Desktop** for Chrome, or
  **code-server** for editing.
- Open the owner-only **Interview Claude** application when the interviewer provides the temporary
  Anthropic key. Its fixed command runs in a second Coder agent with a separate container, PID
  namespace, and ephemeral home. The masked helper keeps the real key in a non-dumpable private
  Unix-socket broker that accepts only the protected Claude process and injects the key only into
  fixed-destination Anthropic API requests. Claude, hooks, commands, and stdio MCP servers never
  inherit the real key. Its pinned Playwright MCP command is registered in Claude's supported
  user-scoped configuration and keeps browser state in that container's ephemeral home.
- Generic SSH and Web Terminal buttons are hidden for the Claude agent. The main development
  terminal intentionally refuses key input.
- Codex, Playwright MCP, Bun, pnpm, Python, npm, Chrome, and the project dependencies are prepared
  before the readiness report is generated.

GitHub external authentication and Coder CLI login are intentionally disabled. The workspace clones
only the public assessment repository over anonymous HTTPS and never updates an existing checkout
automatically.
