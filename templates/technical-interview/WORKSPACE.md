# Technical Interview Workspace

This isolated workspace is prepared for the Proton.ai full-stack assessment at
`~/projects/prmsolutions/interview-template`.

## Quick start

- Read `~/INTERVIEW_READY.md` and run `interview-check` before the call.
- Use `interview-start`, `interview-status`, `interview-restart`, and `interview-stop` to manage only
  the `interview` tmux session.
- Open **Interview App** for the Vue frontend, **API Docs** for FastAPI, **Desktop** for Chrome, or
  **code-server** for editing.
- Run `interview-claude` when the interviewer provides the temporary Anthropic key. The helper masks
  input and retains the key only for the Claude process.

GitHub external authentication and Coder CLI login are intentionally disabled. The workspace clones
only the public assessment repository over anonymous HTTPS and never updates an existing checkout
automatically.
