# Reviewed native guardian

This artifact is the existing independently verified CI build from
[run 40968234189](https://github.com/kethalia/hive/actions/runs/40968234189),
artifact12939316274. Its original verification is preserved in
`docs/checks/autonomous-delivery/guardian-worker-integration/ci-artifact-parent.json`.
The exact binary has also passed the installed test-workspace checks.

The package builder verifies its source, build recipe, builder, ELF and manifest
hashes before including it. A source or recipe change fails packaging until a
replacement CI artifact is reviewed and committed. No install-time compilation or
download is permitted. Including the executable does not enable delivery; the
operator-controlled template and application flags remain off by default.
