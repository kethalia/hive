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
let active = false;

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
    } else if (req.url === "/native") {
      let command = "";
      for await (const part of req) command += part;
      if (command === "/voice") {
        active = !active;
        for (const socket of connections) socket.send(JSON.stringify({ type: "active", active }));
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
  wss.on("connection", (socket) => {
    connections.add(socket);
    socket.send('{"type":"ready"}');
    socket.send('{"type":"active","active":false}');
    socket.on("message", (raw) => {
      const value = JSON.parse(raw.toString());
      if (value.type === "microphone") {
        expect(Buffer.from(value.pcm, "base64").length).toBe(960);
        microphoneFrames++;
      }
      if (value.type === "ping") socket.send('{"type":"pong"}');
      if (value.type === "release") socket.close();
    });
    socket.on("close", () => connections.delete(socket));
  });
  let sample = 0;
  speakerTimer = setInterval(() => {
    if (!active) return;
    const pcm = Buffer.alloc(960);
    for (let i = 0; i < 480; i++)
      pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * sample++) / 48_000)), i * 2);
    for (const socket of connections)
      socket.send(JSON.stringify({ type: "speaker", pcm: pcm.toString("base64") }));
  }, 10);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(() => {
  microphoneFrames = 0;
  active = false;
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
async function voice(page) {
  const terminal = page.getByRole("textbox", { name: "Terminal input" });
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
  await voice(page); // End the simulated native call that was disconnected.
  await voice(page);
  await expect(page.getByRole("status")).toHaveText("Voice connected");
  await expect.poll(() => microphoneFrames).toBeGreaterThan(5);
});
