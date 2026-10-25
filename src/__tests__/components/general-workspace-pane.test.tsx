// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "../helpers/discovery";
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
import { useDiscovery } from "@/lib/discovery/queries";
import { DiscoveryError } from "@/lib/discovery/types";
import { HIVE_WINDOW_OPEN_EVENT } from "@/lib/workspaces/general-workspace";
import { resolveTerminalFilePath } from "@/lib/workspaces/terminal-file-path";

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

function AgentDiscovery() {
  const query = useDiscovery("agent", { workspaceId: "software", buildId: "build-1" });
  return (
    <button type="button" onClick={() => void query.refresh().catch(() => {})}>
      Refresh agent: {query.error?.message ?? query.data?.agentId ?? "pending"}
    </button>
  );
}

describe("GeneralWorkspacePane connections", () => {
  it.each([
    "files",
    "code",
  ] as const)("restores the selected project when opening %s", async (tool) => {
    actions.app.mockResolvedValue({ data: { url: "https://apps.example.com/project" } });
    const input = props();
    input.pane = {
      id: "project",
      kind: "app",
      tool,
      workspaceId: "software",
      label: "Project",
      projectPath: "projects/org/repo",
    };
    render(<GeneralWorkspacePane {...input} />);
    await waitFor(() =>
      expect(actions.app).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: tool === "files" ? "filebrowser" : "code",
          projectPath: "projects/org/repo",
        }),
      ),
    );
    expect(await screen.findByTestId(`general-app-${tool}`)).toHaveAttribute(
      "src",
      "https://apps.example.com/project",
    );
  });

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

  it.each([
    "code",
    "files",
    "desktop",
  ] as const)("preserves the %s iframe while other consumers populate and refresh the agent query", async (tool) => {
    actions.app.mockResolvedValue({ data: { url: "https://app.coder.example/app-auth" } });
    const initial = props();
    const pane = { ...initial.pane, kind: "app" as const, tool, label: tool };
    const { rerender } = render(<GeneralWorkspacePane {...initial} pane={pane} />);
    const frame = await screen.findByTitle(`${tool} · ai-dev-01`);
    expect(actions.agent).not.toHaveBeenCalled();
    rerender(
      <>
        <GeneralWorkspacePane {...initial} pane={pane} />
        <AgentDiscovery />
      </>,
    );
    await screen.findByRole("button", { name: "Refresh agent: agent-1" });
    expect(screen.getByTitle(`${tool} · ai-dev-01`)).toBe(frame);
    actions.agent.mockResolvedValue({ data: { agentId: "agent-2", agentStatus: "connected" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh agent: agent-1" }));
    await screen.findByRole("button", { name: "Refresh agent: agent-2" });
    expect(screen.getByTitle(`${tool} · ai-dev-01`)).toBe(frame);
    actions.agent.mockRejectedValue(new DiscoveryError("denied", 403));
    fireEvent.click(screen.getByRole("button", { name: "Refresh agent: agent-2" }));
    await screen.findByRole("button", { name: "Refresh agent: denied" });
    expect(screen.getByTitle(`${tool} · ai-dev-01`)).toBe(frame);
    expect(actions.app).toHaveBeenCalledOnce();
  });

  it("opens pane logs as a scoped workspace window without mounting a dialog", async () => {
    const listener = vi.fn();
    window.addEventListener(HIVE_WINDOW_OPEN_EVENT, listener);
    try {
      const initial = props();
      render(
        <GeneralWorkspacePane
          {...initial}
          pane={{
            id: "pane-1",
            kind: "terminal",
            workspaceId: "software",
            sessionName: "review",
            label: "review",
          }}
        />,
      );
      await screen.findByTestId("terminal-connection");
      fireEvent.click(screen.getByRole("button", { name: "Open actions for review" }));
      fireEvent.click(screen.getByRole("button", { name: "Session logs" }));
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: { tool: "logs", workspaceId: "software", sessionName: "review" },
        }),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      window.removeEventListener(HIVE_WINDOW_OPEN_EVENT, listener);
    }
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
    expect(actions.agent).toHaveBeenCalledTimes(2);
  });

  it.each([
    "open",
    "new-workspace",
  ] as const)("opens file links with the source workspace/session for %s", async (action) => {
    actions.files.mockResolvedValue({
      data: {
        folderPath: "/home/coder/projects/hive/src/index.ts",
        filesUrl: "https://files.coder.example/fresh-auth",
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
        file: { sessionName: "main", path: "/home/coder/projects/hive/src/index.ts" },
      },
      action === "new-workspace",
    );
  });

  it("preserves the resolved file target after cwd changes and reconnects with fresh authorization", async () => {
    let cwd = "/home/coder/projects/hive";
    let authorizations = 0;
    actions.files.mockImplementation(async ({ filePath }) => {
      const folderPath = resolveTerminalFilePath(filePath, cwd, "/home/coder/projects");
      return {
        data: {
          folderPath,
          filesUrl: `https://files.coder.example/auth-${++authorizations}?path=${encodeURIComponent(folderPath)}`,
        },
      };
    });
    const initial = props();
    const { rerender } = render(
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
    await act(() => actions.terminal.mock.lastCall![0].onFileAction("README.md", "open"));
    const saved = initial.onOpenFile as ReturnType<typeof vi.fn>;
    const file = saved.mock.lastCall![0];
    expect(file.file.path).toBe("/home/coder/projects/hive/README.md");
    expect(JSON.stringify(file)).not.toContain("auth-");
    cwd = "/home/coder/projects/other";
    rerender(<GeneralWorkspacePane {...initial} pane={{ ...file, id: "file-1" }} />);
    const frame = await screen.findByTitle("Files · ai-dev-01");
    expect(frame).toHaveAttribute(
      "src",
      "https://files.coder.example/auth-2?path=%2Fhome%2Fcoder%2Fprojects%2Fhive%2FREADME.md",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open actions for Files" }));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(await screen.findByTitle("Files · ai-dev-01")).toHaveAttribute(
      "src",
      "https://files.coder.example/auth-3?path=%2Fhome%2Fcoder%2Fprojects%2Fhive%2FREADME.md",
    );
    expect(actions.files).toHaveBeenLastCalledWith(
      expect.objectContaining({ filePath: "/home/coder/projects/hive/README.md" }),
    );
  });

  it("does not create a file window when path resolution fails", async () => {
    actions.files.mockResolvedValue({ serverError: "File not allowed" });
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
    await act(() => actions.terminal.mock.lastCall![0].onFileAction("README.md", "open"));
    expect(initial.onOpenFile).not.toHaveBeenCalled();
  });

  it("discards file resolution after the source pane closes", async () => {
    let finish!: (value: unknown) => void;
    actions.files.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const initial = props();
    const { unmount } = render(
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
    const request = actions.terminal.mock.lastCall![0].onFileAction("README.md", "open");
    expect(initial.onOpenFile).not.toHaveBeenCalled();
    unmount();
    await act(async () => {
      finish({
        data: {
          folderPath: "/home/coder/projects/hive/README.md",
          filesUrl: "https://files.coder.example/auth",
        },
      });
      await request;
    });
    expect(initial.onOpenFile).not.toHaveBeenCalled();
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

vi.mock(
  "@/lib/discovery/transport",
  async () => (await import("../helpers/discovery-transport")).discoveryTransport,
);
