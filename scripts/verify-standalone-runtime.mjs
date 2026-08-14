import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const standaloneRoot = resolve(process.cwd(), ".next/standalone");
const nextPackagePath = realpathSync(join(standaloneRoot, "node_modules/next/package.json"));
const requireFromNext = createRequire(nextPackagePath);
const helpersPackagePath = requireFromNext.resolve("@swc/helpers/package.json");
const helpersPackage = JSON.parse(readFileSync(helpersPackagePath, "utf8"));
const interopExport = helpersPackage.exports?.["./_/_interop_require_default"];

assert.equal(typeof interopExport, "object", "@swc/helpers is missing the interop helper export");

for (const condition of ["module-sync", "import", "default"]) {
  const target = interopExport[condition];

  assert.equal(typeof target, "string", `@swc/helpers is missing its ${condition} interop target`);
  assert.ok(
    existsSync(join(dirname(helpersPackagePath), target)),
    `standalone output is missing @swc/helpers target ${target}`,
  );
}

const resolvedInteropPath = requireFromNext.resolve("@swc/helpers/_/_interop_require_default");
const interopHelper = requireFromNext("@swc/helpers/_/_interop_require_default");

assert.equal(
  typeof interopHelper._,
  "function",
  `standalone helper did not load from ${resolvedInteropPath}`,
);

console.log(`Verified standalone SWC helper: ${resolvedInteropPath}`);
