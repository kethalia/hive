import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
let server;
let url;
let handleOffer;
let disconnected;

test.use({
  channel: "chrome",
  permissions: ["microphone"],
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  },
});
test.describe.configure({ mode: "serial" });
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "This prototype is validated with Chrome; Safari voice validation is pending.",
);
test.beforeAll(async () => {
  const styles = await postcss([tailwindcss()]).process(
    await readFile("src/app/globals.css", "utf8"),
    { from: "src/app/globals.css" },
  );
  const bundle = await build({
    entryPoints: ["e2e/fixtures/codex-voice.tsx"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  server = createServer(async (req, res) => {
    if (req.url === "/style.css") {
      res.setHeader("Content-Type", "text/css");
      res.end(styles.css);
    } else if (req.url === "/bundle.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(bundle.outputFiles[0].contents);
    } else if (req.url?.endsWith("/voice")) {
      if (req.method === "GET") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            threads: [{ id: "thread-one", name: "My terminal session", cwd: "/project" }],
          }),
        );
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const offer = JSON.parse(body);
      const answer = await handleOffer(offer.sdp);
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ type: "sdp", sdp: answer })}\n`);
      res.on("close", () => {
        disconnected = true;
      });
    } else {
      res.setHeader("Content-Type", "text/html");
      res.setHeader("Permissions-Policy", "microphone=(self), camera=()");
      res.end(
        '<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script src="/bundle.js"></script></body></html>',
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test("real microphone/WebRTC signaling, incoming audio, mute and cleanup", async ({ page }) => {
  disconnected = false;
  await page.addInitScript(() => {
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.testStreams = [];
    navigator.mediaDevices.getUserMedia = async (options) => {
      const stream = await get(options);
      window.testStreams.push(stream);
      return stream;
    };
    const Audio = window.Audio;
    window.testAudio = [];
    window.Audio = class extends Audio {
      constructor() {
        super();
        window.testAudio.push(this);
      }
    };
  });
  handleOffer = (sdp) =>
    page.evaluate(async (offer) => {
      const peer = new RTCPeerConnection();
      window.remotePeer = peer;
      const audio = new AudioContext();
      window.remoteAudio = audio;
      const source = audio.createOscillator();
      const destination = audio.createMediaStreamDestination();
      source.connect(destination);
      source.start();
      for (const track of destination.stream.getTracks()) peer.addTrack(track, destination.stream);
      await peer.setRemoteDescription({ type: "offer", sdp: offer });
      await peer.setLocalDescription(await peer.createAnswer());
      if (peer.iceGatheringState !== "complete")
        await new Promise((resolve) =>
          peer.addEventListener("icegatheringstatechange", () => {
            if (peer.iceGatheringState === "complete") resolve();
          }),
        );
      return peer.localDescription.sdp;
    }, sdp);
  await page.goto(url);
  await page.getByText("Codex Voice (experimental)", { exact: true }).click();
  await page.getByLabel("Codex session").selectOption("thread-one");
  await page.getByRole("button", { name: "Start voice" }).click();
  await expect(page.locator("summary")).toContainText("Microphone on");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.testAudio.some((audio) => audio.srcObject?.getAudioTracks().length && !audio.paused),
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Mute", exact: true }).click();
  expect(await page.evaluate(() => window.testStreams[0].getAudioTracks()[0].enabled)).toBe(false);
  await page.getByRole("button", { name: "Unmute" }).click();
  expect(await page.evaluate(() => window.testStreams[0].getAudioTracks()[0].enabled)).toBe(true);
  await page.screenshot({ path: "test-results/voice-connected.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "End voice" }).click();
  await expect.poll(() => disconnected).toBe(true);
  expect(await page.evaluate(() => window.testStreams[0].getAudioTracks()[0].readyState)).toBe(
    "ended",
  );
  expect(await page.evaluate(() => window.testAudio[0].srcObject)).toBeNull();
  await page.evaluate(() => {
    window.remotePeer.close();
    void window.remoteAudio.close();
  });
});

test("denied microphone access is actionable and leaves no active call", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Denied", "NotAllowedError");
    };
  });
  await page.goto(url);
  await page.getByText("Codex Voice (experimental)", { exact: true }).click();
  await page.getByLabel("Codex session").selectOption("thread-one");
  await page.getByRole("button", { name: "Start voice" }).click();
  await expect(page.getByRole("alert")).toContainText("Microphone access was denied");
  await expect(page.getByRole("button", { name: "End voice" })).toHaveCount(0);
});
