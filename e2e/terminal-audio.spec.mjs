import { once } from "node:events";
import { readFile } from "node:fs/promises";
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
    if (req.url === "/bundle.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(bundle.outputFiles[0].contents);
    } else if (req.url === "/style.css") {
      res.setHeader("Content-Type", "text/css");
      res.end(styles.css);
    } else if (req.url === "/hive-audio-worklet.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(worklet);
    } else if (req.url.startsWith("/native?")) {
      let command = "";
      for await (const part of req) command += part;
      if (command === "/voice") {
        const sessionName = new URL(req.url, "http://localhost").searchParams.get("sessionName");
        const active = !activeCalls.get(sessionName);
        activeCalls.set(sessionName, active);
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
    socket.send('{"type":"ready"}');
    socket.send(JSON.stringify({ type: "active", active: !!activeCalls.get(sessionName) }));
    socket.on("message", (raw) => {
      const value = JSON.parse(raw.toString());
      if (value.type === "microphone") {
        expect(Buffer.from(value.pcm, "base64").length).toBe(960);
        microphoneFrames++;
        sessionFrames.set(sessionName, (sessionFrames.get(sessionName) ?? 0) + 1);
      }
      if (value.type === "ping") socket.send('{"type":"pong"}');
      if (value.type === "release") {
        activeCalls.set(sessionName, false); // Releasing the real broker ends native capture.
        socket.close();
      }
    });
    socket.on("close", () => connections.delete(socket));
  });
  let sample = 0;
  speakerTimer = setInterval(() => {
    const pcm = Buffer.alloc(960);
    for (let i = 0; i < 480; i++)
      pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * sample++) / 48_000)), i * 2);
    for (const socket of connections)
      if (activeCalls.get(sessionNames.get(socket)))
        socket.send(JSON.stringify({ type: "speaker", pcm: pcm.toString("base64") }));
  }, 10);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(() => {
  microphoneFrames = 0;
  activeCalls.clear();
  sessionFrames.clear();
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
  await terminal.fill("/voice");
  await terminal.press("Enter");
}

test("native /voice prompts audio automatically, exchanges PCM, and releases media on end", async ({
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
  await expect.poll(() => connections.size).toBe(0);
  expect(microphoneFrames).toBe(0);
});

test("parking the persistent terminal releases browser media and the relay", async ({ page }) => {
  await page.goto(url);
  await expect.poll(() => connections.size).toBe(1);
  await voice(page);
  await expect(page.getByRole("status")).toHaveText("Voice connected");
  await page.evaluate(() => {
    document.querySelector('[data-terminal-surface="true"]').inert = true;
  });
  await expect.poll(() => connections.size).toBe(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.audioProbe.tracks.every((track) => track.readyState === "ended")),
    )
    .toBe(true);
});

test("another Hive window cannot share the microphone and releasing it permits a later call", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  await other.goto(`${url}/lock-page`);
  await other.evaluate(
    () =>
      new Promise((resolve) => {
        void navigator.locks.request(
          "hive-terminal-microphone",
          () =>
            new Promise((release) => {
              window.releaseVoiceLock = release;
              resolve(true);
            }),
        );
      }),
  );
  await page.goto(url);
  await expect.poll(() => connections.size).toBe(1);
  await voice(page);
  await expect(page.getByRole("status")).toContainText("other Hive tab or window");
  expect(await page.evaluate(() => window.audioProbe.tracks.length)).toBe(0);
  await expect.poll(() => connections.size).toBe(0);
  await other.close();
  await expect.poll(() => connections.size).toBe(1);
  await voice(page);
  await expect(page.getByRole("status")).toHaveText("Voice connected");
  await expect.poll(() => microphoneFrames).toBeGreaterThan(5);
});

