import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { projectCheckoutCommand, projectCheckoutScript } from "@/lib/projects/checkout-command";

let root: string;
let remote: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hive-project-checkout-"));
  remote = join(root, "remote");
  mkdirSync(remote);
  git(remote, "init", "-b", "main");
  writeFileSync(join(remote, "README.md"), "project\n");
  git(remote, "add", "README.md");
  git(
    remote,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-m",
    "initial",
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function prepare(cloneMissing = true, projectsRoot = root) {
  const harness = `
import json, os, pathlib, sys
scope = {"__name__": "fixture"}
exec(sys.argv[1], scope)
pathlib.Path.home = lambda: pathlib.Path(sys.argv[2])
remote = sys.argv[3]
url = "https://github.com/owner/repo.git"
scope["resolve"] = lambda home, account, repo: ("owner/repo", url, "gh", os.environ)
def fixture_git(cwd, args, gh, env, timeout=12, code="checkout_unavailable"):
    mapped = [remote if item == url else item for item in args]
    result = scope["run"](["git", *mapped], cwd, env, timeout, code)
    if args[0] == "clone":
        scope["run"](["git", "remote", "set-url", "origin", url], cwd / "checkout")
    return result
scope["git"] = fixture_git
try:
    print(json.dumps(scope["main"]({"providerAccountId": "12", "repositoryId": "34", "cloneMissing": json.loads(sys.argv[4]), "projectsRoot": sys.argv[5]})))
except scope["ProjectError"] as error:
    print(json.dumps({"error": str(error)}))
`;
  return JSON.parse(
    execFileSync(
      "python3",
      [
        "-I",
        "-c",
        harness,
        projectCheckoutScript,
        root,
        remote,
        String(cloneMissing),
        projectsRoot,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
}

it("passes the fixed program through the workspace shell and rejects unsafe identifiers", () => {
  expect(projectCheckoutCommand).toMatch(/^python3 -I -c /);
  const result = execFileSync("bash", ["-c", projectCheckoutCommand], {
    input: JSON.stringify({ providerAccountId: "12", repositoryId: "../outside" }),
    encoding: "utf8",
  });
  expect(JSON.parse(result)).toEqual({ error: "checkout_unavailable" });
});

it("clones to the owner/repository directory and preserves local changes on reopen", () => {
  const checkout = join(root, "projects", "owner", "repo");
  expect(prepare(false)).toEqual({ checkout: "missing" });
  expect(existsSync(checkout)).toBe(false);
  expect(prepare()).toEqual({ fullName: "owner/repo", relativePath: "projects/owner/repo" });
  expect(readFileSync(join(checkout, "README.md"), "utf8")).toBe("project\n");
  git(checkout, "remote", "set-url", "origin", "git@github.com:Owner/Repo.git");
  writeFileSync(join(checkout, "README.md"), "local changes\n");
  expect(prepare(false)).toEqual({ fullName: "owner/repo", relativePath: "projects/owner/repo" });
  expect(readFileSync(join(checkout, "README.md"), "utf8")).toBe("local changes\n");
  git(checkout, "remote", "set-url", "origin", "git@github.com:owner/other.git");
  expect(prepare()).toEqual({ error: "checkout_unavailable" });
});

it("preserves an existing folder and refuses a symlinked owner directory", () => {
  const parent = join(root, "projects", "owner");
  mkdirSync(join(parent, "repo"), { recursive: true });
  writeFileSync(join(parent, "repo", "important"), "keep");
  expect(prepare()).toEqual({ error: "checkout_unavailable" });
  expect(readFileSync(join(parent, "repo", "important"), "utf8")).toBe("keep");
  rmSync(parent, { recursive: true });
  symlinkSync(remote, parent, "dir");
  expect(prepare()).toEqual({ error: "checkout_unavailable" });
});

it("keeps the checkout location and reports its path relative to the configured root", () => {
  expect(prepare(true, remote)).toEqual({ error: "checkout_outside_root" });
  expect(existsSync(join(root, "projects"))).toBe(false);
  expect(prepare(true, join(root, "projects"))).toEqual({
    fullName: "owner/repo",
    relativePath: "owner/repo",
  });
  expect(prepare(false, join(root, "projects", "owner"))).toEqual({
    fullName: "owner/repo",
    relativePath: "repo",
  });
  expect(readFileSync(join(root, "projects", "owner", "repo", "README.md"), "utf8")).toBe(
    "project\n",
  );
});
