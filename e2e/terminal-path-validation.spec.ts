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
