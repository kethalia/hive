import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import ts from "typescript";

type ValidationWindow = Window & {
  validation: { hover: string[]; input: string[]; resolve?: () => void };
};

const requireModule = createRequire(`${process.cwd()}/package.json`);
const compile = (path: string) =>
  ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

test("late path validation uses the current pointer cell on the same row", async ({ page }) => {
  await page.setContent('<div id="terminal"></div>');
  await page.addStyleTag({ path: requireModule.resolve("@xterm/xterm/css/xterm.css") });
  await page.addScriptTag({ path: requireModule.resolve("@xterm/xterm") });
  await page.evaluate(
    async ({ targetCode, providerCode }) => {
      const modules: Record<string, Record<string, unknown>> = {};
      const load = (name: string, code: string) => {
        const exports: Record<string, unknown> = {};
        new Function("require", "exports", code)((key: string) => modules[key], exports);
        modules[name] = exports;
        return exports;
      };
      load("./link-target", targetCode);
      const { terminalPathLinkProvider } = load("./path-link-provider", providerCode);
      const state = window as unknown as {
        Terminal: new (options: object) => import("@xterm/xterm").Terminal;
        validation: { hover: string[]; input: string[]; resolve?: () => void };
      };
      const term = new state.Terminal({ cols: 70, rows: 5 });
      term.open(document.getElementById("terminal") as HTMLElement);
      state.validation = { hover: [], input: [] };
      term.onData((data) => state.validation.input.push(data));
      term.registerLinkProvider(
        (
          terminalPathLinkProvider as typeof import("../src/lib/terminal/path-link-provider").terminalPathLinkProvider
        )(
          term,
          { activate: () => {}, hover: (_event, text) => state.validation.hover.push(text) },
          (paths) =>
            new Promise((resolve) => {
              state.validation.resolve = () => resolve(paths);
            }),
        ),
      );
      await new Promise<void>((resolve) =>
        term.write("docs/real.md\x1b[?1000h\x1b[?1006h", resolve),
      );
    },
    {
      targetCode: compile("src/lib/terminal/link-target.ts"),
      providerCode: compile("src/lib/terminal/path-link-provider.ts"),
    },
  );
  const screen = await page.locator(".xterm-screen").boundingBox();
  if (!screen) throw new Error("Terminal screen is missing");
  await page.mouse.move(screen.x + 20, screen.y + 8);
  await page.waitForFunction(() =>
    Boolean((window as unknown as ValidationWindow).validation.resolve),
  );
  await page.mouse.move(screen.x + screen.width * 0.8, screen.y + 8);
  await page.evaluate(() => (window as unknown as ValidationWindow).validation.resolve?.());
  await page.mouse.click(screen.x + screen.width * 0.8, screen.y + 8);
  expect(
    await page.evaluate(() => (window as unknown as ValidationWindow).validation.hover),
  ).toEqual([]);
  expect(
    await page.evaluate(() => (window as unknown as ValidationWindow).validation.input.length),
  ).toBeGreaterThan(0);
});

