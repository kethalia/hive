-- All project-intent migrations ship in the same unreleased epic. This table
-- must be empty on an upgrade from the released schema; unexpected rows fail
-- explicitly rather than receiving invented source/credential provenance.
ALTER TABLE "project_task_intents"
  ADD COLUMN "repository_id" TEXT NOT NULL,
  ADD COLUMN "provider_account_id" TEXT NOT NULL,
  ADD COLUMN "source_sha" TEXT NOT NULL;
ALTER TABLE "project_task_intents" ADD CONSTRAINT "project_task_intents_source_context_check"
CHECK ("repository_id" ~ '^[1-9][0-9]{0,19}$' AND "provider_account_id" ~ '^[1-9][0-9]{0,19}$' AND "source_sha" ~ '^[a-f0-9]{40}$');
