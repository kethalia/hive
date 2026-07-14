import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

describe("web app manifest", () => {
  it("launches the installed app into the workspace console", () => {
    expect(manifest().start_url).toBe("/workspaces");
  });
});
