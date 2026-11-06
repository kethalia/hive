import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("native Preview publisher protocol checks", { timeout: 30000 }, async () => {
  const require = createRequire(import.meta.url);
  try {
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const result = await promisify(execFile)(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        "--test",
        "--test-reporter=tap",
        fileURLToPath(new URL("./native-preview.checks.ts", import.meta.url)),
      ],
      { timeout: 25000, maxBuffer: 1048576, env: environment },
    );
    assert.match(result.stdout, /# fail 0/);
  } catch (error) {
    assert.fail(`${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`);
  }
});
