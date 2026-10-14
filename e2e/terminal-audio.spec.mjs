import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";
import { WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
let server, wss, url;
let connections = new Set();
let microphoneFrames = 0;
let speakerTimer;
const activeCalls = new Map();
const sessionNames = new WeakMap();
const sessionFrames = new Map();
const owners = new Map();
const playback = new WeakMap();

test.use({
  channel: "chrome",
  permissions: ["microphone"],
  launchOptions: {
    args: ["--use-fake-device-for-media-stream"],
  },
});
test.describe.configure({ mode: "serial" });
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Native terminal audio is validated with Chrome.",
);

test.beforeAll(async () => {
  const styles = await postcss([tailwindcss()]).process(
    await readFile("src/app/globals.css", "utf8"),
    { from: "src/app/globals.css" },
  );
  const worklet = await readFile("public/hive-audio-worklet.js");
  const bundle = await build({
    entryPoints: ["e2e/fixtures/terminal-audio.tsx"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  server = createServer(async (req, res) => {
    if (req.url === "/api/auth/terminal-ticket" && req.method === "POST") {
      // Isolate the microphone boundary from the separately tested auth service.
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ticket: `fixture.${"a".repeat(43)}` }));
    } else if (req.url === "/bundle.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(bundle.outputFiles[0].contents);
    } else if (req.url === "/style.css") {
      res.setHeader("Content-Type", "text/css");
      res.end(styles.css);
    } else if (new URL(req.url, "http://localhost").pathname === "/hive-audio-worklet.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(worklet);
    } else if (req.url.startsWith("/native?")) {
      let command = "";
      for await (const part of req) command += part;
      if (command === "/voice") {
        const sessionName = new URL(req.url, "http://localhost").searchParams.get("sessionName");
        const active = !activeCalls.get(sessionName);
        activeCalls.set(sessionName, active);
        if (!active) owners.delete(sessionName);
        for (const socket of connections)
          if (sessionNames.get(socket) === sessionName)
            socket.send(JSON.stringify({ type: "active", active }));
      }
      res.end("ok");
    } else if (req.url === "/lock-page") {
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><title>Other Hive window</title>");
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script src="/bundle.js"></script></body></html>',
      );
    }
  });
  wss = new WebSocketServer({ server });
  wss.on("connection", (socket, req) => {
    const sessionName = new URL(req.url, "http://localhost").searchParams.get("sessionName");
    sessionNames.set(socket, sessionName);
    connections.add(socket);
    socket.send('{"type":"ready","claimRequired":true,"playbackGeneration":true}');
    socket.send(JSON.stringify({ type: "active", active: !!activeCalls.get(sessionName) }));
    socket.on("message", (raw) => {
      const value = JSON.parse(raw.toString());
      if (value.type === "playback") playback.set(socket, value);
      if (value.type === "claim") {
        if (owners.has(sessionName) && owners.get(sessionName) !== socket)
          socket.send(
            '{"type":"error","code":"session_busy","message":"Audio is already connected in another view of this terminal."}',
          );
        else if (activeCalls.get(sessionName)) {
          owners.set(sessionName, socket);
          socket.send('{"type":"claimed"}');
        } else socket.send('{"type":"active","active":false}');
      }
      if (
        value.type === "microphone" &&
        owners.get(sessionName) === socket &&
        activeCalls.get(sessionName)
      ) {
        expect(Buffer.from(value.pcm, "base64").length).toBe(960);
        microphoneFrames++;
        sessionFrames.set(sessionName, (sessionFrames.get(sessionName) ?? 0) + 1);
      }
      if (value.type === "ping") socket.send('{"type":"pong"}');
      if (value.type === "release") {
        socket.close();
      }
    });
    socket.on("close", () => {
      connections.delete(socket);
      if (owners.get(sessionName) === socket) {
        owners.delete(sessionName);
        activeCalls.set(sessionName, false);
        for (const view of connections)
          if (sessionNames.get(view) === sessionName) view.send('{"type":"active","active":false}');
      }
    });
  });
  let sample = 0;
  speakerTimer = setInterval(() => {
    const pcm = Buffer.alloc(960);
    for (let i = 0; i < 480; i++)
      pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * sample++) / 48_000)), i * 2);
    for (const socket of connections)
      if (
        activeCalls.get(sessionNames.get(socket)) &&
        owners.get(sessionNames.get(socket)) === socket &&
        playback.get(socket)?.enabled
      )
        socket.send(
          JSON.stringify({
            type: "speaker",
            pcm: pcm.toString("base64"),
            generation: playback.get(socket).generation,
          }),
        );
  }, 10);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(() => {
  microphoneFrames = 0;
  activeCalls.clear();
  sessionFrames.clear();
  owners.clear();
});
test.afterEach(() => {
  for (const socket of connections) socket.close();
  connections = new Set();
});
test.afterAll(async () => {
  clearInterval(speakerTimer);
  wss.close();
  await new Promise((resolve) => server.close(resolve));
});
async function voice(page, sessionName = "test") {
  await page.bringToFront();
  const terminal = page.getByRole("textbox", {
    name: sessionName === "test" ? "Terminal input" : `${sessionName} terminal input`,
  });
  const pane = page.locator(`[data-session="${sessionName}"]`);
  const stopping = (await pane.getByRole("button", { name: "Stop microphone" }).count()) > 0;
  await terminal.fill("/voice");
  await terminal.press("Enter");
  if (!stopping) await pane.getByRole("button", { name: "Enable microphone" }).click();
}

