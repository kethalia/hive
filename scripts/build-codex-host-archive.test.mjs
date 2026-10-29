import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hostArchive } from "./build-codex-host-archive.mjs";

test("Coder shell startup loads a large host package from a mounted file, outside argv", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "hive-bootstrap-argv-"));
  try {
    const template = "templates/ai-dev-k8s";
    const script = await readFile(`${template}/scripts/install-codex-host.sh.tftpl`, "utf8");
    assert.ok(Buffer.byteLength(script) < 4096);
    const archive = await readFile(`${template}/assets/codex-host.tar`);
    const request = JSON.stringify({ archive: archive.toString("base64") });
    assert.ok(Buffer.byteLength(request) > 131072, "exercise Linux's per-argument limit");
    await writeFile(join(temporary, "request.json"), request);
    await writeFile(
      join(temporary, "install-codex-host.py"),
      'import json,sys,base64,hashlib\nprint(hashlib.sha256(base64.b64decode(json.load(sys.stdin)["archive"])).hexdigest())\n',
    );
    const result = spawnSync(
      "/bin/sh",
      ["-c", script.replaceAll("/opt/hive-codex-host-template", temporary)],
      { encoding: "utf8", env: { HIVE_WORKSPACE_PROFILE: "software" }, timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const { createHash } = await import("node:crypto");
    assert.equal(result.stdout.trim(), createHash("sha256").update(archive).digest("hex"));
    const bootstrap = await readFile(`${template}/hive-host.tf`, "utf8");
    assert.match(bootstrap, /immutable\s*=\s*true/);
    assert.match(bootstrap, /create_before_destroy\s*=\s*true/);
    assert.match(bootstrap, /length\(base64encode\(content\)\).*<= 950000/);
    const deployment = await readFile(`${template}/main.tf`, "utf8");
    assert.match(
      deployment,
      /mount_path\s*=\s*"\/opt\/hive-codex-host-template"\s+read_only\s*=\s*true/,
    );
    assert.match(
      deployment,
      /name\s*=\s*kubernetes_config_map_v1\.hive_host\[0\]\.metadata\[0\]\.name/,
    );
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
    await mkdir(join(temporary, "templates/ai-dev-k8s"), { recursive: true });
    await cp("templates/ai-dev-k8s/scripts", join(temporary, "templates/ai-dev-k8s/scripts"), {
      recursive: true,
    });
    await symlink(join(process.cwd(), "node_modules"), join(temporary, "node_modules"), "dir");
    const actual = await hostArchive(temporary);
    assert.equal(actual.sha256, expected.sha256);
    assert.deepEqual(actual.archive, expected.archive);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
