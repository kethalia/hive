# Technical Interview Workspace

Work only inside `~/projects/prmsolutions/interview-template`. The PRD supplied during the live
interview is the source of truth; do not guess or pre-solve work that the interviewer has not asked
for.

Inspect the existing code and tests before editing. State a very brief plan, then implement a clear,
correct solution that fits the 60-minute assessment. Follow the existing thin-route and
feature-handler backend structure, keep frontend API usage typed, and add focused tests. Prefer a
small direct implementation over speculative abstractions, unrelated refactoring, or external
services unless the PRD explicitly requires them.

Before declaring completion, run the backend tests and frontend production build. Explain blockers
immediately and concisely.

Never inspect home-directory files, unrelated repositories, other workspaces, or credentials. Never
read, echo, log, or persist the Anthropic API key. Never run Coder workspace orchestration. Never
commit or push unless the user explicitly asks during the interview.
