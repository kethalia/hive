---
'hive-web': patch
'hive-auth': patch
'hive-terminal': patch
---

fix(charts): writable /tmp emptyDir under readOnlyRootFilesystem, opt-out toggle

All three chart Deployments now mount a writable `/tmp` emptyDir
(`name: hive-tmp`) so pods with `securityContext.readOnlyRootFilesystem: true`
can satisfy tsx transpile cache writes and any `os.tmpdir()` callers without
EROFS. The volume is enabled by default and can be disabled with
`tmpVolume.enabled: false` for consumers that need to mount their own `/tmp`
(e.g. a sized tmpfs or PVC). The volume name is chart-scoped (`hive-tmp`) to
avoid colliding with user-supplied entries in `.Values.volumes` /
`.Values.volumeMounts`.
