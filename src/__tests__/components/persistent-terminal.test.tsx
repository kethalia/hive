// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode, useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PersistentTerminal,
  PersistentTerminalProvider,
} from "@/components/terminal/PersistentTerminalProvider";
import type { InteractiveTerminalProps } from "@/components/workspaces/InteractiveTerminal";
import { forgetTerminalSession, forgetTerminalViews } from "@/lib/terminal/session-lifetime";

const mounted = vi.fn();
const disposed = vi.fn();
const send = vi.fn();
const term = { focus: vi.fn() };
function Runtime(props: InteractiveTerminalProps) {
  const [initialName] = useState(props.sessionName);
  useEffect(() => {
    mounted(initialName);
    props.onTerminalReady?.(term as never, send);
    props.onConnectionStateChange?.("connected");
    return () => {
      disposed(initialName);
      props.onTerminalDestroy?.();
    };
  }, [initialName, props.onTerminalReady, props.onTerminalDestroy, props.onConnectionStateChange]);
  return (
    <textarea
      aria-label={`terminal-${props.workspaceId}-${props.sessionName}`}
      defaultValue="retained history"
    />
  );
}
const defaults = { agentId: "agent", workspaceId: "workspace-a", sessionName: "shell" };
function View(props: Partial<InteractiveTerminalProps>) {
  return <PersistentTerminal Runtime={Runtime} terminalProps={{ ...defaults, ...props }} />;
}
function App({
  workspace = "workspace-a",
  show = true,
  ...props
}: Partial<InteractiveTerminalProps> & { workspace?: string; show?: boolean }) {
  return (
    <PersistentTerminalProvider>
      {show ? <View key={workspace} workspaceId={workspace} {...props} /> : <p>Git view</p>}
    </PersistentTerminalProvider>
  );
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("dashboard terminal lifetime", () => {
  it("moves the same live surface back after visiting another workspace", () => {
    const readyA = vi.fn();
    const destroyA = vi.fn();
    const { rerender, unmount } = render(
      <App onTerminalReady={readyA} onTerminalDestroy={destroyA} />,
    );
    const surface = screen.getByRole("textbox");
    surface.focus();
    const blur = vi.spyOn(surface, "blur");
    rerender(<App workspace="workspace-b" />);
    expect(blur).toHaveBeenCalled();
    expect(surface.closest("[hidden][inert]")).not.toBeNull();
    expect(disposed).not.toHaveBeenCalled();
    expect(destroyA).toHaveBeenCalledTimes(1);
    const nextReady = vi.fn();
    rerender(<App onTerminalReady={nextReady} />);
    expect(screen.getByRole("textbox")).toBe(surface);
    expect(nextReady).toHaveBeenCalledWith(term, send);
    expect(mounted).toHaveBeenCalledTimes(2);
    expect(disposed).not.toHaveBeenCalled();
    unmount();
    expect(disposed).toHaveBeenCalledTimes(2);
  });

  it("keeps a terminal alive on a non-terminal route and replays its status on return", () => {
    const { rerender } = render(<App />);
    const surface = screen.getByRole("textbox");
    rerender(<App show={false} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(disposed).not.toHaveBeenCalled();
    const status = vi.fn();
    rerender(<App onConnectionStateChange={status} />);
    expect(screen.getByRole("textbox")).toBe(surface);
    expect(status).toHaveBeenCalledWith("connected");
  });

  it("updates callback props without recreating the runtime", () => {
    const { rerender } = render(<App />);
    rerender(<App cloneProof="renewed-proof" onTerminalReady={vi.fn()} layoutSignal="resized" />);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(disposed).not.toHaveBeenCalled();
  });

  it("does not share one surface between two simultaneous views", () => {
    render(
      <PersistentTerminalProvider>
        <View />
        <View />
      </PersistentTerminalProvider>,
    );
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    expect(mounted).toHaveBeenCalledTimes(2);
  });

  it("disposes a removed pane immediately without closing another view of its session", () => {
    function Panes({ showFirst = true }) {
      return (
        <PersistentTerminalProvider>
          {showFirst && <View viewKey="first" />}
          <View viewKey="second" />
        </PersistentTerminalProvider>
      );
    }
    const { rerender } = render(<Panes />);
    const second = screen.getAllByRole("textbox")[1];
    act(() => forgetTerminalViews("workspace-a", ["first"]));
    rerender(<Panes showFirst={false} />);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox")).toBe(second);
    expect(mounted).toHaveBeenCalledTimes(2);
  });

  it("disposes all parked views of a deleted board only in the targeted workspace", () => {
    function Panes({ show = true }) {
      return (
        <PersistentTerminalProvider>
          {show && <View viewKey="first" />}
          {show && <View viewKey="second" sessionName="git" />}
          <View workspaceId="workspace-b" viewKey="first" />
        </PersistentTerminalProvider>
      );
    }
    const { rerender } = render(<Panes />);
    const otherWorkspace = screen.getAllByRole("textbox")[2];
    rerender(<Panes show={false} />);
    expect(disposed).not.toHaveBeenCalled();
    act(() => forgetTerminalViews("workspace-a", ["first", "second"]));
    expect(disposed).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("textbox")).toBe(otherWorkspace);
  });

  it("explicit session deletion releases parked surfaces", () => {
    const { rerender } = render(<App />);
    rerender(<App workspace="workspace-b" />);
    act(() => forgetTerminalSession("workspace-a", "shell"));
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox").getAttribute("aria-label")).toBe(
      "terminal-workspace-b-shell",
    );
  });

  it("shows explicit closure instead of reconnecting a deleted visible session", () => {
    render(<App />);
    act(() => forgetTerminalSession("workspace-a", "shell"));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("closed or renamed");
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it("expires parked terminals after 30 minutes without expiring the active terminal", () => {
    vi.useFakeTimers();
    const { rerender, unmount } = render(<App />);
    rerender(<App workspace="workspace-b" />);
    act(() => vi.advanceTimersByTime(29 * 60_000));
    expect(disposed).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(60_000));
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox").getAttribute("aria-label")).toBe(
      "terminal-workspace-b-shell",
    );
    rerender(<App />);
    expect(mounted).toHaveBeenCalledTimes(3);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels expiry on reattachment and starts a fresh idle period on release", () => {
    vi.useFakeTimers();
    const { rerender } = render(<App />);
    rerender(<App show={false} />);
    act(() => vi.advanceTimersByTime(29 * 60_000));
    rerender(<App />);
    act(() => vi.advanceTimersByTime(2 * 60_000));
    expect(disposed).not.toHaveBeenCalled();
    rerender(<App show={false} />);
    act(() => vi.advanceTimersByTime(30 * 60_000));
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it("bounds parked surfaces without evicting the active one", () => {
    const { rerender } = render(<App />);
    for (let index = 0; index < 26; index++) rerender(<App workspace={`workspace-${index}`} />);
    expect(disposed).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("textbox").getAttribute("aria-label")).toBe(
      "terminal-workspace-25-shell",
    );
  });

  it("survives StrictMode's attachment cleanup without duplicate visible surfaces", () => {
    const { rerender } = render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    rerender(
      <StrictMode>
        <App workspace="workspace-b" />
      </StrictMode>,
    );
    rerender(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });
});
