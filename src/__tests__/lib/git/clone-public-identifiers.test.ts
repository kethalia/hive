import { describe, expect, it } from "vitest";
import {
  getCloneDisplayLabel,
  getGitRepositoryPresentation,
} from "@/lib/git/clone-public-identifiers";

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

describe("getGitRepositoryPresentation", () => {
  it("uses the repository name as title and the directory path as subtitle", () => {
    expect(getGitRepositoryPresentation("projects/kethalia/second-brain")).toEqual({
      title: "second-brain",
      subtitle: "projects/kethalia/second-brain",
    });
  });

  it("rejects unsafe paths", () => {
    expect(getGitRepositoryPresentation("/home/coder/projects/kethalia/hive")).toBeNull();
    expect(getGitRepositoryPresentation("projects/../secrets")).toBeNull();
  });
});