for (const format of [
  "relative",
  "file-url",
  "osc",
  "relative-mouse",
  "relative-output",
  "relative-touch",
  "osc-touch",
  "relative-hybrid-touch",
  "osc-hybrid-touch",
  "relative-escape",
  "osc-escape",
  "relative-missing",
  "osc-missing",
] as const) {
  test(`file menu survives validation-triggered redraws (${format})`, async ({ page }) => {
    await page.setContent('<div id="terminal"></div>');
    await page.addStyleTag({ path: requireModule.resolve("@xterm/xterm/css/xterm.css") });
    for (const module of ["@xterm/xterm", "@xterm/addon-web-links", "@xterm/addon-clipboard"])
      await page.addScriptTag({ path: requireModule.resolve(module) });
    await page.evaluate(
      async ({ sources, format }) => {
        const state = window as unknown as {
          Terminal: new (options: object) => import("@xterm/xterm").Terminal;
          WebLinksAddon: object;
          ClipboardAddon: object;
          checks: number;
          reports: string[];
          actions: string[];
        };
        const modules: Record<string, object> = {
          "@xterm/addon-web-links": state.WebLinksAddon,
          "@xterm/addon-clipboard": state.ClipboardAddon,
          sonner: { toast: Object.assign(() => {}, { success: () => {}, error: () => {} }) },
        };
        for (const [name, code] of sources) {
          const exports = {};
          new Function("require", "exports", code)((key: string) => modules[key], exports);
          modules[name] = exports;
        }
        const { installTerminalBrowserIntegration } = modules[
          "./browser-integration"
        ] as typeof import("../src/lib/terminal/browser-integration");
        const term = new state.Terminal({ cols: 120, rows: 5 });
        term.open(document.getElementById("terminal") as HTMLElement);
        state.checks = 0;
        state.reports = [];
        term.onData((data) => state.reports.push(data));
        state.actions = [];
        installTerminalBrowserIntegration(term, {
          validatePaths: async (paths) => {
            state.checks++;
            await new Promise((resolve) => setTimeout(resolve, 750));
            // Model the terminal being repainted after a server response. Re-linking
            // that same row must not perpetually start another server action.
            if (format !== "relative-output") setTimeout(() => term.refresh(0, 4), 0);
            return format.endsWith("missing") ? [] : paths;
          },
          onFileAction: (path) => state.actions.push(path),
        });
        if (format === "relative-output") {
          let progress = 0;
          setInterval(() => term.write(`\x1b[4;1HBuild progress ${progress++}`), 80);
        }
        const path = format.startsWith("relative")
          ? "docs/design/references/images/flash-desktop-concept.png"
          : "file:///home/coder/.codex/generated_images/example/image.png";
        const text = format.startsWith("osc") ? `\x1b]8;;${path}\x07${path}\x1b]8;;\x07` : path;
        await new Promise<void>((resolve) =>
          term.write(
            `${text}\r\n${format === "relative-mouse" || format.endsWith("escape") ? "\x1b[?1003h\x1b[?1006h" : ""}`,
            resolve,
          ),
        );
      },
      {
        format,
        sources: [
          "link-target",
          "path-validation",
          "path-link-provider",
          "link-menu",
          "browser-integration",
        ].map((name) => [`./${name}`, compile(`src/lib/terminal/${name}.ts`)]),
      },
    );
    const screen = await page.locator(".xterm-screen").boundingBox();
    if (!screen) throw new Error("Terminal screen is missing");
    if (format.endsWith("touch")) {
      await page.locator(".xterm-screen").evaluate((screen) => {
        const rect = screen.getBoundingClientRect();
        const touch = new Touch({
          identifier: 1,
          target: screen,
          clientX: rect.x + 30,
          clientY: rect.y + 8,
        });
        screen.dispatchEvent(
          new TouchEvent("touchstart", {
            bubbles: true,
            touches: [touch],
            changedTouches: [touch],
          }),
        );
        screen.dispatchEvent(
          new TouchEvent("touchend", {
            bubbles: true,
            cancelable: true,
            touches: [],
            changedTouches: [touch],
          }),
        );
      });
    } else await page.mouse.move(screen.x + 30, screen.y + 8);
    await expect(page.getByRole("status")).toHaveText(/Checking file…/, { timeout: 300 });
    await expect(page.getByRole("menuitem")).toHaveCount(0);
    if (format.includes("hybrid")) {
      await page.mouse.move(screen.x + screen.width - 10, screen.y + 8);
      await expect(page.getByRole("status")).toHaveCount(0);
      await page.waitForTimeout(1000);
      await expect(page.getByRole("menu")).toHaveCount(0);
      await page.mouse.move(screen.x + 30, screen.y + 8);
    }
    if (format.endsWith("escape") || format.endsWith("missing")) {
      if (format.endsWith("escape")) await page.keyboard.press("Escape");
      await page.waitForTimeout(1000);
      await expect(page.getByRole("status")).toHaveCount(0);
      await expect(page.getByRole("menu")).toHaveCount(0);
      if (format.endsWith("escape")) {
        await page.evaluate(() => {
          (window as unknown as { reports: string[] }).reports = [];
        });
        // No move: the late provider hover must still arm local click interception.
        await page.mouse.down();
        await page.mouse.up();
        await expect(page.getByRole("menu")).toBeVisible();
        expect(
          await page.evaluate(() => (window as unknown as { reports: string[] }).reports),
        ).toEqual([]);
      }
      return;
    }
    await expect(page.getByRole("menu")).toBeVisible({ timeout: 4000 });
    if (format === "relative-mouse") {
      expect(
        await page.evaluate(() =>
          (window as unknown as { reports: string[] }).reports.some((data) =>
            data.startsWith("\x1b[<35;"),
          ),
        ),
      ).toBe(true);
    }
    expect(await page.evaluate(() => (window as unknown as { checks: number }).checks)).toBe(1);
    await page.getByRole("menuitem", { name: "Open in Files (new window)", exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { actions: string[] }).actions)).toEqual(
      [
        format.startsWith("relative")
          ? "docs/design/references/images/flash-desktop-concept.png"
          : "/home/coder/.codex/generated_images/example/image.png",
      ],
    );
  });
}
