// Browser Testing only; local mock page, synthetic data, no preview requests.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

assert.equal(process.env.HIVE_WORKSPACE_PROFILE, "browser");
function identity(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(") ") + 2).split(" ");
    return {
      pid,
      state: fields[0],
      parent: Number(fields[1]),
      group: Number(fields[2]),
      start: fields[19],
      executable: readlinkSync(`/proc/${pid}/exe`),
    };
  } catch {
    return null;
  }
}
function tree(pid) {
  const result = [];
  for (const value of readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
    .trim()
    .split(/\s+/)
    .filter(Boolean)) {
    const child = identity(Number(value));
    if (child) {
      result.push(child);
      result.push(...tree(child.pid));
    }
  }
  return result;
}
const live = (p) => {
  const current = identity(p.pid);
  return current?.start === p.start && !["Z", "X"].includes(current.state);
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.argv[2] === "worker") {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
    ],
  });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const origin = process.argv[3];
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  await page.goto(origin);
  assert.equal(await page.title(), "LOCAL_DRIVER_CONTROL");
  const children = tree(process.pid);
  const root = children.find(
    (p) => p.parent === process.pid && p.executable === "/opt/google/chrome/chrome",
  );
  assert.ok(root);
  assert.equal(root.group, root.pid);
  process.send({
    root,
    processes: children.filter((p) => p.executable === "/opt/google/chrome/chrome"),
  });
  setInterval(() => {}, 1000);
} else {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<title>LOCAL_DRIVER_CONTROL</title>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const child = fork(
    fileURLToPath(import.meta.url),
    ["worker", `http://127.0.0.1:${server.address().port}`],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  let proof;
  try {
    proof = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("launch_timeout")), 15000);
      child.once("message", (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("driver_exit"));
      });
    });
    assert.equal(identity(proof.root.pid)?.parent, child.pid);
    assert.equal(identity(proof.root.pid)?.start, proof.root.start);
    child.kill("SIGKILL");
    const start = Date.now();
    while (proof.processes.some(live) && Date.now() - start < 10000) await pause(50);
    const remaining = proof.processes.filter(live);
    const result = {
      schemaVersion: 1,
      kind: "actual-chrome-driver-SIGKILL",
      previewRequests: 0,
      localMockOnly: true,
      trackedChromeProcesses: proof.processes.length,
      chromeRootExited: !live(proof.root),
      allTrackedChromeExited: remaining.length === 0,
      elapsedAfterDriverKillMs: Date.now() - start,
      fallbackGroupKill: false,
    };
    if (remaining.length) {
      // Fixture cleanup only: exact verified launch group, never a name/pattern kill.
      const current = identity(proof.root.pid);
      if (current?.start === proof.root.start && current.group === proof.root.pid) {
        process.kill(-proof.root.pid, "SIGKILL");
        result.fallbackGroupKill = true;
      }
    }
    console.log(JSON.stringify(result));
    assert.equal(remaining.length, 0);
  } finally {
    child.kill("SIGKILL");
    await new Promise((r) => server.close(r));
  }
}
