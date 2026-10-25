// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceNotifications } from "@/hooks/useWorkspaceNotifications";
import { resolveGitCloneNotificationAction } from "@/lib/actions/git-clones";
import { TERMINAL_NOTIFICATION_FOCUS_EVENT } from "@/lib/terminal/events";
import { addGeneralWindow, emptyGeneralWorkspace } from "@/lib/workspaces/general-workspace";

vi.mock("@/lib/actions/git-clones", () => ({ resolveGitCloneNotificationAction: vi.fn() }));
const sessionName = `git-clone-${"a".repeat(32)}`;
function setup() {
  const onError = vi.fn(),
    onFocus = vi.fn();
  const hook = renderHook(() => {
    const [state, setState] = useState(() =>
      addGeneralWindow(
        emptyGeneralWorkspace(),
        { kind: "terminal", workspaceId: "software", sessionName: "shell", label: "Shell" },
        "shell",
      ),
    );
    const current = useRef(state);
    const notifications = useWorkspaceNotifications({
      loaded: true,
      state,
      update: (change) => {
        current.current = change(current.current);
        setState(current.current);
        return current.current;
      },
      onError,
      onFocus,
    });
    return { state, ...notifications };
  });
  return { ...hook, onError, onFocus };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(callback, 0),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("general workspace notifications", () => {
  it("claims foreground navigation and focuses the existing window without discovery", async () => {
    const { result, onFocus } = setup();
    let handled = false;
    act(() => {
      handled = !window.dispatchEvent(
        new CustomEvent(TERMINAL_NOTIFICATION_FOCUS_EVENT, {
          cancelable: true,
          detail: { workspaceId: "software", sessionName: "shell" },
        }),
      );
    });
    expect(handled).toBe(true);
    await waitFor(() => expect(onFocus).toHaveBeenCalledWith("board-1", "shell"));
    expect(result.current.state.boards).toHaveLength(1);
    expect(resolveGitCloneNotificationAction).not.toHaveBeenCalled();
  });
  it("keeps the current board and shows loading while resolving an authorized missing repository", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(resolveGitCloneNotificationAction).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }) as never,
    );
    const { result } = setup();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.open("software", sessionName);
    });
    expect(result.current.opening).toBe(true);
    expect(result.current.state.boards).toHaveLength(1);
    await act(async () => {
      finish({
        data: {
          sessionName,
          clonePath: "projects/kethalia/hive",
          cloneSessionKey: "identity",
          cloneProof: "must-not-persist",
        },
      });
      await pending;
    });
    expect(result.current.opening).toBe(false);
    expect(result.current.state.boards).toHaveLength(2);
    const target = result.current.state.boards[1];
    expect(result.current.state.activeBoardKey).toBe(target.key);
    expect(target.windows[0]).toMatchObject({
      relativePath: "projects/kethalia/hive",
      sessionName,
      label: "hive",
    });
    expect(JSON.stringify(result.current.state)).not.toContain("must-not-persist");
  });
  it("does not mutate the canvas on an expired or unauthorized repository", async () => {
    vi.mocked(resolveGitCloneNotificationAction).mockResolvedValue({
      serverError: "Terminal unavailable",
    } as never);
    const { result, onError } = setup();
    const before = result.current.state;
    await act(async () => {
      await result.current.open("software", sessionName);
    });
    expect(result.current.state).toBe(before);
    expect(onError).toHaveBeenCalledWith("Terminal unavailable");
  });
  it.each(["superseded", "unmounted"])("ignores %s asynchronous resolution", async (reason) => {
    let finish!: (value: unknown) => void;
    vi.mocked(resolveGitCloneNotificationAction).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }) as never,
    );
    const { result, unmount, onError, onFocus } = setup();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.open("software", sessionName);
    });
    if (reason === "unmounted") unmount();
    else
      await act(async () => {
        await result.current.open("software", "shell");
      });
    await act(async () => {
      finish({ serverError: "late failure" });
      await pending;
    });
    expect(onError).not.toHaveBeenCalled();
    if (reason === "unmounted") expect(onFocus).not.toHaveBeenCalled();
    else expect(result.current.state.boards).toHaveLength(1);
  });
});
