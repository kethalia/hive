import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("Prisma schema", () => {
  const schemaPath = path.resolve(__dirname, "../../../prisma/schema.prisma");
  const schema = fs.readFileSync(schemaPath, "utf-8");

  it("defines Task model with expected fields", () => {
    expect(schema).toContain("model Task {");
    expect(schema).toContain("prompt");
    expect(schema).toContain("repoUrl");
    expect(schema).toContain("status");
    expect(schema).toContain("createdAt");
    expect(schema).toContain("updatedAt");
    expect(schema).toContain("attachments");
  });

  it("defines TaskLog model with expected fields", () => {
    expect(schema).toContain("model TaskLog {");
    expect(schema).toContain("taskId");
    expect(schema).toContain("message");
    expect(schema).toContain("level");
  });

  it("defines Workspace model with expected fields", () => {
    expect(schema).toContain("model Workspace {");
    expect(schema).toContain("taskId");
    expect(schema).toContain("coderWorkspaceId");
    expect(schema).toContain("templateType");
    expect(schema).toContain("status");
  });

  it("defines TaskStatus enum with correct values", () => {
    expect(schema).toContain("enum TaskStatus {");
    for (const val of ["queued", "running", "verifying", "done", "failed"]) {
      expect(schema).toContain(val);
    }
  });

  it("defines WorkspaceStatus enum with correct values", () => {
    expect(schema).toContain("enum WorkspaceStatus {");
    for (const val of ["pending", "starting", "running", "stopped", "deleted", "failed"]) {
      expect(schema).toContain(val);
    }
  });
});
