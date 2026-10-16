import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const destination = process.argv[2];
const settingsPreview = process.argv.includes("--settings");
if (!destination) throw new Error("Supply a preview output directory");
await mkdir(destination, { recursive: true });
const preferences = {
  question: true,
  approval: true,
  ready: true,
  failure: true,
  token: true,
  template: true,
};
const mockActions = `
export const getVapidPublicKeyAction = async () => ({ data: { publicKey: "AQID" } });
export const subscribePushAction = async () => ({ data: { success: true } });
export const unsubscribePushAction = async () => ({ data: { success: true } });
export const testPushAction = async () => ({ data: { sent: 1 } });
export const getPushPreferencesAction = async () => ({ data: ${JSON.stringify(preferences)} });
export const updatePushPreferencesAction = async (input) => { window.savedPreferences = input.preferences; return { data: { success: true } }; };
`;
await build({
  entryPoints: [
    settingsPreview ? "e2e/fixtures/settings.tsx" : "e2e/fixtures/notification-settings.tsx",
  ],
  bundle: true,
  outfile: `${destination}/bundle.js`,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  tsconfig: "tsconfig.json",
  define: {
    "process.env.NODE_ENV": '"development"',
    "process.env.NEXT_PUBLIC_HIVE_APP_VERSION": '"2.21.6"',
    "process.env.NEXT_PUBLIC_HIVE_APP_BUILD": '"fixture-loaded-build"',
  },
  plugins: [
    {
      name: "notification-action-fixtures",
      setup(build) {
        build.onResolve({ filter: /^next\/navigation$/ }, () => ({
          path: "fixture-navigation",
          namespace: "fixture",
        }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `export const usePathname = () => "${settingsPreview ? "/settings" : "/notifications"}"; export const useRouter = () => ({ push: (url) => { window.location.href = url; } });`,
          loader: "js",
        }));
        build.onLoad({ filter: /src\/lib\/push\/(actions|subscribe)\.ts$/ }, () => ({
          contents: mockActions,
          loader: "ts",
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
await writeFile(
  `${destination}/sw.js`,
  `self.hiveTestHandlers = {}; const listen = self.addEventListener.bind(self); self.addEventListener = (type, handler) => { self.hiveTestHandlers[type] = handler; listen(type, handler); };\n${await readFile("public/sw.js", "utf8")}`,
);
await mkdir(`${destination}/icons`, { recursive: true });
await copyFile("public/icons/icon-192.png", `${destination}/icons/icon-192.png`);
await copyFile(
  settingsPreview ? "e2e/settings.browser.mjs" : "e2e/notifications.browser.mjs",
  `${destination}/validate.mjs`,
);
