# Browser Testing Workspace

Use this workspace only for browser automation, end-to-end tests, screenshots, traces, accessibility
inspection, and headed Chrome debugging. Keep application implementation in its owning workspace;
make code changes here only when the browser task explicitly includes the checked-out repository.

Prefer deterministic Playwright locators and assertions. Record the target URL, viewport, account,
and environment used for evidence. Do not claim a visual or interaction result unless the relevant
page was actually exercised, and do not mutate production data without explicit authorization.

Treat cookies, downloads, traces, screenshots, and authenticated browser profiles as potentially
sensitive. Keep them out of Git unless the repository explicitly requires reviewed fixtures.

Use repository-local source, Git history, issues, and `AGENTS.md` files as the source of truth. Use
only vendor-published or OpenAI-curated skills and plugins. Do not require or sync an Obsidian vault.
