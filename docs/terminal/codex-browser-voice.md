# Native Codex voice through the browser

Hive forwards browser microphone and speaker audio to the virtual audio devices
of each workspace terminal. Codex uses its own native `/voice` command and its
current session. Microphone approval appears inside the requesting terminal.

## Use

1. Focus the Hive window and the terminal containing Codex, then type `/voice`.
2. Click **Enable microphone** in that terminal.
3. Allow microphone access to the Hive website or installed PWA when prompted.
4. Speak normally. Codex replies play through the browser. Click **Stop microphone**
   or use Codex's `/voice` command to end voice.

The bridge is enabled by default. Opening a native capture stream requests audio;
the browser only starts microphone access after explicit approval in Hive.
An idle terminal does not request or hold the microphone. A small status message
appears for a request, connection, active call, paused call, or error. Hive requires
approval for every new call, even when browser permission is already granted.
HTTPS (or localhost) and Web Audio/AudioWorklet
support are required. Pressing Enter in the terminal enables playback under
browser autoplay rules.

The focused terminal can start a new call. When a toolbar control has
focus outside the terminal, the selected pane can start it instead. Changing
pane, workspace, tab, or window focus keeps existing calls connected and pauses
microphone input and speaker playback in every unfocused pane. Only the focused,
selected pane sends your voice and plays replies. Returning to a paused pane
resumes the same call without another claim or microphone permission request.
Enter and touch Enter only unlock speaker playback. They never
approve microphone capture. Approval applies to the current pending request in
the selected terminal, and is not retained after capture ends, a connection
fails, or the terminal's audio bridge remounts. If a request ends before you
approve it, run `/voice` again. A view left open on an unused device cannot claim
a call solely because its browser still reports focus. Background views do not
reserve an idle relay.

Approval enables that terminal's virtual microphone. Workspace programs with
access to the same virtual device can read audio during the approved call;
the approval does not identify or isolate an individual workspace process.

Hiding the browser tab or parking the terminal pauses its audio and shows “Voice
paused — focus this pane to resume” when its status is visible. Paused calls
retain their relay and microphone stream, with microphone tracks disabled and
queued audio discarded. Codex tasks keep running. Ending native voice, losing
the connection, denying or revoking permission, or disposing the terminal
releases browser audio and disconnects the native audio streams.

When returning, Hive resumes a suspended or interrupted browser audio context
before enabling audio or showing “Voice connected”. The playback startup deadline
runs only while the pane is focused. If autoplay still requires a gesture, press
Enter in the selected pane. Browser freeze/resume events and delayed heartbeat
timers trigger a fresh liveness probe; actual connection failures still end calls.

One terminal view owns a session's audio. Different terminal sessions can keep
voice calls connected simultaneously, each using its own virtual microphone and
speaker devices; focus determines which call exchanges browser audio. Browsers
with Web Locks prevent duplicate calls for the same terminal across Hive tabs
and PWA windows at the same origin. The workspace broker also enforces one
active view per terminal across devices. After fixing permission or connection
errors, wait for reconnection and run `/voice` again. If a call ends while its
browser permission prompt is open, finish that prompt before retrying that
terminal's call. Its microphone reservation remains held until the request
settles; a late grant is stopped without sending audio.

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

The new broker lets idle views observe capture activity without owning audio.
Deploy the matching terminal proxy and web application before restarting onto the
new workspace image. Refresh older Hive views on all devices after deployment.
The web client retains compatibility with the old relay handshake, whose idle
ownership behavior remains until the workspace is upgraded.
Explicit browser microphone approval applies to both relay handshakes. Deploy
the updated web application and refresh existing Hive views to enforce it;
this consent change does not require a new workspace image or terminal proxy.

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

The browser opens an authenticated audio WebSocket for a visible, focused terminal.
An owned call retains its connection across pane, workspace, tab, and window
focus changes, with browser microphone and playback paused while unfocused.
The matching terminal proxy advertises support for playback focus generations.
It suppresses speaker delivery while paused and tags subsequent frames with the
current generation. The browser rejects older generations, including messages
queued while its tab was frozen. Older clients retain their previous frame format;
deploy both the web client and terminal proxy to enable this protection.
The AudioWorklet also tags microphone packets with their capture generation, so
packets already queued on its MessagePort before pausing cannot be sent when
focus resumes. This metadata stays inside the browser; upstream microphone PCM
keeps its existing format.
The proxy starts `hive-audio relay -- <session>` through the existing Coder PTY API.
That relay observes the session broker without claiming its devices. Native
capture notifies observers; a recently armed, focused view claims the call before
requesting microphone permission. Only the owner sends capture PCM or receives
speaker PCM. Other observers cannot stop or take over an active call. Audio uses 48 kHz
mono signed 16-bit PCM in bounded ten-millisecond frames. The AudioWorklet and
workspace broker discard stale samples when consumers stall. Audio is not stored
in files or logs. Heartbeats and deadlines release abandoned connections.

Closing the native capture stream releases the browser microphone and playback
context. A paused (PulseAudio "corked") stream still belongs to the same call and
retains browser ownership until it closes. Pausing and resuming capture therefore
does not cancel a permission request or allow another pane to claim the call.
Browser release stops the session audio server if native streams are open,
disconnecting capture/playback. A subsequent relay recreates the same devices.
Brokers retain
devices while a tmux session references them, and exit after five idle minutes once
that session is gone. Workspace shutdown terminates these processes normally.

## Verification

- Python broker tests cover idle observers, cross-device call ownership,
  capture pause/resume, malformed PCM,
  release, and owner expiry.
- Terminal proxy tests cover authorization, bounded frames, fragmented PTY output,
  startup heartbeats, backpressure, and disconnect cleanup.
- Browser unit tests cover focus gating, late grants, pending permission
  reservations, concurrent calls, stale media callbacks, denial, and cleanup.
- `e2e/terminal-audio.spec.mjs` uses real Chrome microphone and AudioWorklet APIs
  with synthetic input and an emulated workspace relay. Desktop, tablet, and mobile
  viewport tests cover PCM in both directions, denial, parking without disconnecting,
  per-terminal microphone ownership across windows, concurrent terminal calls,
  unused-device observers, takeover rejection, focus gating, focused microphone and
  speaker routing, pending permission cancellation, and touch input outside xterm.
- A separate live probe used the unmodified Codex **0.161.0** native voice helper,
  an isolated ephemeral Codex thread, and the production PulseAudio broker. Spoken
  output produced measurable speaker samples; a synthetic tone reached native
  capture. Browser release disconnected the native capture stream.
- A Codex **0.162.1** regression probe reproduced missing ALSA plugins at
  `/usr/lib/alsa-lib`. Selecting the installed Debian plugin directory let the
  unmodified helper stay active for sixteen seconds, deliver nonzero speaker
  samples, receive an injected microphone tone, and reconnect after release.
  The updated image smoke test rejects the missing upstream plugin directory.
- An isolated ALSA/PulseAudio lifecycle probe reproduced browser ownership being
  released while the native capture stream remained open but corked. With the
  updated broker, the same stream retains ownership through pause/resume and
  releases it when closed.

Browser validation runs in the `browser-testing` profile. Evidence is preserved
in the primary checkout under `.artifacts/voice-bridge/` and
`.artifacts/voice-ownership/` and `.artifacts/per-terminal-voice/`. These checks do not cover
physical microphone acoustics, Safari/iOS, long conversations, or live approval
interactions. Codex account access and compatibility with its experimental native
voice feature remain necessary. The container image build and image smoke tests
run in CI; they cannot run in the primary workspace without a Docker runtime.
