import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Prisma schema", () => {
  const schemaPath = path.resolve(__dirname, "../../../../packages/db/prisma/schema.prisma");
  const schema = fs.readFileSync(schemaPath, "utf-8");

  it("does not retain the retired task runner schema", () => {
    expect(schema).not.toContain("model Task {");
    expect(schema).not.toContain("model TaskLog {");
    expect(schema).not.toContain("model Workspace {");
    expect(schema).not.toContain("enum TaskStatus {");
    expect(schema).not.toContain("enum WorkspaceStatus {");
    expect(schema).not.toContain("tasks               Task[]");
  });

  it("ships a destructive migration for the retired task runner", () => {
    const migrationPath = path.resolve(
      __dirname,
      "../../../../packages/db/prisma/migrations/20260814000000_remove_legacy_tasks/migration.sql",
    );
    const migration = fs.readFileSync(migrationPath, "utf-8");

    expect(migration).toContain('DROP TABLE IF EXISTS "workspaces";');
    expect(migration).toContain('DROP TABLE IF EXISTS "task_logs";');
    expect(migration).toContain('DROP TABLE IF EXISTS "tasks";');
    expect(migration).toContain('DROP TYPE IF EXISTS "WorkspaceStatus";');
    expect(migration).toContain('DROP TYPE IF EXISTS "TaskStatus";');
  });

  it("defines the default-off synced terminal controls user setting", () => {
    expect(schema).toContain("model User {");
    expect(schema).toContain(
      'terminalControlsBeyondMobile Boolean  @default(false) @map("terminal_controls_beyond_mobile")',
    );
  });

  it("adds optional OAuth session storage while retaining legacy UUID session identity", () => {
    expect(schema).toContain('authToken String?  @unique @map("auth_token")');
    expect(schema).toContain(
      'sessionId String   @unique @default(uuid()) @map("session_id") @db.Uuid',
    );
    expect(schema).toContain(
      'emailVerified                Boolean  @default(false) @map("email_verified")',
    );
    expect(schema).toContain(
      'authMode                     String   @default("legacy") @map("auth_mode")',
    );
    expect(schema).toContain("model CoderOAuthAccount {");
    expect(schema).toContain("@@unique([providerId, accountId])");
    expect(schema).toContain("@@unique([userId, providerId])");
    expect(schema).toContain("model BAVerification {");
    expect(schema).toContain("@@index([identifier])");
  });

  it("seeds scoped Coder account links and guards identity, refresh leases and token versions", () => {
    const migration = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../../../packages/db/prisma/migrations/20261114010000_coder_oauth_better_auth/migration.sql",
      ),
      "utf-8",
    );
    expect(migration).toContain("coder_url || '|' || coder_user_id::text, 'coder', id");
    expect(migration).toContain("auth_mode IN ('legacy', 'oauth')");
    expect(migration).toContain("refresh_state IN ('idle', 'refreshing', 'reconnect')");
    expect(migration).toContain("HIVE_OAUTH_ACCOUNT_IDENTITY_IMMUTABLE");
    expect(migration).toContain("NEW.version := OLD.version + 1");
    expect(migration).toContain("NEW.access_token, NEW.refresh_token, NEW.access_token_expires_at");
    expect(migration).toContain("TG_TABLE_SCHEMA");
    expect(migration).toContain('REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE');
  });

  it("defines user-owned navigation favorites with composite scoping", () => {
    expect(schema).toContain("enum NavigationFavoriteKind {");
    expect(schema).toContain("terminal");
    expect(schema).toContain("git");
    expect(schema).toContain("navigationFavorites NavigationFavorite[]");
    expect(schema).toContain("model NavigationFavorite {");
    expect(schema).toContain('userId       String                 @map("user_id") @db.Uuid');
    expect(schema).toContain("kind         NavigationFavoriteKind");
    expect(schema).toContain('workspaceId  String                 @map("workspace_id")');
    expect(schema).toContain('targetKey    String                 @map("target_key")');
    expect(schema).toContain('relativePath String?                @map("relative_path")');
    expect(schema).toContain("position     Int                    @default(2147483647)");
    expect(schema).toContain(
      "user User @relation(fields: [userId], references: [id], onDelete: Cascade)",
    );
    expect(schema).toContain("@@unique([userId, kind, workspaceId, targetKey])");
    expect(schema).toContain("@@index([userId, kind, workspaceId])");
    expect(schema).toContain('@@map("navigation_favorites")');
  });

  it("ships persisted ordering for navigation favorites", () => {
    const migrationPath = path.resolve(
      __dirname,
      "../../../../packages/db/prisma/migrations/20260714000000_add_navigation_favorite_position/migration.sql",
    );
    const migration = fs.readFileSync(migrationPath, "utf-8");

    expect(migration).toContain('ADD COLUMN "position" INTEGER NOT NULL DEFAULT 2147483647;');
    expect(migration).toContain('CREATE INDEX "navigation_favorites_user_id_position_idx"');
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
    expect(migration).toContain('CREATE TABLE "navigation_favorites"');
    expect(migration).toContain('"user_id" UUID NOT NULL');
    expect(migration).toContain('"kind" "NavigationFavoriteKind" NOT NULL');
    expect(migration).toContain('"workspace_id" TEXT NOT NULL');
    expect(migration).toContain('"target_key" TEXT NOT NULL');
    expect(migration).toContain('"relative_path" TEXT');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "navigation_favorites_user_id_kind_workspace_id_target_key_key" ON "navigation_favorites"("user_id", "kind", "workspace_id", "target_key");',
    );
    expect(migration).toContain(
      'CREATE INDEX "navigation_favorites_user_id_kind_workspace_id_idx" ON "navigation_favorites"("user_id", "kind", "workspace_id");',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE',
    );
  });

  it("ships a terminal controls preference migration with a non-null false default", () => {
    const migrationPath = path.resolve(
      __dirname,
      "../../../../packages/db/prisma/migrations/20260603000000_add_terminal_controls_beyond_mobile/migration.sql",
    );
    const migration = fs.readFileSync(migrationPath, "utf-8");

    expect(migration).toContain(
      'ALTER TABLE "users" ADD COLUMN "terminal_controls_beyond_mobile" BOOLEAN NOT NULL DEFAULT false;',
    );
  });
});
