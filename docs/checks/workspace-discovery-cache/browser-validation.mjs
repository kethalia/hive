import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium } from "/home/coder/projects/creator-direction-upgrade-validation/node_modules/playwright-core/index.mjs";

const root = new URL(".", import.meta.url).pathname,
  evidence = join(root, "evidence");
await mkdir(evidence, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    const file = path === "/" || path === "/workspaces" ? "index.html" : path.slice(1);
    if (file.includes("..")) throw Error();
    res.setHeader(
      "Content-Type",
      file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".ttf")
            ? "font/ttf"
            : "text/html",
    );
    res.end(await readFile(join(root, file)));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const report = [];
try {
  for (const width of [1440, 390]) {
    const mobile = width < 1025,
      context = await browser.newContext({
        viewport: { width, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
      });
    await context.addInitScript(() => {
      localStorage.setItem(
        "general-workspace:v1:fixture",
        JSON.stringify({
          version: 1,
          activeBoardKey: "board-1",
          boards: [
            {
              key: "board-1",
              name: "1",
              order: 0,
              activeWindowId: "terminal",
              windows: [
                {
                  id: "terminal",
                  kind: "terminal",
                  workspaceId: "software",
                  sessionName: "hive",
                  label: "hive",
                },
              ],
            },
          ],
        }),
      );
      window.opens = [];
      window.addEventListener("hive:workspace-open", (e) => window.opens.push(e.detail));
    });

    const counts = {};
    let delay = 100,
      fail = false;
    const workspaces = [
      ["software", "ai-dev-01", "ai-dev-k8s", "running"],
      ["browser", "creator-direction-upgrade", "browser-testing", "running"],
      ["infra", "nextcloud-cookbook-infra", "infrastructure", "stopped"],
    ].map(([id, name, template_name, status]) => ({
      id,
      name,
      template_id: template_name,
      template_name,
      owner_name: "daniel",
      last_used_at: new Date().toISOString(),
      latest_build: { id: `build-${id}`, status },
      health: { healthy: true },
    }));
    await context.route("**/api/discovery/**", async (route) => {
      const url = new URL(route.request().url()),
        resource = url.pathname.split("/").at(-1),
        workspaceId = url.searchParams.get("workspaceId");
      counts[`${resource}:${workspaceId}`] = (counts[`${resource}:${workspaceId}`] ?? 0) + 1;
      await new Promise((r) => setTimeout(r, delay));
      let data = [];
      if (resource === "workspaces") data = workspaces;
      if (resource === "agent")
        data = {
          agentId: `${workspaceId}-agent`,
          agentName: "main",
          agentStatus: "connected",
          templateName: "ai-dev-k8s",
        };
      if (resource === "sessions") data = [{ name: "main", created: 1, windows: 1 }];
      if (resource === "repositories")
        data = {
          nodes: [
            {
              kind: "repository",
              id: "hive",
              label: "hive",
              cloneSessionKey: "git-clone:projects/kethalia/hive",
              relativePath: "projects/kethalia/hive",
            },
          ],
        };
      if (resource === "agent-tools")
        data = {
          profile: "software",
          agents: [
            {
              agent: "codex",
              installed: true,
              version: "1.2.3",
              auth: "signed-in",
              tracking: true,
              connections: [],
              plugins: [],
              warnings: [],
            },
          ],
          sessions: [],
          coderMcpSupported: true,
          typescriptServerInstalled: true,
          checkedAt: 1792938800,
        };
      await route.fulfill({
        status: fail ? 503 : 200,
        contentType: "application/json",
        body: JSON.stringify(fail ? { error: "Temporary discovery outage" } : { data }),
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/workspaces`);
    await page.getByTestId("terminal-software").waitFor();
    const preserved = async () =>
      assert.deepEqual(await page.evaluate(() => window.mounts), { "software:hive": 1 });
    assert.ok((counts["workspaces:null"] ?? 0) <= 1);
    assert.equal(counts["templates:null"], undefined);
    const row = page.getByTestId("workspace-disclosure-software");
    if (!(await row.isVisible()))
      await page.getByRole("button", { name: /^toggle sidebar$/i }).click();
    await row.click();
    await page.getByRole("link", { name: "Open Files in workspace", exact: true }).waitFor();
    const agentReads = counts["agent:software"];
    await row.click();
    await row.click();
    assert.equal(counts["agent:software"], agentReads);
    if (mobile) await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Add window", exact: true }).click();
    const search = page.getByPlaceholder("Search terminals, repositories, apps, and commands…");
    await search.fill("hive");
    const repo = mobile
      ? page.getByRole("button").filter({ hasText: "ai-dev-01 · projects/kethalia/hive" })
      : page.locator('[data-action-id="repository:software:git-clone:projects/kethalia/hive"]');
    try {
      await repo.waitFor();
    } catch (e) {
      console.log(
        JSON.stringify({ counts, errors, body: await page.locator("body").innerText() }, null, 2),
      );
      await page.screenshot({ path: join(evidence, `${width}-failure.png`) });
      throw e;
    }
    await page.keyboard.press("Escape");
    const reposBefore = counts["repositories:software"],
      sessionsBefore = counts["sessions:software"];
    const started = Date.now();
    await page.getByRole("button", { name: "Add window", exact: true }).click();
    await repo.waitFor();
    const searchReopenMs = Date.now() - started;
    assert.equal(counts["repositories:software"], reposBefore);
    assert.equal(counts["sessions:software"], sessionsBefore);
    delay = 900;
    fail = true;
    const failedResponse = page.waitForResponse(
      (r) => r.url().includes("/api/discovery/workspaces") && r.status() === 503,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("hive:sidebar-refresh")));
    assert.equal(await repo.isVisible(), true);
    await failedResponse;
    assert.equal(await repo.isVisible(), true);
    await preserved();
    await page.screenshot({ path: join(evidence, `${width}-cached-search.png`) });
    await page.keyboard.press("Escape");
    fail = false;
    delay = 100;
    await page.evaluate(() => window.dispatchEvent(new Event("hive:sidebar-refresh")));
    await page.getByRole("button", { name: "Agent tools", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Agent tools and sessions" });
    await dialog.getByText("1.2.3", { exact: false }).waitFor();
    await page.keyboard.press("Escape");
    const agentsBefore = counts["agent-tools:software"];
    const agentStarted = Date.now();
    await page.getByRole("button", { name: "Agent tools", exact: true }).click();
    await dialog.getByText("1.2.3", { exact: false }).waitFor();
    const agentsReopenMs = Date.now() - agentStarted;
    assert.equal(counts["agent-tools:software"], agentsBefore);
    await preserved();
    await page.screenshot({ path: join(evidence, `${width}-cached-agents.png`) });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Manage Coder workspaces", exact: true }).click();
    await page.getByRole("dialog", { name: "Coder workspaces", exact: true }).waitFor();
    await preserved();
    assert.equal(counts["templates:null"], undefined);
    assert.deepEqual(errors, []);
    report.push({
      width,
      searchReopenMs,
      agentsReopenMs,
      counts,
      terminalMounts: await page.evaluate(() => window.mounts),
    });
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
await writeFile(join(evidence, "result.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
