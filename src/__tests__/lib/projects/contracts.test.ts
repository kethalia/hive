import { describe, expect, it } from "vitest";
import { projectPageSchema } from "@/lib/projects/contracts";

function page() {
  return {
    schemaVersion: 1,
    provider: "github",
    providerAccountId: "123",
    page: 1,
    perPage: 100,
    nextPage: null,
    repositories: [
      {
        provider: "github",
        providerRepositoryId: "42",
        nodeId: "R_42",
        fullName: "owner/hive",
        name: "hive",
        owner: "owner",
        defaultBranch: "main",
        private: true,
        archived: false,
        htmlUrl: "https://github.com/owner/hive",
        permissions: { pull: true, push: false, admin: false },
      },
    ],
  };
}

describe("project metadata trust boundary", () => {
  it("rejects raw credential fields rather than reflecting them to the browser", () => {
    const value = page();
    expect(projectPageSchema.safeParse({ ...value, token: "private-provider-token" }).success).toBe(
      false,
    );
    expect(
      projectPageSchema.safeParse({
        ...value,
        repositories: [{ ...value.repositories[0], temp_clone_token: "private-provider-token" }],
      }).success,
    ).toBe(false);
  });
  it.each([
    "https://attacker.invalid/owner/hive",
    "javascript:alert(1)",
    "https://github.com/other/hive",
  ])("rejects an unbound repository link %s", (htmlUrl) => {
    const value = page();
    value.repositories[0].htmlUrl = htmlUrl;
    expect(projectPageSchema.safeParse(value).success).toBe(false);
  });
  it("rejects ambiguous duplicate identities and page jumps", () => {
    const value = page();
    value.repositories.push({
      ...value.repositories[0],
      name: "renamed",
      fullName: "owner/renamed",
      htmlUrl: "https://github.com/owner/renamed",
    });
    expect(projectPageSchema.safeParse(value).success).toBe(false);
    expect(projectPageSchema.safeParse({ ...page(), nextPage: 3 }).success).toBe(false);
  });
});
