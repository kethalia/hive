# Codex browser voice prototype

Hive can attach browser microphone and speaker audio to a running Codex thread.
The terminal remains available for text, tool output, and approvals. This is an
experimental integration, tested with Codex CLI/app-server **0.161.0**.

## Enable and use

Set `HIVE_CODEX_VOICE_ENABLED=true` in the Hive **web service** environment and
restart that service. It defaults to disabled. The flag is delivered through
Hive's runtime configuration; it does not require a separate frontend rebuild.
For the umbrella Helm chart, the override is:

```yaml
hive-web:
  config:
    HIVE_CODEX_VOICE_ENABLED: "true"
```

For Docker Compose, set the flag in `.env` and recreate the `app` container;
both local and production Compose configurations pass it into the web service.
If Cloudflare or another reverse proxy forwards a public hostname to a different
origin hostname, also set `HIVE_PUBLIC_ORIGIN=https://hive.example.com` on the web
service (`hive-web.config.HIVE_PUBLIC_ORIGIN` in Helm). Use the exact public
scheme, host, and optional port without a path. The route accepts the forwarded
host/protocol only when both match this configured origin. Direct same-origin
requests do not need this setting.

For multiple browser hostnames behind a reverse proxy, set
`HIVE_VOICE_ALLOWED_ORIGINS=https://hive.example.com,https://hive.local.example.com`
on the web service (`hive-web.config.HIVE_VOICE_ALLOWED_ORIGINS` in Helm). Each
entry must be an exact HTTP(S) origin without credentials, path, query, or
fragment. `HIVE_PUBLIC_ORIGIN` remains accepted alongside this list. Forwarded
host and protocol must match the requesting origin; cross-site requests remain
rejected. Set this list only with an image that supports it; older releases
ignore it.

1. Open Codex normally in the workspace terminal, using its shared app-server daemon.
2. Expand **Codex Voice (experimental)** above the terminal.
3. Select the Codex session that is open in the terminal. The picker shows its
   title, working directory, and ID suffix. Use Codex's `/status` to compare IDs
   when several sessions have similar names.
4. Click **Start voice**, grant microphone access, and speak. Replies play through
   the browser. **Mute** disables microphone tracks; **End voice** ends the call.

Use the Hive control to start browser audio. Typing the literal `/voice` command
in the remote terminal still selects Codex's native audio path. Do not start that
native call concurrently with a Hive call on the same thread.

## Connection and lifecycle

The authenticated Next.js route resolves the workspace and connected agent using
the requesting user's Coder credentials. SSH carries a WebSocket connection to
`codex app-server proxy`. Codex credentials remain in the workspace; no public
app-server listener or additional OpenAI API key is required by Hive.

Discovery reads metadata for up to 100 loaded threads, excludes subagents and
threads that reject direct input, and never resumes saved sessions or changes
their settings. Selection is explicit because a terminal pane does not expose
its current Codex thread ID to Hive. The default workspace user and `CODEX_HOME`
must match those used by the Codex terminal session; standalone `--no-daemon`
sessions and custom remote servers are outside this prototype.

The browser sends its WebRTC offer to `thread/realtime/start` with audio output
and protocol V3. Codex supplies the answer through `thread/realtime/sdp`. V3 is
required for the tested AVAS endpoint: the default protocol was rejected with
`invalid_quicksilver_alpha_header`. Media travels over WebRTC; the Hive HTTP
stream carries signaling and ten-second heartbeats, not recordings or audio
chunks. Only the small voice-specific operation set is exposed to the browser.

A workspace-local `flock` prevents overlapping Hive voice connections to the
same thread across web replicas. One page can own one microphone call. End,
component unmount, browser tab hiding, permission failure, failed WebRTC, and
stalled signaling release browser media.
Transient WebRTC disconnects get ten seconds to recover before teardown;
reconnection cancels that timer, while failed or closed peers end immediately.
Browser cancellation requests
`thread/realtime/stop` before closing SSH. Startup and RPC calls have deadlines,
and calls have a 30-minute prototype limit. Cleanup is best effort if the web
service or workspace dies abruptly; the browser still closes its media tracks.

## Verification and limits

- Unit/integration coverage includes authenticated route boundaries, bounded
  offers, selected-thread filtering, RPC failures, cancellation, late microphone
  grants, mute, and preventing concurrent microphone use.
- `e2e/codex-voice.spec.mjs` exercises real Chrome microphone/WebRTC APIs with
  synthetic audio, incoming playback, denial, mute/unmute, and cleanup. It uses
  the production stylesheet and checks desktop and mobile viewport overflow.
- Live verification used an isolated ephemeral thread on the 0.161.0 daemon,
  Chrome in Browser Testing, and silent microphone input. WebRTC connected;
  `thread/realtime/appendSpeech` produced measurable incoming audio for “Ready.”
  Existing work threads were not used for this probe.
- This proves the transport and spoken output. Physical microphone acoustics,
  Safari/iOS, sustained conversation, and live tool-approval interactions still
  need interactive user testing. Availability also depends on Codex account
  access to voice and its experimental protocol remaining compatible.

Browser checks belong to the `browser-testing` profile. During implementation,
the disposable `voice-browser-test` workspace supplied Chrome; evidence is
preserved in the primary checkout under `.artifacts/voice/` before cleanup.
