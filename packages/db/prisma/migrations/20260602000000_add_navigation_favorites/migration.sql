-- CreateEnum
CREATE TYPE "NavigationFavoriteKind" AS ENUM ('terminal', 'git');

-- CreateTable
CREATE TABLE "navigation_favorites" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "NavigationFavoriteKind" NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "target_key" TEXT NOT NULL,
    "label" TEXT,
    "relative_path" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "navigation_favorites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "navigation_favorites_user_id_kind_workspace_id_target_key_key" ON "navigation_favorites"("user_id", "kind", "workspace_id", "target_key");

-- CreateIndex
CREATE INDEX "navigation_favorites_user_id_kind_workspace_id_idx" ON "navigation_favorites"("user_id", "kind", "workspace_id");

-- AddForeignKey
ALTER TABLE "navigation_favorites" ADD CONSTRAINT "navigation_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
