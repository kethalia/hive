---
'hive-web': patch
'hive-auth': patch
'hive-terminal': patch
---

ci: trigger fresh release through the gated Release workflow

The v1.0.3 release (commit `e581794`) ran Release in parallel with Build
images on the merge `push`, so the retag step looked for
`:sha-e581794` before Build had pushed it and errored with
`Source image ... does not exist in registry`. Result: `hive-web` and
`hive-auth` never got `:v1.0.3` / `:latest` tags published on GHCR
(only `:sha-e581794`). `hive-terminal` was recovered manually via
workflow_dispatch.

PR #64 fixed the underlying race by switching Release to
`workflow_run: ["Build images"] completed`. Patch-bump the stack so a
release flows end-to-end through the gated workflow and produces the
missing version tags.
