-- DropForeignKey
ALTER TABLE "codex_host_slots" DROP CONSTRAINT "codex_host_slots_active_registration_fkey";

-- RenameForeignKey
ALTER TABLE "project_task_intents" RENAME CONSTRAINT "project_task_intents_project_fkey" TO "project_task_intents_owner_id_project_id_fkey";
