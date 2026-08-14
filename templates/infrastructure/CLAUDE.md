# Infrastructure Workspace

Use this workspace for cluster configuration, Terraform, Helm, deployment workflows, runners, and
platform repositories. Begin with read-only inspection and repository-local validation. Separate
desired-state changes from actions against a live environment.

Plans, diffs, manifests, and dry runs are normal implementation work. Applying infrastructure,
rotating secrets, changing access, deleting resources, or mutating production requires explicit user
authorization and a resolved target environment. Never infer the active cluster, account, namespace,
or state backend from filenames alone.

Keep credentials out of source and terminal output. Prefer repository-pinned toolchains and documented
wrappers; the template supplies editor support and common clients but does not grant cluster access.

Use repository-local source, Git history, issues, runbooks, and `AGENTS.md` files as the source of
truth. Use only vendor-published or OpenAI-curated skills and plugins. Do not require or sync an
Obsidian vault.
