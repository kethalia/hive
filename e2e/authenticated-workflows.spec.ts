import { expect, type Page, type TestInfo, test } from "@playwright/test";

const appUrl = process.env.PLAYWRIGHT_BASE_URL;
const coderUrl = process.env.HIVE_E2E_CODER_URL;
const email = process.env.HIVE_E2E_EMAIL;
const password = process.env.HIVE_E2E_PASSWORD;
const credentialsReady = Boolean(appUrl && coderUrl && email && password);

async function login(page: Page) {
  await page.goto(new URL("/login", appUrl).toString());
  await page.getByLabel("Coder URL").fill(coderUrl ?? "");
  await page.getByLabel("Email").fill(email ?? "");
  await page.getByLabel("Password").fill(password ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/tasks$/);

  const dismissNotifications = page.getByRole("button", { name: "Dismiss notification prompt" });
  if (await dismissNotifications.isVisible().catch(() => false)) {
    await dismissNotifications.click();
  }
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

test.describe("authenticated Hive workflows", () => {
  test.skip(!credentialsReady, "Set the Hive preview URL and Coder test credentials.");

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("covers tasks, forms, recovery states, and global navigation", async ({
    page,
  }, testInfo) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
    await capture(page, testInfo, "tasks");

    await page.keyboard.press("Control+K");
    await expect(page.getByText("Workspaces", { exact: true }).last()).toBeVisible();
    await expect(page.getByText("Templates", { exact: true }).last()).toBeVisible();
    await expect(page.getByText("Terminal status", { exact: true }).last()).toBeVisible();
    await page.keyboard.press("Escape");

    await page.keyboard.press("Control+Shift+2");
    await expect(page).toHaveURL(/\/workspaces$/);
    await page.keyboard.press("Control+Shift+1");
    await expect(page).toHaveURL(/\/tasks$/);

    await page.goto(new URL("/tasks/new", appUrl).toString());
    await expect(page.getByRole("heading", { name: "New Task" })).toBeVisible();
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
    await expect(page.getByRole("link", { name: "Tasks" })).toBeVisible();
    await expect(page.getByRole("link", { name: "New task" })).toBeVisible();

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
    await page.getByRole("button", { name: "Push" }).click();
    await expect(page.getByRole("heading", { name: "Push hive?" })).toBeVisible();
    await expect(page.getByText(/Existing workspaces are not rebuilt automatically/)).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.goto(new URL("/workspaces", appUrl).toString());
    await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
    await page.getByRole("button", { name: /Add workspace/ }).click();
    await expect(page.getByRole("heading", { name: "Add workspace" })).toBeVisible();
    await expect(page.getByLabel("Workspace name")).toBeVisible();
    await expect(page.getByLabel("Template")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await capture(page, testInfo, "workspaces");

    await page.goto(new URL("/terminal/status", appUrl).toString());
    await expect(page.getByRole("heading", { name: "Terminal status" })).toBeVisible();
    await expect(page.getByText(/does not include terminal content/i)).toBeVisible();

    await page.goto(new URL("/workspaces/not-a-real-workspace/terminal", appUrl).toString());
    await expect(
      page.getByRole("heading", { name: "Workspace session is unavailable" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Workspaces" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Diagnostics" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("opens a live workspace terminal when one is available", async ({ page }, testInfo) => {
    await page.goto(new URL("/workspaces", appUrl).toString());
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
