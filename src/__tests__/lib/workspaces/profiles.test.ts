import { describe, expect, it } from "vitest";
import { WORKSPACE_PROFILES, workspaceProfileForTemplate } from "@/lib/workspaces/profiles";

describe("workspace profiles", () => {
  it("keeps a stable profile catalog for the launch flow", () => {
    expect(WORKSPACE_PROFILES.map(({ id }) => id)).toEqual([
      "software",
      "browser",
      "interview",
      "game",
      "electronics",
      "infrastructure",
      "custom",
    ]);
  });

  it.each([
    ["orchestrator-home", "custom"],
    ["orchestrator-v2", "custom"],
    ["command-center", "custom"],
    ["control-plane-tools", "custom"],
    ["ai-dev-k8s", "software"],
    ["browser-testing", "browser"],
    ["technical-interview", "interview"],
    ["proton-interview", "interview"],
    ["playwright-qa", "browser"],
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

  it("keeps the retired orchestrator profile available only for legacy workspace labeling", () => {
    expect(WORKSPACE_PROFILES.some(({ id }) => id === ("orchestrator" as string))).toBe(false);
    expect(workspaceProfileForTemplate("orchestrator")).toMatchObject({
      id: "orchestrator",
      label: "Legacy orchestrator",
    });
  });
});
