import {
  type BrowserContextOptions,
  test as base,
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import {
  findWorkspaceWindowInDirection,
  type WorkspaceWindowDirection,
} from "../src/lib/workspaces/workspace-window-layout";

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

interface TouchCoordinates {
  x: number;
  y: number;
}

function cdpTouchPoint(id: number, coordinates: TouchCoordinates) {
  return {
    id,
    x: coordinates.x,
    y: coordinates.y,
    radiusX: 5,
    radiusY: 5,
    force: 1,
  };
}

async function dispatchTwoFingerSwipe(page: Page, target: Locator, direction: "left" | "right") {
  const box = await target.boundingBox();
  if (!box) throw new Error("Gesture target has no measurable bounds.");

  const session = await page.context().newCDPSession(page);

  const travel = Math.min(Math.max(box.width * 0.4, 80), box.width * 0.6);
  const startX = direction === "left" ? box.x + box.width * 0.75 : box.x + box.width * 0.25;
  const endX = direction === "left" ? startX - travel : startX + travel;
  const centerY = box.y + box.height * 0.55;

  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [cdpTouchPoint(1, { x: startX, y: centerY - 18 })],
    });
    await page.waitForTimeout(40);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        cdpTouchPoint(1, { x: startX, y: centerY - 18 }),
        cdpTouchPoint(2, { x: startX, y: centerY + 18 }),
      ],
    });
    let previousX = startX;
    for (const progress of [0.25, 0.5, 0.75, 1]) {
      const x = startX + (endX - startX) * progress;
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          cdpTouchPoint(1, { x, y: centerY - 18 }),
          cdpTouchPoint(2, { x: previousX, y: centerY + 18 }),
        ],
      });
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          cdpTouchPoint(1, { x, y: centerY - 18 }),
          cdpTouchPoint(2, { x, y: centerY + 18 }),
        ],
      });
      previousX = x;
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(100);
  } finally {
    await session.detach();
  }
}

async function dispatchTwoFingerPinch(page: Page, target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error("Gesture target has no measurable bounds.");

  const session = await page.context().newCDPSession(page);
  const centerX = box.x + box.width * 0.5;
  const centerY = box.y + box.height * 0.55;

  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        cdpTouchPoint(1, { x: centerX, y: centerY - 10 }),
        cdpTouchPoint(2, { x: centerX, y: centerY + 10 }),
      ],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        cdpTouchPoint(1, { x: centerX, y: centerY - 42 }),
        cdpTouchPoint(2, { x: centerX, y: centerY + 42 }),
      ],
    });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await session.detach();
  }
}

async function dispatchOneFingerRightSwipe(
  page: Page,
  target: Locator,
  origin: "edge" | "surface",
) {
  const box = await target.boundingBox();
  if (!box) throw new Error("One-finger swipe target has no measurable bounds.");

  const session = await page.context().newCDPSession(page);
  const startX = origin === "edge" ? 4 : box.x + box.width * 0.45;
  const endX = Math.min(startX + 88, page.viewportSize()?.width ?? startX + 88);
  const y = box.y + box.height * 0.55;

  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [cdpTouchPoint(1, { x: startX, y })],
    });
    await page.waitForTimeout(32);
    for (const progress of [0.25, 0.5, 0.75, 1]) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          cdpTouchPoint(1, {
            x: startX + (endX - startX) * progress,
            y,
          }),
        ],
      });
      await page.waitForTimeout(16);
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await session.detach();
  }
}

async function dispatchOneFingerLeftSwipe(page: Page, target: Locator, origin: "edge" | "surface") {
  const box = await target.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error("Global navigation gesture target could not be measured.");

  const session = await page.context().newCDPSession(page);
  const startX = origin === "edge" ? viewport.width - 4 : box.x + box.width * 0.55;
  const endX = startX - 88;
  const y = box.y + box.height * 0.55;

  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [cdpTouchPoint(1, { x: startX, y })],
    });
    await page.waitForTimeout(32);
    for (const progress of [0.25, 0.5, 0.75, 1]) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          cdpTouchPoint(1, {
            x: startX + (endX - startX) * progress,
            y,
          }),
        ],
      });
      await page.waitForTimeout(16);
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await session.detach();
  }
}

async function dispatchTouchLongPress(page: Page, target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error("Long-press target has no measurable bounds.");

  const session = await page.context().newCDPSession(page);
  const point = cdpTouchPoint(1, {
    x: box.x + Math.min(96, box.width * 0.3),
    y: box.y + box.height * 0.5,
  });

  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await page.waitForTimeout(650);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await session.detach();
  }
}

function activeTouchTerminalFrame(page: Page) {
  return page
    .locator('[data-pane-mode][data-active="true"]:visible')
    .filter({ has: page.locator('[data-terminal-navigation-surface="true"]') })
    .first();
}

async function ensureThreeTouchTerminals(page: Page) {
  const terminalFrames = page
    .locator("[data-pane-mode]:visible")
    .filter({ has: page.locator('[data-terminal-navigation-surface="true"]') });
  const createdSessionNames = await page
    .locator('[data-workspace-window-id^="gesture-e2e-"]:visible')
    .evaluateAll((panes) =>
      panes.flatMap((pane) => {
        const sessionName = pane.getAttribute("data-workspace-window-id");
        return sessionName ? [sessionName] : [];
      }),
    );
  while ((await terminalFrames.count()) < 3) {
    const sessionCountBefore = await terminalFrames.count();
    const createdSessionName = `gesture-e2e-${Date.now()}-${createdSessionNames.length + 1}`;
    createdSessionNames.push(createdSessionName);
    await page.getByRole("button", { name: "Open workspace command palette" }).click();
    await page.getByRole("combobox").fill(createdSessionName);
    await page
      .getByRole("option", {
        name: new RegExp(`^New terminal session named ${createdSessionName}`),
      })
      .click();
    await expect.poll(() => terminalFrames.count()).toBeGreaterThan(sessionCountBefore);
  }
  await expect.poll(() => terminalFrames.count()).toBeGreaterThanOrEqual(3);
  return createdSessionNames;
}

