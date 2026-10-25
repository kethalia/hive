import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getRequestSession: vi.fn() }));
vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser: vi.fn() }));
vi.mock("@/lib/workspace/exec", () => ({ execInWorkspace: vi.fn() }));
vi.mock("@/lib/discovery/server-cache", () => ({
  discoveryCacheKey: (parts: string[]) => parts.join(":"),
  invalidateDiscovery: vi.fn(),
}));

import { cloneProjectAction } from "@/lib/actions/clone-project";
import { getRequestSession } from "@/lib/auth/session";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { cloneProjectCommand, cloneProjectSchema } from "@/lib/git/clone-project";
import { execInWorkspace } from "@/lib/workspace/exec";

const input = { workspaceId: "dev", organization: "kethalia", repository: "hive" };
const client = {
  getWorkspace: vi.fn(),
  getWorkspaceAgentName: vi.fn(async () => "dev.main"),
  getBaseUrl: () => "https://coder.example.test",
  getSessionToken: () => "secret",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getRequestSession).mockResolvedValue({
    user: { id: "user", username: "owner" },
    session: {},
  } as never);
  vi.mocked(getCoderClientForUser).mockResolvedValue(client as never);
  client.getWorkspace.mockResolvedValue({
    id: "dev",
    owner_name: "owner",
    latest_build: { id: "build", status: "running" },
  });
  client.getWorkspaceAgentName.mockResolvedValue("dev.main");
  vi.mocked(execInWorkspace).mockResolvedValue({ exitCode: 0, stdout: "cloned\n", stderr: "" });
});
describe("clone project authorization", () => {
  it("uses the authenticated Coder client and returns only a public pane descriptor", async () => {
    const result = await cloneProjectAction(input);
    expect(getCoderClientForUser).toHaveBeenCalledWith("user");
    expect(execInWorkspace).toHaveBeenCalledWith(
      "dev.main",
      expect.any(String),
      expect.objectContaining({ sessionToken: "secret" }),
    );
    expect(result?.data).toMatchObject({
      kind: "terminal",
      workspaceId: "dev",
      label: "hive",
      relativePath: "projects/kethalia/hive",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it.each(["stopped", "other-owner"])("does not execute when workspace is %s", async (state) => {
    client.getWorkspace.mockResolvedValue({
      id: "dev",
      owner_name: state === "other-owner" ? "other" : "owner",
      latest_build: { status: state === "stopped" ? state : "running" },
    });
    expect((await cloneProjectAction(input))?.serverError).toBeTruthy();
    expect(execInWorkspace).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated requests before looking up Coder", async () => {
    vi.mocked(getRequestSession).mockResolvedValue(null);
    expect((await cloneProjectAction(input))?.serverError).toBe("Not authenticated");
    expect(getCoderClientForUser).not.toHaveBeenCalled();
  });
  it.each([
    "../hive",
    "https://evil/repo",
    "repo;echo bad",
    "$(echo bad)",
    "--help",
  ])("rejects path or command input %s", (repository) =>
    expect(cloneProjectSchema.safeParse({ ...input, repository }).success).toBe(false));
});
describe("clone project filesystem boundaries", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "hive-clone-test-"));
    mkdirSync(join(directory, "bin"));
    writeFileSync(
      join(directory, "bin", "gh"),
      '#!/usr/bin/env python3\nimport os,pathlib,sys\nif os.environ.get("FAIL_CLONE"): sys.exit(1)\npathlib.Path(sys.argv[4],".git").mkdir()\npathlib.Path(sys.argv[4],"origin.txt").write_text(sys.argv[3])\n',
      { mode: 0o755 },
    );
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  const execute = (root: string, extra = {}) =>
    spawnSync("sh", ["-c", cloneProjectCommand(root, "kethalia", "hive")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}`, ...extra },
    });
  it("clones to the chosen home, refuses an existing project, and never overwrites its files", () => {
    expect(execute(directory).status).toBe(0);
    const origin = join(directory, "projects/kethalia/hive/origin.txt");
    expect(readFileSync(origin, "utf8")).toBe("https://github.com/kethalia/hive");
    writeFileSync(origin, "user work");
    expect(execute(directory).stdout.trim()).toBe("already-exists");
    expect(readFileSync(origin, "utf8")).toBe("user work");
  });
  it("rejects symlinked parents and cleans only its newly created folder on failure", () => {
    mkdirSync(join(directory, "other"));
    symlinkSync(join(directory, "other"), join(directory, "projects"));
    expect(execute(directory).stdout.trim()).toBe("unsafe-parent");
    rmSync(join(directory, "projects"));
    expect(execute(directory, { FAIL_CLONE: "1" }).stdout.trim()).toBe("clone-failed");
    expect(execute(directory).status).toBe(0);
  });
});
