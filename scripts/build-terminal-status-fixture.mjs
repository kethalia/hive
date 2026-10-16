import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const destination = process.argv[2];
if (!destination) throw new Error("Supply a fixture output directory");
await mkdir(destination, { recursive: true });
await build({
  entryPoints: ["e2e/fixtures/terminal-status.tsx"],
  bundle: true,
  outfile: `${destination}/bundle.js`,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "fixture-boundaries",
      setup(build) {
        build.onResolve({ filter: /^next\/(navigation|link)$/ }, ({ path }) => ({
          path,
          namespace: "fixture",
        }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents: path.endsWith("navigation")
            ? 'export const usePathname = () => "/terminal/status";'
            : "export default function Link({children, ...props}) { return <a {...props}>{children}</a>; }",
          loader: "tsx",
          resolveDir: process.cwd(),
        }));
        build.onLoad({ filter: /src\/lib\/terminal\/auth-transport\.ts$/ }, () => ({
          contents: "export const fetchTerminal = (...args) => fetch(...args);",
          loader: "js",
        }));
      },
    },
  ],
});
const styles = await postcss([tailwindcss()]).process(
  await readFile("src/app/globals.css", "utf8"),
  { from: "src/app/globals.css" },
);
await writeFile(`${destination}/style.css`, styles.css);
await writeFile(
  `${destination}/index.html`,
  '<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script src="/bundle.js"></script></body></html>',
);
await copyFile("e2e/terminal-status.browser.mjs", `${destination}/validate.mjs`);
