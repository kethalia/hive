import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker from "./bootstrap.mjs";

const account = "225177f82b9234ede14e897fe15e0cb5";
for (const component of ["app", "auth", "jobs"]) {
  test(`${component} reservation has only inert configuration`, async () => {
    const config = JSON.parse(
      await readFile(new URL(`./wrangler.${component}.jsonc`, import.meta.url), "utf8"),
    );
    assert.deepEqual(config, {
      $schema: "../../../node_modules/wrangler/config-schema.json",
      name: `hive-${component}-production`,
      account_id: account,
      main: "./bootstrap.mjs",
      compatibility_date: "2026-11-05",
      workers_dev: false,
      preview_urls: false,
      triggers: { crons: [] },
      limits: { cpu_ms: 100 },
      observability: { enabled: false, logs: { enabled: false, invocation_logs: false } },
      vars: {
        HIVE_DEPLOYMENT_STATE: "awaiting-main-release",
        HIVE_PROJECT_TASKS_ENABLED: "false",
        HIVE_DELIVERY_RELEASE_ENABLED: "false",
        HIVE_DELIVERY_RELEASE_PRODUCTION_ENABLED: "false",
        HIVE_DELIVERY_DATABASE_ENABLED: "false",
      },
    });
  });
}

test("bootstrap always returns an uncached unavailable response", async () => {
  for (const method of ["GET", "POST", "DELETE"]) {
    const response = await worker.fetch(
      new Request("https://example.invalid/any/path", { method }),
    );
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "deployment_pending");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal(worker.scheduled, undefined);
});
