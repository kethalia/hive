import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { projectCheckoutCommand, projectCheckoutScript } from "@/lib/projects/checkout-command";

const home = mkdtempSync(join(tmpdir(), "hive-project-checkout-"));
const gitRemote = join(home, "remote");
const checkout = join(home, ".local/share/hive/project-checkouts/12-34/checkout");
const procRoot = join(home, "proc");
const fixture = { HOME: home, TMUX_TMPDIR: home, PATH: `${join(home, "bin")}:${process.env.PATH}` };
const env = { ...process.env, ...fixture };

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
}

function manage(action: "open" | "cleanup") {
  // Use a controlled process inventory, even on CI hosts where other
  // same-user processes are visible but their procfs links are restricted.
  // Git, tmux and checkout filesystem checks still use real fixtures.
  const harness = `
import json, os, pathlib, sys
scope = {"__name__": "fixture"}
exec(sys.argv[1], scope)
remote = sys.argv[2]
scope["resolve"] = lambda home, account, repo: ("owner/repo", "https://github.com/owner/repo.git", "gh", os.environ)
def fixture_git(cwd, args, gh, env, timeout=12, code="checkout_unavailable"):
    if args == ["remote", "get-url", "origin"]:
        assert scope["run"](["git", *args], cwd, env, timeout, code).decode().strip() == remote
        return b"https://github.com/owner/repo.git"
    mapped = [remote if item == "https://github.com/owner/repo.git" else item for item in args]
    return scope["run"](["git", *mapped], cwd, env, timeout, code)
scope["git"] = fixture_git
in_use = scope["in_use"]
scope["in_use"] = lambda path: in_use(path, pathlib.Path(sys.argv[4]))
try:
    print(json.dumps(scope["main"]({"action": sys.argv[3], "providerAccountId": "12", "repositoryId": "34"})))
except scope["ProjectError"] as error:
    print(json.dumps({"error": str(error)}))
`;
  return JSON.parse(
    execFileSync("python3", ["-c", harness, projectCheckoutScript, gitRemote, action, procRoot], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

afterAll(() => {
  try {
    execFileSync("tmux", ["-L", "web", "kill-server"], { env, stdio: "ignore" });
  } catch {
    // The session can already have exited.
  }
  rmSync(home, { recursive: true, force: true });
});

it("passes the fixed project program through the workspace shell", () => {
  const result = execFileSync("bash", ["-c", projectCheckoutCommand], {
    input: JSON.stringify({ action: "open", providerAccountId: "12", repositoryId: "../outside" }),
    encoding: "utf8",
  });
  expect(JSON.parse(result)).toEqual({ error: "checkout_unavailable" });
});

const localTmuxAvailable = process.platform === "linux" && spawnSync("tmux", ["-V"]).status === 0;
it.skipIf(!localTmuxAvailable)(
  "prepares and reuses a real checkout and only cleans published work",
  async () => {
    mkdirSync(gitRemote);
    mkdirSync(join(home, "bin"));
    mkdirSync(join(procRoot, "self"), { recursive: true });
    writeFileSync(join(procRoot, "self/mountinfo"), "");
    writeFileSync(
      join(home, "bin", "codex"),
      '#!/bin/sh\nprintf "%s" "$PULSE_SERVER" > "$HOME/codex-pulse"\npwd > "$HOME/codex-cwd"\nexec sleep 30\n',
      {
        mode: 0o755,
      },
    );
    writeFileSync(
      join(home, "bin", "hive-audio"),
      '#!/bin/sh\nprintf "%s" "$*" > "$HOME/audio-args"\nprintf "%s\\n" "unix:/tmp/project-fixture.sock"\n',
      { mode: 0o755 },
    );
    git(gitRemote, "init", "-b", "main");
    git(gitRemote, "config", "receive.denyCurrentBranch", "ignore");
    writeFileSync(join(gitRemote, "README.md"), "project\n");
    writeFileSync(join(gitRemote, ".gitignore"), "node_modules/\n.local-secret\n");
    writeFileSync(join(gitRemote, "package.json"), '{"packageManager":"pnpm@10.32.1"}');
    writeFileSync(join(gitRemote, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(
      join(home, "bin", "pnpm"),
      '#!/bin/sh\nprintf "%s" "$*" > "$HOME/install-args"\nmkdir node_modules\n',
      {
        mode: 0o755,
      },
    );
    git(gitRemote, "add", ".");
    git(
      gitRemote,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "initial",
    );

    const project = manage("open");
    expect(project).toMatchObject({ status: "opened", fullName: "owner/repo" });
    await vi.waitFor(() =>
      expect(readFileSync(join(home, "codex-cwd"), "utf8").trim()).toBe(checkout),
    );
    expect(readFileSync(join(home, "install-args"), "utf8")).toBe(
      "install --frozen-lockfile --ignore-scripts --ignore-pnpmfile",
    );
    expect(readFileSync(join(home, "audio-args"), "utf8")).toBe(
      `prepare -- ${project.sessionName}`,
    );
    expect(readFileSync(join(home, "codex-pulse"), "utf8")).toBe("unix:/tmp/project-fixture.sock");
    expect(manage("open")).toEqual(project);
    expect(manage("cleanup")).toEqual({ error: "checkout_in_use" });
    execFileSync("tmux", ["-L", "web", "kill-session", "-t", `=${project.sessionName}`], { env });

    const consumer = join(procRoot, "1234");
    mkdirSync(join(consumer, "fd"), { recursive: true });
    writeFileSync(join(consumer, "status"), `State:\tS\nUid:\t${process.getuid?.()}\n`);
    symlinkSync(checkout, join(consumer, "cwd"), "dir");
    expect(manage("cleanup")).toEqual({ error: "checkout_in_use" });
    rmSync(consumer, { recursive: true });

    writeFileSync(join(checkout, ".local-secret"), "keep");
    await vi.waitFor(() => expect(manage("cleanup")).toEqual({ error: "checkout_dirty" }));
    rmSync(join(checkout, ".local-secret"));
    writeFileSync(join(checkout, "README.md"), "edited\n");
    expect(manage("cleanup")).toEqual({ error: "checkout_dirty" });
    git(checkout, "add", "README.md");
    git(
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "edit",
    );
    expect(manage("cleanup")).toEqual({ error: "checkout_unpublished" });
    git(checkout, "push", "origin", "main");
    await vi.waitFor(() => expect(manage("cleanup")).toEqual({ status: "removed" }));
    expect(manage("cleanup")).toEqual({ status: "absent" });
  },
  12_000,
);
