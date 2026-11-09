# Completed test workspace storage release

Status: proposal only; owner approval pending. No deletion has occurred.

## Exact target

- Coder: `https://coder.kethalia.com`.
- Workspace: `daniel/hive-infra-4gi-1108`.
- Workspace UUID: `76a2812a-ea32-48da-89ca-538fcd64f6a2`.
- Owner UUID: `3b232194-5c7d-41f0-834d-e7fe6911ebc0`.
- Template UUID: `78c1aaa0-ff41-4a88-b1c3-909c16d85e34`.
- Created: `2026-11-08T21:50:10.112691Z`.
- Current stopped build: `1aa83712-d2b9-4f32-ad54-7a53cab63f3e`.
- HOME PVC: `coder-76a2812a-ea32-48da-89ca-538fcd64f6a2-home`.
- PVC UID: `838cd8ea-9da5-47a7-94f9-1c7d14d905fd`.
- PV/Longhorn volume: `pvc-838cd8ea-9da5-47a7-94f9-1c7d14d905fd`.

The primary's original creation record identifies this as an unmanaged persistent
test workspace. It has no signed disposable-cleanup receipt. Fresh inspection
matches all four identity fields and the original successful stop; no newer build
or active task has replaced the completed database-capture task.

## Preserved work and deletion effect

The bounded Infrastructure task captured the production database read-only and
returned its evidence. Twelve private capture files remain in the primary
workspace with permissions 0600, alongside the earlier attempt and selected-key
evidence. The original transfer verified binary hashes and full archive decoding;
the owned capture process exited and its listener closed. The later local restore,
decryption and schema-upgrade rehearsals use these primary copies.

The proposal permanently deletes this test workspace and its 4Gi HOME, including
its remaining temporary files and tool caches. The preserved capture is not a full
HOME snapshot. Its primary copies remain available for the roadmap.

## Why this unblocks validation

The clean software test workspace `codex/hive-epic-1109` exists, but its new 4Gi
volume reports `ReplicaSchedulingFailure: insufficient storage`. Its Pod is
scheduled, and neither container has started. Read-only inspection finds physical
space available, but the current 100% provisioning limit leaves less than 4Gi of
allocatable reservation on each disk. Longhorn checks requested plus scheduled
space against that limit, independently of actual free bytes.
[Scheduling reference](https://longhorn.io/docs/1.13.0/nodes-and-volumes/nodes/scheduling/).

The completed Infrastructure disk has two stopped, nonfailed 4Gi replicas on
`k3s-02` and `k3s-03`. Its PV has reclaim policy `Delete`. Normal workspace deletion
should release 4Gi of scheduled reservation on each of those disks, enough for the
new test volume's two 4Gi replicas under the observed capacity snapshot. This is an
expected outcome to verify, not a claim that cleanup or attachment has succeeded.

## Execution after approval

Recheck the original creation record against fresh workspace identity, latest
stopped build, PVC UID and PV association. Confirm the preserved capture files and
the completed task. Submit one normal Coder delete build for this exact workspace
using its existing template version `9861dba6-d20a-4dd4-8642-84947eadb981`. An unknown
acknowledgment permits read-only reconciliation, not another delete request.

Observe normal provider reclamation and the already-created software test Pod.
Record the delete result and actual capacity/attachment outcome. No cluster-wide
storage setting change or production cutover is included.

The workspace retention rule requires explicit owner confirmation of this exact
persistent target before deletion. The proposal does not classify it as disposable
or create a cleanup receipt retroactively.