test("background capture after ordinary Enter cannot use an already-granted microphone", async ({
  page,
  request,
}, testInfo) => {
  await page.goto(url);
  await expect.poll(() => connections.size).toBe(1);
  const input = page.getByRole("textbox", { name: "Terminal input" });
  await input.fill("ls");
  await input.press("Enter");
  // Simulate an arbitrary workspace recorder starting during the former 15s arm.
  await request.post(`${url}/native?sessionName=test`, { data: "/voice" });
  await input.press("Enter");
  await page.waitForTimeout(300);
  const observation = {
    ...(await page.evaluate(() => ({
      permissionRequests: window.audioProbe.requests,
      tracks: window.audioProbe.tracks.map((track) => track.readyState),
    }))),
    microphoneFrames,
    owners: owners.size,
  };
  const observationPath = testInfo.outputPath("unapproved-capture-observation.json");
  await writeFile(observationPath, `${JSON.stringify(observation, null, 2)}\n`);
  await testInfo.attach("unapproved-capture-observation", {
    path: observationPath,
    contentType: "application/json",
  });
  expect(observation.permissionRequests).toBe(0);
  expect(microphoneFrames).toBe(0);
  expect(owners.size).toBe(0);
  await expect(page.getByRole("button", { name: "Enable microphone" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("microphone-approval-required.png") });
  await page.getByRole("button", { name: "Enable microphone" }).click();
  await expect(page.getByRole("status")).toHaveText("Voice connected");
  await expect.poll(() => microphoneFrames).toBeGreaterThan(5);
  await page.getByRole("button", { name: "Stop microphone" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.audioProbe.tracks.every((track) => track.readyState === "ended")),
    )
    .toBe(true);
  await expect.poll(() => connections.size).toBe(1);
  await request.post(`${url}/native?sessionName=test`, { data: "/voice" });
  await expect(page.getByRole("button", { name: "Enable microphone" })).toBeVisible();
  await input.press("Enter");
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.audioProbe.requests)).toBe(1);
  expect(owners.size).toBe(0);
});

test("native /voice requires approval, exchanges PCM, and releases media on end", async ({
  page,
}, testInfo) => {
  await page.goto(url);
  await expect.poll(() => connections.size).toBe(1);
  expect(await page.evaluate(() => window.audioProbe.tracks.length)).toBe(0);
  await expect(page.getByText("Start voice", { exact: true })).toHaveCount(0);
  await voice(page);
  await expect(page.getByRole("status")).toHaveText("Voice connected");
  await expect.poll(() => microphoneFrames).toBeGreaterThan(5);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const analyser = window.audioProbe.analysers.at(-1);
        if (!analyser) return 0;
        const values = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(values);
        return Math.max(...values.map((value) => Math.abs(value - 128)));
      }),
    )
    .toBeGreaterThan(10);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("native-voice-connected.png") });
  await voice(page);
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.audioProbe.tracks.every((track) => track.readyState === "ended")),
    )
    .toBe(true);
  expect(
    await page.evaluate(() =>
      window.audioProbe.contexts.every((context) => context.state === "closed"),
    ),
  ).toBe(true);
});

test("denial ends the native audio connection and explains how to retry", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  await cdp.send("Browser.setPermission", {
    permission: { name: "microphone" },
    setting: "denied",
    origin: url,
    browserContextId: targetInfo.browserContextId,
  });
  await page.goto(url);
  await expect.poll(() => connections.size).toBe(1);
  await voice(page);
  await expect(page.getByRole("status")).toContainText("Microphone access was denied");
  await expect.poll(() => owners.size).toBe(0);
  await expect.poll(() => activeCalls.get("test")).toBe(false);
  expect(microphoneFrames).toBe(0);
});

