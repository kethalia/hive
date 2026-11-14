import { describe, expect, it, vi } from "vitest";
import {
  createTerminalDiagnostics,
  parseTerminalDiagnosticsTarget,
  terminalDiagnosticsRuntime,
} from "@/lib/terminal/diagnostics.server";

describe("terminal diagnostic boundary", () => {
  it("validates the exact HTTP endpoint/query shape used by current clients", () => {
    expect(
      parseTerminalDiagnosticsTarget(new URL("https://hive.example/keepalive/status")),
    ).not.toBeNull();
    expect(
      parseTerminalDiagnosticsTarget(
        new URL("https://hive.example/session-events?sessionName=git-clone-abc&after=5&limit=500"),
      ),
    ).not.toBeNull();
    for (const suffix of [
      "/session-events?after=1&after=2",
      "/keepalive/status?token=private",
      "/session-events?workspaceId=wrong",
      "/session-events?sessionName=a%2Fb",
      "/session-events?unknown=1",
    ])
      expect(parseTerminalDiagnosticsTarget(new URL(`https://hive.example${suffix}`))).toBeNull();
  });
  it("does not accept a cookie as a substitute for the exact signed HTTP ticket", async () => {
    const fetcher = vi.fn();
    const env = {
      HIVE_PUBLIC_ORIGIN: "https://hive.example",
      HIVE_GENERIC_TERMINAL_ENABLED: "true",
      COOKIE_SECRET: "synthetic",
    };
    expect(
      (
        await terminalDiagnosticsRuntime(
          new Request("https://hive.example/session-events", {
            headers: { Cookie: "session=anything" },
          }),
          env,
          fetcher,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await terminalDiagnosticsRuntime(
          new Request("https://hive.example/session-events", { method: "POST" }),
          env,
          fetcher,
        )
      ).status,
    ).toBe(405);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("requires request-local database ownership before creating callback hooks", () => {
    expect(() => createTerminalDiagnostics({ userId: "invalid" } as never)).toThrow();
  });
});
