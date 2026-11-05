import assert from "node:assert/strict";
import test from "node:test";
import { inspectPilotSchedule } from "./disable-delivery-pilot-schedule.mjs";

const id = "11111111-1111-4111-8111-111111111111",
  tag = "a".repeat(32),
  created = "2026-11-05T17:00:00.000Z";
const receipt = {
  schemaVersion: 1,
  accountId: "225177f82b9234ede14e897fe15e0cb5",
  name: "hive-jobs-compatibility-preview",
  action: "enable",
  tag,
  createdOn: created,
  deploymentId: id,
  versionId: id,
};
function provider(change = () => {}) {
  const scripts = {
      result: [{ id: receipt.name, tag, created_on: created }],
      result_info: { total_count: 1 },
    },
    deployments = {
      result: { deployments: [{ id, versions: [{ percentage: 100, version_id: id }] }] },
    },
    schedules = { result: { schedules: [{ cron: "*/5 * * * *" }] } };
  change({ scripts, deployments, schedules });
  return async (method, url) => {
    assert.equal(method, "GET");
    return url.endsWith("/deployments")
      ? deployments
      : url.endsWith("/schedules")
        ? schedules
        : scripts;
  };
}
test("recovery validates exact script, active deployment, and only expected schedule", async () => {
  assert.equal((await inspectPilotSchedule(receipt, provider())).tag, tag);
  assert.deepEqual(
    (
      await inspectPilotSchedule(
        receipt,
        provider((x) => {
          x.schedules.result.schedules = [];
        }),
      )
    ).schedules,
    [],
  );
  for (const change of [
    (x) => (x.scripts.result[0].tag = "b".repeat(32)),
    (x) => (x.scripts.result[0].created_on = "2026-11-05T16:00:00Z"),
    (x) => (x.deployments.result.deployments[0].id = "22222222-2222-4222-8222-222222222222"),
    (x) => x.schedules.result.schedules.push({ cron: "0 * * * *" }),
    (x) => (x.scripts.result_info.total_count = 2),
  ])
    await assert.rejects(inspectPilotSchedule(receipt, provider(change)));
});