test("parking the persistent terminal pauses audio and resumes the retained call", async ({
  page,
}) => {
  await page.goto(url);
  await expect.poll(() => connections.size).toBe(1);
  await voice(page);
  await expect(page.getByRole("status")).toHaveText("Voice connected");
  await page.evaluate(() => {
    document.querySelector('[data-terminal-surface="true"]').inert = true;
  });
  await expect(page.getByRole("status", { includeHidden: true })).toContainText("Voice paused");
  expect(connections.size).toBe(1);
  expect(owners.size).toBe(1);
  const owner = owners.get("test");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.audioProbe.tracks.every((track) => !track.enabled && track.readyState === "live"),
      ),
    )
    .toBe(true);
  const frames = microphoneFrames;
  await page.waitForTimeout(250);
  expect(microphoneFrames).toBe(frames);
  await page.evaluate(() => {
    document.querySelector('[data-terminal-surface="true"]').inert = false;
  });
  await expect(page.getByRole("status")).toHaveText("Voice connected");
  await expect.poll(() => microphoneFrames).toBeGreaterThan(frames + 5);
  expect(connections.size).toBe(1);
  expect(owners.get("test")).toBe(owner);
  expect(
    await page.evaluate(() =>
      window.audioProbe.tracks.map((track) => [track.enabled, track.readyState]),
    ),
  ).toEqual([[true, "live"]]);
});

test("a suspended context resumes the retained call after returning to the pane", async ({
  page,
}) => {
  await page.goto(url);
  await voice(page);
  await expect(page.getByRole("status")).toHaveText("Voice connected");
  const owner = owners.get("test");
  await page.evaluate(async () => {
    document.querySelector('[data-terminal-surface="true"]').inert = true;
    await window.audioProbe.contexts.at(-1).suspend();
  });
  await expect(page.getByRole("status", { includeHidden: true })).toContainText("Voice paused");
  await page.evaluate(() => {
    document.querySelector('[data-terminal-surface="true"]').inert = false;
  });
  await expect(page.getByRole("status")).toHaveText("Voice connected");
  expect(await page.evaluate(() => window.audioProbe.contexts.at(-1).state)).toBe("running");
  const frames = microphoneFrames;
  await expect.poll(() => microphoneFrames).toBeGreaterThan(frames + 5);
  expect(owners.get("test")).toBe(owner);
  expect(await page.evaluate(() => window.audioProbe.tracks.length)).toBe(1);
});

test("page freeze and resume events pause audio while retaining the relay", async ({ page }) => {
  await page.goto(url);
  await voice(page);
  await expect(page.getByRole("status")).toHaveText("Voice connected");
  const owner = owners.get("test");
  // Chrome may decline to freeze a live audio page via its debugging API.
  // Dispatch lifecycle events here; the unit test models the frozen timer gap.
  await page.evaluate(() => document.dispatchEvent(new Event("freeze")));
  await expect(page.getByRole("status")).toContainText("Voice paused");
  const frames = microphoneFrames;
  await page.waitForTimeout(250);
  expect(microphoneFrames).toBe(frames);
  await page.evaluate(() => document.dispatchEvent(new Event("resume")));
  await expect(page.getByRole("status")).toHaveText("Voice connected");
  await expect.poll(() => microphoneFrames).toBeGreaterThan(frames + 5);
  expect(owners.get("test")).toBe(owner);
  expect(connections.size).toBe(1);
});

test("another Hive window cannot share the microphone and releasing it permits a later call", async ({
  page,
  context,
  request,
}) => {
  const other = await context.newPage();
  await other.goto(`${url}/lock-page`);
  await other.evaluate(
    (lockName) =>
      new Promise((resolve) => {
        void navigator.locks.request(
          lockName,
          () =>
            new Promise((release) => {
              window.releaseVoiceLock = release;
              resolve(true);
            }),
        );
      }),
    `hive-terminal-microphone:${url.replace(/^http/, "ws")}/ws/audio?workspaceId=workspace&agentId=agent&sessionName=test`,
  );
  await page.goto(url);
  await expect.poll(() => connections.size).toBe(1);
  await voice(page);
  await expect(page.getByRole("status")).toContainText("other Hive tab or window");
  expect(await page.evaluate(() => window.audioProbe.tracks.length)).toBe(0);
  expect(owners.size).toBe(0);
  await other.close();
  await expect.poll(() => connections.size).toBe(1);
  await request.post(`${url}/native?sessionName=test`, { data: "/voice" });
  await voice(page);
  await expect(page.getByRole("status")).toHaveText("Voice connected");
  await expect.poll(() => microphoneFrames).toBeGreaterThan(5);
});