async function verifyTerminalTouchNavigation(page: Page) {
  const activePaneLabel = page.getByTestId("active-pane-label").first();
  const firstTerminalLabel = (await activePaneLabel.textContent())?.trim();
  if (!firstTerminalLabel) throw new Error("Active terminal has no label.");

  const terminalLabels = await page
    .locator("[data-pane-mode]:visible")
    .filter({ has: page.locator('[data-terminal-navigation-surface="true"]') })
    .evaluateAll((frames) =>
      frames.flatMap((frame) => {
        const label = frame.getAttribute("data-pane-label")?.trim();
        return label ? [label] : [];
      }),
    );
  if (terminalLabels.length < 3) throw new Error("Three terminal labels are required.");
  const firstTerminalIndex = terminalLabels.indexOf(firstTerminalLabel);
  if (firstTerminalIndex < 0) throw new Error("Active terminal is absent from terminal order.");
  const previousTerminalLabel =
    terminalLabels[(firstTerminalIndex - 1 + terminalLabels.length) % terminalLabels.length];
  if (!previousTerminalLabel) throw new Error("Previous terminal label could not be resolved.");

  await dispatchTwoFingerSwipe(
    page,
    activeTouchTerminalFrame(page).getByTestId("terminal-fit-host"),
    "left",
  );
  await expect
    .poll(async () => (await activePaneLabel.textContent())?.trim())
    .toBe(previousTerminalLabel);
  const terminalLabelAfterLeftSwipe = (await activePaneLabel.textContent())?.trim();
  if (!terminalLabelAfterLeftSwipe)
    throw new Error("Active terminal has no label after left swipe.");
  await dispatchTwoFingerSwipe(
    page,
    activeTouchTerminalFrame(page).getByTestId("terminal-fit-host"),
    "right",
  );
  await expect
    .poll(async () => (await activePaneLabel.textContent())?.trim())
    .toBe(firstTerminalLabel);
  const terminalLabelAfterRightSwipe = (await activePaneLabel.textContent())?.trim();
  if (!terminalLabelAfterRightSwipe) {
    throw new Error("Active terminal has no label after right swipe.");
  }
  await dispatchTwoFingerPinch(
    page,
    activeTouchTerminalFrame(page).getByTestId("terminal-fit-host"),
  );
  await expect(activePaneLabel).toHaveText(terminalLabelAfterRightSwipe);
}

async function verifyMobileWorkspaceWindowDrag(page: Page) {
  const terminalWindows = page
    .locator("[data-workspace-window-id]:visible")
    .filter({ has: page.locator('[data-terminal-navigation-surface="true"]') });
  await expect.poll(() => terminalWindows.count()).toBeGreaterThanOrEqual(2);
  const draggedWindow = terminalWindows.first();
  const targetWindow = terminalWindows.nth(1);
  const dragHeader = draggedWindow.locator('[data-testid$="-header"]');
  const dragActivator = dragHeader.locator('[data-testid$="-title"]');
  const dragBox = await dragActivator.boundingBox();
  const targetBox = await targetWindow.boundingBox();
  if (!dragBox || !targetBox) throw new Error("Mobile workspace windows could not be measured.");

  const persistedLayoutBefore = await persistedWorkspaceWindowLayout(page);
  const { targetPoint } = workspaceDropTarget(targetBox);
  const start = {
    x: dragBox.x + dragBox.width * 0.35,
    y: dragBox.y + dragBox.height * 0.5,
  };
  const session = await page.context().newCDPSession(page);

  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [cdpTouchPoint(1, start)],
    });
    await page.waitForTimeout(50);
    for (const progress of [0.2, 0.4, 0.6, 0.8, 1]) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          cdpTouchPoint(1, {
            x: start.x + (targetPoint.x - start.x) * progress,
            y: start.y + (targetPoint.y - start.y) * progress,
          }),
        ],
      });
      await page.waitForTimeout(16);
    }
    await expect(draggedWindow).toHaveAttribute("data-workspace-window-dragging", "true");
    await expect(page.getByTestId("workspace-window-drop-placeholder")).toBeVisible();
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await session.detach();
  }

  await expect(page.getByTestId("workspace-window-drop-placeholder")).toHaveCount(0);
  await expect.poll(() => persistedWorkspaceWindowLayout(page)).not.toBe(persistedLayoutBefore);
}

async function verifyWorkspaceTouchNavigation(page: Page) {
  const boardTabs = page.getByRole("tab", { name: /workspace/i });
  const initialBoardCount = await boardTabs.count();
  await page.getByTestId("workspace-board-new").click();
  await expect(boardTabs).toHaveCount(initialBoardCount + 1);
  const createdBoard = boardTabs.last();
  await expect(createdBoard).toHaveAttribute("aria-selected", "true");

  const boardBar = page.getByTestId("workspace-board-bar");
  await dispatchTwoFingerSwipe(page, boardBar, "right");
  await expect(boardTabs.first()).toHaveAttribute("aria-selected", "true");
  await dispatchTwoFingerSwipe(page, boardBar, "left");
  await expect(createdBoard).toHaveAttribute("aria-selected", "true");
  await boardTabs.first().click();
  return { boardTabs, createdBoard, initialBoardCount };
}

async function verifySidebarEdgeNavigation(page: Page) {
  const urlBeforeSwipe = page.url();
  const historyLengthBeforeSwipe = await page.evaluate(() => history.length);
  const terminalSurface = activeTouchTerminalFrame(page).locator(
    '[data-terminal-navigation-surface="true"]',
  );
  await dispatchOneFingerRightSwipe(page, terminalSurface, "surface");

  const mobileSidebar = page.locator(
    '[data-sidebar="sidebar"][data-mobile="true"][data-side="left"]',
  );
  await expect(mobileSidebar).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(mobileSidebar).toBeHidden();

  await dispatchOneFingerRightSwipe(page, terminalSurface, "edge");

  await expect(mobileSidebar).toBeVisible();
  await expect(page).toHaveURL(urlBeforeSwipe);
  expect(await page.evaluate(() => history.length)).toBe(historyLengthBeforeSwipe);
  await page.keyboard.press("Escape");
  await expect(mobileSidebar).toBeHidden();
}

