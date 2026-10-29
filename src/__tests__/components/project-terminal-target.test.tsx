// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ socket: vi.fn(), dispose: vi.fn() }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    onData() {}
    onResize() {}
    dispose = calls.dispose;
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

import { ProjectTerminal } from "@/components/projects/ProjectTerminal";

const projectId = "22222222-2222-4222-8222-222222222222";
const target = { workspaceId: "workspace", threadId: "manager-thread" };
const grant = () => ({
  url: `${window.location.origin}/api/projects/${projectId}/terminal`,
  ticket: "fixture-ticket",
  expiresAt: Math.floor(Date.now() / 1000) + 45,
  protocolVersion: "0.165.0",
  binding: { ownerId: "owner", buildId: "build", serverInstanceId: "runtime", ...target },
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      constructor(url: string) {
        calls.socket(url);
      }
      addEventListener() {}
      close() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(grant())),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("task manager terminal target", () => {
  it.each([
    { workspaceId: "other" },
    { threadId: "replacement" },
  ])("never opens a socket for a different target %j", async (changed) => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ ...grant(), binding: { ...grant().binding, ...changed } }),
    );
    render(<ProjectTerminal projectId={projectId} visible expected={target} />);
    await screen.findByRole("alert");
    expect(calls.socket).not.toHaveBeenCalled();
  });
  it("keeps the same terminal mounted when switching views", async () => {
    const view = render(<ProjectTerminal projectId={projectId} visible expected={target} />);
    await waitFor(() => expect(calls.socket).toHaveBeenCalledTimes(1));
    view.rerender(
      <ProjectTerminal projectId={projectId} visible={false} expected={{ ...target }} />,
    );
    expect(calls.socket).toHaveBeenCalledTimes(1);
    expect(calls.dispose).not.toHaveBeenCalled();
    view.unmount();
    expect(calls.dispose).toHaveBeenCalledTimes(1);
  });
});
