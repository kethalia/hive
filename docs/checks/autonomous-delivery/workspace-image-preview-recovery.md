# Preview image recording recovery

[Run41009109919](https://github.com/kethalia/hive/actions/runs/41009109919)
built, smoke-tested and pushed the reviewed014d08e image. Its final recording step
failed. That workflow remains failed; no rebuild, re-push, retry or activation was
performed during recovery.

The recorder treated `docker image inspect .Id` as the config digest. The runner
uses Docker29.4.2 with the containerd image store. Its Buildx output identifies
`30ea4d3d…21bbcc` as ImageID/manifest while the exported config is
`b40d18c3…791a1a`. Containerd-backed [Moby image inspection](https://github.com/moby/moby/blob/master/daemon/containerd/image_inspect.go)
returns the target descriptor digest as `ID`. The final shell step did not echo
its variable value, so that particular value was not separately observed in logs.
The assumption is reproduced by supplying this descriptor ID to the old config-only
predicate; all other predicates were recovered independently.

The fix names the input `EXPECTED_LOCAL_IMAGE_ID`. It accepts an exact match to
either the registry manifest digest or its config digest, and reports which form
matched alongside both digests. This covers the containerd and classic stores.
An unrelated ID still rejects. No registry lookup or credential boundary changed.

Read-only recovery verified the current registry manifest against the exact digest
printed by both Buildx export and Docker push. Its config blob hash, source commit
label, Linux/amd64 platform and cli variant match. Only the17.3MB compressed helper
layer and297-byte pin layer were downloaded. Both compressed hashes and config
DiffIDs were verified before reading their root-owned regular files. The actual
54,091,902-byte helper hashes to
`6696bfcf39d80dd4236997df87def6ba592ef27526a9d817a4b85db6e2f58be8`, matching
its image pin and the earlier local reproducible build.

The recovered image is:

```text
ghcr.io/kethalia/hive-base@sha256:30ea4d3d6271efb8b4e351d2983cc09f01cb1a92ddb7e8f889f6d21d1021bbcc
```

The corrected recorder then successfully verified that existing image using the
recovered image pin. It did not execute an image or change its tag. The original
failure, selected logs, job status, exact source hashes and recovered facts are
preserved in `workspace-image-preview-recovery.json` and
`workspace-image-preview-first-failure.txt`. The registry digest remains the
immutable deployment reference; the preview tag is an independently checked name.
