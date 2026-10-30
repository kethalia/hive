import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx"))("esbuild");

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(root, ".artifacts/dock-playground");
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["examples/dock-playground/main.tsx"],
  outfile: resolve(output, "bundle.js"),
  bundle: true,
  minify: true,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  tsconfig: resolve(root, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
});
const styles = await postcss([tailwindcss()]).process(
  await readFile(resolve(root, "src/app/globals.css"), "utf8"),
  { from: resolve(root, "src/app/globals.css") },
);
await writeFile(
  resolve(output, "style.css"),
  `${styles.css}\n${await readFile(resolve(output, "bundle.css"), "utf8")}\n${await readFile(resolve(root, "examples/dock-playground/style.css"), "utf8")}`,
);
await writeFile(
  resolve(output, "index.html"),
  '<!doctype html><html lang="en" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#151519"><title>Hive · Dock playground</title><link rel="stylesheet" href="./style.css"></head><body><div id="root"></div><script type="module" src="./bundle.js"></script></body></html>',
);

if (!process.argv.includes("--build-only")) {
  const files = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/bundle.js": ["bundle.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"],
  };
  const port = Number(process.env.PORT ?? 4317);
  const server = createServer(async (request, response) => {
    const route = files[new URL(request.url ?? "/", "http://localhost").pathname];
    if (!route || !["GET", "HEAD"].includes(request.method ?? "")) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    try {
      const body = await readFile(resolve(output, route[0]));
      response.writeHead(200, {
        "Content-Type": route[1],
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(500);
      response.end("Preview asset unavailable");
    }
  });
  server.listen(port, "0.0.0.0", () => console.log(`Dock playground listening on :${port}`));
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close(() => process.exit(0)));
}
