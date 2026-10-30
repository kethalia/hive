# Workspace agent identity helper

This Linux amd64 helper reads one authenticated manifest using the official Coder
Agent SDK `v2.38.4`, Agent RPC `2.11`, role `client`. It has no resource mutation,
owner credential fallback, local debug endpoint or installation behavior.

The fixed no-argument CLI reads one strict JSON object from stdin:

```json
{"schemaVersion":1,"kind":"workspace-read","coderOrigin":"https://coder.example.com","workspaceId":"11111111-1111-4111-8111-111111111111","buildId":"22222222-2222-4222-8222-222222222222","appId":"33333333-3333-4333-8333-333333333333","appOrigin":"https://hive-read--main--workspace--owner.apps.example.com","provisionalAgentId":"44444444-4444-4444-8444-444444444444"}
```

`kind` selects only `workspace-read` (`hive-read`, loopback port13342) or
`project-host` (`codex-session`, port13341). The configured HTTPS Coder origin must
match platform `CODER_AGENT_URL`. Only `CODER_AGENT_TOKEN` or its private
`CODER_AGENT_TOKEN_FILE` is consumed. Both, when present, must match. The helper
rejects links, shared/private-file permissions violations and conflicting tokens.
It does not read a Coder CLI store or `CODER_SESSION_TOKEN`.

Successful output repeats the exact input scope, supplies the authenticated
runtime `agentId`, SDK version and `manifestBindingSha256`. The digest is SHA256
of Go's compact JSON encoding of the same output struct with its digest field
omitted. It is a selected-facts integrity identifier, not a signature or hardware
attestation. The caller must independently pin the executable and effective
configuration. The provisioner-controlled manifest environment value
`HIVE_RUNTIME_BUILD_ID` must match; absent metadata fails closed. Owner UUID stays
bound by the original provisioner and Hive owner/app verification: the manifest
supplies an owner name, not owner UUID.

The connection permits only the exact RPC path, version and client role at the
pinned origin, rejects redirects and uses verified TLS with no proxy. It performs
one `GetManifest`, awaits connection close, and retains only identity/app/build
fields. The helper enforces a4MiB total incoming wire budget and64KiB outgoing wire
budget; SDK Dial uses compression disabled by default. The SDK's initial
WebSocket read limit is subsequently disabled by websocket.NetConn and is not
claimed as an effective limit. The DRPC reader has a4MiB buffer bound. Dial/TLS/headers are
bounded at3s, RPC context at8s and the entire CLI at10s. It does not claim secure
memory erasure of discarded Go allocations.

## Reproducible build

Use the official Go toolchain version pinned in `go.mod`. Keep module/build caches
outside a constrained persistent home. `go.sum` and the exact upstream Coder
module replacements are checked source inputs; no SDK source is vendored or
patched. Build/test with `GOTOOLCHAIN=local`, `GOSUMDB=sum.golang.org`,
`GOVCS=*:off`, `CGO_ENABLED=0`, `GOOS=linux`, `GOARCH=amd64`, `GOAMD64=v1`:

```sh
go test -mod=readonly -p=2 -count=1 -timeout=40s ./...
go build -mod=readonly -p=2 -trimpath -buildvcs=false \
  -ldflags='-s -w -buildid=' -o /tmp/hive-workspace-identity .
```

The local TLS integration uses the official WebSocket/yamux/DRPC libraries and
exercises the actual SDK method. The test-only `TestLiveReadOnlyManifest` is
skipped unless explicitly enabled, and belongs only in a separately compiled
reviewed diagnostic test artifact. It reports fixed booleans, never a manifest,
credential or raw upstream response. Missing build metadata is reported without
normalizing or replacing it. It is not part of the installed CLI.

Image installation and both service-installer normalization remain separate
reviewed integration steps. The binary is an image asset, not a public template
annotation or embedded runtime archive.
