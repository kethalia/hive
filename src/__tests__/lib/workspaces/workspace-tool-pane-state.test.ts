import { describe, expect, it } from "vitest";
import {
  parsePersistedWorkspaceToolPanes,
  serializeWorkspaceToolPanes,
  workspaceToolPaneStorageKey,
} from "@/lib/workspaces/workspace-tool-pane-state";

describe("workspace tool pane persistence", () => {
  it("round-trips safe pane descriptors without persisting authenticated URLs", () => {
    const serialized = serializeWorkspaceToolPanes([
      {
        boardKey: "default",
        sessionName: "git-clone-safe-hive",
        tool: "code",
        label: "hive",
        cloneSessionKey: "git-clone:kethalia/hive",
        relativePath: "kethalia/hive",
      },
    ]);

    expect(serialized).not.toContain("codeUrl");
    expect(serialized).not.toContain("coder_application_connect_api_key");
    expect(parsePersistedWorkspaceToolPanes(serialized)).toEqual([
      {
        boardKey: "default",
        sessionName: "git-clone-safe-hive",
        tool: "code",
        label: "hive",
        cloneSessionKey: "git-clone:kethalia/hive",
        relativePath: "kethalia/hive",
      },
    ]);
  });

  it("drops malformed, duplicate, and path-traversing pane descriptors", () => {
    expect(
      parsePersistedWorkspaceToolPanes(
        JSON.stringify({
          version: 1,
          panes: [
            { boardKey: "default", sessionName: "main", tool: "files", label: "main" },
            { boardKey: "default", sessionName: "main", tool: "files", label: "duplicate" },
            {
              boardKey: "default",
              sessionName: "git-hive",
              tool: "code",
              label: "hive",
              cloneSessionKey: "git-clone:kethalia/hive",
              relativePath: "../secrets",
            },
            { boardKey: "default", sessionName: "main", tool: "desktop", label: "main" },
          ],
        }),
      ),
    ).toEqual([{ boardKey: "default", sessionName: "main", tool: "files", label: "main" }]);
  });

  it("scopes panes by workspace and workspace surface", () => {
    expect(workspaceToolPaneStorageKey("ws-1", "workspace")).toBe(
      "workspace-tool-panes:workspace:ws-1",
    );
    expect(workspaceToolPaneStorageKey("ws-1", "unified")).toBe(
      "workspace-tool-panes:unified:ws-1",
    );
  });
});
