# Ordinary clipboard upload on Workers (F07)

This disabled slice preserves the existing multipart POST and `{paths}` response
for terminal clipboard files. `HIVE_TERMINAL_PASTE_ENABLED` must explicitly equal
`true`; no deployment, provider write, resource or flag was enabled here. Node's
SSH implementation remains the Node dispatch. There is no new workspace service,
database model, browser command selector or arbitrary file/URL API.

## Contract and authority

The exact workspace UUID route accepts same-origin POST only, with the existing
signed Hive session cookie, strict multipart file fields, no alternate bearer,
query or encoded request body. Current private auth, fixed Coder origin, actual
Coder principal, workspace owner, current running build and a unique connected
agent must match. The shared generic-terminal authorization was extracted without
changing its ticket contract. Private auth/provider reads retain five-second,
bounded-response and redirect rejection rules. Owner/build checks repeat after
body admission and approximately every20 seconds during upload.

The UI still uploads at most10 files,10 MiB each and20 MiB total; multipart
overhead remains bounded at21 MiB. A Worker admits one upload at a time per
isolate to bound multipart/File/copy memory; Node retains its existing four-slot
admission. This is local capacity rather than a global quota. Multipart reads now
race caller abort even if a custom stream's read/cancel never completes, and have
a65,536-chunk CPU bound. No UI changes or extra upload round trips are required.

Files still go to `/tmp/hive-terminal-paste/<random-UUID>-<sanitized-name>`.
There is no caller CWD/path selector: the existing clipboard contract returns
absolute temporary paths independent of the selected shell directory. The target
directory must be an owned0700 directory opened without symlink traversal. The
helper takes a nonblocking exclusive lock on that open directory for its lifetime;
an unknown still-running helper causes another attempt to fail before READY,
rather than queueing another upload on the same inode. The
helper creates0600 partial files with exclusive/no-follow open, verifies SHA-256
and exact length, fsyncs, links to a new final name without replacement, verifies
the published regular-file inode and fsyncs the directory before its file ACK.
Existing files and preexisting partials are retained on collision. Completed
files from earlier batch entries remain if a later entry fails, as with the
existing sequential upload behavior. No acknowledged user file is auto-deleted.

## Fixed PTY protocol and failure

The existing official Coder reconnecting PTY endpoint carries a server-owned
command invoking `/usr/bin/python3 -I`. The helper sets raw/no-echo mode before
sending its random nonce READY. Only fixed typed manifest/file-start/base64 chunk
frames follow. Each16 KiB chunk is ACK paced, and a final file ACK binds nonce,
index, size, digest and exact generated path. Workspace bytes or raw diagnostics
are never returned as errors, logs or tool context. There is no user-chosen
command, new tmux session, CLI owner credential copy or generic execution API.
[Coder PTY endpoint](https://github.com/coder/coder/blob/v2.38.4/codersdk/workspacesdk/workspacesdk.go#L383),
[binary input protocol](https://github.com/coder/coder/blob/v2.38.4/codersdk/workspacesdk/agentconn.go#L231).

The Worker bounds handshake at10 seconds, each ACK at5 seconds, total request at
120 seconds and output at1 MiB/8,192 messages/8 KiB per delivered message or line.
The Python helper independently alarms after110 seconds and removes only its own
unpublished partial on exception. Closing the transport does not prove remote
process death, kernel quiescence or absence of a file published before a lost ACK.
There is no reconnect/retry of an uncertain upload. The fixed helper's deadline
limits its lifetime; successful ACKs prove this protocol's completed writes, not
external writer quiescence. As with generic terminal relay, delivered WS bounds
do not prevent the platform's initial message allocation.

## Audit of remaining baseline paths

| Path | Current live caller and remaining work |
| --- | --- |
| Clipboard upload | Terminal clipboard UI; this slice replaces its SSH transport when explicitly enabled. |
| Voice | `CodexVoiceControls`/`BrowserVoice`; Node SSH+`ws` proxy to an existing CLI app-server, loaded-thread listing and bounded realtime start/stop signaling. Existing installed read/host endpoints have no voice route. Remains blocked on Workers. |
| Agent tools | `AgentToolsPanel`; inspect/install/disable/configure/resume use SSH-dispatched Python. Mutations and inventory need a separately reviewed installed fixed operation adapter. |
| Settings | Live Settings uses push preferences/subscription/test-push server actions and notification-source hook installation/deletion. Hook installation uses SSH and must preserve credential staging/confirmation. The old terminal-settings action exports have no live UI caller, so merely allowlisting them would not complete Settings parity. |

## Local evidence and limits

Actual Python PTY tests cover binary data, digest and private permissions, ten
empty files, invalid paths, bad hash cleanup, directory symlinks, existing files,
preexisting partial symlinks and self-timeout. That last adversarial partial test
found and corrected cleanup of a name whose exclusive open had failed; cleanup
now begins only after this helper actually creates its partial.

The actual local workerd proof uses explicit synthetic private auth/Coder service
bindings, real WS upgrade/binary framing and the exact fixed command. It verifies
20 MiB across two10 MiB files, digest/path ACKs, empty files, default-off, origin
and session checks, revoked access and wrong/lost ACK without retry. The provider
double does not execute Python; the real Python PTY suite independently exercises
the same embedded source. This is not real Coder, browser, production performance,
Free-tier CPU-limit or deployed-provider acceptance. No raw clipboard content is
stored in the repository evidence. Exact sources/results are under
`terminal-paste-local/`; installed/live preview and browser acceptance remain gates.
