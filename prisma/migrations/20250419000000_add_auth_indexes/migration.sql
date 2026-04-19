-- Add unique constraint on coder_tokens.user_id (one active token per user)
CREATE UNIQUE INDEX "coder_tokens_user_id_key" ON "coder_tokens"("user_id");

-- Add index on tasks.user_id for filtered queries
CREATE INDEX "tasks_user_id_idx" ON "tasks"("user_id");
