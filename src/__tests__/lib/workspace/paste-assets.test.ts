import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecInWorkspace = vi.hoisted(() => vi.fn());
const mockGetCoderClientForUser = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("@/lib/coder/user-client", () => ({
  getCoderClientForUser: mockGetCoderClientForUser,
}));

vi.mock("@/lib/workspace/exec", () => ({
  execInWorkspace: mockExecInWorkspace,
}));

import { uploadTerminalPasteAssets } from "@/lib/workspace/paste-assets";

function mockSpawnSuccess() {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stdin: { end: ReturnType<typeof vi.fn> };
  };
  child.kill = vi.fn();
  child.stderr = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  child.stderr.setEncoding = vi.fn();
  child.stdin = {
    end: vi.fn(() => {
      queueMicrotask(() => child.emit("close", 0));
    }),
  };
  mockSpawn.mockReturnValue(child);
  return child;
}

describe("uploadTerminalPasteAssets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecInWorkspace.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    mockGetCoderClientForUser.mockResolvedValue({
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-token",
      getWorkspaceAgentName: vi.fn().mockResolvedValue("workspace.agent"),
    });
  });

  it("streams base64 image bytes through stdin instead of command argv", async () => {
    const child = mockSpawnSuccess();
    const bytes = new TextEncoder().encode("image-bytes");

    const paths = await uploadTerminalPasteAssets({
      userId: "user-1",
      workspaceId: "workspace-1",
      files: [{ name: "pasted.png", type: "image/png", bytes }],
    });

    expect(paths[0]).toMatch(/^\/tmp\/hive-terminal-paste\/.+\.png$/);
    expect(mockExecInWorkspace).toHaveBeenCalledWith(
      "workspace.agent",
      "umask 077 && mkdir -p '/tmp/hive-terminal-paste'",
      expect.objectContaining({
        coderUrl: "https://coder.example.com",
        sessionToken: "coder-token",
      }),
    );
    expect(mockSpawn).toHaveBeenCalledWith(
      "coder",
      [
        "ssh",
        "--wait=no",
        "workspace.agent",
        "--",
        "bash",
        "-lc",
        expect.stringMatching(/^base64 -d > '\/tmp\/hive-terminal-paste\/.+\.png'$/),
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          CODER_URL: "https://coder.example.com",
          CODER_SESSION_TOKEN: "coder-token",
        }),
        stdio: ["pipe", "ignore", "pipe"],
      }),
    );
    expect(child.stdin.end).toHaveBeenCalledWith(Buffer.from(bytes).toString("base64"));
    expect(JSON.stringify(mockSpawn.mock.calls)).not.toContain(
      Buffer.from(bytes).toString("base64"),
    );
  });
});
