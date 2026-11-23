# Reviewed native guardian

This artifact is the existing independently verified CI build from
[run 40968234189](https://github.com/kethalia/hive/actions/runs/40968234189),
artifact 12939316274. [The original verification record](https://github.com/kethalia/hive/blob/fe1665ee71ba34d9922a46b872528235bb619c57/docs/checks/autonomous-delivery/guardian-worker-integration/ci-artifact-parent.json)
records the installed workspace checks on the epic branch.

The package builder verifies its source, build recipe, builder, ELF and manifest
hashes before including it. A source or recipe change fails packaging until a
replacement CI artifact is reviewed and committed. No install-time compilation or
download is permitted. Including the executable does not enable delivery; the
operator-controlled template and application flags remain off by default.
