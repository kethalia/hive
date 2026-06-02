import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Prisma schema", () => {
  const schemaPath = path.resolve(__dirname, "../../../../packages/db/prisma/schema.prisma");
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

  it("defines user-owned navigation favorites with composite scoping", () => {
    expect(schema).toContain("enum NavigationFavoriteKind {");
    expect(schema).toContain("terminal");
    expect(schema).toContain("git");
    expect(schema).toContain("navigationFavorites NavigationFavorite[]");
    expect(schema).toContain("model NavigationFavorite {");
    expect(schema).toContain("userId       String                 @map(\"user_id\") @db.Uuid");
    expect(schema).toContain("kind         NavigationFavoriteKind");
    expect(schema).toContain("workspaceId  String                 @map(\"workspace_id\")");
    expect(schema).toContain("targetKey    String                 @map(\"target_key\")");
    expect(schema).toContain("relativePath String?                @map(\"relative_path\")");
    expect(schema).toContain("user User @relation(fields: [userId], references: [id], onDelete: Cascade)");
    expect(schema).toContain("@@unique([userId, kind, workspaceId, targetKey])");
    expect(schema).toContain("@@index([userId, kind, workspaceId])");
    expect(schema).toContain("@@map(\"navigation_favorites\")");
  });

  it("ships a navigation favorites migration with relation, unique key, and lookup index", () => {
    const migrationPath = path.resolve(
      __dirname,
      "../../../../packages/db/prisma/migrations/20260602000000_add_navigation_favorites/migration.sql",
    );
    const migration = fs.readFileSync(migrationPath, "utf-8");

    expect(migration).toContain(
      "CREATE TYPE \"NavigationFavoriteKind\" AS ENUM ('terminal', 'git');",
    );
    expect(migration).toContain("CREATE TABLE \"navigation_favorites\"");
    expect(migration).toContain("\"user_id\" UUID NOT NULL");
    expect(migration).toContain("\"kind\" \"NavigationFavoriteKind\" NOT NULL");
    expect(migration).toContain("\"workspace_id\" TEXT NOT NULL");
    expect(migration).toContain("\"target_key\" TEXT NOT NULL");
    expect(migration).toContain("\"relative_path\" TEXT");
    expect(migration).toContain(
      "CREATE UNIQUE INDEX \"navigation_favorites_user_id_kind_workspace_id_target_key_key\" ON \"navigation_favorites\"(\"user_id\", \"kind\", \"workspace_id\", \"target_key\");",
    );
    expect(migration).toContain(
      "CREATE INDEX \"navigation_favorites_user_id_kind_workspace_id_idx\" ON \"navigation_favorites\"(\"user_id\", \"kind\", \"workspace_id\");",
    );
    expect(migration).toContain(
      "FOREIGN KEY (\"user_id\") REFERENCES \"users\"(\"id\") ON DELETE CASCADE ON UPDATE CASCADE",
    );
  });
});
