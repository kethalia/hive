import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SESSION_COMPOSE_CONSUMERS = [
  "src/app/(dashboard)/workspaces/[id]/terminal/terminal-client.tsx",
  "src/components/workspaces/MultiSessionWorkspace.tsx",
  "src/components/workspaces/TerminalTabManager.tsx",
] as const;

describe("session compose usage", () => {
  it("routes session pages through the shared TerminalSessionCompose surface", async () => {
    for (const filePath of SESSION_COMPOSE_CONSUMERS) {
      const source = await readFile(filePath, "utf8");

      expect(source, filePath).toContain("@/components/terminal/TerminalSessionCompose");
      expect(source, filePath).not.toContain("@/components/terminal/ComposePanel");
    }
  });
});