test("different terminal calls stay connected and only the focused pane transmits audio", async ({
  page,
  request,
}, testInfo) => {
  await page.goto(`${url}/panes`);
  await expect.poll(() => connections.size).toBe(1);
  await page.getByRole("textbox", { name: "first terminal input" }).focus();
  await request.post(`${url}/native?sessionName=second`, { data: "/voice" });
  await expect(page.locator('[data-session="second"]').getByRole("status")).toHaveCount(0);
  expect(await page.evaluate(() => window.audioProbe.tracks.length)).toBe(0);
  await request.post(`${url}/native?sessionName=second`, { data: "/voice" });
  await voice(page, "first");
  await expect(page.locator('[data-session="first"]').getByRole("status")).toHaveText(
    "Voice connected",
  );
  await expect.poll(() => sessionFrames.get("first") ?? 0).toBeGreaterThan(5);
  await voice(page, "second");
  await expect(page.locator('[data-session="second"]').getByRole("status")).toHaveText(
    "Voice connected",
  );
  expect(await page.evaluate(() => window.audioProbe.tracks.length)).toBe(2);
  await expect.poll(() => sessionFrames.get("second") ?? 0).toBeGreaterThan(5);
  await expect(page.locator('[data-session="first"]').getByRole("status")).toHaveText(
    "Voice paused — focus this pane to resume",
  );
  const firstOwner = owners.get("first");
  const secondOwner = owners.get("second");
  const firstFrames = sessionFrames.get("first");
  await page.waitForTimeout(250);
  expect(sessionFrames.get("first")).toBe(firstFrames);
  await page.getByRole("textbox", { name: "first terminal input" }).focus();
  await expect(page.locator('[data-session="first"]').getByRole("status")).toHaveText(
    "Voice connected",
  );
  await expect(page.locator('[data-session="second"]').getByRole("status")).toContainText(
    "Voice paused",
  );
  const secondFrames = sessionFrames.get("second");
  await expect.poll(() => sessionFrames.get("first")).toBeGreaterThan(firstFrames + 5);
  expect(sessionFrames.get("second")).toBe(secondFrames);
  expect(owners.get("first")).toBe(firstOwner);
  expect(owners.get("second")).toBe(secondOwner);
  expect(connections.size).toBe(2);
  await page.screenshot({ path: testInfo.outputPath("voice-follows-focused-pane.png") });
  await voice(page, "first");
  await expect(page.locator('[data-session="first"]').getByRole("status")).toHaveCount(0);
  await expect(page.locator('[data-session="second"]').getByRole("status")).toHaveText(
    "Voice paused — focus this pane to resume",
  );
  await page.getByRole("textbox", { name: "second terminal input" }).focus();
  await expect(page.locator('[data-session="second"]').getByRole("status")).toHaveText(
    "Voice connected",
  );
  await expect.poll(() => sessionFrames.get("second") ?? 0).toBeGreaterThan(secondFrames + 5);
  expect(
    await page.evaluate(() => window.audioProbe.tracks.map((track) => track.readyState)),
  ).toEqual(["ended", "live"]);
});

test("duplicate views cannot overlap pending permission or use a late grant", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.permissionRequests = 0;
    navigator.mediaDevices.getUserMedia = (constraints) => {
      window.permissionRequests++;
      return new Promise((resolve, reject) => {
        window.grantMicrophone = () => native(constraints).then(resolve, reject);
      });
    };
  });
  await page.goto(`${url}/duplicate`);
  await expect.poll(() => connections.size).toBe(1);
  await voice(page, "first");
  await expect(page.locator('[data-session="first"]').getByRole("status")).toContainText(
    "Connecting voice",
  );
  await voice(page, "first");
  await expect(page.locator('[data-session="first"]').getByRole("status")).toHaveCount(0);
  await voice(page, "second");
  await expect(page.locator('[data-session="second"]').getByRole("status")).toContainText(
    "another view",
  );
  expect(await page.evaluate(() => window.permissionRequests)).toBe(1);
  await page.evaluate(() => window.grantMicrophone());
  await expect
    .poll(() => page.evaluate(() => window.audioProbe.tracks.map((track) => track.readyState)))
    .toEqual(["ended"]);
  expect(microphoneFrames).toBe(0);
  await request.post(`${url}/native?sessionName=test`, { data: "/voice" });
  await voice(page, "second");
  await expect.poll(() => page.evaluate(() => window.permissionRequests)).toBe(2);
  await page.evaluate(() => window.grantMicrophone());
  await expect(page.locator('[data-session="second"]').getByRole("status")).toHaveText(
    "Voice connected",
  );
  await expect.poll(() => sessionFrames.get("test") ?? 0).toBeGreaterThan(5);
});

