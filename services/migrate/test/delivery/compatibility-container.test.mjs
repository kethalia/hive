import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runContainerCompatibility } from "../../src/delivery/compatibility-container.mjs";

const hash = (s) => s.repeat(64);
const ref = (s) => `registry.example/app@sha256:${hash(s)}`;
const config = {
  schemaVersion: 1,
  catalogId: randomUUID(),
  planDigest: hash("a"),
  sourceSha: "b".repeat(40),
  postgresImage: ref("c"),
  oldImage: ref("d"),
  newImage: ref("e"),
  scenarioImage: ref("f"),
  oldAppDigest: hash("d"),
  newAppDigest: hash("e"),
  compatibilityDigest: hash("1"),
};
test("isolated compatibility runner pins all images and cleans up after success and failure", () => {
  for (const failing of [false, true]) {
    const calls = [];
    const docker = (args) => {
      calls.push(args);
      if (args[0] === "image") return JSON.stringify([args.at(-1)]);
      if (failing && args.at(-1) === "verify") throw Error("scenario failed");
      return "";
    };
    if (failing)
      assert.throws(() => runContainerCompatibility(config, { docker }), /scenario failed/);
    else assert.equal(runContainerCompatibility(config, { docker }).planDigest, config.planDigest);
    assert.equal(calls.filter((c) => c[0] === "pull").length, 4);
    assert.ok(calls.some((c) => c[0] === "network" && c.includes("--internal")));
    assert.equal(calls.filter((c) => c[0] === "rm").length, 3);
    assert.equal(calls.at(-1)[0], "network");
    assert.equal(
      calls.some((c) => c.includes("-p") || c.includes("--privileged")),
      false,
    );
  }
  assert.throws(() =>
    runContainerCompatibility({ ...config, newImage: ref("1") }, { docker: () => "" }),
  );
});
