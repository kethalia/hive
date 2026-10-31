# Dedicated test-workspace account pilot

**Passed, with one nonfatal tool-path limitation.** The installed isolated native
runtime completed one root turn and exactly one child turn using the workspace's
own signed-in account. No primary authentication or API key was copied. This is
account/runtime interoperability evidence, not production delivery, independent
observer authority, or writer-quiescence evidence.

Verified primary-owned deployment values:

- Workspace: `22c4f094-46f0-4a76-86ca-37ad74254872` (persistent test workspace).
- Build: `ebafefde-23d7-46cb-948f-865a7c0fb464`.
- Archive: `94a6c97e26238cfb6904cdfca699863e22e472014dd296d6cef6fc3eeae0f2d8`.
- All 21 installed package files matched the primary canonical manifest.
- Official host health200; isolated mode enabled; manager disabled.

The corrected installed no-inference readiness passed native initialize,
effective managed requirements, command execution and credential/config/policy
read-denial controls. `native-account-readiness-corrected.json` preserves those
results. The initial pre-correction startup failure remains separately recorded
in `native-account-pilot-first-failure.json` and `native-account-readiness.json`.

The actual catalog advertised `gpt-6.1-sol`, low effort and multi-agent v2. Both
requested and effective root/child settings matched exactly; fallback was
disabled. The only spawn call was
`call_731d04a196774e38957d2f00d56db6ba`, linking:

- Root thread: `01a1895b-e5d8-71b2-81c8-d7dc4e2c7638`.
- Child thread: `01a1895c-00d6-77d2-a251-4b5334a32b54`.

The prompt ran from `20:31:03.790Z` to `20:31:38.612Z` on 2026-10-29, within the
five-minute watchdog. The child implemented `merge_intervals` and six unittest
cases. It ran all six successfully; the root inspected both files and reran the
same six successfully. The copied fixture also passes in the primary workspace:

```sh
cd docs/checks/autonomous-delivery/native-account-pilot-fixture
python3 -B -m unittest -v
```

`native-account-pilot.json` records the exact model catalog, resolved settings,
spawn/turn identities and all five native command events. The first command
failed because `rg` was absent from the fixed PATH (exit127). The child used `ls`
instead; no dependency download or installation occurred. This limitation is
retained honestly rather than treating all commands as successful.

After preserving the source files, result and file hashes in the primary, the
pilot closed its own runtime. Cleanup checked the creation receipt's original
root inode/device, exact file hashes, empty sandbox-created placeholder
directories, absence of same-UID process cwd/FD references and exit of the
recorded wrapper/monitor/native chain. It removed only that newly created
synthetic fixture. `native-account-pilot-cleanup.json` records those checks.
Official host/controller state, dedicated authentication, native history and the
private pilot evidence remain in the persistent test workspace. Health remains
200. This reviewed synthetic-fixture cleanup does not enable production checkout
cleanup or clear D04 holds.

The runnable account/readiness probes are intentionally pinned to the verified
test build/archive. They are not installed host services and must not select
trust values from incoming workspace claims.
