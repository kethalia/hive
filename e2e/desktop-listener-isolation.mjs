import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { verifyAnonymousCoderLogin } from "./helpers/coder-anonymous-denial.mjs";

const config = JSON.parse(readFileSync(0, "utf8"));
assert.equal(process.env.HIVE_WORKSPACE_PROFILE, "browser", "Run in Browser Testing");
const root = config.artifactDir ?? process.cwd();
const report = { browser: null, checks: [], screenshots: [] };
let stage = "launch";
let browser;
let terminal;
try {
  browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  report.browser = browser.version();
  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
  stage = "anonymous-owner-app";
  const anon = await anonymous.newPage();
  const evidence = await verifyAnonymousCoderLogin(anon, config);
  report.checks.push({ name: "anonymous access cannot open the desktop", passed: true, evidence });
  await anonymous.close();
  const owner = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  const page = await owner.newPage();
  let frames = 0;
  const paths = [];
  page.on("websocket", (socket) => {
    paths.push(new URL(socket.url()).pathname);
    socket.on("framereceived", () => frames++);
  });
  stage = "owner-authentication";
  await page.goto(config.authRedirect, { waitUntil: "domcontentloaded", timeout: 20000 });
  assert.equal(new URL(page.url()).origin, new URL(config.appUrl).origin);
  stage = "desktop-connect";
  await page.waitForFunction(
    () => document.body.innerText.includes("Connected ("),
    {},
    { timeout: 20000 },
  );
  assert.ok(frames > 0);
  assert.ok(paths.some((p) => p.includes("websockify")));
  report.checks.push({
    name: "authenticated Coder app displays the real desktop over WebSocket",
    passed: true,
    frames_received: frames,
  });
  stage = "keyboard-input";
  const marker = join(root, `keyboard-marker-${randomUUID()}.txt`);
  terminal = spawn(
    "xterm",
    [
      "-geometry",
      "80x12+40+40",
      "-title",
      "Hive desktop isolation verification",
      "-e",
      "bash",
      "--noprofile",
      "--norc",
      "-c",
      `IFS= read -r value; printf '%s\\n' "$value" > '${marker}'; sleep 60`,
    ],
    { env: { ...process.env, DISPLAY: ":1" }, stdio: "ignore" },
  );
  await page.waitForTimeout(1600);
  const canvases = await page
    .locator("canvas")
    .evaluateAll((elements) => elements.map((c, index) => ({ index, area: c.width * c.height })));
  const selected = canvases.sort((a, b) => b.area - a.area)[0];
  await page
    .locator("canvas")
    .nth(selected.index)
    .click({ position: { x: 120, y: 120 } });
  await page.keyboard.type("hive-loopback-desktop-check");
  await page.keyboard.press("Enter");
  for (let i = 0; i < 40 && !existsSync(marker); i++) await page.waitForTimeout(100);
  assert.equal(readFileSync(marker, "utf8").trim(), "hive-loopback-desktop-check");
  report.checks.push({
    name: "keyboard input reaches the workspace through the authenticated desktop",
    passed: true,
  });
  await page.screenshot({ path: join(root, "desktop-owner-chromium.png") });
  report.screenshots.push("desktop-owner-chromium.png");
  stage = "reconnect";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.body.innerText.includes("Connected ("),
    {},
    { timeout: 20000 },
  );
  report.checks.push({ name: "desktop reconnects through the Coder app", passed: true });
  await owner.close();
  report.success = true;
} catch (error) {
  report.success = false;
  report.failure_stage = stage;
  report.error_type = error.name;
} finally {
  terminal?.kill();
  await browser?.close();
}
writeFileSync(join(root, "browser-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (!report.success) process.exitCode = 1;