async function verifyGlobalCommandDrawerGesture(page: Page) {
  const urlBeforeSwipe = page.url();
  const historyLengthBeforeSwipe = await page.evaluate(() => history.length);
  const terminalSurface = activeTouchTerminalFrame(page).locator(
    '[data-terminal-navigation-surface="true"]',
  );

  await dispatchOneFingerLeftSwipe(page, terminalSurface, "surface");

  const globalDrawer = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("searchbox", { name: "Search global navigation" }) });
  await expect(globalDrawer).toBeVisible();
  await expect(globalDrawer).toHaveAttribute("data-side", "right");
  const drawerBox = await globalDrawer.boundingBox();
  const viewport = page.viewportSize();
  if (!drawerBox || !viewport) throw new Error("Global navigation sidebar could not be measured.");
  expect(drawerBox.height).toBeGreaterThanOrEqual(viewport.height - 1);
  expect(drawerBox.width).toBeLessThanOrEqual(289);
  const globalSearch = globalDrawer.getByRole("searchbox", { name: "Search global navigation" });
  await expect(globalSearch).toBeVisible();
  expect(await globalSearch.evaluate((input) => getComputedStyle(input).fontSize)).toBe("16px");
  await expect(
    globalDrawer.getByRole("button", { name: /Workspaces Open Coder workspaces/ }),
  ).toBeVisible();
  await expect(
    globalDrawer.getByRole("button", { name: /Templates Review and push/ }),
  ).toBeVisible();
  await expect(globalDrawer.getByRole("button", { name: /Terminal status Inspect/ })).toBeVisible();
  await expect(
    globalDrawer.getByRole("button", { name: /New terminal session in workspace/ }),
  ).toBeVisible();
  await expect(globalDrawer.locator('[data-slot="command-shortcut"]')).toHaveCount(0);

  const sessionDisclosure = globalDrawer
    .locator('[data-testid^="mobile-command-disclosure-workspace:session:"]')
    .first();
  await expect(sessionDisclosure).toBeVisible();
  await expect(sessionDisclosure).toHaveAttribute("aria-expanded", "false");
  const sessionTitle = (await sessionDisclosure.textContent())?.trim();
  if (!sessionTitle) throw new Error("Terminal session disclosure has no visible title.");
  await sessionDisclosure.click();
  await expect(sessionDisclosure).toHaveAttribute("aria-expanded", "true");
  const sessionActions = globalDrawer.getByRole("group", { name: /actions$/ }).first();
  await expect(sessionActions).toBeVisible();
  await expect(sessionActions.getByRole("button", { name: "Add" })).toBeVisible();
  await expect(sessionActions.getByRole("button", { name: "Open" })).toBeVisible();
  await expect(sessionActions.getByRole("button", { name: "VS Code" })).toBeVisible();
  await expect(sessionActions.getByRole("button", { name: "Files" })).toBeVisible();
  await expect(sessionActions.getByRole("button", { name: "Logs" })).toBeVisible();

  await dispatchOneFingerRightSwipe(page, globalDrawer, "surface");
  const leftSidebar = page.locator(
    '[data-sidebar="sidebar"][data-mobile="true"][data-side="left"]',
  );
  await expect(leftSidebar).toBeVisible();
  await expect(globalDrawer).toBeHidden();

  await dispatchOneFingerLeftSwipe(page, leftSidebar, "surface");
  await expect(globalDrawer).toBeVisible();
  await expect(leftSidebar).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(globalDrawer).toBeHidden();

  await dispatchOneFingerLeftSwipe(page, terminalSurface, "edge");

  await expect(globalDrawer).toBeVisible();
  await expect(page).toHaveURL(urlBeforeSwipe);
  expect(await page.evaluate(() => history.length)).toBe(historyLengthBeforeSwipe);
  await page.keyboard.press("Escape");
  await expect(globalDrawer).toBeHidden();
}

async function verifyNativePaneActions(page: Page, testInfo: TestInfo) {
  const frame = activeTouchTerminalFrame(page);
  const paneHeader = frame.locator('[data-testid$="-header"]');
  const moreButton = frame.getByRole("button", { name: /^Open actions for / });
  await expect(paneHeader.getByRole("button")).toHaveCount(1);
  await expect(paneHeader.locator('[data-testid$="-drag-icon"]')).toHaveCount(1);
  await expect(page.getByTestId("git-terminal-font-size-controls")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Decrease font size" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Increase font size" })).toBeVisible();
  const moreButtonBox = await moreButton.boundingBox();
  if (!moreButtonBox) throw new Error("Pane action button has no measurable bounds.");
  expect(moreButtonBox.width).toBeGreaterThanOrEqual(44);
  expect(moreButtonBox.height).toBeGreaterThanOrEqual(44);

  await moreButton.click();
  const actionSheet = page.getByTestId("workspace-pane-action-sheet");
  await expect(actionSheet).toBeVisible();
  await expect(actionSheet.locator("[cmdk-root]")).toHaveCount(0);
  const directActions = actionSheet.locator("fieldset > button");
  await expect.poll(() => directActions.count()).toBeGreaterThanOrEqual(5);
  await expect(actionSheet.locator('[data-testid^="workspace-pane-action-move-"]')).toHaveCount(0);
  expect(
    await directActions.evaluateAll((buttons) =>
      buttons.every((button) => button.getBoundingClientRect().height >= 44),
    ),
  ).toBe(true);
  await capture(page, testInfo, "mobile-native-pane-actions");
  await actionSheet.getByRole("button", { name: "Close pane actions" }).click();
  await expect(actionSheet).toBeHidden();

  await dispatchTouchLongPress(page, frame.locator('[data-testid$="-header"]'));
  await expect(actionSheet).toBeHidden();
}

async function cleanupTestSession(page: Page, sessionName: string) {
  await page.keyboard.press("Escape").catch(() => undefined);
  const workspacePane = page.locator(`[data-workspace-window-id="${sessionName}"]`);
  if (await workspacePane.isVisible().catch(() => false)) {
    await workspacePane.getByRole("button", { name: /^Open actions for / }).click();
    await page
      .getByTestId("workspace-pane-action-sheet")
      .getByRole("button", { name: /^Remove terminal/ })
      .click();
    await expect(workspacePane).toHaveCount(0);
  }
  const revealActions = page.getByTestId(`show-terminal-session-actions-${sessionName}`);
  const sessionsToggle = page.getByRole("button", { name: "Sessions" });
  const sessionsToggleInViewport =
    (await sessionsToggle.count()) > 0 &&
    (await sessionsToggle.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    }));
  if (!sessionsToggleInViewport) {
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  }
  await expect(sessionsToggle).toBeInViewport();
  if ((await sessionsToggle.getAttribute("aria-expanded")) !== "true") {
    await sessionsToggle.click();
  }
  const killSession = page.getByTestId(`kill-session-${sessionName}`);
  const sessionLink = page.getByRole("link", { name: sessionName, exact: true });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if ((await sessionLink.count()) === 0) return;
    if ((await killSession.count()) > 0) {
      const clicked = await killSession
        .click({ force: true, timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
      if (clicked) {
        const removed = await expect
          .poll(() => sessionLink.count(), { timeout: 2_000 })
          .toBe(0)
          .then(() => true)
          .catch(() => false);
        if (removed) return;
      }
    }
    if ((await revealActions.count()) > 0) {
      await revealActions.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`Could not clean up test terminal session ${sessionName}.`);
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

function trackFileBrowserResourceLoads(page: Page) {
  let successfulLoads = 0;
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      url.hostname.startsWith("filebrowser--") &&
      url.pathname === "/api/resources/" &&
      response.ok()
    ) {
      successfulLoads += 1;
    }
  });
  return () => successfulLoads;
}

function trackVsCodeWorkbenchLoads(page: Page) {
  let successfulLoads = 0;
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      url.hostname.startsWith("code-server--") &&
      url.pathname.endsWith("/vs/code/browser/workbench/workbench.js") &&
      response.ok()
    ) {
      successfulLoads += 1;
    }
  });
  return () => successfulLoads;
}

