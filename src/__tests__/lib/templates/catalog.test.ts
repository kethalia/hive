import { describe, expect, it } from "vitest";
import { KNOWN_TEMPLATES, TEMPLATE_CATALOG, templateCatalogEntry } from "@/lib/templates/catalog";

describe("template catalog", () => {
  it("registers every deployable workspace template in profile order", () => {
    expect(KNOWN_TEMPLATES).toEqual([
      "orchestrator",
      "ai-dev",
      "ai-dev-k8s",
      "game-dev",
      "electronics",
      "infrastructure",
    ]);
  });

  it("covers every built-in non-custom profile", () => {
    expect(new Set(TEMPLATE_CATALOG.map(({ profileId }) => profileId))).toEqual(
      new Set(["orchestrator", "software", "game", "electronics", "infrastructure"]),
    );
  });

  it("indexes catalog entries by normalized template name", () => {
    expect(templateCatalogEntry(" GAME-DEV ")).toMatchObject({
      profileId: "game",
      runtime: "kubernetes",
    });
    expect(templateCatalogEntry("external-template")).toBeNull();
  });
});