test("background capture cannot claim audio and focus changes do not move an ongoing call", async ({
  page,
  request,
}, testInfo) => {
  await page.goto(`${url}/panes`);
  await expect.poll(() => connections.size).toBe(2);
  await page.getByRole("textbox", { name: "first terminal input" }).focus();
  await request.post(`${url}/native?sessionName=second`, { data: "/voice" });
  await expect(page.locator('[data-session="second"]').getByRole("status")).toContainText(
    "Select this terminal",
  );
  expect(await page.evaluate(() => window.audioProbe.tracks.length)).toBe(0);
  await voice(page, "first");
  await expect(page.locator('[data-session="first"]').getByRole("status")).toHaveText(
    "Voice connected",
  );
  await expect.poll(() => sessionFrames.get("first") ?? 0).toBeGreaterThan(5);
  await expect.poll(() => connections.size).toBe(2);
  await voice(page, "second");
  await expect(page.locator('[data-session="second"]').getByRole("status")).toContainText(
    "other terminal",
  );
  expect(await page.evaluate(() => window.audioProbe.tracks.length)).toBe(1);
  expect(sessionFrames.get("second") ?? 0).toBe(0);
  await expect(page.locator('[data-session="first"]').getByRole("status")).toHaveText(
    "Voice connected",
  );
  await page.screenshot({ path: testInfo.outputPath("voice-stays-with-origin-pane.png") });
  await voice(page, "first");
  await expect(page.locator('[data-session="first"]').getByRole("status")).toHaveCount(0);
  await expect.poll(() => connections.size).toBe(2);
  await voice(page, "second");
  await expect(page.locator('[data-session="second"]').getByRole("status")).toHaveText(
    "Voice connected",
  );
  await expect.poll(() => sessionFrames.get("second") ?? 0).toBeGreaterThan(5);
  expect(
    await page.evaluate(() => window.audioProbe.tracks.map((track) => track.readyState)),
  ).toEqual(["ended", "live"]);
});

test("ending a call during permission cannot open a competing prompt or use a late grant", async ({
  page,
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
  await page.goto(`${url}/panes`);
  await expect.poll(() => connections.size).toBe(2);
  await voice(page, "first");
  await expect(page.locator('[data-session="first"]').getByRole("status")).toContainText(
    "Connecting voice",
  );
  await voice(page, "first");
  await expect(page.locator('[data-session="first"]').getByRole("status")).toHaveCount(0);
  await voice(page, "second");
  await expect(page.locator('[data-session="second"]').getByRole("status")).toContainText(
    "other terminal",
  );
  expect(await page.evaluate(() => window.permissionRequests)).toBe(1);
  await page.evaluate(() => window.grantMicrophone());
  await expect
    .poll(() => page.evaluate(() => window.audioProbe.tracks.map((track) => track.readyState)))
    .toEqual(["ended"]);
  expect(microphoneFrames).toBe(0);
  await expect.poll(() => connections.size).toBe(2);
  await voice(page, "second");
  await expect.poll(() => page.evaluate(() => window.permissionRequests)).toBe(2);
  await page.evaluate(() => window.grantMicrophone());
  await expect(page.locator('[data-session="second"]').getByRole("status")).toHaveText(
    "Voice connected",
  );
  await expect.poll(() => sessionFrames.get("second") ?? 0).toBeGreaterThan(5);
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
  await request.post(`${url}/native?sessionName=test`, { data: "/voice" });
  await expect(page.getByRole("status")).toContainText("Select this terminal");
  expect(await page.evaluate(() => window.audioProbe.tracks.length)).toBe(0);
  await other.close();
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await expect.poll(() => connections.size).toBe(1);
  await voice(page);
  await expect(page.getByRole("status")).toHaveText("Voice connected");
});

test("external Compose-style focus uses the selected pane to choose a new call", async ({
  page,
  request,
}) => {
  await page.goto(`${url}/panes`);
  await expect.poll(() => connections.size).toBe(2);
  // Unlock playback first, then focus a control outside either terminal.
  await page.getByRole("textbox", { name: "second terminal input" }).press("Enter");
  await page.getByRole("button", { name: "Select second pane" }).click();
  await expect(page.locator('[data-pane-mode][data-active="true"]')).toContainText(
    "Codex terminal",
  );
  await request.post(`${url}/native?sessionName=second`, { data: "/voice" });
  await expect(page.locator('[data-session="second"]').getByRole("status")).toHaveText(
    "Voice connected",
  );
  expect(await page.evaluate(() => window.audioProbe.tracks.length)).toBe(1);
  expect(sessionFrames.get("first") ?? 0).toBe(0);
});
