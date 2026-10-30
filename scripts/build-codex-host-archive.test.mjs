import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hostArchive } from "./build-codex-host-archive.mjs";

test("Coder shell startup passes only the small mounted request to the fixed image launcher", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "hive-bootstrap-argv-"));
  try {
    const template = "templates/ai-dev-k8s";
    const script = await readFile(`${template}/scripts/install-codex-host.sh.tftpl`, "utf8");
    assert.ok(Buffer.byteLength(script) < 4096);
    const request = JSON.stringify({
      imageArchiveSha256: "a".repeat(64),
      imageInstallerSha256: "b".repeat(64),
      config: {},
    });
    await writeFile(join(temporary, "request.json"), request);
    const launcher = join(temporary, "launcher.py");
    await writeFile(
      launcher,
      'import json,sys,hashlib\nassert sys.argv[1:] == ["host"]\nprint(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())\n',
    );
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        script
          .replaceAll("/opt/hive-codex-host-template", temporary)
          .replaceAll("/usr/local/libexec/hive-template-bootstrap", launcher),
      ],
      { encoding: "utf8", env: { HIVE_WORKSPACE_PROFILE: "software" }, timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const { createHash } = await import("node:crypto");
    assert.equal(result.stdout.trim(), createHash("sha256").update(request).digest("hex"));
    const bootstrap = await readFile(`${template}/hive-host.tf`, "utf8"),
      deployment = await readFile(`${template}/main.tf`, "utf8");
    assert.match(bootstrap, /imageArchiveSha256\s*=\s*filesha256/);
    assert.match(bootstrap, /imageInstallerSha256\s*=\s*filesha256/);
    assert.match(bootstrap, /length\(base64encode\(content\)\).*<= 16384/);
    assert.match(
      deployment,
      /mount_path\s*=\s*"\/opt\/hive-codex-host-template"\s+read_only\s*=\s*true/,
    );
    assert.match(deployment, /metadata\.annotations\['hive\.kethalia\.com\/host-request'\]/);
    assert.doesNotMatch(deployment, /kubernetes_config_map_v1\.hive_host/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("host archive has the same digest across checkouts sharing a dependency store", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "hive-archive-repro-"));
  try {
    const expected = await hostArchive(process.cwd());
    await mkdir(join(temporary, "scripts"));
    await cp(
      "scripts/build-codex-host-bundle.mjs",
      join(temporary, "scripts/build-codex-host-bundle.mjs"),
    );
    await cp(
      "scripts/build-native-guardian.mjs",
      join(temporary, "scripts/build-native-guardian.mjs"),
    );
    await cp("scripts/host-archive-codec.mjs", join(temporary, "scripts/host-archive-codec.mjs"));
    await mkdir(join(temporary, "templates/ai-dev-k8s"), { recursive: true });
    await cp("templates/ai-dev-k8s/scripts", join(temporary, "templates/ai-dev-k8s/scripts"), {
      recursive: true,
    });
    await mkdir(join(temporary, "tools/native-guardian/prebuilt"), { recursive: true });
    await cp(
      "tools/native-guardian/prebuilt/linux-x64",
      join(temporary, "tools/native-guardian/prebuilt/linux-x64"),
      { recursive: true },
    );
    await symlink(join(process.cwd(), "node_modules"), join(temporary, "node_modules"), "dir");
    const actual = await hostArchive(temporary);
    assert.equal(actual.sha256, expected.sha256);
    assert.deepEqual(actual.archive, expected.archive);
    assert.deepEqual(actual.compressed, expected.compressed);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
