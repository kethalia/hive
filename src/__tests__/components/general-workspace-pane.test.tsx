// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const actions = vi.hoisted(() => ({
  app: vi.fn(),
  agent: vi.fn(),
  clone: vi.fn(),
  files: vi.fn(),
  terminal: vi.fn(),
  mount: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("@/lib/actions/workspaces", () => ({
  getWorkspaceAppToolAction: actions.app,
  getWorkspaceAgentAction: actions.agent,
  getWorkspaceSessionToolsAction: actions.files,
}));
vi.mock("@/lib/actions/git-clones", () => ({ resolveGitCloneTerminalAction: actions.clone }));
vi.mock("next/dynamic", async () => {
  const { PersistentTerminal } = await import("@/components/terminal/PersistentTerminalProvider");
  const { useEffect } = await import("react");
  function Runtime(props: Record<string, unknown>) {
    actions.terminal(props);
    useEffect(() => {
      actions.mount(props.viewKey);
      return () => {
        actions.dispose(props.viewKey);
      };
    }, [props.viewKey]);
    return <div data-testid="terminal-connection">{JSON.stringify(props)}</div>;
  }
  return {
    default: () => (props: Record<string, unknown>) => (
      <PersistentTerminal terminalProps={props as never} Runtime={Runtime as never} />
    ),
  };
});
vi.mock("@/components/workspaces/WorkspacePaneActionSheet", () => ({
  WorkspacePaneActionSheet: ({
    actions: items,
    open,
  }: {
    actions: { id: string; label: string; onSelect: () => void }[];
    open: boolean;
  }) =>
    open
      ? items.map((item) => (
          <button type="button" key={item.id} onClick={item.onSelect}>
            {item.label}
          </button>
        ))
      : null,
}));

import { PersistentTerminalProvider } from "@/components/terminal/PersistentTerminalProvider";

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
    onOpenFile: vi.fn(),
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
  it("recreates only the selected pane runtime when reconnecting an unchanged agent", async () => {
    const initial = props();
    const pane = {
      id: "pane-1",
      kind: "terminal" as const,
      workspaceId: "software",
      sessionName: "main",
      label: "Main",
    };
    render(
      <PersistentTerminalProvider>
        <GeneralWorkspacePane {...initial} pane={pane} />
        <GeneralWorkspacePane
          {...initial}
          pane={{ ...pane, id: "pane-2", sessionName: "other", label: "Other" }}
        />
      </PersistentTerminalProvider>,
    );
    await waitFor(() => expect(actions.mount).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Open actions for Main" }));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(actions.mount).toHaveBeenCalledTimes(3));
    expect(actions.dispose).toHaveBeenCalledExactlyOnceWith('["board-1","pane-1"]');
    expect(actions.mount.mock.calls.filter(([key]) => key === '["board-1","pane-2"]')).toHaveLength(
      1,
    );
    expect(actions.agent).toHaveBeenCalledTimes(3);
  });

  it.each([
    "open",
    "new-workspace",
  ] as const)("opens file links with the source workspace/session for %s", async (action) => {
    const initial = props();
    render(
      <GeneralWorkspacePane
        {...initial}
        pane={{
          id: "pane-1",
          kind: "terminal",
          workspaceId: "software",
          sessionName: "main",
          label: "Main",
        }}
      />,
    );
    await screen.findByTestId("terminal-connection");
    await act(() => actions.terminal.mock.lastCall![0].onFileAction("src/index.ts", action));
    expect(initial.onOpenFile).toHaveBeenCalledWith(
      {
        kind: "app",
        workspaceId: "software",
        tool: "files",
        label: "Files",
        file: { sessionName: "main", path: "src/index.ts" },
      },
      action === "new-workspace",
    );
  });

  it("resolves a restored file pane through fresh scoped authorization", async () => {
    actions.files.mockResolvedValue({
      data: {
        filesUrl: "https://files.coder.example/fresh-auth",
        folderPath: "/projects/hive/src/index.ts",
        reloadRequired: false,
      },
    });
    render(
      <GeneralWorkspacePane
        {...props()}
        pane={{
          id: "file-1",
          kind: "app",
          workspaceId: "software",
          tool: "files",
          label: "Files",
          file: { sessionName: "main", path: "src/index.ts" },
        }}
      />,
    );
    expect(await screen.findByTitle("Files · ai-dev-01")).toHaveAttribute(
      "src",
      "https://files.coder.example/fresh-auth",
    );
    expect(actions.files).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "software",
        sessionName: "main",
        filePath: "src/index.ts",
        tool: "files",
      }),
    );
    expect(actions.app).not.toHaveBeenCalled();
  });

  it("closes a reserved download window when file authorization fails", async () => {
    actions.files.mockResolvedValue({ serverError: "File not allowed" });
    const close = vi.fn();
    const replace = vi.fn();
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue({ close, location: { replace } } as unknown as Window);
    render(
      <GeneralWorkspacePane
        {...props()}
        pane={{
          id: "pane-1",
          kind: "terminal",
          workspaceId: "software",
          sessionName: "main",
          label: "Main",
        }}
      />,
    );
    await screen.findByTestId("terminal-connection");
    await act(() => actions.terminal.mock.lastCall![0].onFileAction("secret.txt", "download"));
    expect(actions.files).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "software",
        sessionName: "main",
        filePath: "secret.txt",
        download: true,
      }),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
    open.mockRestore();
  });
});
