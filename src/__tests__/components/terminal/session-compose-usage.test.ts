import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function expectSharedSessionCompose(source: string, filePath: string) {
  expect(source, filePath).toContain("@/components/terminal/TerminalSessionCompose");
  expect(source, filePath).not.toContain("@/components/terminal/ComposePanel");
}

describe("session compose usage", () => {
  it("routes session pages through the shared TerminalSessionCompose surface", async () => {
    const terminalClientSource = await readFile(
      "src/app/(dashboard)/workspaces/[id]/terminal/terminal-client.tsx",
      "utf8",
    );
    const multiSessionWorkspaceSource = await readFile(
      "src/components/workspaces/MultiSessionWorkspace.tsx",
      "utf8",
    );
    const terminalTabManagerSource = await readFile(
      "src/components/workspaces/TerminalTabManager.tsx",
      "utf8",
    );

    expectSharedSessionCompose(
      terminalClientSource,
      "src/app/(dashboard)/workspaces/[id]/terminal/terminal-client.tsx",
    );
    expectSharedSessionCompose(
      multiSessionWorkspaceSource,
      "src/components/workspaces/MultiSessionWorkspace.tsx",
    );
    expectSharedSessionCompose(
      terminalTabManagerSource,
      "src/components/workspaces/TerminalTabManager.tsx",
    );
  });
});
