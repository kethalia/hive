-- Explicit presence checks avoid SQL CHECK's three-valued NULL semantics.
ALTER TABLE "project_task_intents" ADD CONSTRAINT "project_task_intents_encryption_presence_check"
CHECK (("ciphertext" IS NULL) = ("iv" IS NULL) AND ("ciphertext" IS NULL) = ("auth_tag" IS NULL));
ALTER TABLE "project_task_intents" ADD CONSTRAINT "project_task_intents_lease_presence_check"
CHECK (("lease_id" IS NULL) = ("lease_until" IS NULL));
ALTER TABLE "project_task_intents" ADD CONSTRAINT "project_task_intents_digest_check"
CHECK ("request_digest" ~ '^[a-f0-9]{64}$');
