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
- Open the owner-only **Interview Claude** application, or run `interview-claude`, to create a
  one-time pairing code. Then open **Interview Claude Key** and enter the pairing code plus the
  interviewer-provided temporary key. The browser encrypts the key for the protected runtime; the
  candidate terminal never receives it. The fixed client is loaded from a read-only pod-local volume
  and relays the terminal to a sibling runtime that has no Coder agent, Coder token, SSH endpoint, or
  web terminal. The runtime keeps the decrypted key in a non-dumpable private
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
IaC, orchestration, and default Chrome/Chromium credential stores without reading, reporting, or
deleting their values. Normal headed Chrome launches use only the pod-ephemeral interview profile.
