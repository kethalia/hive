// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    vi.clearAllMocks();
  });

  it("resolves File Browser and asks the workspace to add it as a pane", async () => {
    const onOpenTool = vi.fn();
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
});
