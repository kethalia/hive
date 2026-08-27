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
  Anthropic key, or run `interview-claude`. The fixed client is loaded from a read-only pod-local
  volume and relays the terminal to a sibling runtime that has no Coder agent, Coder token, SSH
  endpoint, or web terminal. The runtime keeps the real key in a non-dumpable private
  Unix-socket broker and injects it only into fixed-destination Anthropic API requests. Claude,
  hooks, commands, and stdio MCP servers never inherit the real key. Its pinned Playwright MCP
  command and browser state remain in the shell-inaccessible runtime's ephemeral home.
- The client can reach only the protected launch protocol; it cannot enter the runtime home,
  process namespace, or credential broker.
- Codex, Playwright MCP, Bun, pnpm, Python, npm, Chrome, and the project dependencies are prepared
  before the readiness report is generated.

GitHub external authentication and Coder CLI login are intentionally disabled. The workspace clones
only the public assessment repository over anonymous HTTPS and never updates an existing checkout
automatically. `interview-check` also rejects standard persisted Codex, cloud, cluster, registry,
IaC, and orchestration credential stores without reading, reporting, or deleting their values.