async function expectFileBrowserReady(
  page: Page,
  getSuccessfulLoads: () => number,
  previousLoadCount: number,
) {
  await expect(page.getByTestId("workspace-tool-frame-files")).toBeVisible({ timeout: 30_000 });
  await expect.poll(getSuccessfulLoads, { timeout: 30_000 }).toBeGreaterThan(previousLoadCount);
}

async function verifyEmbeddedToolsOpenInParallel(
  page: Page,
  testInfo: TestInfo,
  getSuccessfulFileBrowserLoads: () => number,
  getSuccessfulVsCodeLoads: () => number,
) {
  const previousFileBrowserLoadCount = getSuccessfulFileBrowserLoads();
  const previousVsCodeLoadCount = getSuccessfulVsCodeLoads();
  const fileBrowserButton = page.getByRole("button", { name: /^Browse files for / }).first();
  const vsCodeButton = page.getByRole("button", { name: /^Open VS Code for / }).first();

  await fileBrowserButton.click();
  await expect(vsCodeButton).toBeEnabled();
  await vsCodeButton.click();

  await expect(page.getByTestId("workspace-tool-pane-files")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("workspace-tool-pane-code")).toBeVisible({ timeout: 30_000 });
  const fileBrowserFrame = page.getByTestId("workspace-tool-frame-files");
  await expect(fileBrowserFrame).toHaveAttribute("src", /filebrowser--.*\/files\//);
  await expect(page.getByTestId("workspace-tool-frame-code")).toHaveAttribute(
    "src",
    /code-server--/,
  );
  await Promise.all([
    expectFileBrowserReady(page, getSuccessfulFileBrowserLoads, previousFileBrowserLoadCount),
    expect
      .poll(getSuccessfulVsCodeLoads, { timeout: 45_000 })
      .toBeGreaterThan(previousVsCodeLoadCount),
  ]);
  await expect(page.getByTestId("workspace-tool-pane-files")).toHaveAttribute(
    "data-pane-state",
    "ready",
  );
  await expect(page.getByTestId("workspace-tool-pane-code")).toHaveAttribute(
    "data-pane-state",
    "ready",
  );
  await capture(page, testInfo, "workspace-tools-embedded-in-parallel");
}

interface WorkspaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type WorkspaceTestDropPosition = "top" | "left";

interface WorkspaceMeasurement {
  body: Locator;
  bodyBox: WorkspaceRect;
  renderedRects: Map<string, WorkspaceRect>;
}

async function measureWorkspaceWindows(page: Page): Promise<WorkspaceMeasurement> {
  const body = page.getByTestId("multi-session-body");
  const windows = page.locator("[data-workspace-window-id]:visible");
  await expect.poll(() => windows.count()).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("multi-session-grid")).toHaveAttribute(
    "data-layout-mode",
    "binary-split",
  );

  const bodyBox = await body.boundingBox();
  if (!bodyBox) throw new Error("Workspace body has no measurable bounds.");
  const renderedRects = new Map<string, WorkspaceRect>();
  for (let index = 0; index < (await windows.count()); index += 1) {
    const window = windows.nth(index);
    const id = await window.getAttribute("data-workspace-window-id");
    const rect = await window.boundingBox();
    if (!id || !rect) throw new Error(`Workspace window ${index} has incomplete geometry.`);
    renderedRects.set(id, rect);
  }
  return { body, bodyBox, renderedRects };
}

async function verifyWorkspaceCoverage(measurement: WorkspaceMeasurement) {
  const { body, bodyBox, renderedRects } = measurement;
  let totalWindowArea = 0;
  for (const windowBox of renderedRects.values()) {
    expect(windowBox.x).toBeGreaterThanOrEqual(bodyBox.x - 1);
    expect(windowBox.y).toBeGreaterThanOrEqual(bodyBox.y - 1);
    expect(windowBox.x + windowBox.width).toBeLessThanOrEqual(bodyBox.x + bodyBox.width + 1);
    expect(windowBox.y + windowBox.height).toBeLessThanOrEqual(bodyBox.y + bodyBox.height + 1);
    totalWindowArea += windowBox.width * windowBox.height;
  }
  expect(totalWindowArea).toBeGreaterThan(bodyBox.width * bodyBox.height * 0.98);
  expect(totalWindowArea).toBeLessThan(bodyBox.width * bodyBox.height * 1.02);
  expect(
    await body.evaluate((element) => ({
      horizontal: element.scrollWidth - element.clientWidth,
      vertical: element.scrollHeight - element.clientHeight,
    })),
  ).toEqual({ horizontal: 0, vertical: 0 });
}

async function workspaceWindowId(window: Locator, label: string): Promise<string> {
  const id = await window.getAttribute("data-workspace-window-id");
  if (!id) throw new Error(`${label} has no window ID.`);
  return id;
}

function workspaceWindowContaining(page: Page, pane: Locator): Locator {
  return page.locator("[data-workspace-window-id]:visible").filter({ has: pane }).first();
}

async function verifyDirectionalWorkspaceFocus(
  page: Page,
  { bodyBox, renderedRects }: WorkspaceMeasurement,
) {
  const codePane = page.getByTestId("workspace-tool-pane-code");
  const filesPane = page.getByTestId("workspace-tool-pane-files");
  await expect(codePane).toHaveAttribute("data-active", "true");
  const codeWindow = workspaceWindowContaining(page, codePane);
  const codeWindowId = await workspaceWindowId(codeWindow, "Code window");
  const filesWindowId = await workspaceWindowId(
    workspaceWindowContaining(page, filesPane),
    "Files window",
  );
  const directions: WorkspaceWindowDirection[] = ["left", "right", "up", "down"];
  const directionToFiles = directions.find(
    (direction) =>
      findWorkspaceWindowInDirection(renderedRects, codeWindowId, direction) === filesWindowId,
  );
  if (!directionToFiles) {
    throw new Error("The files pane is not the closest directional neighbor of the code pane.");
  }
  await codeWindow.locator('[data-window-drag-surface="true"]').click();
  await expect(codePane).toHaveAttribute("data-active", "true");
  const keyDirection = `${directionToFiles[0]?.toUpperCase()}${directionToFiles.slice(1)}`;
  await page.keyboard.press(`Control+Arrow${keyDirection}`);
  await expect(filesPane).toHaveAttribute("data-active", "true");

  const edgeCandidate = closestWorkspaceEdge(bodyBox, renderedRects);
  const edgeWindow = page.locator(`[data-workspace-window-id="${edgeCandidate.id}"]:visible`);
  await edgeWindow.locator('[data-window-drag-surface="true"]').click();
  await expect(edgeWindow.locator('[data-active="true"]')).toHaveCount(1);
  await page.keyboard.press(`Control+Arrow${edgeCandidate.direction}`);
  await expect(edgeWindow.locator('[data-active="true"]')).toHaveCount(1);
}

