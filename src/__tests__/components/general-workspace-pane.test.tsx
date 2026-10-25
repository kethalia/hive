// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const actions = vi.hoisted(() => ({ app: vi.fn(), agent: vi.fn(), clone: vi.fn() }));
vi.mock("@/lib/actions/workspaces", () => ({
  getWorkspaceAppToolAction: actions.app,
  getWorkspaceAgentAction: actions.agent,
}));
vi.mock("@/lib/actions/git-clones", () => ({ resolveGitCloneTerminalAction: actions.clone }));
vi.mock("next/dynamic", () => ({
  default: () => (props: Record<string, unknown>) => (
    <div data-testid="terminal-connection">{JSON.stringify(props)}</div>
  ),
}));
vi.mock("@/components/workspaces/WorkspacePaneActionSheet", () => ({
  WorkspacePaneActionSheet: () => null,
}));

import { GeneralWorkspacePane } from "@/components/workspaces/GeneralWorkspacePane";
import type { CoderWorkspace } from "@/lib/coder/types";

function props(): ComponentProps<typeof GeneralWorkspacePane> {
  return {
    pane: { id: "pane-1", kind: "app", workspaceId: "software", tool: "code", label: "VS Code" },
    workspace: {
      id: "software",
      name: "ai-dev-01",
      template_name: "ai-dev-k8s",
      latest_build: { id: "build-1", status: "running" },
    } as CoderWorkspace,
    boardKey: "board-1",
    active: true,
    visible: true,
    mobile: false,
    layoutSignal: "",
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onOpenTool: vi.fn(),
    onReady: vi.fn(),
    onDestroy: vi.fn(),
    onStart: vi.fn(),
  };
}

describe("GeneralWorkspacePane connections", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.resetAllMocks();
    actions.agent.mockResolvedValue({ data: { agentId: "agent-1", agentStatus: "connected" } });
  });

  it("embeds the authorized app URL and preserves it when a board is hidden", async () => {
    actions.app.mockResolvedValue({ data: { url: "https://code.coder.example/app-auth" } });
    const initial = props();
    const { rerender } = render(<GeneralWorkspacePane {...initial} />);
    const frame = await screen.findByTitle("VS Code · ai-dev-01");
    expect(frame).toHaveAttribute("src", "https://code.coder.example/app-auth");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame).toHaveAttribute("sandbox", expect.stringContaining("allow-same-origin"));
    expect(actions.app).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "software", tool: "code" }),
    );
    rerender(<GeneralWorkspacePane {...initial} visible={false} active={false} />);
    expect(screen.getByTitle("VS Code · ai-dev-01")).toBe(frame);
    expect(actions.app).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close VS Code window" }));
    expect(initial.onClose).toHaveBeenCalledOnce();
  });

  it("discards a late app response after the Coder build has changed", async () => {
    let finishOld!: (value: unknown) => void;
    actions.app.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    const initial = props();
    const { rerender } = render(<GeneralWorkspacePane {...initial} />);
    await waitFor(() => expect(actions.app).toHaveBeenCalledOnce());
    actions.app.mockResolvedValue({ data: { url: "https://code.coder.example/new-build" } });
    rerender(
      <GeneralWorkspacePane
        {...initial}
        workspace={{
          ...initial.workspace!,
          latest_build: { ...initial.workspace!.latest_build, id: "build-2" },
        }}
      />,
    );
    const frame = await screen.findByTitle("VS Code · ai-dev-01");
    expect(frame).toHaveAttribute("src", "https://code.coder.example/new-build");
    await act(async () => finishOld({ data: { url: "https://code.coder.example/old-build" } }));
    expect(frame).toHaveAttribute("src", "https://code.coder.example/new-build");
  });

  it("requires the updated document policy instead of embedding an app when reload is required", async () => {
    actions.app.mockResolvedValue({
      data: { url: "https://code.coder.example/", reloadRequired: true },
    });
    render(<GeneralWorkspacePane {...props()} />);
    expect(await screen.findByRole("button", { name: "Reload Hive" })).toBeInTheDocument();
    expect(screen.queryByTitle("VS Code · ai-dev-01")).not.toBeInTheDocument();
  });

  it("does not connect a stopped workspace and offers an explicit start", () => {
    const initial = props();
    render(
      <GeneralWorkspacePane
        {...initial}
        workspace={{
          ...initial.workspace!,
          latest_build: { ...initial.workspace!.latest_build, status: "stopped" },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start workspace" }));
    expect(initial.onStart).toHaveBeenCalledOnce();
    expect(actions.app).not.toHaveBeenCalled();
  });

  it("resolves a restored repository terminal with fresh workspace credentials", async () => {
    actions.clone.mockResolvedValue({
      data: {
        sessionName: "git-clone-fresh",
        clonePath: "/home/coder/projects/hive",
        cloneProof: "fresh-proof",
      },
    });
    const initial = props();
    render(
      <GeneralWorkspacePane
        {...initial}
        pane={{
          id: "pane-1",
          kind: "terminal",
          workspaceId: "software",
          sessionName: "pending-clone",
          label: "hive",
          cloneSessionKey: "clone-key",
          relativePath: "projects/hive",
        }}
      />,
    );
    const terminal = await screen.findByTestId("terminal-connection");
    expect(JSON.parse(terminal.textContent!)).toMatchObject({
      workspaceId: "software",
      agentId: "agent-1",
      sessionName: "git-clone-fresh",
      cloneProof: "fresh-proof",
    });
    expect(actions.clone).toHaveBeenCalledWith({
      workspaceId: "software",
      cloneSessionKey: "clone-key",
      relativePath: "projects/hive",
    });
    expect(actions.app).not.toHaveBeenCalled();
  });
});
