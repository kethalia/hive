# Desktop listener isolation

Validated on 2026-10-13 in disposable Browser Testing workspace
`daniel/hive-desktop-isolation-check` (`4bed84ef-fb9d-4ecf-913a-ec06f33827fd`).
The current pinned image supplies KasmVNC 1.4.0 and Chrome 155. The repository's
guard was compiled in that workspace, and the launcher ran with only its library
path substituted to the task directory. Source hashes for the initial validation are recorded in
`verification.json` and `browser-report.json`.

The pinned Coder KasmVNC module 1.3.0 already selects loopback TCP but disables
BasicAuth, permits existing user configuration to override the listener, and
starts an independent wildcard UDP listener. The observed baseline had UDP
`0.0.0.0:6080` despite the TCP loopback setting. KasmVNC 1.4.0 always creates
WebUDP when creating its WebSocket listener and has no UDP-disable flag: zero
selects the WebSocket port. Sources:
[Coder module](https://registry.coder.com/modules/coder/kasmvnc),
[WebSocket/UDP initialization](https://github.com/kasmtech/KasmVNC/blob/v1.4.0/common/network/TcpSocket.cxx#L722),
[UDP parameter](https://github.com/kasmtech/KasmVNC/blob/v1.4.0/common/rfb/ServerCore.cxx),
[configuration precedence](https://www.kasmweb.com/kasmvnc/docs/master/man/vncserver.html).

The bind guard is a small native library loaded only into the managed Xvnc
process. It denies all non-loopback IPv4/IPv6 binds, including UDP, and allows
Unix sockets. The launcher tests the guard before startup, overrides network
options while preserving other Kasm settings, disables raw RFB/X11 TCP, and
verifies the actual backend socket ownership before declaring readiness.
Desktop applications start without the guard. Missing or unloadable libraries
fail startup after retiring the previous managed display.

Results:

- The backend owns exactly TCP `127.0.0.1:6080`; no UDP, raw VNC, or X11 TCP listener.
- Peer probes from the software workspace are refused on 6080, 5901, and 6001.
- Anonymous users cannot open the real Coder desktop app. The configured owner
  connects, receives the desktop over WebSocket, types into a real xterm, and reconnects.
- A persisted user config requesting `0.0.0.0`, port 6099, and IPv6 cannot widen
  the listener. Its custom 1100×700 resolution and frame rate 35 are preserved.
- A stale PID file naming the launcher’s parent cannot terminate that unrelated process.
- Four native/config/startup regressions and all 46 template tests pass.
- Read-only Terraform fmt/init/validate passes with no diagnostics in reused
  Infrastructure workspace `daniel/backup-targeted-recovery`. Its temporary
  files were removed; the workspace remains assigned to its existing task.

The browser harness is `e2e/desktop-listener-isolation.mjs`. Run it only in
Browser Testing, passing `appUrl`, the expected `coderUrl`, a fresh owner app `authRedirect`, and
`artifactDir` through stdin JSON. Obtain the redirect via Coder's authenticated
application API and keep its signed proof out of logs and saved artifacts.
The harness uses installed Chrome and the repository-pinned Playwright version.

This verifies the existing Coder app/agent proxy plus the repository launcher on
the current image. New image construction is checked in PR CI; template/image
rollout remains separate. No second authenticated user's account or retired
Council deployment was inspected. Security Cloud finding state is unchanged.

Review follow-up: the anonymous check now requires a successful response from
the configured Coder origin at `/login` with a visible sign-in button. A missing
canvas or arbitrary redirect cannot pass. Five Chrome regressions cover a valid
login, delayed public desktop, blank page, unexpected login origin, and error
response. The corrected harness passed all four checks against the real Coder
app in disposable workspace `daniel/hive-desktop-review-check`. Current source
hashes, regression results, and cleanup are in `review-verification.json`; the
live login evidence is in `review-browser-report.json`. Run the regressions in
Browser Testing with `node --test e2e/desktop-anonymous-denial-regressions.mjs`.
