# Workspace app isolation validation

Chrome desktop and mobile checks passed for the production tool panel, app-origin
validation, framing policies, and retired proxy responses. The harness simulates
Coder app authentication and app content; it does not connect to a live Coder
deployment or run File Browser/KasmVNC binaries.

The checks cover blocked Hive DOM/API reads, absence of Hive cookies and Coder
API headers in app requests, blocked microphone capture even after a Hive grant,
independent top-level app permission state, cookie-overlapping host rejection,
desktop fullscreen/tab continuity, and inert legacy navigation/script requests.

The workspace `hive-proxy-isolation-browser` was created as disposable for this
task. Its immutable ID, provenance, browser version, source hashes, and results
are recorded in [verification.json](verification.json). The full test report is
preserved in [browser-report.json](browser-report.json).

- [Desktop File Browser boundary probe](screenshots/desktop-filebrowser.png)
- [Mobile File Browser boundary probe](screenshots/mobile-filebrowser.png)
- [Desktop tool frame](screenshots/desktop-desktop.png)
- [Mobile tool frame](screenshots/mobile-desktop.png)

Reproduce in Browser Testing from the repository root:

```bash
pnpm exec playwright test e2e/workspace-app-isolation.spec.mjs --project=desktop-chromium --project=mobile-chromium --workers=1
```

The harness uses the workspace's installed Chrome. It creates only temporary TLS
fixtures and loopback HTTPS servers, then closes those servers and removes its
certificate directory. Dependency installation uses the repository lockfile;
no browser or system-dependency installer is required.
