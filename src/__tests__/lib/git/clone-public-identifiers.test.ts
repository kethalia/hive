import { describe, expect, it } from "vitest";
import { getCloneDisplayLabel } from "@/lib/git/clone-public-identifiers";

describe("getCloneDisplayLabel", () => {
  it("removes the conventional projects container from repository labels", () => {
    expect(getCloneDisplayLabel("projects/kethalia/hive")).toBe("kethalia/hive");
    expect(getCloneDisplayLabel("Git/projects/phlox-labs/platform/orchard")).toBe(
      "phlox-labs/platform/orchard",
    );
  });

  it("preserves already concise repository paths", () => {
    expect(getCloneDisplayLabel("kethalia/hive")).toBe("kethalia/hive");
  });

  it("rejects absolute and traversing paths", () => {
    expect(getCloneDisplayLabel("/home/coder/projects/kethalia/hive")).toBeNull();
    expect(getCloneDisplayLabel("projects/../secrets")).toBeNull();
  });
});