async function verifyHoverWorkspaceFocus(page: Page) {
  const filesPane = page.getByTestId("workspace-tool-pane-files");
  const codePane = page.getByTestId("workspace-tool-pane-code");
  const filesFrame = page.getByTestId("workspace-tool-frame-files");
  const codeFrame = page.getByTestId("workspace-tool-frame-code");

  await page.getByTestId("workspace-tool-pane-files-header").hover();
  await expect(filesPane).toHaveAttribute("data-active", "true");
  await codeFrame.focus();
  await expect(codePane).toHaveAttribute("data-active", "true");
  await filesFrame.hover();
  await expect(filesPane).toHaveAttribute("data-active", "true");
  await page.getByTestId("workspace-tool-pane-code-header").hover();
  await expect(codePane).toHaveAttribute("data-active", "true");
}

async function verifyWorkspaceWindowChrome(page: Page) {
  const pane = page.locator('[data-pane-mode="tiled"]:visible').first();
  const window = workspaceWindowContaining(page, pane);
  const paneBox = await pane.boundingBox();
  const windowBox = await window.boundingBox();
  if (!paneBox || !windowBox) throw new Error("Workspace window chrome could not be measured.");

  expect(paneBox.x - windowBox.x).toBeGreaterThanOrEqual(1);
  expect(paneBox.y - windowBox.y).toBeGreaterThanOrEqual(1);
  expect(windowBox.width - paneBox.width).toBeGreaterThanOrEqual(2);
  expect(windowBox.height - paneBox.height).toBeGreaterThanOrEqual(2);
  expect(await pane.evaluate((element) => getComputedStyle(element).borderRadius)).not.toBe("0px");

  const codeHeader = page.getByTestId("workspace-tool-pane-code-header");
  const dragIcon = page.getByTestId("workspace-tool-pane-code-drag-icon");
  const title = page.getByTestId("workspace-tool-pane-code-title");
  const dragIconBox = await dragIcon.boundingBox();
  const titleBox = await title.boundingBox();
  if (!dragIconBox || !titleBox) {
    throw new Error("Workspace window title could not be measured.");
  }
  await expect(codeHeader.getByRole("button", { name: /^Drag / })).toHaveCount(0);
  expect(Math.abs(dragIconBox.width - 12)).toBeLessThan(1);
  expect(Math.abs(dragIconBox.height - 12)).toBeLessThan(1);
  expect(
    Math.abs(dragIconBox.y + dragIconBox.height / 2 - (titleBox.y + titleBox.height / 2)),
  ).toBeLessThan(1);
}

function closestWorkspaceEdge(bodyBox: WorkspaceRect, rects: ReadonlyMap<string, WorkspaceRect>) {
  const candidates = [...rects.entries()].flatMap(([id, rect]) => [
    { id, direction: "Left", distance: Math.abs(rect.x - bodyBox.x) },
    {
      id,
      direction: "Right",
      distance: Math.abs(bodyBox.x + bodyBox.width - (rect.x + rect.width)),
    },
    { id, direction: "Up", distance: Math.abs(rect.y - bodyBox.y) },
    {
      id,
      direction: "Down",
      distance: Math.abs(bodyBox.y + bodyBox.height - (rect.y + rect.height)),
    },
  ]);
  candidates.sort((left, right) => left.distance - right.distance);
  const edgeCandidate = candidates[0];
  if (!edgeCandidate || edgeCandidate.distance > 2) {
    throw new Error("No workspace window reaches the workspace edge.");
  }
  return edgeCandidate;
}

async function verifyWorkspaceWindowDrag(page: Page) {
  await verifyNoopWorkspaceWindowDrags(page);
  await verifySiblingWorkspaceWindowSwap(page);

  const codeWindow = workspaceWindowContaining(page, page.getByTestId("workspace-tool-pane-code"));
  const terminalWindow = page
    .locator('[data-workspace-window-id]:has([data-terminal-surface="true"]):visible')
    .first();
  const terminalBoxBefore = await terminalWindow.boundingBox();
  if (!(await codeWindow.boundingBox()) || !terminalBoxBefore) {
    throw new Error("Workspace windows could not be measured before drag.");
  }
  const persistedLayoutBefore = await persistedWorkspaceWindowLayout(page);
  const { dropPosition, targetPoint } = workspaceDropTarget(terminalBoxBefore);
  const dragSurface = page.getByTestId("workspace-tool-pane-code-header");
  await startWorkspaceWindowDrag(page, dragSurface, targetPoint);
  const { dragged: codeExpected, target: terminalExpected } = workspaceSplitRects(
    terminalBoxBefore,
    dropPosition,
  );
  await expect(codeWindow).toHaveCSS("opacity", "0.6");
  await expectPointerInsideWorkspaceWindow(codeWindow, targetPoint);
  await expectStandaloneWorkspacePlaceholder(page, codeExpected, dropPosition);
  await expectWorkspaceRect(terminalWindow, terminalExpected);
  await page.mouse.up();

  await expectWorkspaceRect(codeWindow, codeExpected);
  await expectWorkspaceRect(terminalWindow, terminalExpected);
  await expect.poll(() => persistedWorkspaceWindowLayout(page)).not.toBe(persistedLayoutBefore);
}

async function verifyNoopWorkspaceWindowDrags(page: Page) {
  const codeWindow = workspaceWindowContaining(page, page.getByTestId("workspace-tool-pane-code"));
  const dragSurface = page.getByTestId("workspace-tool-pane-code-header");
  const bodyBox = await page.getByTestId("multi-session-body").boundingBox();
  const windowBoxBefore = await codeWindow.boundingBox();
  if (!bodyBox || !windowBoxBefore) {
    throw new Error("Workspace bounds could not be measured before no-op drag validation.");
  }
  const persistedLayoutBefore = await persistedWorkspaceWindowLayout(page);

  await dragSurface.click();
  await waitForTwoAnimationFrames(page);
  await expect(page.getByTestId("workspace-window-drop-placeholder")).toHaveCount(0);
  await expectWorkspaceRect(codeWindow, windowBoxBefore);
  expect(await persistedWorkspaceWindowLayout(page)).toBe(persistedLayoutBefore);

  await startWorkspaceWindowDrag(page, dragSurface, pointOutsideWorkspace(page, bodyBox));
  await expectOriginWorkspacePlaceholder(page, windowBoxBefore);
  await page.mouse.up();
  await waitForTwoAnimationFrames(page);
  await expect(page.getByTestId("workspace-window-drop-placeholder")).toHaveCount(0);
  await expectWorkspaceRect(codeWindow, windowBoxBefore);
  expect(await persistedWorkspaceWindowLayout(page)).toBe(persistedLayoutBefore);
}

