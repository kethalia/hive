import { expect, test } from "@playwright/test";

const harnessHtml = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Terminal reconnect lifecycle harness</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #0b0d10;
        color: #f4f7fb;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          linear-gradient(135deg, rgba(37, 99, 235, 0.18), transparent 42%),
          #0b0d10;
      }

      main {
        width: min(860px, calc(100vw - 32px));
        display: grid;
        gap: 16px;
      }

      h1 {
        margin: 0;
        font-size: 24px;
        font-weight: 650;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }

      .session {
        min-height: 180px;
        border: 1px solid #263241;
        border-radius: 8px;
        background: #090b0f;
        overflow: hidden;
      }

      .session header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid #1f2937;
        padding: 8px 10px;
        background: #111827;
        font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }

      .status {
        border-radius: 999px;
        padding: 2px 8px;
        background: #064e3b;
        color: #a7f3d0;
        font-size: 11px;
      }

      .session[data-state="reconnecting"] .status {
        background: #7c2d12;
        color: #fed7aa;
      }

      pre {
        margin: 0;
        padding: 12px;
        color: #cbd5e1;
        font: 12px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <main data-testid="reconnect-harness">
      <h1>Terminal reconnect lifecycle harness</h1>
      <section class="grid">
        <article class="session" data-testid="session-main" data-session="main"></article>
        <article class="session" data-testid="session-clone" data-session="clone"></article>
      </section>
    </main>
    <script>
      const sessions = new Map([
        ["main", { name: "main", state: "connected", socketOpen: true, refreshes: 0, connects: 1, inFlight: false }],
        ["clone", { name: "clone", state: "connected", socketOpen: true, refreshes: 0, connects: 1, inFlight: false }],
      ]);
      let visibilityState = "visible";

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get() {
          return visibilityState;
        },
      });

      function isConnectionLost(session) {
        return (
          session.state === "disconnected" ||
          session.state === "workspace-offline" ||
          session.state === "failed" ||
          (session.state === "connected" && !session.socketOpen)
        );
      }

      function render() {
        for (const session of sessions.values()) {
          const el = document.querySelector('[data-session="' + session.name + '"]');
          el.dataset.state = session.state;
          el.dataset.socketOpen = String(session.socketOpen);
          el.dataset.refreshes = String(session.refreshes);
          el.dataset.connects = String(session.connects);
          el.innerHTML =
            '<header><span>' + session.name + '</span><span class="status">' + session.state + '</span></header>' +
            '<pre>socketOpen=' + session.socketOpen +
            '\nrefreshes=' + session.refreshes +
            '\nconnects=' + session.connects +
            '\ninFlight=' + session.inFlight + '</pre>';
        }
      }

      async function reconnect(session) {
        if (session.inFlight || !isConnectionLost(session)) return;
        session.inFlight = true;
        session.state = "reconnecting";
        session.refreshes += 1;
        render();
        await new Promise((resolve) => setTimeout(resolve, 20));
        session.socketOpen = true;
        session.connects += 1;
        session.state = "connected";
        session.inFlight = false;
        render();
      }

      function foregroundReconnectIfLost() {
        for (const session of sessions.values()) {
          void reconnect(session);
        }
      }

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "hidden") foregroundReconnectIfLost();
      });
      window.addEventListener("pageshow", () => {
        if (document.visibilityState !== "hidden") foregroundReconnectIfLost();
      });
      window.addEventListener("online", foregroundReconnectIfLost);

      window.terminalReconnectHarness = {
        drop(name) {
          const session = sessions.get(name);
          session.socketOpen = false;
          render();
        },
        async foregroundBurst() {
          visibilityState = "visible";
          window.dispatchEvent(new Event("pageshow"));
          document.dispatchEvent(new Event("visibilitychange"));
          window.dispatchEvent(new Event("online"));
          await new Promise((resolve) => setTimeout(resolve, 40));
        },
        background() {
          visibilityState = "hidden";
          document.dispatchEvent(new Event("visibilitychange"));
          window.dispatchEvent(new Event("pagehide"));
        },
      };

      render();
    </script>
  </body>
</html>`;

test("foreground lifecycle keeps healthy sessions stable and refreshes a lost session once", async ({
  page,
}, testInfo) => {
  await page.setContent(harnessHtml);

  await expect(page.getByTestId("session-main")).toHaveAttribute("data-state", "connected");
  await expect(page.getByTestId("session-clone")).toHaveAttribute("data-state", "connected");

  await page.evaluate(() => {
    window.terminalReconnectHarness.background();
  });
  await page.evaluate(async () => {
    await window.terminalReconnectHarness.foregroundBurst();
  });

  await expect(page.getByTestId("session-main")).toHaveAttribute("data-refreshes", "0");
  await expect(page.getByTestId("session-clone")).toHaveAttribute("data-refreshes", "0");

  await page.evaluate(() => {
    window.terminalReconnectHarness.drop("clone");
  });
  await page.evaluate(async () => {
    await window.terminalReconnectHarness.foregroundBurst();
  });

  await expect(page.getByTestId("session-main")).toHaveAttribute("data-refreshes", "0");
  await expect(page.getByTestId("session-clone")).toHaveAttribute("data-refreshes", "1");
  await expect(page.getByTestId("session-clone")).toHaveAttribute("data-state", "connected");

  const screenshot = await page.screenshot({
    path: testInfo.outputPath("terminal-reconnect-visual.png"),
    fullPage: true,
  });
  expect(screenshot.byteLength).toBeGreaterThan(10_000);
});

declare global {
  interface Window {
    terminalReconnectHarness: {
      background: () => void;
      drop: (name: "main" | "clone") => void;
      foregroundBurst: () => Promise<void>;
    };
  }
}
