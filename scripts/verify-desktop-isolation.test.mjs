import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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
        .replaceAll("/tmp/.X1-lock", join(root, "display.lock"))
        .replaceAll("/tmp/.X11-unix/X1", join(root, "display.sock"))
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
    assert.equal(
      readFileSync(`templates/${name}/scripts/kasmvnc-loopback.c`, "utf8"),
      readFileSync(source, "utf8"),
    );
    assert.match(
      tf,
      /HIVE_DESKTOP_GUARD_SOURCE_B64=.*base64encode\(file\("\$\{path.module\}\/scripts\/kasmvnc-loopback.c"\)\)/,
    );
  }
});

for (const valid of [true, false]) {
  test(`old-image guard bootstrap ${valid ? "compiles the bundled source" : "fails closed on a compiler error"}`, () => {
    const root = mkdtempSync(join(tmpdir(), "hive-guard-bootstrap-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      for (const name of ["Xvnc", "kasmvncserver", "startxfce4"])
        writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const bootstrap = launcher.slice(
        launcher.indexOf("# Older pinned"),
        launcher.indexOf("umask 077"),
      );
      const script =
        `set -euo pipefail\nstate_dir='${root}'\nlibrary='${root}/absent.so'\n${bootstrap}\nprintf 'bootstrap verified\\n'\n`.replaceAll(
          "/usr/bin/Xvnc",
          join(bin, "Xvnc"),
        );
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:/usr/bin:/bin`,
          HIVE_DESKTOP_GUARD_SOURCE_B64: Buffer.from(
            valid ? readFileSync(source) : "invalid C source",
          ).toString("base64"),
        },
      });
      if (valid) {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /bootstrap verified/);
      } else {
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(result.stdout, /bootstrap verified/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

function retirement(root) {
  return launcher
    .split("<<'PYTHON'\n")[1]
    .split("\nPYTHON")[0]
    .replaceAll("Path.home()", `Path("${root}")`)
    .replaceAll("/tmp/.X1-lock", join(root, "display.lock"))
    .replaceAll("/tmp/.X11-unix/X1", join(root, "display.sock"));
}

test("forced desktop retirement waits for exit and clears its stale display artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "hive-desktop-retire-"));
  let child;
  try {
    const fake = join(root, "fake.c");
    const binary = join(root, "Xvnc");
    writeFileSync(
      fake,
      `
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 4) return 1;
  signal(SIGTERM, SIG_IGN);
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  snprintf(address.sun_path, sizeof(address.sun_path), "%s", argv[2]);
  if (bind(fd, (struct sockaddr *)&address, sizeof(address)) || listen(fd, 1)) return 2;
  FILE *lock = fopen(argv[3], "w");
  fprintf(lock, "%d\\n", getpid()); fclose(lock);
  puts("ready"); fflush(stdout);
  for (;;) pause();
}
`,
    );
    const build = spawnSync("cc", ["-Wall", "-Wextra", "-Werror", fake, "-o", binary], {
      encoding: "utf8",
    });
    assert.equal(build.status, 0, build.stderr);
    child = spawn(binary, [":1", join(root, "display.sock"), join(root, "display.lock")]);
    const exited = once(child, "exit");
    await once(child.stdout, "data");
    const result = spawnSync("python3", ["-", join(root, "server.pid")], {
      input: retirement(root),
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await exited)[1], "SIGKILL");
    for (const path of ["display.sock", "display.lock"])
      assert.equal(spawnSync("test", ["-e", join(root, path)]).status, 1);
  } finally {
    child?.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ["process", "socket"]) {
  test(`retirement preserves a live unrelated display ${mode} and its lock`, async () => {
    const root = mkdtempSync(join(tmpdir(), "hive-desktop-live-"));
    const server = createServer();
    try {
      server.listen(join(root, "display.sock"));
      await once(server, "listening");
      const pid = mode === "process" ? process.pid : 99999999;
      writeFileSync(join(root, "display.lock"), `${pid}\n`);
      const result = spawnSync("python3", ["-", join(root, "server.pid")], {
        input: retirement(root),
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, mode === "process" ? /live process/ : /live listener/);
      assert.equal(readFileSync(join(root, "display.lock"), "utf8"), `${pid}\n`);
      assert.doesNotThrow(() => process.kill(process.pid, 0));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  });
}