function pointOutsideWorkspace(page: Page, bodyBox: WorkspaceRect) {
  const viewport = page.viewportSize();
  if (bodyBox.x >= 16) {
    return { x: bodyBox.x - 8, y: bodyBox.y + bodyBox.height / 2 };
  }
  if (bodyBox.y >= 16) {
    return { x: bodyBox.x + bodyBox.width / 2, y: bodyBox.y - 8 };
  }
  if (viewport && bodyBox.x + bodyBox.width + 8 < viewport.width) {
    return { x: bodyBox.x + bodyBox.width + 8, y: bodyBox.y + bodyBox.height / 2 };
  }
  if (viewport && bodyBox.y + bodyBox.height + 8 < viewport.height) {
    return { x: bodyBox.x + bodyBox.width / 2, y: bodyBox.y + bodyBox.height + 8 };
  }
  throw new Error("The workspace fills the viewport, so an outside drop point is unavailable.");
}

async function verifySiblingWorkspaceWindowSwap(page: Page) {
  const codeWindow = workspaceWindowContaining(page, page.getByTestId("workspace-tool-pane-code"));
  const filesWindow = workspaceWindowContaining(
    page,
    page.getByTestId("workspace-tool-pane-files"),
  );
  const codeBefore = await codeWindow.boundingBox();
  const filesBefore = await filesWindow.boundingBox();
  if (!codeBefore || !filesBefore) throw new Error("Sibling tool windows could not be measured.");
  const persistedLayoutBefore = await persistedWorkspaceWindowLayout(page);
  const { dropPosition, targetPoint } = workspaceDropTarget(filesBefore);

  await startWorkspaceWindowDrag(
    page,
    page.getByTestId("workspace-tool-pane-code-header"),
    targetPoint,
  );
  await expect(codeWindow).toHaveCSS("opacity", "0.6");
  await expectPointerInsideWorkspaceWindow(codeWindow, targetPoint);
  await expectStandaloneWorkspacePlaceholder(page, filesBefore, dropPosition);
  await expectWorkspaceRect(filesWindow, codeBefore);
  await page.mouse.up();

  await expectWorkspaceRect(codeWindow, filesBefore);
  await expectWorkspaceRect(filesWindow, codeBefore);
  await expect.poll(() => persistedWorkspaceWindowLayout(page)).not.toBe(persistedLayoutBefore);
}

function workspaceDropTarget(target: WorkspaceRect): {
  dropPosition: WorkspaceTestDropPosition;
  targetPoint: { x: number; y: number };
} {
  if (target.height > target.width) {
    return {
      dropPosition: "top",
      targetPoint: { x: target.x + target.width / 2, y: target.y + target.height / 4 },
    };
  }
  return {
    dropPosition: "left",
    targetPoint: { x: target.x + target.width / 4, y: target.y + target.height / 2 },
  };
}

async function startWorkspaceWindowDrag(
  page: Page,
  dragHandle: Locator,
  targetPoint: { x: number; y: number },
) {
  const dragGrip = dragHandle.locator('[data-testid$="-drag-icon"]');
  const dragHandleBox = await dragGrip.boundingBox();
  if (!dragHandleBox) throw new Error("VS Code drag handle could not be measured.");
  await page.mouse.move(
    dragHandleBox.x + dragHandleBox.width / 2,
    dragHandleBox.y + dragHandleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 12 });
}

async function waitForTwoAnimationFrames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function expectStandaloneWorkspacePlaceholder(
  page: Page,
  expected: WorkspaceRect,
  dropPosition: WorkspaceTestDropPosition,
) {
  const placeholder = page.getByTestId("workspace-window-drop-placeholder");
  await expect(placeholder).toBeVisible();
  await expect(placeholder).toHaveAttribute("data-workspace-window-drop-kind", "destination");
  await expect(placeholder).toHaveAttribute("data-workspace-window-drop-position", dropPosition);
  expect(
    await placeholder.evaluate((element) => Boolean(element.closest("[data-workspace-window-id]"))),
  ).toBe(false);
  await expectWorkspaceRect(placeholder, expected);
}

async function expectOriginWorkspacePlaceholder(page: Page, expected: WorkspaceRect) {
  const placeholder = page.getByTestId("workspace-window-drop-placeholder");
  await expect(placeholder).toBeVisible();
  await expect(placeholder).toHaveAttribute("data-workspace-window-drop-kind", "origin");
  await expect(placeholder).not.toHaveAttribute("data-workspace-window-drop-position");
  await expectWorkspaceRect(placeholder, expected);
}

async function expectPointerInsideWorkspaceWindow(
  window: Locator,
  pointer: { x: number; y: number },
) {
  await expect
    .poll(async () => {
      const rect = await window.boundingBox();
      if (!rect) return false;
      return (
        pointer.x >= rect.x &&
        pointer.x <= rect.x + rect.width &&
        pointer.y >= rect.y &&
        pointer.y <= rect.y + rect.height
      );
    })
    .toBe(true);
}

function workspaceSplitRects(
  target: WorkspaceRect,
  dropPosition: WorkspaceTestDropPosition,
): { dragged: WorkspaceRect; target: WorkspaceRect } {
  const dragged =
    dropPosition === "top"
      ? { ...target, height: target.height / 2 }
      : { ...target, width: target.width / 2 };
  const remainingTarget =
    dropPosition === "top"
      ? { ...dragged, y: target.y + target.height / 2 }
      : { ...dragged, x: target.x + target.width / 2 };
  return { dragged, target: remainingTarget };
}

async function persistedWorkspaceWindowLayout(page: Page) {
  return page.evaluate(() =>
    Object.entries(window.localStorage)
      .filter(([key]) => key.startsWith("workspace-window-layout:"))
      .map(([key, value]) => `${key}:${value}`)
      .sort()
      .join("\n"),
  );
}

async function expectWorkspaceRect(window: Locator, expected: WorkspaceRect) {
  for (const axis of ["x", "y", "width", "height"] as const) {
    await expect.poll(() => rectDelta(window, axis, expected[axis])).toBeLessThan(2);
  }
}

async function rectDelta(
  window: Locator,
  axis: "x" | "y" | "width" | "height",
  target: number,
): Promise<number> {
  return Math.abs(((await window.boundingBox())?.[axis] ?? 0) - target);
}

