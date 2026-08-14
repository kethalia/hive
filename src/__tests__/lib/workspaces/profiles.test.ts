import { describe, expect, it } from "vitest";
import { WORKSPACE_PROFILES, workspaceProfileForTemplate } from "@/lib/workspaces/profiles";

describe("workspace profiles", () => {
  it("keeps a stable profile catalog for the launch flow", () => {
    expect(WORKSPACE_PROFILES.map(({ id }) => id)).toEqual([
      "orchestrator",
      "software",
      "game",
      "electronics",
      "infrastructure",
      "custom",
    ]);
  });

  it.each([
    ["orchestrator-home", "orchestrator"],
    ["ai-dev", "software"],
    ["ai-dev-k8s", "software"],
    ["game-dev", "game"],
    ["electronics", "electronics"],
    ["infrastructure", "infrastructure"],
    ["unity-game-studio", "game"],
    ["kicad-electronics", "electronics"],
    ["terraform-platform", "infrastructure"],
    ["research-lab", "custom"],
  ])("maps %s to the %s profile", (templateName, expectedProfile) => {
    expect(workspaceProfileForTemplate(templateName).id).toBe(expectedProfile);
  });
});
