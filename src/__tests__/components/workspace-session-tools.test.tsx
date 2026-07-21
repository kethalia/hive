// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const mockGetWorkspaceSessionTools = vi.fn();

vi.mock("@/lib/actions/workspaces", () => ({
  getWorkspaceSessionToolsAction: (...args: unknown[]) => mockGetWorkspaceSessionTools(...args),
}));

vi.mock("lucide-react", () => ({
  Code2: () => <span>Code icon</span>,
  FolderOpen: () => <span>Folder icon</span>,
  Loader2: () => <span>Loading</span>,
  ScrollText: () => <span>Logs icon</span>,
}));

import { WorkspaceSessionTools } from "@/components/workspaces/WorkspaceSessionTools";

describe("WorkspaceSessionTools", () => {
  beforeEach(() => {
    mockGetWorkspaceSessionTools.mockResolvedValue({
      data: {
        codeUrl: "https://code.test/?folder=%2Fhome%2Fcoder%2Fhive",
        filesUrl: "https://files.test/files/home/coder/hive",
        folderPath: "/home/coder/hive",
      },
    });
  });

  afterEach(() => {
    cleanup();
    document.head.querySelector('meta[name="hive-coder-frame-hosts"]')?.remove();
    vi.clearAllMocks();
  });

  it("resolves File Browser and asks the workspace to add it as a pane", async () => {
    const onOpenTool = vi.fn();
    const frameHostsMeta = document.createElement("meta");
    frameHostsMeta.name = "hive-coder-frame-hosts";
    frameHostsMeta.content = "https://coder.example.com~https://apps.example.com";
    document.head.append(frameHostsMeta);
    render(
      <WorkspaceSessionTools
        workspaceId="ws-1"
        sessionName="git-hive"
        label="Hive"
        fallbackPath="/home/coder/hive"
        onOpenTool={onOpenTool}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Browse files for Hive" }));
    await waitFor(() => expect(onOpenTool).toHaveBeenCalled());
    expect(mockGetWorkspaceSessionTools).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sessionName: "git-hive",
      fallbackPath: "/home/coder/hive",
      documentFrameHosts: ["https://coder.example.com", "https://apps.example.com"],
      tool: "files",
    });
    expect(onOpenTool).toHaveBeenCalledWith({
      tool: "files",
      urls: {
        codeUrl: "https://code.test/?folder=%2Fhome%2Fcoder%2Fhive",
        filesUrl: "https://files.test/files/home/coder/hive",
        folderPath: "/home/coder/hive",
      },
    });
  });

  it("resolves VS Code and asks the workspace to add it as a pane", async () => {
    const onOpenTool = vi.fn();
    render(
      <WorkspaceSessionTools
        workspaceId="ws-1"
        sessionName="shell"
        label="Shell"
        onOpenTool={onOpenTool}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open VS Code for Shell" }));
    await waitFor(() => expect(onOpenTool).toHaveBeenCalled());
    expect(mockGetWorkspaceSessionTools).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "code" }),
    );
    expect(onOpenTool).toHaveBeenCalledWith({
      tool: "code",
      urls: expect.objectContaining({
        codeUrl: "https://code.test/?folder=%2Fhome%2Fcoder%2Fhive",
      }),
    });
  });

  it("opens live session logs without requesting a Coder app URL", () => {
    const onOpenTool = vi.fn();
    const onOpenLogs = vi.fn();
    render(
      <WorkspaceSessionTools
        workspaceId="ws-1"
        sessionName="git-hive"
        label="Hive"
        onOpenTool={onOpenTool}
        onOpenLogs={onOpenLogs}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open session logs for Hive" }));

    expect(onOpenLogs).toHaveBeenCalledOnce();
    expect(mockGetWorkspaceSessionTools).not.toHaveBeenCalled();
    expect(onOpenTool).not.toHaveBeenCalled();
  });

  it("opens File Browser and VS Code concurrently with independent loading states", async () => {
    const filesRequest = Promise.withResolvers<{
      data: { codeUrl: string; filesUrl: string; folderPath: string | null };
    }>();
    const codeRequest = Promise.withResolvers<{
      data: { codeUrl: string; filesUrl: string; folderPath: string | null };
    }>();
    mockGetWorkspaceSessionTools.mockImplementation(({ tool }: { tool: "code" | "files" }) =>
      tool === "files" ? filesRequest.promise : codeRequest.promise,
    );
    const onOpenTool = vi.fn();
    render(
      <WorkspaceSessionTools
        workspaceId="ws-1"
        sessionName="shell"
        label="Shell"
        onOpenTool={onOpenTool}
      />,
    );

    const filesButton = screen.getByRole("button", { name: "Browse files for Shell" });
    const codeButton = screen.getByRole("button", { name: "Open VS Code for Shell" });
    fireEvent.click(filesButton);
    fireEvent.click(codeButton);

    expect(mockGetWorkspaceSessionTools).toHaveBeenCalledTimes(2);
    expect(filesButton).toBeDisabled();
    expect(codeButton).toBeDisabled();

    await act(async () => {
      codeRequest.resolve({
        data: {
          codeUrl: "https://code.test",
          filesUrl: "https://files.test",
          folderPath: "/home/coder",
        },
      });
      await codeRequest.promise;
    });

    expect(codeButton).toBeEnabled();
    expect(filesButton).toBeDisabled();
    expect(onOpenTool).toHaveBeenCalledWith({
      tool: "code",
      urls: {
        codeUrl: "https://code.test",
        filesUrl: "https://files.test",
        folderPath: "/home/coder",
      },
    });

    await act(async () => {
      filesRequest.resolve({
        data: {
          codeUrl: "https://code.test",
          filesUrl: "https://files.test",
          folderPath: "/home/coder",
        },
      });
      await filesRequest.promise;
    });

    expect(filesButton).toBeEnabled();
    expect(onOpenTool).toHaveBeenCalledWith({
      tool: "files",
      urls: {
        codeUrl: "https://code.test",
        filesUrl: "https://files.test",
        folderPath: "/home/coder",
      },
    });
  });

  it("ignores a pending tool response after the workspace changes", async () => {
    const pending = Promise.withResolvers<{
      data: {
        codeUrl: string;
        filesUrl: string;
        folderPath: string | null;
      };
    }>();
    mockGetWorkspaceSessionTools.mockReturnValueOnce(pending.promise);
    const onOpenTool = vi.fn();
    const { rerender } = render(
      <WorkspaceSessionTools
        workspaceId="ws-old"
        sessionName="shell"
        label="Shell"
        onOpenTool={onOpenTool}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Browse files for Shell" }));

    rerender(
      <WorkspaceSessionTools
        workspaceId="ws-new"
        sessionName="shell"
        label="Shell"
        onOpenTool={onOpenTool}
      />,
    );
    await act(async () => {
      pending.resolve({
        data: {
          codeUrl: "https://old-code.test",
          filesUrl: "https://old-files.test",
          folderPath: "/old",
        },
      });
      await pending.promise;
    });

    expect(mockGetWorkspaceSessionTools).toHaveBeenCalledOnce();
    expect(onOpenTool).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Browse files for Shell" })).toBeEnabled();
  });

  it("ignores a pending tool response after the source controls unmount", async () => {
    const pending = Promise.withResolvers<{
      data: {
        codeUrl: string;
        filesUrl: string;
        folderPath: string | null;
      };
    }>();
    mockGetWorkspaceSessionTools.mockReturnValueOnce(pending.promise);
    const onOpenTool = vi.fn();
    const { unmount } = render(
      <WorkspaceSessionTools
        workspaceId="ws-1"
        sessionName="shell"
        label="Shell"
        onOpenTool={onOpenTool}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open VS Code for Shell" }));

    unmount();
    await act(async () => {
      pending.resolve({
        data: {
          codeUrl: "https://code.test",
          filesUrl: "https://files.test",
          folderPath: "/workspace",
        },
      });
      await pending.promise;
    });

    expect(mockGetWorkspaceSessionTools).toHaveBeenCalledOnce();
    expect(onOpenTool).not.toHaveBeenCalled();
  });
});