async function verifyWorkspaceWindowManagement(page: Page, testInfo: TestInfo) {
  const measurement = await measureWorkspaceWindows(page);
  await verifyWorkspaceCoverage(measurement);
  await verifyWorkspaceWindowChrome(page);
  await verifyHoverWorkspaceFocus(page);
  await verifyDirectionalWorkspaceFocus(page, measurement);
  await verifyWorkspaceWindowDrag(page);
  await verifyWorkspaceCoverage(await measureWorkspaceWindows(page));
  await capture(page, testInfo, "workspace-window-management");
}

async function verifyEmbeddedToolsSurviveRefresh(
  page: Page,
  testInfo: TestInfo,
  getSuccessfulFileBrowserLoads: () => number,
  getSuccessfulVsCodeLoads: () => number,
) {
  const originalCodeUrl = await page.getByTestId("workspace-tool-frame-code").getAttribute("src");
  expect(originalCodeUrl).toBeTruthy();
  const persistedUrls = await page.evaluate(() =>
    Object.entries(window.localStorage)
      .filter(([key]) => key.startsWith("workspace-tool-panes:"))
      .some(([, value]) =>
        /coder_application_connect_api_key|\/api\/workspace-proxy\//.test(value),
      ),
  );
  expect(persistedUrls).toBe(false);

  const inactiveTerminalPane = page
    .getByTestId("multi-session-grid")
    .locator('[data-testid^="workspace-pane-"][data-active="false"]')
    .first();
  if ((await inactiveTerminalPane.count()) > 0) {
    await inactiveTerminalPane.dispatchEvent("click");
  }
  const explicitlyFocusedLabel = (
    await page.getByTestId("active-pane-label").textContent()
  )?.trim();
  expect(explicitlyFocusedLabel).toBeTruthy();

  // Keep the stationary pointer outside the board while panes remount. Otherwise an iframe
  // restored beneath it correctly wins focus through the workspace's hover-focus behavior.
  await page.mouse.move(1, 1);

  const previousFileBrowserLoadCount = getSuccessfulFileBrowserLoads();
  const previousVsCodeLoadCount = getSuccessfulVsCodeLoads();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("multi-session-workspace")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("multi-session-loading")).toHaveCount(0);
  await expect(page.getByTestId("active-pane-label")).toHaveText(explicitlyFocusedLabel ?? "");
  await expect(page.getByTestId("workspace-tool-pane-files")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("workspace-tool-pane-code")).toBeVisible({ timeout: 30_000 });
  await Promise.all([
    expectFileBrowserReady(page, getSuccessfulFileBrowserLoads, previousFileBrowserLoadCount),
    expect
      .poll(getSuccessfulVsCodeLoads, { timeout: 45_000 })
      .toBeGreaterThan(previousVsCodeLoadCount),
    expectConnectedTerminal(page),
  ]);
  await expect(page.getByTestId("workspace-tool-pane-files")).toHaveAttribute(
    "data-pane-state",
    "ready",
  );
  await expect(page.getByTestId("workspace-tool-pane-code")).toHaveAttribute(
    "data-pane-state",
    "ready",
  );
  await expect(page.getByTestId("active-pane-label")).toHaveText(explicitlyFocusedLabel ?? "");

  const restoredCodeUrl = await page.getByTestId("workspace-tool-frame-code").getAttribute("src");
  expect(restoredCodeUrl).toMatch(/code-server--/);
  expect(restoredCodeUrl).not.toBe(originalCodeUrl);
  await capture(page, testInfo, "workspace-tools-restored-after-refresh");
}

async function verifyPaletteToolAndOpenActions(page: Page, testInfo: TestInfo) {
  const sessionLabel = (await page.getByTestId("active-pane-label").textContent())?.trim();
  expect(sessionLabel).toBeTruthy();
  await page.keyboard.press("Control+K");
  await page.getByPlaceholder(/Search terminal sessions/).fill(sessionLabel ?? "");
  const sessionRow = page
    .locator('[cmdk-item][data-action-id^="workspace:session:"]')
    .filter({ hasText: sessionLabel ?? "" })
    .first();
  await expect(sessionRow).toHaveAttribute("aria-selected", "true");
  const searchInput = page.getByPlaceholder(/Search terminal sessions/);
  await expect(searchInput).toBeFocused();
  await searchInput.press("ArrowRight");
  await expect(sessionRow.getByRole("button", { name: "VS Code" })).toHaveAttribute(
    "data-selected",
    "true",
  );
  await searchInput.press("Enter");
  await expect(page.getByTestId("workspace-tool-pane-code")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("remove-workspace-tool-code").click();

  await page.keyboard.press("Control+K");
  await page.getByPlaceholder(/Search terminal sessions/).fill(sessionLabel ?? "");
  const openOption = sessionRow.getByRole("button", { name: "Open", exact: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await openOption.getAttribute("data-selected")) === "true") break;
    await searchInput.press("ArrowLeft");
  }
  await expect(openOption).toHaveAttribute("data-selected", "true");
  await searchInput.press("Enter");
  await expect(page.getByTestId("single-terminal-header")).toBeVisible({ timeout: 15_000 });
  const singleTerminal = await expectConnectedTerminal(page);
  await proveTerminalAcceptsInput(page, singleTerminal);
  await capture(page, testInfo, "single-terminal-connected");
}

async function proveTerminalAcceptsInput(page: Page, terminal: Locator) {
  const marker = `hive-terminal-e2e-${Date.now()}`;
  const input = terminal.locator("textarea.xterm-helper-textarea");
  await input.focus();
  await page.keyboard.type(`printf '${marker}\\n'`);
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".xterm-rows")).toContainText(marker, { timeout: 15_000 });
}

async function visibleWorkspaceWindowIds(page: Page): Promise<string[]> {
  return page.locator("[data-workspace-window-id]:visible").evaluateAll((elements) =>
    elements
      .map((element) => element.getAttribute("data-workspace-window-id"))
      .filter((id): id is string => id !== null)
      .sort(),
  );
}

async function createIsolatedStressTerminal(
  page: Page,
): Promise<{ terminal: Locator; sessionName: string }> {
  const initialWindowIds = await visibleWorkspaceWindowIds(page);
  const sessionName = `stress-e2e-${Date.now()}`;
  await page.getByRole("button", { name: "Open workspace command palette" }).click();
  await page.getByRole("combobox").fill(sessionName);
  await page
    .getByRole("option", {
      name: new RegExp(`^New terminal session named ${sessionName}`),
    })
    .click();
  await expect
    .poll(() => visibleWorkspaceWindowIds(page))
    .toHaveLength(initialWindowIds.length + 1);
  const terminal = page
    .locator(`[data-workspace-window-id="${sessionName}"]`)
    .locator('[data-terminal-surface="true"]');
  await expect(terminal).toHaveAttribute("data-connection-state", "connected", { timeout: 30_000 });
  return { terminal, sessionName };
}

