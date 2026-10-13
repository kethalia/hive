import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = "docker/hive-base/kasmvnc-loopback.c";
const launcher = readFileSync("templates/ai-dev-k8s/scripts/tools-desktop.sh", "utf8");

test("native desktop guard rejects non-loopback TCP/UDP binds while preserving local and Unix sockets", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-desktop-bind-"));
  try {
    const library = join(root, "guard.so");
    const build = spawnSync(
      "cc",
      [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-shared",
        "-fPIC",
        "-Wl,-z,relro,-z,now",
        source,
        "-o",
        library,
        "-ldl",
        "-pthread",
      ],
      { encoding: "utf8" },
    );
    assert.equal(build.status, 0, build.stderr);
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import errno, socket, sys
for family, local, denied in [(socket.AF_INET, "127.0.0.1", ["0.0.0.0", "192.0.2.1"]), (socket.AF_INET6, "::1", ["::", "::ffff:192.0.2.1"])]:
    for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
        try:
            good = socket.socket(family, kind)
        except OSError as error:
            if family == socket.AF_INET6 and error.errno == errno.EAFNOSUPPORT:
                continue
            raise
        with good:
            good.bind((local, 0))
        for host in denied:
            with socket.socket(family, kind) as sock:
                try: sock.bind((host, 0))
                except OSError as error: assert error.errno == errno.EACCES, error
                else: raise AssertionError("Non-loopback bind allowed: " + host)
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
    sock.bind(sys.argv[1])
print("TCP/UDP IPv4/IPv6 isolation and Unix sockets verified")
`,
        join(root, "local.sock"),
      ],
      { encoding: "utf8", env: { ...process.env, LD_PRELOAD: library } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /isolation and Unix sockets verified/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ["missing", "invalid"]) {
  test(`desktop startup fails closed with a ${mode} guard without trusting stale PID files`, () => {
    const root = mkdtempSync(join(tmpdir(), "hive-desktop-start-"));
    try {
      const state = join(root, "state");
      mkdirSync(state);
      writeFileSync(join(state, "server.pid"), `${process.pid}\n`);
      const bin = join(root, "bin");
      mkdirSync(bin);
      const log = join(root, "legacy.log");
      const backendMarker = join(root, "backend-started");
      writeFileSync(join(bin, "kasmvncserver"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`, {
        mode: 0o755,
      });
      writeFileSync(join(bin, "startxfce4"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const backend = join(bin, "Xvnc");
      writeFileSync(backend, `#!/bin/sh\ntouch '${backendMarker}'\n`, { mode: 0o755 });
      const library = join(root, "guard.so");
      if (mode === "invalid") writeFileSync(library, "not a shared library");
      const script = launcher
        .replace('state_dir="$HOME/.local/state/hive-desktop"', `state_dir="${state}"`)
        .replaceAll("/usr/local/lib/hive/kasmvnc-loopback.so", library)
        .replaceAll("/usr/bin/Xvnc", backend)
        .replaceAll("Path.home()", `Path("${root}")`);
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      });
      assert.notEqual(result.status, 0);
      assert.equal(spawnSync("test", ["-e", log]).status, 1);
      assert.doesNotThrow(() => process.kill(process.pid, 0));
      assert.equal(spawnSync("test", ["-e", backendMarker]).status, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("every desktop profile uses the guarded launcher and owner-only loopback Coder app", () => {
  for (const name of [
    "ai-dev-k8s",
    "browser-testing",
    "game-dev",
    "electronics",
    "infrastructure",
  ]) {
    const tf = readFileSync(`templates/${name}/main.tf`, "utf8");
    assert.doesNotMatch(tf, /module "kasmvnc"/);
    const app = tf.match(/resource "coder_app" "desktop" \{([\s\S]*?)\n\}/)?.[1];
    assert.ok(app);
    assert.match(app, /capabilities\.desktop/);
    assert.match(app, /url\s*=\s*"http:\/\/127\.0\.0\.1:6080"/);
    assert.match(app, /share\s*=\s*"owner"/);
    assert.match(app, /subdomain\s*=\s*true/);
    assert.equal(readFileSync(`templates/${name}/scripts/tools-desktop.sh`, "utf8"), launcher);
  }
});
