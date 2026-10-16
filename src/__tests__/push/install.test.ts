import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser: vi.fn() }));

import { installNotificationHooks } from "@/lib/push/install";

const { spawn: realSpawn } =
  await vi.importActual<typeof import("node:child_process")>("node:child_process");

const prepared = {
  client: { getBaseUrl: () => "https://coder.test", getSessionToken: () => "coder-secret" },
  target: "owner/workspace.main",
  workspaceName: "workspace",
} as Awaited<ReturnType<typeof import("@/lib/push/install").prepareNotificationWorkspace>>;

afterEach(() => vi.restoreAllMocks());

describe("notification installer transport", () => {
  it("uses a non-interactive SSH channel and delivers the bundle through stdin through EOF", async () => {
    mocks.spawn.mockImplementation((_program, _args, options) =>
      realSpawn(
        process.execPath,
        [
          "-e",
          `
      let input = '';
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        const bundle = JSON.parse(input);
        process.exit(bundle.token === 'callback-secret' && bundle.hook.includes('def classify') ? 0 : 1);
      });
    `,
        ],
        options,
      ),
    );
    await expect(
      installNotificationHooks(
        prepared,
        "https://hive.test/api/notifications/events",
        "callback-secret",
        {
          sourceId: "source",
          generation: 1,
          createdAt: "2026-10-16T00:00:00Z",
        },
      ),
    ).resolves.toBe("workspace");
    const [program, args, options] = mocks.spawn.mock.calls[0];
    expect(program).toBe("ssh");
    expect(args).toContain("-T");
    expect(args).toContain("ProxyCommand=coder ssh --stdio --wait=no %h");
    expect(args).toContain(prepared.target);
    expect(args.join(" ")).not.toContain("callback-secret");
    expect(args.join(" ")).not.toContain("coder-secret");
    expect(options.env.CODER_SESSION_TOKEN).toBe("coder-secret");
    expect(options.stdio).toEqual(["pipe", "ignore", "pipe"]);
  });
  it("does not expose credential-bearing remote diagnostics on failure", async () => {
    const log = vi.spyOn(console, "error");
    mocks.spawn.mockImplementation((_program, _args, options) =>
      realSpawn(
        process.execPath,
        [
          "-e",
          `
      process.stdin.resume();
      process.stdin.on('end', () => { process.stderr.write('callback-secret'); process.exit(1); });
    `,
        ],
        options,
      ),
    );
    await expect(
      installNotificationHooks(prepared, "https://hive.test/events", "callback-secret", {
        sourceId: "source",
        generation: 1,
        createdAt: "2026-10-16T00:00:00Z",
      }),
    ).rejects.toThrow("Could not install hooks");
    expect(log).not.toHaveBeenCalled();
  });
});
