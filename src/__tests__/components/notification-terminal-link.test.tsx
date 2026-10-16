// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { NotificationTerminalLink } from "@/components/terminal/NotificationTerminalLink";

const mocks = vi.hoisted(() => ({ router: { replace: vi.fn() }, resolve: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));
vi.mock("@/lib/actions/git-clones", () => ({ resolveGitCloneNotificationAction: mocks.resolve }));
const session = `git-clone-${"a".repeat(32)}`;
const identity = {
  sessionName: session,
  clonePath: "projects/kethalia/hive",
  cloneSessionKey: "git-clone:projects/kethalia/hive",
  cloneProof: "fresh-proof",
};
function seedBoard(pane: Record<string, unknown>, workspace = "w") {
  window.localStorage.setItem(
    `workspace-board-state:git:${workspace}`,
    JSON.stringify({
      version: 1,
      activeBoardKey: "main",
      boards: [
        { key: "main", name: "Main", order: 0, panes: [] },
        { key: "review", name: "Review", order: 1, panes: [{ key: "target", order: 0, ...pane }] },
      ],
    }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.resolve.mockResolvedValue({ data: identity });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("notification terminal destination", () => {
  it("opens the workspace for a session on an inactive board", async () => {
    seedBoard({ kind: "terminal", sessionName: "review-agent" });
    render(<NotificationTerminalLink agentId="a" workspaceId="w" sessionName="review-agent" />);
    await waitFor(() =>
      expect(mocks.router.replace).toHaveBeenCalledWith(
        "/workspaces/w/terminal/workspace?session=review-agent",
      ),
    );
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("authorizes a Git terminal absent from all boards before opening its standalone view", async () => {
    render(<NotificationTerminalLink agentId="a" workspaceId="w" sessionName={session} />);
    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledOnce());
    const url = new URL(mocks.router.replace.mock.calls[0][0], "https://hive.test");
    expect(url.pathname).toBe("/workspaces/w/terminal");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      session,
      clonePath: identity.clonePath,
      cloneProof: "fresh-proof",
      cloneSessionKey: identity.cloneSessionKey,
      relativePath: identity.clonePath,
    });
    expect(mocks.resolve).toHaveBeenCalledWith({
      workspaceId: "w",
      agentId: "a",
      sessionName: session,
    });
    expect(window.localStorage.length).toBe(0);
  });
  it("recognizes a saved Git pane even if its stored session ID is missing", async () => {
    seedBoard({
      kind: "git",
      cloneSessionKey: identity.cloneSessionKey,
      relativePath: identity.clonePath,
    });
    render(<NotificationTerminalLink agentId="a" workspaceId="w" sessionName={session} />);
    await waitFor(() =>
      expect(mocks.router.replace).toHaveBeenCalledWith(
        `/workspaces/w/terminal/workspace?session=${session}`,
      ),
    );
  });
  it("does not select a similarly named pane in another Coder workspace", async () => {
    seedBoard({ kind: "terminal", sessionName: "review-agent" }, "other");
    render(<NotificationTerminalLink agentId="a" workspaceId="w" sessionName="review-agent" />);
    await waitFor(() =>
      expect(mocks.router.replace).toHaveBeenCalledWith(
        "/workspaces/w/terminal?session=review-agent",
      ),
    );
  });
  it.each([
    {},
    { data: { ...identity, sessionName: "another-terminal" } },
  ])("does not navigate when authorization fails or resolves another session", async (result) => {
    mocks.resolve.mockResolvedValue(result);
    render(<NotificationTerminalLink agentId="a" workspaceId="w" sessionName={session} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open this terminal");
    expect(mocks.router.replace).not.toHaveBeenCalled();
  });
  it("can retry an unavailable terminal", async () => {
    mocks.resolve.mockRejectedValueOnce(new Error("offline"));
    render(<NotificationTerminalLink agentId="a" workspaceId="w" sessionName={session} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledOnce());
  });
  it("ignores a late result after navigating away", async () => {
    let finish!: (value: unknown) => void;
    mocks.resolve.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { unmount } = render(
      <NotificationTerminalLink agentId="a" workspaceId="w" sessionName={session} />,
    );
    unmount();
    await act(async () => {
      finish({ data: identity });
    });
    expect(mocks.router.replace).not.toHaveBeenCalled();
  });
});
