import {
  type BrowserContextOptions,
  test as base,
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

const appUrl = process.env.PLAYWRIGHT_BASE_URL;
const coderUrl = process.env.HIVE_E2E_CODER_URL;
const email = process.env.HIVE_E2E_EMAIL;
const password = process.env.HIVE_E2E_PASSWORD;
const credentialsReady = Boolean(appUrl && coderUrl && email && password);
const ignoreHTTPSErrors = process.env.HIVE_E2E_IGNORE_HTTPS_ERRORS === "true";
type AuthenticatedStorageState = Exclude<BrowserContextOptions["storageState"], string | undefined>;

const test = base.extend<
  { storageState: BrowserContextOptions["storageState"] },
  { authenticatedStorageState: AuthenticatedStorageState }
>({
  storageState: async ({ authenticatedStorageState }, use) => {
    await use(authenticatedStorageState);
  },
  authenticatedStorageState: [
    async ({ browser }, use) => {
      const context = await browser.newContext({ ignoreHTTPSErrors });
      const page = await context.newPage();
      await login(page);
      const storageState = await context.storageState();
      await context.close();
      await use(storageState);
    },
    { scope: "worker" },
  ],
});

async function login(page: Page) {
  await page.goto(new URL("/login", appUrl).toString());
  await page.getByLabel("Coder URL").fill(coderUrl ?? "");
  await page.getByLabel("Email").fill(email ?? "");
  await page.getByLabel("Password").fill(password ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
}

async function dismissNotificationPrompt(page: Page) {
  const dismissNotifications = page.getByRole("button", {
    name: /Dismiss(?: notification prompt)?/,
  });
  if (await dismissNotifications.isVisible().catch(() => false)) {
    await dismissNotifications.click();
  }
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

async function waitForDashboardReady(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("data-dashboard-keybindings-ready", "true");
}

async function expectConnectedTerminal(page: Page) {
  const terminal = page
    .locator('[data-terminal-surface="true"][data-connection-state]:visible')
    .first();
  await expect(terminal).toBeVisible({ timeout: 30_000 });
  await expect(terminal).toHaveAttribute("data-connection-state", "connected", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("multi-session-loading")).toHaveCount(0);
  return terminal;
}

async function proveTerminalAcceptsInput(page: Page, terminal: Locator) {
  const marker = `hive-terminal-e2e-${Date.now()}`;
  const input = terminal.locator("textarea.xterm-helper-textarea");
  await input.focus();
  await page.keyboard.type(`printf '${marker}\\n'`);
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".xterm-rows")).toContainText(marker, { timeout: 15_000 });
}

test.describe("authenticated Hive workflows", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!credentialsReady, "Set the Hive preview URL and Coder test credentials.");

  test.beforeEach(async ({ page }) => {
    await page.goto(new URL("/tasks", appUrl).toString());
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
    await waitForDashboardReady(page);
    await dismissNotificationPrompt(page);
  });

  test("covers tasks, forms, recovery states, and global navigation", async ({
    page,
  }, testInfo) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
    await capture(page, testInfo, "tasks");

    const navigationModifier = await page.evaluate(() =>
      /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
    );
    await page.keyboard.press(`${navigationModifier}+Shift+1`);
    await expect(page).toHaveURL(/\/workspaces$/);
    await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
    await page.keyboard.press(`${navigationModifier}+Shift+2`);
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();

    await page.keyboard.press("Control+K");
    await expect(page.getByText("Workspaces", { exact: true }).last()).toBeVisible();
    await expect(page.getByText("Templates", { exact: true }).last()).toBeVisible();
    await expect(page.getByText("Terminal status", { exact: true }).last()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    await page.goto(new URL("/tasks/new", appUrl).toString());
    await expect(page.getByRole("heading", { name: "New Task" })).toBeVisible();
    await waitForDashboardReady(page);
    await page.getByLabel("Prompt *").fill("Polish the public release workflow");
    await expect(page.getByText("34 chars")).toBeVisible();
    await expect(
      page
        .getByLabel("Repository URL *")
        .evaluate((input) =>
          "checkValidity" in input && typeof input.checkValidity === "function"
            ? input.checkValidity()
            : false,
        ),
    ).resolves.toBe(false);
    await capture(page, testInfo, "new-task");

    await page.goto(new URL("/tasks/not-a-real-task", appUrl).toString());
    await expect(
      page.getByRole("heading", { name: "This task is no longer available." }),
    ).toBeVisible();
    const taskRecovery = page.locator("#main-content");
    await expect(taskRecovery.getByRole("link", { name: "Tasks" })).toBeVisible();
    await expect(taskRecovery.getByRole("link", { name: "New task" })).toBeVisible();

    expect(
      pageErrors.filter((message) => /hydration|Minified React error #418/i.test(message)),
    ).toEqual([]);
  });

  test("covers templates, workspace creation, status, and terminal recovery", async ({
    page,
  }, testInfo) => {
    await page.goto(new URL("/templates", appUrl).toString());
    await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible();
    await capture(page, testInfo, "templates");

    await page.goto(new URL("/templates/hive", appUrl).toString());
    await waitForDashboardReady(page);
    await page.getByRole("button", { name: "Push" }).click();
    await expect(page.getByRole("heading", { name: "Push hive?" })).toBeVisible();
    await expect(page.getByText(/Existing workspaces are not rebuilt automatically/)).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.goto(new URL("/workspaces", appUrl).toString());
    await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
    await waitForDashboardReady(page);
    await page.getByRole("button", { name: /Add workspace/ }).click();
    await expect(page.getByRole("heading", { name: "Add workspace" })).toBeVisible();
    await expect(page.getByLabel("Workspace name")).toBeVisible();
    await expect(page.getByLabel("Template")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await capture(page, testInfo, "workspaces");

    await page.goto(new URL("/terminal/status", appUrl).toString());
    await expect(page.getByRole("heading", { name: "Terminal status" })).toBeVisible();
    await expect(page.getByText(/never include terminal output/i)).toBeVisible();

    await page.goto(new URL("/workspaces/not-a-real-workspace/terminal", appUrl).toString());
    await expect(
      page.getByRole("heading", { name: "Workspace session is unavailable" }),
    ).toBeVisible();
    const workspaceRecovery = page.locator("#main-content");
    await expect(workspaceRecovery.getByRole("link", { name: "Workspaces" })).toBeVisible();
    await expect(workspaceRecovery.getByRole("link", { name: "Diagnostics" })).toBeVisible();
    await expect(
      workspaceRecovery.getByRole("button", { name: "Retry workspace session" }),
    ).toBeVisible();
  });

  test("opens a live workspace terminal when one is available", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const terminalSocketUrls: string[] = [];
    page.on("websocket", (socket) => {
      const url = new URL(socket.url());
      if (url.searchParams.has("agentId") && url.searchParams.has("reconnectId")) {
        terminalSocketUrls.push(socket.url());
      }
    });

    await page.goto(new URL("/workspaces", appUrl).toString());
    await waitForDashboardReady(page);
    const workspaceLink = page.locator('a[href$="/terminal/workspace"]:visible').first();
    const workspaceAvailable = await workspaceLink
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!workspaceAvailable, "No running workspace available.");

    await workspaceLink.click();
    await expect(page).toHaveURL(/\/workspaces\/[^/]+\/terminal\/workspace/);
    await expect(
      page.locator(
        '[data-testid="multi-session-workspace"], [data-testid="multi-session-empty"], [data-testid="session-load-error"]',
      ),
    ).toBeVisible({ timeout: 30_000 });
    const workspaceTerminal = await expectConnectedTerminal(page);
    await proveTerminalAcceptsInput(page, workspaceTerminal);
    const healthySocketCount = terminalSocketUrls.length;
    expect(healthySocketCount).toBeGreaterThan(0);

    await page.waitForTimeout(20_000);
    await expect(workspaceTerminal).toHaveAttribute("data-connection-state", "connected");
    expect(terminalSocketUrls).toHaveLength(healthySocketCount);
    await capture(page, testInfo, "workspace-terminal-connected");

    await page
      .getByRole("button", { name: /Browse files for/ })
      .first()
      .click();
    const workspaceToolDialog = page.getByTestId("workspace-tool-dialog");
    await expect(workspaceToolDialog).toBeVisible({ timeout: 30_000 });
    const workspaceToolFrame = page.getByTestId("workspace-tool-frame");
    await expect(workspaceToolFrame).toHaveAttribute(
      "src",
      /\/api\/workspace-proxy\/[^/]+\/filebrowser\/files\//,
    );
    const fileBrowserBody = page
      .frameLocator('[data-testid="workspace-tool-frame"]')
      .locator("body");
    await expect(fileBrowserBody).toBeVisible({ timeout: 30_000 });
    await expect(fileBrowserBody).not.toContainText(/login|unauthorized|proxy error/i);
    await capture(page, testInfo, "workspace-file-browser-embedded");

    await workspaceToolDialog.getByRole("tab", { name: /VS Code/ }).click();
    await expect(workspaceToolFrame).toHaveAttribute("src", /code-server--/);
    await expect(
      page.frameLocator('[data-testid="workspace-tool-frame"]').locator(".monaco-workbench"),
    ).toBeVisible({ timeout: 45_000 });
    await capture(page, testInfo, "workspace-vscode-embedded");
    await workspaceToolDialog.getByRole("button", { name: "Close" }).click();

    const sessionLabel = (await page.getByTestId("active-pane-label").textContent())?.trim();
    expect(sessionLabel).toBeTruthy();
    await page.keyboard.press("Control+K");
    await page.getByText(`Open ${sessionLabel}`, { exact: true }).click();
    await expect(page.getByTestId("single-terminal-header")).toBeVisible();
    const singleTerminal = await expectConnectedTerminal(page);
    await proveTerminalAcceptsInput(page, singleTerminal);
    await capture(page, testInfo, "single-terminal-connected");
  });
});