test("an unfocused Hive window cannot begin a microphone call", async ({
  page,
  context,
  request,
}) => {
  await page.goto(url);
  await expect.poll(() => connections.size).toBe(1);
  const cdp = await page.context().newCDPSession(page);
  // Playwright forces every page to report focus, even behind other windows.
  // Disable that emulation to exercise the browser's unfocused state.
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  const other = await context.newPage();
  await other.goto(`${url}/lock-page`);
  await other.bringToFront();
  expect(await page.evaluate(() => document.hasFocus())).toBe(false);
  await expect.poll(() => connections.size).toBe(0);
  await request.post(`${url}/native?sessionName=test`, { data: "/voice" });
  await expect(page.getByRole("status")).toHaveCount(0);
  expect(await page.evaluate(() => window.audioProbe.tracks.length)).toBe(0);
  await request.post(`${url}/native?sessionName=test`, { data: "/voice" });
  await other.close();
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await expect.poll(() => connections.size).toBe(1);
  await voice(page);
  await expect(page.getByRole("status")).toHaveText("Voice connected");
});

test("external Compose-style focus uses the selected pane to choose a new call", async ({
  page,
}) => {
  await page.goto(`${url}/panes`);
  await expect.poll(() => connections.size).toBe(1);
  await page.getByRole("button", { name: "Select second pane" }).click();
  await expect(page.locator('[data-pane-mode][data-active="true"]')).toContainText(
    "Codex terminal",
  );
  await page.getByRole("button", { name: "Send voice to selected pane" }).click();
  await page
    .locator('[data-session="second"]')
    .getByRole("button", { name: "Enable microphone" })
    .click();
  await expect(page.locator('[data-session="second"]').getByRole("status")).toHaveText(
    "Voice connected",
  );
  expect(await page.evaluate(() => window.audioProbe.tracks.length)).toBe(1);
  expect(sessionFrames.get("first") ?? 0).toBe(0);
});

test("an unused device cannot own a session or interrupt the current device's call", async ({
  page,
  browser,
}) => {
  // A separate context models another device: browser microphone locks are not shared.
  const otherContext = await browser.newContext({ permissions: ["microphone"] });
  try {
    const unused = await otherContext.newPage();
    await unused.goto(url);
    await expect.poll(() => connections.size).toBe(1);
    expect(owners.size).toBe(0);
    await page.goto(url);
    await expect.poll(() => connections.size).toBe(2);
    await voice(page);
    await expect(page.getByRole("status")).toHaveText("Voice connected");
    await expect.poll(() => microphoneFrames).toBeGreaterThan(5);
    expect(await unused.evaluate(() => window.audioProbe.tracks.length)).toBe(0);
    await expect(unused.getByRole("button", { name: "Enable microphone" })).toBeVisible();
    const frames = microphoneFrames;
    await otherContext.close();
    await expect.poll(() => microphoneFrames).toBeGreaterThan(frames + 5);
    await expect(page.getByRole("status")).toHaveText("Voice connected");
    expect(await page.evaluate(() => window.audioProbe.tracks.at(-1).readyState)).toBe("live");
  } finally {
    await otherContext.close();
  }
});

test("another device cannot take over a live call in the same terminal", async ({
  page,
  browser,
}) => {
  await page.goto(url);
  await voice(page);
  await expect(page.getByRole("status")).toHaveText("Voice connected");
  const otherContext = await browser.newContext({ permissions: ["microphone"] });
  try {
    const other = await otherContext.newPage();
    await other.goto(url);
    await expect.poll(() => connections.size).toBe(2);
    // Enter on the other device cannot claim the current call.
    await other.getByRole("textbox", { name: "Terminal input" }).press("Enter");
    expect(await other.evaluate(() => window.audioProbe.tracks.length)).toBe(0);
    await other.getByRole("button", { name: "Enable microphone" }).click();
    await expect(other.getByRole("status")).toContainText("another view");
    expect(await other.evaluate(() => window.audioProbe.tracks.length)).toBe(0);
    const frames = microphoneFrames;
    await expect.poll(() => microphoneFrames).toBeGreaterThan(frames + 5);
    await expect(page.getByRole("status")).toHaveText("Voice connected");
  } finally {
    await otherContext.close();
  }
});
