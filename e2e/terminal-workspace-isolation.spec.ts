import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import ts from "typescript";

const requireModule = createRequire(`${process.cwd()}/package.json`);
const compile = (path: string) =>
  ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

test.use({ hasTouch: true });

for (const kind of ["url", "osc-url", "file"] as const) {
  test(`touch link menus stay in the active workspace (${kind})`, async ({ page }) => {
    // Model the mounted board layers; the component test checks that switching
    // MultiSessionWorkspace applies these inert attributes without remounting.
    await page.setContent(`
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <button id="first-tab">First workspace</button>
    <button id="second-tab">Second workspace</button>
    <main style="position:relative; height:300px">
      <section data-board-key="first" data-board-active="false" inert
        style="position:absolute; inset:0; opacity:0; pointer-events:none">
        <div data-terminal-native-selection="true" id="first"></div>
      </section>
      <section data-board-key="second" data-board-active="true"
        style="position:absolute; inset:0">
        <div data-terminal-native-selection="true" id="second"></div>
      </section>
    </main>
  `);
    await page.addStyleTag({ path: "src/styles/xterm.css" });
    await page.addStyleTag({
      content: '[role="menu"] { position:fixed; z-index:100; background:white; padding:8px }',
    });
    for (const module of ["@xterm/xterm", "@xterm/addon-web-links", "@xterm/addon-clipboard"])
      await page.addScriptTag({ path: requireModule.resolve(module) });
    await page.evaluate(
      async ({ sources, kind }) => {
        const state = window as unknown as {
          Terminal: new (options: object) => import("@xterm/xterm").Terminal;
          WebLinksAddon: object;
          ClipboardAddon: object;
          taps: string[];
          input: Record<string, string>;
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
        const selectBoard = (key: string) => {
          for (const board of document.querySelectorAll<HTMLElement>("[data-board-key]")) {
            const active = board.dataset.boardKey === key;
            board.dataset.boardActive = String(active);
            board.inert = !active;
            board.style.opacity = active ? "1" : "0";
            board.style.pointerEvents = active ? "" : "none";
          }
        };
        state.taps = [];
        state.input = { first: "", second: "" };
        for (const key of ["first", "second"]) {
          const tab = document.getElementById(`${key}-tab`);
          const host = document.getElementById(key);
          if (!tab || !host) throw new Error("Missing workspace fixture");
          tab.onclick = () => selectBoard(key);
          // InteractiveTerminal blocks touch compatibility presses before xterm
          // can focus/select. A link must work through touchend, not mouse fallback.
          host.addEventListener("mousedown", (event) => event.stopImmediatePropagation(), true);
          const term = new state.Terminal({ cols: 50, rows: 8 });
          term.open(host);
          installTerminalBrowserIntegration(term, {
            validatePaths: (paths) =>
              new Promise((resolve) => setTimeout(() => resolve(paths), 50)),
          });
          host.addEventListener("pointerdown", () => state.taps.push(key));
          host.addEventListener("touchend", (event) => {
            if (event.defaultPrevented) return;
            selectBoard(key);
            term.focus();
          });
          host.addEventListener("click", (event) => {
            term.focus();
            event.preventDefault();
          });
          term.onData((data) => {
            state.input[key] += data;
          });
          const url = `https://example.com/${key}`;
          const text =
            kind === "file"
              ? `docs/${key}.md`
              : kind === "osc-url"
                ? `\x1b]8;;${url}\x07Pull request\x1b]8;;\x07`
                : url;
          await new Promise<void>((resolve) => term.write(`${text}\r\nType here`, resolve));
        }
      },
      {
        kind,
        sources: [
          ["@/lib/gestures/conventions", compile("src/lib/gestures/conventions.ts")],
          ...[
            "link-target",
            "path-validation",
            "path-link-provider",
            "link-menu",
            "native-selection",
            "browser-integration",
          ].map((name) => [`./${name}`, compile(`src/lib/terminal/${name}.ts`)]),
        ],
      },
    );

    for (const key of ["second", "first", "second", "first"]) {
      await page.locator(`#${key}-tab`).tap();
      const screen = await page.locator(`#${key} .xterm-screen`).boundingBox();
      if (!screen) throw new Error("Missing terminal screen");
      await page.touchscreen.tap(screen.x + 30, screen.y + screen.height / 16);
      await expect(page.getByRole("menu")).toContainText(
        kind === "file" ? `docs/${key}.md` : `https://example.com/${key}`,
      );
      await expect(page.locator(`[data-board-key="${key}"]`)).toHaveAttribute(
        "data-board-active",
        "true",
      );
      // Tap a non-link row, close the menu and type into the visible terminal.
      await page.touchscreen.tap(
        screen.x + screen.width - 10,
        screen.y + (screen.height * 15) / 16,
      );
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(page.locator(`#${key} textarea`)).toBeFocused();
      await page.keyboard.type("x");
    }
    const result = await page.evaluate(() => {
      const state = window as unknown as { taps: string[]; input: Record<string, string> };
      return { taps: state.taps, input: state.input };
    });
    expect(result.taps).toEqual([
      "second",
      "second",
      "first",
      "first",
      "second",
      "second",
      "first",
      "first",
    ]);
    expect(result.input).toEqual({ first: "xx", second: "xx" });
  });
}
