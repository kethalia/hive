import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { syncVoicePackage } from "./build-package.mjs";

test("all three pinned bootstrap requests use bounded Downward API mounts", async () => {
  await syncVoicePackage(process.cwd(), true);
  const root = "templates/ai-dev-k8s",
    main = await readFile(`${root}/main.tf`, "utf8");
  assert.doesNotMatch(main, /kubernetes_config_map_v1/);
  for (const kind of ["host", "read", "voice"]) {
    const tf = await readFile(`${root}/hive-${kind}.tf`, "utf8");
    assert.match(tf, /imageArchiveSha256\s*=\s*filesha256/);
    assert.match(tf, /imageInstallerSha256\s*=\s*filesha256/);
    assert.match(tf, /<= 16384/);
    assert.doesNotMatch(tf, /archive\s*=\s*filebase64/);
    assert.match(
      main,
      new RegExp(`metadata\\.annotations\\['hive\\.kethalia\\.com\\/${kind}-request'\\]`),
    );
  }
  const docker = await readFile("docker/hive-base/Dockerfile", "utf8"),
    workflow = await readFile(".github/workflows/build-base-image.yml", "utf8");
  assert.equal((workflow.match(/template-runtime=\.\/templates\/ai-dev-k8s/g) ?? []).length, 3);
  assert.match(docker, /COPY --from=template-runtime --chmod=0444/);
  assert.match(docker, /hive-template-bootstrap/);
});