async function startSustainedOutput(page: Page, terminal: Locator, marker: string) {
  const input = terminal.locator("textarea.xterm-helper-textarea");
  await input.focus();
  await page.keyboard.type(
    `i=0; while [ "$i" -lt 15 ]; do i=$((i+1)); printf '${marker} %s %s\\n' "$(date -Is)" "$i"; sleep 1; done`,
  );
  await page.keyboard.press("Enter");
}

async function captureSustainedActivity(
  page: Page,
  testInfo: TestInfo,
  sessions: Array<{ terminal: Locator; marker: string }>,
): Promise<boolean[]> {
  const observedMarkers = sessions.map(() => false);
  for (let second = 1; second <= 15; second += 1) {
    await page.waitForTimeout(1_000);
    await page.screenshot({
      path: testInfo.outputPath(
        `workspace-sustained-activity-${String(second).padStart(2, "0")}.png`,
      ),
      fullPage: true,
    });
    for (const [index, { terminal, marker }] of sessions.entries()) {
      await expect(terminal).toHaveAttribute("data-connection-state", "connected");
      const output = await terminal.locator(".xterm-rows").textContent();
      if (output?.includes(marker)) observedMarkers[index] = true;
    }
  }
  return observedMarkers;
}

async function verifySustainedTerminalActivity(page: Page, testInfo: TestInfo, terminal: Locator) {
  const marker = `hive-window-stress-${Date.now()}`;
  const secondaryMarker = `secondary-${Date.now().toString(36)}`;
  const stressSession = await createIsolatedStressTerminal(page);
  const stressWindow = stressSession.terminal.locator(
    "xpath=ancestor::*[@data-workspace-window-id]",
  );
  const initialWindowIds = await visibleWorkspaceWindowIds(page);

  await stressWindow.getByRole("button", { name: /^Open session logs for / }).click();
  const eventLogPane = page.getByTestId("workspace-tool-pane-logs");
  try {
    await expect(eventLogPane).toBeVisible({ timeout: 15_000 });

    await startSustainedOutput(page, terminal, marker);
    await startSustainedOutput(page, stressSession.terminal, secondaryMarker);
    const observedMarkers = await captureSustainedActivity(page, testInfo, [
      { terminal, marker },
      { terminal: stressSession.terminal, marker: secondaryMarker },
    ]);

    expect(observedMarkers).toEqual([true, true]);
    await expect(eventLogPane.getByRole("log")).toContainText(/browser_input|upstream_output/, {
      timeout: 15_000,
    });
    const finalWindowIds = await visibleWorkspaceWindowIds(page);
    expect(finalWindowIds).toHaveLength(initialWindowIds.length + 1);
    expect(initialWindowIds.every((id) => finalWindowIds.includes(id))).toBe(true);
    expect(finalWindowIds.some((id) => id.includes(":logs"))).toBe(true);
  } finally {
    if (await eventLogPane.isVisible().catch(() => false)) {
      await page.getByTestId("remove-workspace-tool-logs").click();
      await expect(eventLogPane).toHaveCount(0);
    }
    await cleanupTestSession(page, stressSession.sessionName);
  }
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
    await expect(page.getByTestId("create-workspace-template")).toBeVisible();
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

  test("supports touch navigation and native pane actions", async ({
    browserName,
    isMobile,
    page,
  }, testInfo) => {
    test.skip(browserName !== "chromium" || !isMobile, "Requires Chromium touch CDP events.");
    test.setTimeout(90_000);

    await page.goto(new URL("/workspaces", appUrl).toString());
    await waitForDashboardReady(page);
    const workspaceLink = page.locator('a[href$="/terminal/workspace"]:visible').first();
    const workspaceAvailable = await workspaceLink
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!workspaceAvailable, "No running workspace available.");

    const workspaceHref = await workspaceLink.getAttribute("href");
    if (!workspaceHref) throw new Error("Running workspace link has no destination.");
    await page.goto(new URL(workspaceHref, appUrl).toString());
    await expect(
      page.locator('[data-testid="multi-session-workspace"], [data-testid="multi-session-empty"]'),
    ).toBeVisible({ timeout: 30_000 });

    let createdSessionNames: string[] = [];
    try {
      createdSessionNames = await ensureThreeTouchTerminals(page);
      await expectConnectedTerminal(page);
      await verifySidebarEdgeNavigation(page);
      await verifyGlobalCommandDrawerGesture(page);
      await verifyTerminalTouchNavigation(page);
      await verifyMobileWorkspaceWindowDrag(page);
      const { boardTabs, createdBoard, initialBoardCount } =
        await verifyWorkspaceTouchNavigation(page);
      await verifyNativePaneActions(page, testInfo);
      await createdBoard.click();
      await expect(createdBoard).toHaveAttribute("aria-selected", "true");
      await createdBoard.click();
      await expect(boardTabs).toHaveCount(initialBoardCount);
      await capture(page, testInfo, "mobile-touch-workspace-navigation");
    } finally {
      for (const createdSessionName of createdSessionNames) {
        await cleanupTestSession(page, createdSessionName);
      }
    }
  });

  test("opens a live workspace terminal when one is available", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const getSuccessfulFileBrowserLoads = trackFileBrowserResourceLoads(page);
    const getSuccessfulVsCodeLoads = trackVsCodeWorkbenchLoads(page);
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

    const workspaceHref = await workspaceLink.getAttribute("href");
    expect(workspaceHref).toBeTruthy();
    if (!workspaceHref) throw new Error("Running workspace link has no destination.");
    await page.goto(new URL(workspaceHref, appUrl).toString());
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

    await test.step("embed File Browser and VS Code with independent parallel loading", async () => {
      await verifyEmbeddedToolsOpenInParallel(
        page,
        testInfo,
        getSuccessfulFileBrowserLoads,
        getSuccessfulVsCodeLoads,
      );
    });
    await test.step("keeps every window stable under sustained terminal activity", async () => {
      await verifySustainedTerminalActivity(page, testInfo, workspaceTerminal);
      expect(pageErrors).toEqual([]);
    });
    await test.step("tile, focus, and drag workspace windows without overflow", async () => {
      await verifyWorkspaceWindowManagement(page, testInfo);
    });
    await test.step("restore embedded tools with fresh authorization after refresh", async () => {
      await verifyEmbeddedToolsSurviveRefresh(
        page,
        testInfo,
        getSuccessfulFileBrowserLoads,
        getSuccessfulVsCodeLoads,
      );
    });
    await page.getByTestId("remove-workspace-tool-files").click();
    await page.getByTestId("remove-workspace-tool-code").click();
    await test.step("choose VS Code and Open with palette arrow keys", async () => {
      await verifyPaletteToolAndOpenActions(page, testInfo);
    });
  });
});
