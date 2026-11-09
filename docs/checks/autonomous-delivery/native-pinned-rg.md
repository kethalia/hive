# Pinned ripgrep command availability

The successful account pilot retained one nonfatal command failure: `rg` was not
on the fixed command PATH. The child used `ls` and still completed its tests.
No installed workspace or account inference was changed for this correction.

The local actual-native probe demonstrates that a PATH prefix alone is
insufficient: the named sandbox profile must also permit reading the exact
executable. The canonical namespace therefore:

- Requires the canonical vendor `codex-path` directory to be owned by the current
  UID, non-group/world-writable, and contain exactly `rg`.
- Keeps the existing `codex-path/rg` SHA-256 pin unchanged:
  `e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849`.
- Uses only `<verified vendor>/codex-path:/usr/bin:/bin` as PATH.
- Adds a read grant for that exact pinned file, retaining the vendor read-only
  mount and all protected token/config/history denials. It grants no directory
  write, arbitrary PATH entry, package installation or network capability.

`probe-codex-pinned-rg.mjs` reconstructs the baseline and PATH-only negative
controls, both exit127, and the combined positive control, exit0 with ripgrep
15.2.0. Token/config reads and rg writes remain denied in all cases. The native
namespace regression also executes an actual text search and verifies a hostile
write fails without changing the executable digest. Root/child/CLI/resume and
other denial checks remain in that suite.

Validation uses local Responses fixtures only:

```sh
HIVE_TEST_NATIVE_CODEX=1 node scripts/probe-codex-pinned-rg.mjs
HIVE_TEST_NATIVE_CODEX=1 node --test scripts/verify-codex-native-namespace.test.mjs scripts/verify-codex-project-supervisor.test.mjs
node --test scripts/verify-codex-host-package.test.mjs
```

Results: all three probe cases, 33 actual native/supervisor tests and three package
tests pass. The original account pilot evidence remains unchanged. Package
installation is a separate parent-controlled step.
