ALTER TABLE "navigation_favorites"
ADD COLUMN "position" INTEGER NOT NULL DEFAULT 2147483647;

CREATE INDEX "navigation_favorites_user_id_position_idx"
ON "navigation_favorites"("user_id", "position");
