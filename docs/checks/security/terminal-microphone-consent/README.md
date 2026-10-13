# Terminal microphone consent validation

The production terminal audio controller and React approval controls were tested
in disposable Browser Testing workspace `daniel/hive-microphone-consent-check`.
Implementation remained in the primary software workspace; browser evidence was
copied here before cleanup. The temporary workspace's owner login was revoked
after checking its owner, creation time, and distinction from the primary key.

## Checks

- 70 targeted Vitest tests pass: browser controller, approval UI, and terminal
  Enter/Compose playback integration.
- 26 Chrome checks pass: 13 cases each on desktop and mobile Chromium, using
  fake microphone input and real browser permissions, audio contexts, and worklets.
- Biome, TypeScript, and diff checks pass.

The adversarial case submits `ls` with Enter, then starts a workspace capture
request during the former 15-second arm. Browser microphone permission is already
granted. Before explicit approval, both browser profiles make zero microphone
permission requests and send zero PCM frames. Approval starts real browser audio;
Stop ends every track. A subsequent workspace request requires another approval.

Other browser checks cover permission denial, parking/freeze and focus changes,
separate terminal sessions, pending grants, duplicate views, and cross-device
ownership. Unit regressions additionally cover omitted/false claim flags,
reconnection/remounting, claim cancellation, late grants after Stop, and queued
clicks against replacement requests or terminal identities.

The same adversarial test fails with the three production audio/controller files
restored from `27f7301`, while keeping identical test instrumentation and ticket
fixtures. The original code opens microphone access without approval; the
baseline observation and expected failure are preserved alongside the passing
desktop/mobile observations.

## Evidence and scope

`chrome-validation.txt` contains the passing browser run. The PNG files show
desktop/mobile approval, an approved call with Stop, and focus-paused calls.
`desktop-unapproved-capture.json` and `mobile-unapproved-capture.json` record
the pre-approval browser/media counts. `baseline-observation.json` and
`baseline-regression.txt` capture the original failure.

The ticket endpoint and workspace broker are simulated to isolate this browser
consent boundary. These checks do not prove the deployed stack's behavior or
isolate individual workspace processes sharing an approved virtual microphone.
Deploy the updated web client and refresh existing views before live verification
or closing either Security Cloud finding.
