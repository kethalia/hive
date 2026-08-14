import { describe, expect, it } from "vitest";
import {
  KNOWN_TEMPLATES,
  TEMPLATE_CATALOG,
  templateCatalogEntry,
  workspaceSurfaceLabel,
  workspaceTemplateCapabilities,
} from "@/lib/templates/catalog";

describe("template catalog", () => {
  it("registers every deployable workspace template in profile order", () => {
    expect(KNOWN_TEMPLATES).toEqual([
      "orchestrator",
      "ai-dev-k8s",
      "browser-testing",
      "game-dev",
      "electronics",
      "infrastructure",
    ]);
  });

  it("covers every built-in non-custom profile", () => {
    expect(new Set(TEMPLATE_CATALOG.map(({ profileId }) => profileId))).toEqual(
      new Set(["orchestrator", "software", "browser", "game", "electronics", "infrastructure"]),
    );
  });

  it("indexes catalog entries by normalized template name", () => {
    expect(templateCatalogEntry(" GAME-DEV ")).toMatchObject({
      profileId: "game",
      runtime: "kubernetes",
    });
    expect(templateCatalogEntry("external-template")).toBeNull();
  });

  it("describes isolated runtime surfaces for navigation and template details", () => {
    expect(workspaceSurfaceLabel("orchestrator")).toBe("CLI");
    expect(workspaceSurfaceLabel("ai-dev-k8s")).toBe("CLI + web tools");
    expect(workspaceSurfaceLabel("game-dev")).toBe("Desktop");
    expect(workspaceSurfaceLabel("browser-testing")).toBe("Browser + desktop");
    expect(workspaceTemplateCapabilities("orchestrator")).toEqual({
      browser: false,
      desktop: false,
      editor: false,
      fileBrowser: false,
      web3: false,
    });
    expect(workspaceTemplateCapabilities("browser-testing")).toMatchObject({
      browser: true,
      desktop: true,
    });
  });

  it("keeps unknown external templates backward compatible with workspace app links", () => {
    expect(workspaceTemplateCapabilities("external-template")).toMatchObject({
      desktop: true,
      editor: true,
      fileBrowser: true,
    });
    expect(workspaceSurfaceLabel("external-template")).toBe("External");
  });
});
