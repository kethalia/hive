# Native Codex voice through the browser

Hive forwards browser microphone and speaker audio to the virtual audio devices
of each workspace terminal. Codex uses its own native `/voice` command and its
current session. There is no session picker or separate Start voice bar.

## Use

1. Open Codex in a Hive terminal and type `/voice`.
2. Allow microphone access to the Hive website or installed PWA when prompted.
3. Speak normally. Codex replies play through the browser. Use Codex's `/voice`
   command to end voice.

The bridge is enabled by default. Microphone access starts only when the native
application opens its capture stream. An idle terminal does not request or hold
the microphone. A small status message appears during connection, an active call,
or an error. Browser permission settings determine whether future calls prompt
again. HTTPS (or localhost) and Web Audio/AudioWorklet support are required.
Pressing Enter in the terminal enables playback under browser autoplay rules.

Hiding the browser tab, parking the terminal, losing the connection, denying or
revoking permission, and closing the terminal release browser audio and disconnect
the native audio streams. Keep the terminal visible during a call. One terminal
view owns a session's audio, and one call owns a page's microphone. Browsers with
Web Locks also enforce one microphone owner across Hive tabs and PWA windows at
the same origin. End the first call before starting voice in another session;
other sessions can keep running text and tools. After fixing
permission or connection errors, wait for reconnection and run `/voice` again.

## Rollout

Deploy matching versions of **hive-web**, **hive-terminal**, and the **hive-base
workspace image**. The base image installs `hive-audio`, PulseAudio, and the ALSA
Pulse plugin in every profile. These are virtual audio devices; no `/dev/snd`,
privileged container, desktop, SSH listener, or extra OpenAI API key is needed.
The image also exposes Debian's ALSA plugins at `/usr/lib/alsa-lib`, the upstream
path used by Codex's bundled ALSA. Image smoke tests force this plugin path when
opening the default capture and playback devices, so the system ALSA library's
Debian-specific lookup cannot conceal a missing compatibility path.

Update the templates' pinned workspace image digest through the normal image
rollout, restart the workspace, and open a **new terminal session**. Existing tmux
shells and Codex processes retain their old environment; reconnecting an existing
terminal does not change that environment. Older workspace images still support
ordinary terminal use and report that their audio helper is unavailable.

The terminal proxy's existing `ALLOWED_ORIGINS`, Hive cookie authentication, Coder
credentials, and workspace/agent authorization also protect `/ws/audio`. Ensure
the ingress forwards this WebSocket route to the terminal proxy just as it does
`/ws`. No new public workspace port is required.

`HIVE_CODEX_VOICE_ENABLED` and the old web voice route's origin settings belong to
the retained prototype API. They do not enable or configure this native bridge,
and the old control bar is no longer rendered.

## Transport and lifecycle

The terminal's launch command prepares a private PulseAudio server and passes its
`PULSE_SERVER` to the new tmux session. This environment variable is preserved by
Codex's native voice helper. The system ALSA default points to the Pulse plugin.
Each terminal gets separate microphone and speaker null sinks, so audio cannot
cross terminal sessions. The broker follows the session's recorded `PULSE_SERVER`
across tmux renames; reusing the old name allocates separate devices. Session names
follow the same validation as ordinary terminals and are hashed into fixed-length
device paths. Nothing alters Codex's binary, thread selection, voice
protocol, or account credentials.

The browser opens an authenticated audio WebSocket while the terminal is visible.
The proxy starts `hive-audio relay -- <session>` through the existing Coder PTY API.
That relay claims the session broker; a second view is rejected. Native capture
activity triggers the browser microphone request automatically. Audio uses 48 kHz
mono signed 16-bit PCM in bounded ten-millisecond frames. The AudioWorklet and
workspace broker discard stale samples when consumers stall. Audio is not stored
in files or logs. Heartbeats and deadlines release abandoned connections.

Ending native capture releases the browser microphone and playback context.
Browser release stops the session audio server if native streams are open,
disconnecting capture/playback. A subsequent relay recreates the same devices.
Brokers retain
devices while a tmux session references them, and exit after five idle minutes once
that session is gone. Workspace shutdown terminates these processes normally.

## Verification

- Python broker tests cover ownership, malformed PCM, release, and owner expiry.
- Terminal proxy tests cover authorization, bounded frames, fragmented PTY output,
  startup heartbeats, backpressure, and disconnect cleanup.
- Browser unit tests cover late grants, concurrent calls, denial, and cleanup.
- `e2e/terminal-audio.spec.mjs` uses real Chrome microphone and AudioWorklet APIs
  with synthetic input and an emulated workspace relay. All twelve desktop, tablet,
  and mobile viewport tests cover PCM in both directions, denial, parking, and
  microphone ownership across windows.
- A separate live probe used the unmodified Codex **0.161.0** native voice helper,
  an isolated ephemeral Codex thread, and the production PulseAudio broker. Spoken
  output produced measurable speaker samples; a synthetic tone reached native
  capture. Browser release disconnected the native capture stream.
- A Codex **0.162.1** regression probe reproduced missing ALSA plugins at
  `/usr/lib/alsa-lib`. Selecting the installed Debian plugin directory let the
  unmodified helper stay active for sixteen seconds, deliver nonzero speaker
  samples, receive an injected microphone tone, and reconnect after release.
  The updated image smoke test rejects the missing upstream plugin directory.

Browser validation runs in the `browser-testing` profile. Evidence is preserved
in the primary checkout under `.artifacts/voice-bridge/`. These checks do not cover
physical microphone acoustics, Safari/iOS, long conversations, or live approval
interactions. Codex account access and compatibility with its experimental native
voice feature remain necessary. The container image build and image smoke tests
run in CI; they cannot run in the primary workspace without a Docker runtime.
