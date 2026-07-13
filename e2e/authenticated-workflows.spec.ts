import {
  type BrowserContextOptions,
  test as base,
  expect,
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
  await expect(page).toHaveURL(/\/tasks$/);
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
    await page.keyboard.press(`${navigationModifier}+Shift+2`);
    await expect(page).toHaveURL(/\/workspaces$/);
    await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
    await page.keyboard.press(`${navigationModifier}+Shift+1`);
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
    await page.goto(new URL("/workspaces", appUrl).toString());
    await waitForDashboardReady(page);
    const workspaceLink = page.getByRole("link", { name: /Open workspace for/ }).first();
    test.skip(
      !(await workspaceLink.isVisible().catch(() => false)),
      "No running workspace available.",
    );

    await workspaceLink.click();
    await expect(page).toHaveURL(/\/workspaces\/[^/]+\/terminal\/workspace/);
    await expect(
      page.locator(
        '[data-testid="multi-session-workspace"], [data-testid="multi-session-empty"], [data-testid="session-load-error"]',
      ),
    ).toBeVisible({ timeout: 30_000 });
    await capture(page, testInfo, "workspace-terminal");
  });
});
